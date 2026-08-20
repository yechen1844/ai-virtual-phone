// lib/complex-memory/recall.ts
// 复杂记忆系统 · 读取管线四步编排：固定注入 → 向量召回 → 丝线联想 → 重排序 → 预算控制。
// 输出 MemoryContextBundle，由 chat-engine 接管 coreMemories / longTermMemories 两个槽位。

import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity, keywordOverlapRatio } from "../memory-embedding";
import { simpleLLMCall } from "../api-helpers";
import { estimateTokens } from "../token-counter";
import { loadComplexMemoryConfig } from "./config";
import { renderMemoryPrompt, DEFAULT_PROMPTS } from "./prompts";
import {
  getCurrentCore,
  loadEvents,
  loadDailies,
  loadPeriods,
  saveEvent,
  saveDaily,
  savePeriod,
} from "./storage";
import { boostedVoltage } from "./voltage";
import type {
  ComplexDaily,
  ComplexEvent,
  ComplexMemoryConfig,
  ComplexPeriod,
  MemoryContextBundle,
  MemoryRecallItem,
} from "./types";

function dateString(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatEventLine(e: ComplexEvent): string {
  return `[${e.timestamp.slice(0, 16).replace("T", " ")}] ${e.content}`;
}

function formatDailyLine(d: ComplexDaily): string {
  return `[${d.date}] ${d.content}`;
}

function formatPeriodLine(p: ComplexPeriod): string {
  const range = p.endTime ? `${p.startTime} ~ ${p.endTime}` : `${p.startTime} ~ 至今`;
  return `【${p.title}】${range}\n${p.summary}`;
}

function formatRecallItem(item: MemoryRecallItem): string {
  const kindLabel = item.kind === "event" ? "事件" : item.kind === "daily" ? "日记" : "周期";
  return `[${kindLabel} ${item.timestamp}] ${item.content}`;
}

/**
 * 组装复杂记忆上下文包。
 * @param shortTermText 短期上下文文本（来自 prepareShortTermContext 的 recentBlocks 合并，
 *                      两系统短期同源，此处仅用于 token 统计与查看器展示，不重复注入）
 */
export async function buildMemoryContextBundle(
  characterId: string,
  characterName: string,
  currentContext: string,
  options?: { shortTermText?: string },
): Promise<MemoryContextBundle> {
  const config = loadComplexMemoryConfig();

  const [core, events, dailies, periods] = await Promise.all([
    getCurrentCore(characterId),
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
  ]);

  // ① 固定注入区（硬性保留）
  const coreMemory = core?.content ?? "";
  const fixedEvents = events.slice(-config.fixedRecentEventCount).map(formatEventLine).join("\n");
  const yesterday = dailies.find((d) => d.date === dateString(-1));
  const yesterdayDaily = yesterday ? formatDailyLine(yesterday) : "";
  const activePeriods = periods
    .filter((p) => p.status === "active")
    .map(formatPeriodLine)
    .join("\n\n");
  const fixedShortTerm = options?.shortTermText ?? "";

  // ② 向量召回（无 embedding API 时关键词退化）
  let recalledItems = await vectorRecall(characterId, currentContext, config, { events, dailies, periods });

  // 剔除与固定注入区重复的实体（最新事件/昨日日记/活跃周期已硬性注入）
  const fixedIds = new Set<string>([
    ...events.slice(-config.fixedRecentEventCount).map((e) => e.id),
    ...(yesterday ? [yesterday.id] : []),
    ...periods.filter((p) => p.status === "active").map((p) => p.id),
  ]);
  recalledItems = recalledItems.filter((item) => !fixedIds.has(item.id));

  // ④ 丝线联想：召回含日记时并入其归属周期 summary，由重排决定是否引入
  if (config.silkAssociationEnabled) {
    recalledItems = silkAssociate(recalledItems, periods);
  }

  // ③ 重排序（未配置重排序模型时按向量分截断）
  const reranked = config.rerankEnabled
    ? await rerankCandidates(recalledItems, currentContext, coreMemory, characterName, config)
    : recalledItems.slice(0, config.rerankKeepMax);

  // 预算控制：固定注入区优先，召回区按得分从高到低填充
  const fixedTokens =
    estimateTokens(coreMemory) +
    estimateTokens(fixedShortTerm) +
    estimateTokens(fixedEvents) +
    estimateTokens(yesterdayDaily) +
    estimateTokens(activePeriods);
  const kept = trimRecalledToBudget(fixedTokens, reranked, config.totalInjectTokenBudget);

  const recalled = kept.map(formatRecallItem).join("\n\n");
  const tokenEstimate =
    fixedTokens + kept.reduce((sum, item) => sum + estimateTokens(item.content) + 8, 0);

  // 电压回升：所有被最终注入的实体 +0.1 并刷新 lastAccessedAt
  await boostInjected(characterId, { events, dailies, periods, fixedEventCount: config.fixedRecentEventCount, yesterday, kept });

  return {
    coreMemory,
    fixedShortTerm,
    fixedEvents,
    yesterdayDaily,
    activePeriods,
    recalled,
    recalledItems: kept,
    tokenEstimate,
  };
}

// ── ② 向量召回 ──
async function vectorRecall(
  characterId: string,
  currentContext: string,
  config: ComplexMemoryConfig,
  entities: { events: ComplexEvent[]; dailies: ComplexDaily[]; periods: ComplexPeriod[] },
): Promise<MemoryRecallItem[]> {
  const embApi = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;

  const candidates: Array<{ item: MemoryRecallItem; embedding?: number[] }> = [];
  for (const e of entities.events) {
    candidates.push({
      item: { kind: "event", id: e.id, characterId, timestamp: e.timestamp, content: e.content, score: 0, voltage: e.voltage, belongsToPeriods: e.periodsRef },
      embedding: e.embedding,
    });
  }
  for (const d of entities.dailies) {
    candidates.push({
      item: { kind: "daily", id: d.id, characterId, timestamp: d.date, content: d.content, score: 0, voltage: d.voltage, belongsToPeriods: d.belongsToPeriods },
      embedding: d.embedding,
    });
  }
  for (const p of entities.periods) {
    candidates.push({
      item: { kind: "period", id: p.id, characterId, timestamp: p.startTime, content: p.summary, score: 0, voltage: p.voltage },
      embedding: p.embedding,
    });
  }

  if (candidates.length === 0 || !currentContext.trim()) return [];

  if (embApi && resolveEmbeddingModel(embApi)) {
    const queryEmbedding = await generateEmbedding(currentContext, embApi);
    if (queryEmbedding) {
      const withEmb = candidates.filter((c) => c.embedding && c.embedding.length > 0);
      if (withEmb.length > 0) {
        const scored = withEmb.map((c) => ({ item: c.item, score: cosineSimilarity(queryEmbedding, c.embedding!) }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, config.recallTopK).map((s) => ({ ...s.item, score: s.score }));
      }
    }
  }

  const scored = candidates.map((c) => ({ item: c.item, score: keywordOverlapRatio(currentContext, c.item.content) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, config.recallTopK).map((s) => ({ ...s.item, score: s.score }));
}

// ── ④ 丝线联想 ──
function silkAssociate(recalled: MemoryRecallItem[], periods: ComplexPeriod[]): MemoryRecallItem[] {
  const linkedIds = new Set<string>();
  for (const item of recalled) {
    if (item.kind === "daily" && item.belongsToPeriods) {
      for (const pid of item.belongsToPeriods) linkedIds.add(pid);
    }
  }
  if (linkedIds.size === 0) return recalled;

  const periodById = new Map(periods.map((p) => [p.id, p]));
  const extra: MemoryRecallItem[] = [];
  for (const pid of linkedIds) {
    const p = periodById.get(pid);
    if (p && !recalled.some((r) => r.id === p.id)) {
      extra.push({
        kind: "period",
        id: p.id,
        characterId: p.characterId,
        timestamp: p.startTime,
        content: `【${p.title}】${p.summary}`,
        score: 0,
        voltage: p.voltage,
      });
    }
  }
  return extra.length > 0 ? [...recalled, ...extra] : recalled;
}

// ── ③ 重排序 ──
async function rerankCandidates(
  candidates: MemoryRecallItem[],
  context: string,
  coreMemory: string,
  characterName: string,
  config: ComplexMemoryConfig,
): Promise<MemoryRecallItem[]> {
  const fallback = () =>
    [...candidates].sort((a, b) => b.score - a.score).slice(0, config.rerankKeepMax);
  if (candidates.length === 0) return [];

  const apiConfig = resolveAuxiliaryApiConfig("complexRerankApiConfigId");
  if (!apiConfig) return fallback();

  const candidatesText = candidates
    .map((c, i) => `${i + 1}. [${c.kind}] ${c.timestamp} ${c.content.slice(0, 150)}`)
    .join("\n");

  const template = config.prompts.rerank?.trim() || DEFAULT_PROMPTS.rerank;
  const prompt = renderMemoryPrompt(template, characterName, "", {
    candidates: candidatesText,
    context: context.slice(0, 1200),
    coreMemory: coreMemory.slice(0, 1200),
    keepMax: String(config.rerankKeepMax),
  });

  const result = await simpleLLMCall(
    apiConfig,
    [{ role: "user", content: prompt }],
    { temperature: 0.1, label: "复杂记忆·重排序" },
  );
  if (!result.content) return fallback();

  const scores = parseRerankScores(result.content);
  if (scores.size === 0) return fallback();

  return candidates
    .map((c) => ({ item: c, score: scores.get(c.id) ?? c.score }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.rerankKeepMax)
    .map((x) => ({ ...x.item, score: x.score }));
}

function parseRerankScores(text: string): Map<string, number> {
  const cleaned = text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return new Map();
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as { scores?: Array<Record<string, unknown>> };
    const map = new Map<string, number>();
    for (const s of obj.scores ?? []) {
      if (typeof s.id === "string" && typeof s.total === "number" && Number.isFinite(s.total)) {
        map.set(s.id, s.total);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ── 预算控制 ──
function trimRecalledToBudget(
  fixedTokens: number,
  recalledItems: MemoryRecallItem[],
  budget: number,
): MemoryRecallItem[] {
  const remaining = budget - fixedTokens;
  if (remaining <= 0) return [];
  const sorted = [...recalledItems].sort((a, b) => b.score - a.score);
  const result: MemoryRecallItem[] = [];
  let used = 0;
  for (const item of sorted) {
    const tokens = estimateTokens(item.content) + 8;
    if (used + tokens > remaining) break;
    result.push(item);
    used += tokens;
  }
  return result;
}

// ── 电压回升 ──
async function boostInjected(
  characterId: string,
  deps: {
    events: ComplexEvent[];
    dailies: ComplexDaily[];
    periods: ComplexPeriod[];
    fixedEventCount: number;
    yesterday?: ComplexDaily;
    kept: MemoryRecallItem[];
  },
): Promise<void> {
  const now = Date.now();
  const boosts: Array<Promise<void>> = [];

  const fixedIds = new Set<string>();
  for (const e of deps.events.slice(-deps.fixedEventCount)) {
    fixedIds.add(e.id);
    const b = boostedVoltage(e, 0.1, now);
    boosts.push(saveEvent({ ...e, ...b }));
  }
  if (deps.yesterday) {
    fixedIds.add(deps.yesterday.id);
    const b = boostedVoltage(deps.yesterday, 0.1, now);
    boosts.push(saveDaily({ ...deps.yesterday, ...b }));
  }
  for (const p of deps.periods.filter((x) => x.status === "active")) {
    fixedIds.add(p.id);
    const b = boostedVoltage(p, 0.1, now);
    boosts.push(savePeriod({ ...p, ...b }));
  }

  for (const item of deps.kept) {
    if (fixedIds.has(item.id)) continue;
    if (item.kind === "event") {
      const e = deps.events.find((x) => x.id === item.id);
      if (e) {
        const b = boostedVoltage(e, 0.1, now);
        boosts.push(saveEvent({ ...e, ...b }));
      }
    } else if (item.kind === "daily") {
      const d = deps.dailies.find((x) => x.id === item.id);
      if (d) {
        const b = boostedVoltage(d, 0.1, now);
        boosts.push(saveDaily({ ...d, ...b }));
      }
    } else if (item.kind === "period") {
      const p = deps.periods.find((x) => x.id === item.id);
      if (p) {
        const b = boostedVoltage(p, 0.1, now);
        boosts.push(savePeriod({ ...p, ...b }));
      }
    }
  }

  await Promise.all(boosts);
}
