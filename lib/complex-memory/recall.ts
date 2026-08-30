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
  getCurrentCoreView,
  loadEvents,
  loadDailies,
  loadPeriods,
  saveEvent,
  saveDaily,
  savePeriod,
} from "./storage";
import { boostedVoltage } from "./voltage";
import { formatLocalDateTime } from "./utils";
import type {
  ComplexDaily,
  ComplexEvent,
  ComplexMemoryConfig,
  ComplexPeriod,
  EmotionVector,
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

// ── 轻量情绪探测（M5 情绪参与召回用，无外部依赖） ──
const POSITIVE_WORDS = [
  "开心","高兴","幸福","喜欢","爱","兴奋","期待","满意","笑","棒","好","不错",
  "感动","温暖","甜蜜","幸运","骄傲","快乐","愉快","满足","惊喜","谢谢","感谢","美好",
];
const NEGATIVE_WORDS = [
  "难过","伤心","生气","愤怒","烦","讨厌","失望","焦虑","害怕","哭","累","疲惫","崩溃",
  "失落","孤独","委屈","郁闷","沮丧","紧张","担心","不安","痛苦","想哭","恨","暴躁",
];
const HIGH_AROUSAL_WORDS = [
  "激动","兴奋","抓狂","大笑","哭","崩溃","尖叫","爆发","愤怒","狂喜","怒吼","震惊","兴奋",
];
const LOW_AROUSAL_WORDS = ["平静","安稳","无聊","安静","淡定","疲惫","困","麻木","放松","慵懒"];

/** 从文本中探测情绪向量（valence -1~1, arousal 0~1）。无法判断时返回零向量。 */
function detectEmotion(text: string): EmotionVector {
  let pos = 0;
  let neg = 0;
  for (const w of POSITIVE_WORDS) if (text.includes(w)) pos += 1;
  for (const w of NEGATIVE_WORDS) if (text.includes(w)) neg += 1;
  const total = pos + neg;
  const valence = total === 0 ? 0 : (pos - neg) / total;
  let high = 0;
  let low = 0;
  for (const w of HIGH_AROUSAL_WORDS) if (text.includes(w)) high += 1;
  for (const w of LOW_AROUSAL_WORDS) if (text.includes(w)) low += 1;
  const aTotal = high + low;
  const arousal = aTotal === 0 ? 0 : high / aTotal;
  return { valence, arousal };
}

/** 二维情绪向量余弦相似度（任一侧为零向量则 0）。 */
function emotionSimilarity(a: EmotionVector, b: EmotionVector): number {
  const dot = a.valence * b.valence + a.arousal * b.arousal;
  const magA = Math.hypot(a.valence, a.arousal);
  const magB = Math.hypot(b.valence, b.arousal);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

/** 每日记忆时间窗：近 full 天全额，full→floor 天线性衰减至底值。 */
function dailyTimeWindowWeight(date: string, config: ComplexMemoryConfig, now = Date.now()): number {
  const days = Math.max(0, (now - new Date(date).getTime()) / 86_400_000);
  if (days <= config.recallTimeWindowFullDays) return 1;
  if (days >= config.recallTimeWindowFloorDays) return config.recallTimeWindowFloor;
  const span = config.recallTimeWindowFloorDays - config.recallTimeWindowFullDays;
  const ratio = span > 0 ? (days - config.recallTimeWindowFullDays) / span : 1;
  return 1 - (1 - config.recallTimeWindowFloor) * ratio;
}

function formatEventLine(e: ComplexEvent): string {
  return `[${formatLocalDateTime(e.timestamp)}] ${e.content}`;
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
  return `[${kindLabel} ${formatLocalDateTime(item.timestamp)}] ${item.content}`;
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
  options?: { shortTermText?: string; skipRerank?: boolean; maxRecallEntries?: number },
): Promise<MemoryContextBundle> {
  const config = loadComplexMemoryConfig();

  const [core, events, dailies, periods] = await Promise.all([
    getCurrentCoreView(characterId),
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
  ]);

  // 已覆盖事件不再参与召回/固定注入：其内容已归纳进周期 summary，长期保留只会永久占用电压、
  // 导致「已覆盖却不删除」。这里统一在加载后剔除，供固定注入区与向量召回共用。
  const recallableEvents = events.filter((e) => !e.coveredByPeriod);

  // ① 固定注入区（硬性保留）：核心记忆已按 category 分组渲染（identity→bond→principle→milestone）
  const coreMemory = core.text;
  const fixedEvents = recallableEvents.slice(-config.fixedRecentEventCount).map(formatEventLine).join("\n");
  const yesterday = dailies.find((d) => d.date === dateString(-1));
  const yesterdayDaily = yesterday ? formatDailyLine(yesterday) : "";
  // 特殊日期固定注入：最近 N 篇被标记为特殊的日记优先生效
  const specialDailies = dailies
    .filter((d) => d.special === true)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, Math.max(0, config.fixedSpecialDateCount));
  const specialDateDailies = specialDailies.map(formatDailyLine).join("\n\n");
  const activePeriods = periods
    .filter((p) => p.status === "active")
    .map(formatPeriodLine)
    .join("\n\n");
  const fixedShortTerm = options?.shortTermText ?? "";

  // ② 向量召回（无 embedding API 时关键词退化）——只用未覆盖且未删除的事件
  let recalledItems = await vectorRecall(characterId, currentContext, config, { events: recallableEvents, dailies, periods });

  // 剔除与固定注入区重复的实体（最新事件/昨日日记/特殊日期日记/活跃周期已硬性注入）
  const fixedIds = new Set<string>([
    ...recallableEvents.slice(-config.fixedRecentEventCount).map((e) => e.id),
    ...(yesterday ? [yesterday.id] : []),
    ...specialDailies.map((d) => d.id),
    ...periods.filter((p) => p.status === "active").map((p) => p.id),
  ]);
  recalledItems = recalledItems.filter((item) => !fixedIds.has(item.id));

  // ④ 丝线联想：召回含日记时并入其归属周期 summary，由重排决定是否引入
  if (config.silkAssociationEnabled) {
    recalledItems = silkAssociate(recalledItems, periods);
  }

  // ③ 重排序（未配置重排序模型时按向量分截断；预览等只求看结果的场景可跳过，避免等一次 LLM 排序；
  //    非会话场景（自定义 app/阅读等）也跳过重排，且只放行最多 maxRecallEntries 条向量召回结果）
  const reranked = config.rerankEnabled && !options?.skipRerank
    ? await rerankCandidates(recalledItems, currentContext, coreMemory, characterName, config)
    : recalledItems.slice(0, options?.maxRecallEntries ?? config.rerankKeepMax);

  // 预算控制：固定注入区优先，召回区按得分从高到低填充
  const fixedTokens =
    estimateTokens(coreMemory) +
    estimateTokens(fixedShortTerm) +
    estimateTokens(fixedEvents) +
    estimateTokens(yesterdayDaily) +
    estimateTokens(specialDateDailies) +
    estimateTokens(activePeriods);
  const kept = trimRecalledToBudget(fixedTokens, reranked, config.totalInjectTokenBudget);

  const recalled = kept.map(formatRecallItem).join("\n\n");
  const tokenEstimate =
    fixedTokens + kept.reduce((sum, item) => sum + estimateTokens(item.content) + 8, 0);

  // 电压回升：所有被最终注入的实体 +0.1 并刷新 lastAccessedAt
  await boostInjected(characterId, { events: recallableEvents, dailies, periods, fixedEventCount: config.fixedRecentEventCount, yesterday, specialDailies, kept });

  return {
    coreMemory,
    fixedShortTerm,
    fixedEvents,
    yesterdayDaily,
    specialDateDailies,
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

  const candidates: Array<{ item: MemoryRecallItem; embedding?: number[]; emotion?: EmotionVector }> = [];
  for (const e of entities.events) {
    candidates.push({
      item: { kind: "event", id: e.id, characterId, timestamp: e.timestamp, content: e.content, score: 0, voltage: e.voltage, belongsToPeriods: e.periodsRef },
      embedding: e.embedding,
      emotion: e.emotion,
    });
  }
  for (const d of entities.dailies) {
    candidates.push({
      item: { kind: "daily", id: d.id, characterId, timestamp: d.date, content: d.content, score: 0, voltage: d.voltage, belongsToPeriods: d.belongsToPeriods },
      embedding: d.embedding,
      emotion: d.emotionVector,
    });
  }
  for (const p of entities.periods) {
    candidates.push({
      item: { kind: "period", id: p.id, characterId, timestamp: p.startTime, content: p.summary, score: 0, voltage: p.voltage },
      embedding: p.embedding,
    });
  }

  if (candidates.length === 0 || !currentContext.trim()) return [];

  // M5 情绪参与召回：探测当前上下文情绪，评分按 score × (1 + λ × 情绪相似度) 加权（周期无情绪向量，跳过）
  const ctxEmotion = detectEmotion(currentContext);
  const applyWeights = (scored: Array<{ item: MemoryRecallItem; score: number }>): MemoryRecallItem[] => {
    const weighted = scored.map((s) => {
      let score = s.score;
      const cand = candidates.find((c) => c.item.id === s.item.id);
      // 每日记忆时间窗：仅日记按时间降权（事件不受此窗，久远但关键的事件必须能召回）
      if (s.item.kind === "daily") {
        score *= dailyTimeWindowWeight(s.item.timestamp, config);
      }
      // 情绪加权
      if (cand?.emotion && (ctxEmotion.valence !== 0 || ctxEmotion.arousal !== 0)) {
        score *= 1 + config.emotionRecallLambda * emotionSimilarity(cand.emotion, ctxEmotion);
      }
      return { item: s.item, score };
    });
    weighted.sort((a, b) => b.score - a.score);
    return weighted.slice(0, config.recallTopK).map((s) => ({ ...s.item, score: s.score }));
  };

  if (embApi && resolveEmbeddingModel(embApi)) {
    const queryEmbedding = await generateEmbedding(currentContext, embApi);
    if (queryEmbedding) {
      const withEmb = candidates.filter((c) => c.embedding && c.embedding.length > 0);
      if (withEmb.length > 0) {
        const scored = withEmb.map((c) => ({ item: c.item, score: cosineSimilarity(queryEmbedding, c.embedding!) }));
        return applyWeights(scored);
      }
    }
  }

  const scored = candidates.map((c) => ({ item: c.item, score: keywordOverlapRatio(currentContext, c.item.content) }));
  return applyWeights(scored);
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

  // 重排优先用「复杂记忆重排序」专属配置；若未单独绑定则回退用「复杂记忆生成」配置
  // （用户通常把聊天模型绑定在这里），避免因没在重排专属槽位绑定而静默回退成纯向量排序，
  // 表现为"重排一直失败但其实根本没调用模型"。
  const apiConfig =
    resolveAuxiliaryApiConfig("complexRerankApiConfigId") ??
    resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) {
    console.warn("[ComplexMemory] 重排序未绑定任何聊天API，回退为向量评分排序");
    return fallback();
  }

  // 键兜底：重排序的整个副 API 调用都包进 try/catch，任何异常（网络/解析/格式）都回退到
  // 向量评分排序再注入，避免异常冒泡导致该轮复杂记忆整块丢失（固定注入 + 向量召回不受影响）。
  try {
    const candidatesText = candidates
    .map((c, i) => `${i + 1}. [${c.kind}] ${c.timestamp} ${c.content}`)
    .join("\n");

  // 修复：不再把候选/上下文/核心记忆硬截断到 150 / 1200 字，否则打分模型只看到残缺记忆，
  // 无法真正按相关性重排。候选已受 recallTopK 限制，此处给足全文，让打分基于完整内容判断。
  const template = config.prompts.rerank?.trim() || DEFAULT_PROMPTS.rerank;
  const prompt = renderMemoryPrompt(template, characterName, "", {
    candidates: candidatesText,
    context,
    coreMemory,
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
  } catch {
    return fallback();
  }
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
    specialDailies: ComplexDaily[];
    kept: MemoryRecallItem[];
  },
): Promise<void> {
  const now = Date.now();
  const boosts: Array<Promise<void>> = [];

  const fixedIds = new Set<string>();
  for (const e of deps.events.slice(-deps.fixedEventCount)) {
    fixedIds.add(e.id);
    const b = boostedVoltage(e, 0.1, { kind: "event", now });
    boosts.push(saveEvent({ ...e, ...b }));
  }
  if (deps.yesterday) {
    fixedIds.add(deps.yesterday.id);
    const b = boostedVoltage(deps.yesterday, 0.1, { kind: "daily", special: deps.yesterday.special === true, now });
    boosts.push(saveDaily({ ...deps.yesterday, ...b }));
  }
  for (const d of deps.specialDailies) {
    fixedIds.add(d.id);
    const b = boostedVoltage(d, 0.1, { kind: "daily", special: true, now });
    boosts.push(saveDaily({ ...d, ...b }));
  }
  for (const p of deps.periods.filter((x) => x.status === "active")) {
    fixedIds.add(p.id);
    const b = boostedVoltage(p, 0.1, { kind: "period", now });
    boosts.push(savePeriod({ ...p, ...b }));
  }

  for (const item of deps.kept) {
    if (fixedIds.has(item.id)) continue;
    if (item.kind === "event") {
      const e = deps.events.find((x) => x.id === item.id);
      if (e) {
        const b = boostedVoltage(e, 0.1, { kind: "event", now });
        boosts.push(saveEvent({ ...e, ...b }));
      }
    } else if (item.kind === "daily") {
      const d = deps.dailies.find((x) => x.id === item.id);
      if (d) {
        const b = boostedVoltage(d, 0.1, { kind: "daily", special: d.special === true, now });
        boosts.push(saveDaily({ ...d, ...b }));
      }
    } else if (item.kind === "period") {
      const p = deps.periods.find((x) => x.id === item.id);
      if (p) {
        const b = boostedVoltage(p, 0.1, { kind: "period", now });
        boosts.push(savePeriod({ ...p, ...b }));
      }
    }
  }

  await Promise.all(boosts);
}
