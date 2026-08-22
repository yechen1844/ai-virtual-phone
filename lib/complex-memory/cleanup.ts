// lib/complex-memory/cleanup.ts
// 复杂记忆系统 · 记忆清洗：向量聚类 → 三种处置（融合更新 / 并入周期 / 合并为新周期）→ 快照回退。
// 触发：用户手动发起（查看器「记忆清洗」入口），按角色执行。
// 快照存 KV（按角色保留最近 3 次），一键整体回退。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { cosineSimilarity, keywordOverlapRatio } from "../memory-embedding";
import { registerDynamicPrefix, kvGet, kvSet } from "../kv-db";
import {
  loadEvents,
  loadDailies,
  loadPeriods,
  saveEvent,
  saveDaily,
  savePeriod,
  deleteEvent,
  deleteDaily,
} from "./storage";
import { distillPeriod } from "./period-distiller";
import { dateFromTimestamp } from "./utils";
import type { ComplexDaily, ComplexEvent, ComplexPeriod, EmotionVector } from "./types";

export const CLEANUP_SNAPSHOT_PREFIX = "ai_phone_complex_memory_cleanup_";
registerDynamicPrefix(CLEANUP_SNAPSHOT_PREFIX);

const MAX_SNAPSHOTS = 3;
const EMB_THRESHOLD = 0.72;
const KW_THRESHOLD = 0.4;
const MAX_CLUSTER_SIZE = 6;

// ── 类型 ──
export type CleanupEntry = {
  kind: "event" | "daily";
  id: string;
  date: string;
  content: string;
  emotion?: EmotionVector;
  embedding?: number[];
  periodIds: string[];
  importance?: number;
};

export type CleanupCluster = {
  clusterId: string;
  entries: CleanupEntry[];
  similarity: number;       // 簇内平均相似度
  reasons: string[];        // 聚类证据（时间接近 / 同周期 / 向量相似）
  timestamp: string;
};

export type CleanupOperation = "merge" | "into_period" | "new_period";

export type CleanupSnapshotItem = {
  kind: "event" | "daily";
  record: ComplexEvent | ComplexDaily;
};

export type CleanupSnapshot = {
  id: string;
  characterId: string;
  createdAt: string;
  operation: CleanupOperation;
  affected: CleanupSnapshotItem[];
  replacedWithId?: string;   // 融合/新周期产物 id（回退时删除）
  periodId?: string;         // 并入/新周期涉及的周期
};

export type CleanupSnapshotList = CleanupSnapshot[];

// ── 快照读写（KV） ──
function loadSnapshots(characterId: string): CleanupSnapshotList {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(CLEANUP_SNAPSHOT_PREFIX + characterId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CleanupSnapshotList) : [];
  } catch {
    return [];
  }
}

function saveSnapshots(characterId: string, snaps: CleanupSnapshotList): void {
  if (typeof window === "undefined") return;
  kvSet(CLEANUP_SNAPSHOT_PREFIX + characterId, JSON.stringify(snaps.slice(-MAX_SNAPSHOTS)));
}

function pushSnapshot(characterId: string, snap: CleanupSnapshot): void {
  const list = loadSnapshots(characterId);
  list.push(snap);
  saveSnapshots(characterId, list);
}

export function listCleanupSnapshots(characterId: string): CleanupSnapshotList {
  return loadSnapshots(characterId).slice().reverse();
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function avgEmotion(entries: CleanupEntry[]): EmotionVector {
  const valid = entries.filter((e) => e.emotion);
  if (valid.length === 0) return { valence: 0, arousal: 0.5 };
  const valence = valid.reduce((s, e) => s + (e.emotion?.valence ?? 0), 0) / valid.length;
  const arousal = valid.reduce((s, e) => s + (e.emotion?.arousal ?? 0.5), 0) / valid.length;
  return { valence, arousal };
}

// ── ① 聚类扫描 ──
export async function scanCleanupClusters(characterId: string): Promise<CleanupCluster[]> {
  const [events, dailies] = await Promise.all([loadEvents(characterId), loadDailies(characterId)]);
  const entries: CleanupEntry[] = [
    ...events.map((e) => ({
      kind: "event" as const,
      id: e.id,
      date: dateFromTimestamp(e.timestamp),
      content: e.content,
      emotion: e.emotion,
      embedding: e.embedding,
      periodIds: e.periodsRef,
      importance: e.importanceScore,
    })),
    ...dailies.map((d) => ({
      kind: "daily" as const,
      id: d.id,
      date: d.date,
      content: d.content,
      emotion: d.emotionVector,
      embedding: d.embedding,
      periodIds: d.belongsToPeriods,
    })),
  ];
  if (entries.length < 2) return [];

  const n = entries.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  const pairSims: Array<{ i: number; j: number; sim: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = entries[i];
      const b = entries[j];
      let sim: number;
      let threshold: number;
      if (a.embedding && a.embedding.length > 0 && b.embedding && b.embedding.length > 0) {
        sim = cosineSimilarity(a.embedding, b.embedding);
        threshold = EMB_THRESHOLD;
      } else {
        sim = keywordOverlapRatio(a.content, b.content);
        threshold = KW_THRESHOLD;
      }
      if (sim >= threshold) {
        adj[i].push(j);
        adj[j].push(i);
        pairSims.push({ i, j, sim });
      }
    }
  }

  // 连通分量 = 召回时易互相干扰/混淆的记忆组
  const visited = new Array<boolean>(n).fill(false);
  const comps: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    visited[i] = true;
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nx of adj[cur]) {
        if (!visited[nx]) {
          visited[nx] = true;
          stack.push(nx);
        }
      }
    }
    if (comp.length >= 2) comps.push(comp);
  }

  const out: CleanupCluster[] = [];
  for (const comp of comps) {
    let ids = comp;
    if (comp.length > MAX_CLUSTER_SIZE) {
      // 截断超大簇：保留与簇内成员平均相似度最高的若干条
      const avgSimOf = (idx: number): number => {
        let total = 0;
        let cnt = 0;
        for (const p of pairSims) {
          if ((p.i === idx || p.j === idx) && comp.includes(p.i) && comp.includes(p.j)) {
            total += p.sim;
            cnt += 1;
          }
        }
        return cnt ? total / cnt : 0;
      };
      ids = [...comp].sort((a, b) => avgSimOf(b) - avgSimOf(a)).slice(0, MAX_CLUSTER_SIZE);
    }
    const members = ids.map((idx) => entries[idx]);
    const sims = pairSims.filter((p) => ids.includes(p.i) && ids.includes(p.j)).map((p) => p.sim);
    const avg = sims.length ? sims.reduce((s, v) => s + v, 0) / sims.length : 0;

    // 二次证据：时间接近度 + 同周期归属
    const reasons: string[] = [];
    const times = members.map((m) => new Date(m.date).getTime());
    const spanDays = (Math.max(...times) - Math.min(...times)) / 86_400_000;
    if (spanDays <= 7) reasons.push(`时间接近（${Math.round(spanDays)} 天内）`);
    const periodCount = new Map<string, number>();
    for (const m of members) {
      for (const pid of m.periodIds) periodCount.set(pid, (periodCount.get(pid) ?? 0) + 1);
    }
    for (const [pid, c] of periodCount) {
      if (c >= Math.max(2, Math.ceil(members.length / 2))) {
        reasons.push(`同周期（${c}/${members.length} 条）`);
      }
    }
    if (reasons.length === 0) reasons.push("向量相似度聚类");

    out.push({
      clusterId: `cluster_${Date.now()}_${out.length}_${Math.random().toString(36).slice(2, 5)}`,
      entries: members,
      similarity: avg,
      reasons,
      timestamp: new Date().toISOString(),
    });
  }
  return out;
}

// ── LLM 融合 ──
async function llmMergeText(
  characterId: string,
  characterName: string,
  entries: CleanupEntry[],
): Promise<string | null> {
  const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) return null;
  const materials = entries
    .map((e) => `[${e.kind === "daily" ? "日记" : "事件"} ${e.date}] ${e.content}`)
    .join("\n");
  const prompt = `以下是角色记忆库中高度相似、容易互相干扰的 ${entries.length} 条记录。
请将它们融合为一条精炼的第一人称记忆叙事：保留关键事实、情绪与时间线索，删除重复细节，150-400 字。
记录：
${materials}
只输出融合后的正文，不要输出任何其他内容。`;
  const result = await simpleLLMCall(
    apiConfig,
    [{ role: "user", content: prompt }],
    { temperature: 0.3, label: `复杂记忆·清洗融合·${characterName}` },
  );
  const text = (result.content ?? "").trim();
  return text || null;
}

async function loadAffected(characterId: string, entries: CleanupEntry[]): Promise<CleanupSnapshotItem[]> {
  const [events, dailies] = await Promise.all([loadEvents(characterId), loadDailies(characterId)]);
  const out: CleanupSnapshotItem[] = [];
  for (const e of entries) {
    if (e.kind === "event") {
      const rec = events.find((x) => x.id === e.id);
      if (rec) out.push({ kind: "event", record: rec });
    } else {
      const rec = dailies.find((x) => x.id === e.id);
      if (rec) out.push({ kind: "daily", record: rec });
    }
  }
  return out;
}

// ── ② 处置一：融合更新（LLM 合并成一条，替换原多条） ──
export async function mergeCluster(
  characterId: string,
  characterName: string,
  cluster: CleanupCluster,
): Promise<{ success: boolean; error?: string; snapshotId?: string }> {
  const merged = await llmMergeText(characterId, characterName, cluster.entries);
  if (!merged) return { success: false, error: "融合文本生成失败（请检查辅助 API 配置）" };

  const allDaily = cluster.entries.every((e) => e.kind === "daily");
  const earliest = cluster.entries.map((e) => e.date).sort()[0];
  const emotion = avgEmotion(cluster.entries);
  const periodIds = uniq(cluster.entries.flatMap((e) => e.periodIds));
  const now = new Date().toISOString();
  const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const affected = await loadAffected(characterId, cluster.entries);

  let replacedWithId: string;
  if (allDaily) {
    replacedWithId = `day_${earliest.replace(/-/g, "")}`;
    const daily: ComplexDaily = {
      id: replacedWithId,
      characterId,
      date: earliest,
      content: merged,
      belongsToPeriods: periodIds,
      emotionVector: emotion,
      voltage: 1,
      lastAccessedAt: now,
      createdAt: now,
    };
    await saveDaily(daily);
    for (const e of cluster.entries) await deleteDaily(e.id);
  } else {
    replacedWithId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const event: ComplexEvent = {
      id: replacedWithId,
      characterId,
      timestamp: `${earliest}T00:00:00.000Z`,
      content: merged,
      emotion,
      periodsRef: periodIds,
      voltage: 1,
      importanceScore: 0.7,
      lastAccessedAt: now,
      createdAt: now,
    };
    await saveEvent(event);
    for (const e of cluster.entries) await deleteEvent(e.id);
  }

  pushSnapshot(characterId, {
    id: snapshotId,
    characterId,
    createdAt: now,
    operation: "merge",
    affected,
    replacedWithId,
  });
  return { success: true, snapshotId };
}

// ── 处置二：并入某周期（整簇作为素材并入，原条目消磨） ──
export async function mergeClusterIntoPeriod(
  characterId: string,
  characterName: string,
  cluster: CleanupCluster,
  periodId: string,
): Promise<{ success: boolean; error?: string; snapshotId?: string }> {
  const periods = await loadPeriods(characterId);
  const period = periods.find((p) => p.id === periodId);
  if (!period) return { success: false, error: "目标周期不存在" };

  const now = new Date().toISOString();
  const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const affected = await loadAffected(characterId, cluster.entries);

  // 关联：日记 belongsToPeriods / 事件 periodsRef 并入目标周期
  const [events, dailies] = await Promise.all([loadEvents(characterId), loadDailies(characterId)]);
  const writes: Array<Promise<void>> = [];
  for (const e of cluster.entries) {
    if (e.kind === "event") {
      const rec = events.find((x) => x.id === e.id);
      if (rec && !rec.periodsRef.includes(periodId)) {
        writes.push(saveEvent({ ...rec, periodsRef: [...rec.periodsRef, periodId] }));
      }
    } else {
      const rec = dailies.find((x) => x.id === e.id);
      if (rec && !rec.belongsToPeriods.includes(periodId)) {
        writes.push(saveDaily({ ...rec, belongsToPeriods: [...rec.belongsToPeriods, periodId] }));
      }
    }
  }
  await Promise.all(writes);

  // active 周期：滚动累积追加簇内容；stabilized/archived：重新打开为 active 再提炼
  const stamp = `[清洗并入 ${cluster.entries.length} 条 ${cluster.entries[0]?.date}]`;
  const bulk = cluster.entries.map((e) => `- [${e.date}] ${e.content}`).join("\n");
  if (period.status === "active") {
    const prev = period.rollingSummary?.trim();
    const next = prev ? `${prev}\n${stamp}\n${bulk}` : `${stamp}\n${bulk}`;
    await savePeriod({ ...period, rollingSummary: next, updatedAt: now });
  } else {
    await savePeriod({
      ...period,
      status: "active",
      endTime: null,
      rollingSummary: period.rollingSummary?.trim()
        ? `${period.rollingSummary.trim()}\n${stamp}\n${bulk}`
        : `${stamp}\n${bulk}`,
      updatedAt: now,
    });
  }

  // 触发提炼（锁外异步）
  void distillPeriod(characterId, characterName, periodId).catch((err) =>
    console.warn("[ComplexMemory] 清洗并入后提炼失败:", periodId, err),
  );

  pushSnapshot(characterId, {
    id: snapshotId,
    characterId,
    createdAt: now,
    operation: "into_period",
    affected,
    periodId,
  });
  return { success: true, snapshotId };
}

// ── 处置三：合并为新周期（整簇生成一条新周期） ──
export async function createPeriodFromCluster(
  characterId: string,
  characterName: string,
  cluster: CleanupCluster,
): Promise<{ success: boolean; error?: string; snapshotId?: string; periodId?: string }> {
  const dates = cluster.entries.map((e) => e.date).sort();
  const earliest = dates[0];
  const now = new Date().toISOString();
  const snapshotId = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const affected = await loadAffected(characterId, cluster.entries);

  const periodId = `period_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const period: ComplexPeriod = {
    id: periodId,
    characterId,
    title: `记忆簇 ${earliest}（${cluster.entries.length} 条）`,
    startTime: earliest,
    endTime: null,
    status: "active",
    summary: "",
    timelineIndex: {},
    associatedDates: uniq(dates),
    linkedPeriods: [],
    coveredEventIds: [],
    voltage: 1,
    lastAccessedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await savePeriod(period);

  // 关联簇内条目到新周期
  const [events, dailies] = await Promise.all([loadEvents(characterId), loadDailies(characterId)]);
  const writes: Array<Promise<void>> = [];
  for (const e of cluster.entries) {
    if (e.kind === "event") {
      const rec = events.find((x) => x.id === e.id);
      if (rec && !rec.periodsRef.includes(periodId)) {
        writes.push(saveEvent({ ...rec, periodsRef: [...rec.periodsRef, periodId] }));
      }
    } else {
      const rec = dailies.find((x) => x.id === e.id);
      if (rec && !rec.belongsToPeriods.includes(periodId)) {
        writes.push(saveDaily({ ...rec, belongsToPeriods: [...rec.belongsToPeriods, periodId] }));
      }
    }
  }
  await Promise.all(writes);

  void distillPeriod(characterId, characterName, periodId).catch((err) =>
    console.warn("[ComplexMemory] 新周期提炼失败:", periodId, err),
  );

  pushSnapshot(characterId, {
    id: snapshotId,
    characterId,
    createdAt: now,
    operation: "new_period",
    affected,
    periodId,
  });
  return { success: true, snapshotId, periodId };
}

// ── 一键回退 ──
export async function rollbackCleanup(
  characterId: string,
  snapshotId: string,
): Promise<{ success: boolean; error?: string }> {
  const list = loadSnapshots(characterId);
  const snap = list.find((s) => s.id === snapshotId);
  if (!snap) return { success: false, error: "快照不存在或已过期" };

  // 恢复全部原条目
  for (const item of snap.affected) {
    if (item.kind === "daily") {
      await saveDaily(item.record as ComplexDaily);
    } else {
      await saveEvent(item.record as ComplexEvent);
    }
  }

  // 删除融合产物（事件/日记尝试删除，不存在则静默）
  if (snap.replacedWithId) {
    await deleteEvent(snap.replacedWithId).catch(() => {});
    await deleteDaily(snap.replacedWithId).catch(() => {});
  }

  // 移除该快照
  saveSnapshots(characterId, list.filter((s) => s.id !== snapshotId));
  return { success: true };
}
