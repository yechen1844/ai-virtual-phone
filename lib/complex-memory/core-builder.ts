// lib/complex-memory/core-builder.ts
// 复杂记忆系统 · L5 核心记忆（条目式）构建与更新。
// 触发：bootstrap / 定期重构 / 周期提炼微调 / 手动增删改 / 回退 / feedback 重生成。
// 每次更新产出「条目数组 + 新版本快照」，逐条消毒，快照整体替换式镜像到 float core 库。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { loadCharacters } from "../character-storage";
import { loadMemoryEntriesByType } from "../memory-storage";
import {
  loadComplexMemoryConfig,
  acquireGenerationLock,
  releaseGenerationLock,
} from "./config";
import { renderMemoryPrompt, DEFAULT_PROMPTS } from "./prompts";
import {
  getCurrentCoreView,
  loadCoreSnapshots,
  loadCoreEntries,
  saveCoreEntries,
  saveCoreSnapshots,
  saveCoreSnapshot,
  loadLegacyCores,
  renderCoreEntriesText,
} from "./storage";
import { mirrorCoreEntriesToFloat } from "./mirror";
import { getUserName, capSourceMaterials } from "./utils";
import { buildGenerationContext } from "./context-builder";
import type { ComplexCoreEntry, ComplexCoreSnapshot, CoreCategory, CoreTrigger } from "./types";

const CORE_CATEGORIES: CoreCategory[] = ["identity", "bond", "principle", "milestone"];

// ── 消毒检查（逐条） ──
export function sanitizeCoreEntryText(text: string, banList: string[]): boolean {
  return !banList.some((w) => w && text.includes(w));
}

type ParsedCoreEntry = { text: string; category: CoreCategory };

function parseCoreEntriesJson(text: string): ParsedCoreEntry[] | null {
  const cleaned = text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
  // 兼容两种输出：裸数组 [ {...}, ... ] 或对象 { entries: [ {...}, ... ] }（部分模型偏好后者）
  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart < 0 || arrEnd <= arrStart) return null;
  try {
    const raw = cleaned.slice(arrStart, arrEnd + 1);
    const parsed: unknown = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed as { entries?: unknown[] })?.entries;
    if (!Array.isArray(arr)) return null;
    const out: ParsedCoreEntry[] = [];
    for (const item of arr) {
      const o = (item ?? {}) as Record<string, unknown>;
      const textVal = typeof o.text === "string" ? o.text.trim() : "";
      if (!textVal) continue;
      const cat = CORE_CATEGORIES.includes(o.category as CoreCategory) ? (o.category as CoreCategory) : "principle";
      out.push({ text: textVal, category: cat });
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function getCharacter(characterId: string): { name: string; persona: string } {
  try {
    const c = loadCharacters().find((x) => x.id === characterId);
    return { name: c?.name ?? "角色", persona: c?.persona ?? "" };
  } catch {
    return { name: "角色", persona: "" };
  }
}

export function newCoreEntry(
  characterId: string,
  props: { text: string; category: CoreCategory; sourceTrigger: CoreTrigger },
): ComplexCoreEntry {
  const now = new Date().toISOString();
  return {
    id: `centry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    characterId,
    text: props.text.trim(),
    category: props.category,
    createdAt: now,
    sourceTrigger: props.sourceTrigger,
    active: true,
  };
}

async function nextVersion(characterId: string): Promise<number> {
  const snaps = await loadCoreSnapshots(characterId);
  return snaps.length === 0 ? 1 : Math.max(...snaps.map((s) => s.version)) + 1;
}

/** 写入一组条目 + 新快照（替换式：旧快照 isCurrent=false；镜像整体重放）。 */
async function commitCoreVersion(
  characterId: string,
  props: {
    trigger: CoreTrigger;
    note: string;
    entries: ComplexCoreEntry[];
    sourceMaterials?: string;
  },
): Promise<{ success: boolean; error?: string; version?: number }> {
  if (props.entries.length === 0) {
    return { success: false, error: "核心记忆条目为空，已拒绝入库" };
  }

  const version = await nextVersion(characterId);
  const now = new Date().toISOString();

  const snaps = await loadCoreSnapshots(characterId);
  for (const s of snaps) {
    if (s.isCurrent) await saveCoreSnapshot({ ...s, isCurrent: false });
  }

  await saveCoreEntries(props.entries);

  const snap: ComplexCoreSnapshot = {
    id: `cver_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    characterId,
    version,
    entryIds: props.entries.map((e) => e.id),
    note: props.note,
    trigger: props.trigger,
    // 生成该版本时的素材截断存储（供查看器回查「总结的原始记录」）
    sourceMaterials: props.sourceMaterials ? capSourceMaterials(props.sourceMaterials) : undefined,
    createdAt: now,
    isCurrent: true,
  };
  await saveCoreSnapshots([snap]);

  const activeEntries = props.entries.filter((e) => e.active);
  await mirrorCoreEntriesToFloat(characterId, activeEntries).catch((err) =>
    console.warn("[ComplexMemory] 核心记忆镜像 float 失败:", err),
  );

  console.log(`[ComplexMemory] 核心记忆 ${props.trigger} 生成成功: v${version}（${activeEntries.length} 条）`);
  return { success: true, version };
}

/** 生成一组条目（LLM 输出条目数组 → 逐条消毒）。 */
async function generateCoreEntries(
  characterId: string,
  characterName: string,
  trigger: CoreTrigger,
  existingCoreText: string,
  newMaterials: string,
  feedback: string,
): Promise<{ success: boolean; error?: string; entries?: ComplexCoreEntry[] }> {
  const config = loadComplexMemoryConfig();
  const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) return { success: false, error: "未配置复杂记忆生成 API" };

  const persona = getCharacter(characterId).persona;
  const ctx = buildGenerationContext(characterId);
  const template = config.prompts.core?.trim() || DEFAULT_PROMPTS.core;
  const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
    persona,
    personality: ctx.personality,
    rules: ctx.rules,
    userPersona: ctx.userPersona,
    worldContext: ctx.worldContext,
    existingCore: existingCoreText,
    newMaterials,
    banList: config.sanitizerBanList.join("、"),
    feedback,
  });

  const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], {
    temperature: 0.3,
    label: `复杂记忆·核心·${characterName}`,
  });
  if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };
  if (result.wasTruncated) return { success: false, error: "核心记忆生成疑似被截断，已取消入库" };

  const parsed = parseCoreEntriesJson(result.content);
  if (!parsed || parsed.length === 0) {
    return { success: false, error: "核心记忆条目标解析失败（需输出条目数组 JSON）" };
  }

  // 逐条消毒：被拦截条目单独丢弃，不废整版
  const blocked = parsed.filter((p) => !sanitizeCoreEntryText(p.text, config.sanitizerBanList));
  if (blocked.length > 0) {
    console.warn(`[ComplexMemory] 核心记忆 ${blocked.length} 条含禁用词被丢弃`);
  }
  const kept = parsed
    .filter((p) => sanitizeCoreEntryText(p.text, config.sanitizerBanList))
    .map((p) => newCoreEntry(characterId, { text: p.text, category: p.category, sourceTrigger: trigger }));

  if (kept.length === 0) {
    return { success: false, error: "核心记忆条目全部命中禁用词，已拒绝入库" };
  }
  return { success: true, entries: kept };
}

async function generateAndCommit(
  characterId: string,
  characterName: string,
  trigger: CoreTrigger,
  note: string,
  newMaterials: string,
  feedback = "",
): Promise<{ success: boolean; error?: string; version?: number }> {
  const view = await getCurrentCoreView(characterId);
  const res = await generateCoreEntries(
    characterId,
    characterName,
    trigger,
    view.text,
    newMaterials,
    feedback,
  );
  if (!res.success || !res.entries) return { success: false, error: res.error };
  return commitCoreVersion(characterId, {
    trigger,
    note: note || trigger,
    entries: res.entries,
    sourceMaterials: newMaterials,
  });
}

// ── bootstrap：首次启用生成 v1（无快照时；有存量整块则拆条） ──
export async function bootstrapCoreMemory(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string }> {
  const view = await getCurrentCoreView(characterId);
  if (view.snapshot) return { success: false, error: "核心记忆已存在（幂等）" };

  const legacy = await loadLegacyCores(characterId);
  if (legacy.length > 0) {
    return splitLegacyCoreMemory(characterId, characterName);
  }

  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const [{ loadEvents, loadDailies }, floatLongTerm] = await Promise.all([
      import("./storage"),
      loadMemoryEntriesByType(characterId, "long_term"),
    ]);
    const [events, dailies] = await Promise.all([loadEvents(characterId), loadDailies(characterId)]);
    const persona = getCharacter(characterId).persona;
    const materials: string[] = [];
    if (persona.trim()) materials.push(`[人设]\n${persona}`);
    for (const e of events) materials.push(`[事件 ${e.timestamp.slice(0, 10)}] ${e.content}`);
    for (const d of dailies) materials.push(`[日记 ${d.date}] ${d.content}`);
    for (const m of floatLongTerm) materials.push(`[长期记忆] ${m.content}`);
    const newMaterials = materials.slice(-40).join("\n\n");
    return await generateAndCommit(characterId, characterName, "bootstrap", "首次启用 bootstrap", newMaterials);
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 存量整块 → 条目拆解（一次性，LLM） ──
export async function splitLegacyCoreMemory(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  const legacy = await loadLegacyCores(characterId);
  if (legacy.length === 0) return { success: false, error: "无存量整块核心记忆可拆解" };
  const legacyContent = legacy[legacy.length - 1].content;
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const config = loadComplexMemoryConfig();
    const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
    if (!apiConfig) return { success: false, error: "未配置复杂记忆生成 API" };
    const prompt = renderMemoryPrompt(
      DEFAULT_PROMPTS.coreSplit,
      characterName,
      getUserName(characterId),
      {
        legacyContent,
        categoryDefs:
          "identity(身份认知) / bond(关系纽带) / principle(原则承诺) / milestone(里程碑事件)",
        banList: config.sanitizerBanList.join("、"),
      },
    );
    const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], {
      temperature: 0.2,
      label: `复杂记忆·核心拆条·${characterName}`,
    });
    if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };
    const parsed = parseCoreEntriesJson(result.content);
    if (!parsed || parsed.length === 0) {
      return { success: false, error: "核心拆条解析失败，请重试" };
    }
    const kept = parsed
      .filter((p) => sanitizeCoreEntryText(p.text, config.sanitizerBanList))
      .map((p) => newCoreEntry(characterId, { text: p.text, category: p.category, sourceTrigger: "bootstrap" }));
    if (kept.length === 0) return { success: false, error: "核心拆条全部命中禁用词" };
    const commit = await commitCoreVersion(characterId, {
      trigger: "bootstrap",
      note: "由存量整块核心记忆一次性拆条",
      entries: kept,
    });
    if (commit.success) {
      // 拆条成功后保留原整块记录（双轨可回退，不物理删除）
      console.log(`[ComplexMemory] 存量整块已拆条为 v${commit.version}`);
    }
    return commit;
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 定期重构：每 N 篇日记触发 ──
export async function rebuildCoreMemory(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string }> {
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const materials = await collectCoreMaterials(characterId);
    const result = await generateAndCommit(characterId, characterName, "scheduled", "定期重构", materials);
    if (result.success) {
      const { loadCharacterState, saveCharacterState } = await import("./config");
      const state = loadCharacterState(characterId);
      saveCharacterState({ ...state, dailyCountSinceCoreUpdate: 0 });
    }
    return result;
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 事件驱动微调：周期提炼完成后 ──
export async function fineTuneCoreMemory(
  characterId: string,
  characterName: string,
  periodTitle: string,
  periodSummary: string,
): Promise<{ success: boolean; error?: string }> {
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const newMaterials = `【周期「${periodTitle}」总结】\n${periodSummary}`;
    const result = await generateAndCommit(characterId, characterName, "period_driven", "周期提炼微调", newMaterials);
    return { success: result.success, error: result.error };
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 重新生成 + 改进意见 ──
export async function regenerateCoreWithFeedback(
  characterId: string,
  characterName: string,
  feedback: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  const trimmed = (feedback || "").trim();
  if (!trimmed) return { success: false, error: "请先输入改进意见" };
  return generateAndCommit(characterId, characterName, "manual", trimmed, "", trimmed);
}

// ── 一键回退到历史版本（回退动作本身生成新快照） ──
export async function rollbackCoreVersion(
  characterId: string,
  characterName: string,
  targetVersion: number,
): Promise<{ success: boolean; error?: string; version?: number }> {
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const snaps = await loadCoreSnapshots(characterId);
    const target = snaps.find((s) => s.version === targetVersion);
    if (!target) return { success: false, error: `未找到版本 v${targetVersion}` };
    if (target.isCurrent) return { success: false, error: `v${targetVersion} 已是当前版本` };

    const allEntries = await loadCoreEntries(characterId);
    const byId = new Map(allEntries.map((e) => [e.id, e]));
    const entries = target.entryIds.map((id) => byId.get(id)).filter((e): e is ComplexCoreEntry => !!e);
    if (entries.length === 0) return { success: false, error: `版本 v${targetVersion} 无可还原条目` };

    void characterName;
    const note = `回退自 v${targetVersion}`;
    return commitCoreVersion(characterId, { trigger: "manual", note, entries });
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 条目手动增删改（每次生成新快照） ──
async function commitFromCurrentEntrySet(
  characterId: string,
  characterName: string,
  nextEntries: ComplexCoreEntry[],
  note: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  void characterName;
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    return await commitCoreVersion(characterId, { trigger: "manual", note, entries: nextEntries });
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

export async function addCoreEntry(
  characterId: string,
  characterName: string,
  category: CoreCategory,
  text: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  const trimmed = text.trim();
  if (!trimmed) return { success: false, error: "条目内容为空" };
  if (!CORE_CATEGORIES.includes(category)) return { success: false, error: "未知条目分类" };
  const config = loadComplexMemoryConfig();
  if (!sanitizeCoreEntryText(trimmed, config.sanitizerBanList)) {
    return { success: false, error: "条目含禁用词" };
  }
  const view = await getCurrentCoreView(characterId);
  const next = [...view.activeEntries, newCoreEntry(characterId, { text: trimmed, category, sourceTrigger: "manual" })];
  return commitFromCurrentEntrySet(characterId, characterName, next, "手动新增条目");
}

export async function editCoreEntry(
  characterId: string,
  characterName: string,
  entryId: string,
  category: CoreCategory,
  text: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  const trimmed = text.trim();
  if (!trimmed) return { success: false, error: "条目内容为空" };
  const config = loadComplexMemoryConfig();
  if (!sanitizeCoreEntryText(trimmed, config.sanitizerBanList)) {
    return { success: false, error: "条目含禁用词" };
  }
  const view = await getCurrentCoreView(characterId);
  const old = view.activeEntries.find((e) => e.id === entryId);
  if (!old) return { success: false, error: "条目不存在" };
  const replaced = newCoreEntry(characterId, { text: trimmed, category, sourceTrigger: "manual" });
  const next = view.activeEntries
    .filter((e) => e.id !== entryId)
    .concat(replaced);
  return commitFromCurrentEntrySet(characterId, characterName, next, "编辑条目");
}

export async function deleteCoreEntry(
  characterId: string,
  characterName: string,
  entryId: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  const view = await getCurrentCoreView(characterId);
  if (!view.activeEntries.some((e) => e.id === entryId)) {
    return { success: false, error: "条目不存在" };
  }
  const next = view.activeEntries.filter((e) => e.id !== entryId);
  return commitFromCurrentEntrySet(characterId, characterName, next, "删除条目");
}

// ── 素材收集（定期重构 / 微调复用） ──
async function collectCoreMaterials(characterId: string): Promise<string> {
  // 注意：此处避免与 daily/period 模块形成强耦合，动态引用
  const { loadDailies, loadPeriods } = await import("./storage");
  const [dailies, periods] = await Promise.all([loadDailies(characterId), loadPeriods(characterId)]);
  const materials: string[] = [];
  for (const d of dailies.slice(-5)) materials.push(`[日记 ${d.date}] ${d.content}`);
  for (const p of periods.filter((x) => x.status !== "active").slice(-3)) {
    materials.push(`[周期 ${p.title}] ${p.summary}`);
  }
  // 历史条目作为增量合并素材（供 LLM 延续已有认知）
  const entries = await loadCoreEntries(characterId);
  const activeText = renderCoreEntriesText(entries.filter((e) => e.active).slice(-40));
  if (activeText.trim()) materials.push(`[既有核心记忆]\n${activeText}`);
  return materials.join("\n\n");
}