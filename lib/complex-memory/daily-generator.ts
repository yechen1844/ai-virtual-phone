// lib/complex-memory/daily-generator.ts
// 复杂记忆系统 · L3 每日日记生成（补生成语义）+ 周期开合判定。
// 调度器每分钟检查：发现"最近已结束且有活动、日记未生成、已静默 X 分钟"的日期即补生成。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "../memory-embedding";
import {
  acquireGenerationLock,
  releaseGenerationLock,
  loadComplexMemoryConfig,
  loadCharacterState,
  saveCharacterState,
} from "./config";
import { renderMemoryPrompt, DEFAULT_PROMPTS } from "./prompts";
import {
  getCurrentCoreView,
  loadActivePeriods,
  loadEvents,
  saveDaily,
  savePeriod,
  getDaily,
  deleteDaily,
} from "./storage";
import { getUserName, dateString, dateFromTimestamp, extractJsonObject, clampNum, capSourceMaterials } from "./utils";
import { loadSourceTimeline } from "./source";
import { pushFeedAudit } from "./feed-audit";
import { buildGenerationContext } from "./context-builder";
import { distillPeriod } from "./period-distiller";
import { rebuildCoreMemory } from "./core-builder";
import type { ComplexDaily, ComplexPeriod, EmotionVector } from "./types";

type PeriodCheck = {
  newPeriods?: Array<{ title?: string; reason?: string }>;
  closedPeriods?: Array<{ periodId?: string; reason?: string }>;
  activePeriodIds?: string[];
};

type PeriodProgressItem = { periodId: string; progress: string };

type DailyParseResult = {
  diary: string;
  emotion: EmotionVector;
  periodCheck: PeriodCheck;
  periodProgress: PeriodProgressItem[];
};

/** 调度器入口：找到最近一个「已结束且有活动、日记未生成」的日期并补生成。
 *  跨天（昨天及更早）日期已结束，直接视为可补；静默条件只约束当天日记。 */
export async function maybeGenerateDaily(
  characterId: string,
  characterName: string,
): Promise<{ generated: boolean; error?: string }> {
  const timeline = loadSourceTimeline(characterId);

  const byDate = new Map<string, { lastTs: number }>();
  for (const e of timeline) {
    const d = dateFromTimestamp(e.timestamp);
    const rec = byDate.get(d);
    if (rec) {
      rec.lastTs = Math.max(rec.lastTs, new Date(e.timestamp).getTime());
    } else {
      byDate.set(d, { lastTs: new Date(e.timestamp).getTime() });
    }
  }
  if (byDate.size === 0) return { generated: false };

  // 只补「昨天」一个日期；且只在「昨天确实有新活动」时才补。
  // 绝不补很久以前的历史缺失（避免与迁移/手动冲突 + 疯狂生成无用记忆），也绝不碰最近没有任何新记录的角色。
  const yesterday = dateString(-1);
  const existing = await getDaily(characterId, yesterday);
  if (existing) return { generated: false };
  const rec = byDate.get(yesterday);
  if (!rec) return { generated: false };
  const result = await generateDaily(characterId, characterName, yesterday);
  if (!result.success) return { generated: false, error: result.error };
  return { generated: true };
}

export async function generateDaily(
  characterId: string,
  characterName: string,
  date: string,
  opts?: { suppressChain?: boolean; migrated?: boolean },
): Promise<{ success: boolean; error?: string }> {
  const config = loadComplexMemoryConfig();

  const existing = await getDaily(characterId, date);
  if (existing) return { success: false, error: "当日日记已存在（幂等）" };

  if (!acquireGenerationLock(characterId, "daily")) {
    return { success: false, error: "已有生成任务进行中" };
  }

  let outcome: { success: boolean; error?: string } = { success: false, error: "未知错误" };
  let closedPeriodIds: string[] = [];
  let shouldRebuildCore = false;

  try {
    const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
    if (!apiConfig) return { success: false, error: "未配置复杂记忆生成 API" };

    const dayTimeline = loadSourceTimeline(characterId, { full: true, date });
    const dayEvents = (await loadEvents(characterId)).filter((e) => dateFromTimestamp(e.timestamp) === date);
    const [core, activePeriods] = await Promise.all([getCurrentCoreView(characterId), loadActivePeriods(characterId)]);

    // 当日时间线直接展示原始聊天（标时间，不标成“事件”），让模型看清当天真实聊了什么；
    // 避免 1~3 条消息被 formatTimelineForSummarization 标成“- 事件:”后，模型误以为“只有事件记忆、没有实质聊天”而写不出日记。
    const timelineText = dayTimeline
      .map((e) => `- [${e.timestamp.slice(11, 16)}] ${e.content}`)
      .join("\n");
    const eventsText = dayEvents.map((e) => `- ${e.content}`).join("\n");
    const coreText = core.text;
    const periodsText = activePeriods.map((p) => `【${p.title}】(id: ${p.id}) ${p.startTime} 起${p.endTime ? `至 ${p.endTime}` : "至今"}：${p.summary}`).join("\n");
    const periodMainlines = activePeriods.map((p) => `【${p.title}】(id: ${p.id}) ${p.summary}`).join("\n");
    const ctx = buildGenerationContext(characterId);

    const template = config.prompts.daily?.trim() || DEFAULT_PROMPTS.daily;
    const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
      date,
      timeline: timelineText,
      events: eventsText,
      todayTimeline: timelineText,
      todayEvents: eventsText,
      coreMemory: coreText,
      activePeriods: periodsText,
      periodMainlines,
      persona: ctx.persona,
      personality: ctx.personality,
      rules: ctx.rules,
      userPersona: ctx.userPersona,
      worldContext: ctx.worldContext,
      length: String(config.dailyTargetLength),
      rollingAppendMax: String(config.rollingAppendMax),
    }, date);

    const result = await simpleLLMCall(
      apiConfig,
      [{ role: "user", content: prompt }],
      { temperature: 0.4, label: `复杂记忆·日记·${characterName}` },
    );
    // 投喂审计：记录本次日记生成实际发给模型的完整 prompt
    pushFeedAudit({
      characterId,
      characterName,
      kind: "daily",
      date,
      prompt,
      response: result.content ?? (result.error ?? ""),
      model: apiConfig.defaultModel,
    });
    if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };

    const parsed = parseDailyJson(result.content);
    if (!parsed) return { success: false, error: "日记 JSON 解析失败" };

    const periodResult = await applyPeriodCheck(characterId, date, parsed.periodCheck, activePeriods);
    await applyPeriodProgress(characterId, date, parsed.periodProgress);

    const now = new Date().toISOString();
    const daily: ComplexDaily = {
      id: `day_${characterId}_${date.replace(/-/g, "")}`,
      characterId,
      date,
      content: parsed.diary,
      belongsToPeriods: periodResult.belongsToPeriods,
      emotionVector: parsed.emotion,
      voltage: 1,
      // 原始素材截断存储（供查看器回查「总结的原始记录」）
      sourceMaterials: capSourceMaterials(
        [timelineText && `[当日时间线]\n${timelineText}`, eventsText && `[当日事件记忆]\n${eventsText}`]
          .filter(Boolean)
          .join("\n\n"),
      ),
      migrated: opts?.migrated === true ? true : undefined,
      lastAccessedAt: now,
      createdAt: now,
    };

    if (config.vectorRecallEnabled) {
      const embApi = resolveAuxiliaryApiConfig("embeddingApiConfigId");
      if (embApi && resolveEmbeddingModel(embApi)) {
        try {
          const emb = await generateEmbedding(parsed.diary, embApi);
          if (emb) daily.embedding = emb;
        } catch {
          /* 向量失败不阻断 */
        }
      }
    }

    await saveDaily(daily);

    const state = loadCharacterState(characterId);
    const newCount = (state.dailyCountSinceCoreUpdate ?? 0) + 1;
    saveCharacterState({
      ...state,
      lastDailyDate: date,
      dailyCountSinceCoreUpdate: newCount,
    });

    closedPeriodIds = periodResult.closedPeriodIds;
    // 核心双触发：日记数满 coreDailyInterval 篇触发定期重构（周期驱动微调由 period-distiller 的 fineTuneCoreMemory 负责）
    shouldRebuildCore = newCount >= config.coreDailyInterval;
    outcome = { success: true };

    console.log(`[ComplexMemory] 日记生成成功: ${date}`);
  } finally {
    releaseGenerationLock(characterId, "daily");
  }

  // 锁释放后再触发链式任务，避免与当前任务争抢互斥锁
  if (!opts?.suppressChain) {
    for (const pid of closedPeriodIds) {
      distillPeriod(characterId, characterName, pid).catch((err) =>
        console.warn("[ComplexMemory] 周期提炼失败:", pid, err),
      );
    }
    if (shouldRebuildCore) {
      rebuildCoreMemory(characterId, characterName).catch((err) =>
        console.warn("[ComplexMemory] 核心记忆定期重构失败:", err),
      );
    }
  }

  return outcome;
}

function parseDailyJson(text: string): DailyParseResult | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const diary = typeof obj.diary === "string" ? obj.diary.trim() : "";
    if (!diary) return null;
    const emo = (obj.emotion ?? {}) as Record<string, unknown>;
    const pc = (obj.periodCheck ?? {}) as Record<string, unknown>;
    const newPeriods = Array.isArray(pc.newPeriods)
      ? pc.newPeriods.map((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          return {
            title: typeof o.title === "string" ? o.title : "",
            reason: typeof o.reason === "string" ? o.reason : "",
          };
        })
      : [];
    const closedPeriods = Array.isArray(pc.closedPeriods)
      ? pc.closedPeriods.map((p) => {
          const o = (p ?? {}) as Record<string, unknown>;
          return {
            periodId: typeof o.periodId === "string" ? o.periodId : "",
            reason: typeof o.reason === "string" ? o.reason : "",
          };
        })
      : [];
    const activePeriodIds = Array.isArray(pc.activePeriodIds)
      ? pc.activePeriodIds.filter((x): x is string => typeof x === "string")
      : [];
    const pp = Array.isArray(obj.periodProgress) ? obj.periodProgress : [];
    const periodProgress: PeriodProgressItem[] = pp
      .map((item) => {
        const o = (item ?? {}) as Record<string, unknown>;
        return {
          periodId: typeof o.periodId === "string" ? o.periodId : "",
          progress: typeof o.progress === "string" ? o.progress.trim() : "",
        };
      })
      .filter((x) => x.periodId && x.progress);
    return {
      diary,
      emotion: {
        valence: clampNum(emo.valence, -1, 1, 0),
        arousal: clampNum(emo.arousal, 0, 1, 0.5),
      },
      periodCheck: { newPeriods, closedPeriods, activePeriodIds },
      periodProgress,
    };
  } catch {
    return null;
  }
}

/** 手动重新总结某一天的日记：删除旧日记后按当日时间线重新生成（自选日期重新总结）。 */
export async function regenerateDaily(
  characterId: string,
  characterName: string,
  date: string,
): Promise<{ success: boolean; error?: string }> {
  const existing = await getDaily(characterId, date);
  if (existing) await deleteDaily(existing.id);
  return generateDaily(characterId, characterName, date, { suppressChain: true });
}

/** 按日期范围总结：对范围内「有聊天记录」的每一天生成/重生成日记（用于按日期补生成缺失日记）。 */
export async function summarizeDailyRange(
  characterId: string,
  characterName: string,
  start?: string,
  end?: string,
): Promise<{ success: boolean; error?: string; generated: number; failedDates: string[] }> {
  const timeline = loadSourceTimeline(characterId, { full: true });
  const byDate = new Set<string>();
  for (const e of timeline) {
    const d = dateFromTimestamp(e.timestamp);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (start && d < start) continue;
    if (end && d > end) continue;
    byDate.add(d);
  }
  const dates = [...byDate].sort();
  let generated = 0;
  const failedDates: string[] = [];
  for (const d of dates) {
    const existing = await getDaily(characterId, d);
    const res = existing
      ? await regenerateDaily(characterId, characterName, d)
      : await generateDaily(characterId, characterName, d, { suppressChain: true });
    if (res.success || res.error === "当日日记已存在（幂等）") generated++;
    else failedDates.push(d);
  }
  return { success: true, generated, failedDates };
}

async function applyPeriodCheck(
  characterId: string,
  date: string,
  check: PeriodCheck,
  activePeriods: ComplexPeriod[],
): Promise<{ belongsToPeriods: string[]; closedPeriodIds: string[] }> {
  const belongsToPeriods = new Set<string>();
  const closedPeriodIds: string[] = [];

  for (const p of activePeriods) {
    if (check.activePeriodIds?.includes(p.id)) belongsToPeriods.add(p.id);
  }

  for (const np of check.newPeriods ?? []) {
    if (!np.title) continue;
    const now = new Date().toISOString();
    const period: ComplexPeriod = {
      id: `period_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      characterId,
      title: np.title,
      startTime: date,
      endTime: null,
      status: "active",
      summary: "",
      timelineIndex: {},
      associatedDates: [date],
      linkedPeriods: [],
      coveredEventIds: [],
      voltage: 1,
      lastAccessedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await savePeriod(period);
    belongsToPeriods.add(period.id);
  }

  for (const cp of check.closedPeriods ?? []) {
    if (!cp.periodId) continue;
    const p = activePeriods.find((x) => x.id === cp.periodId);
    if (p && p.endTime === null) {
      await savePeriod({ ...p, endTime: date, updatedAt: new Date().toISOString() });
      closedPeriodIds.push(p.id);
    }
  }

  return { belongsToPeriods: [...belongsToPeriods], closedPeriodIds };
}

/** 周期滚动累积：把 LLM 输出的「该周期今日进展」按日记日期戳追加进活跃周期 rollingSummary。 */
async function applyPeriodProgress(
  characterId: string,
  date: string,
  progress: PeriodProgressItem[],
): Promise<void> {
  if (progress.length === 0) return;
  const config = loadComplexMemoryConfig();
  const periods = await loadActivePeriods(characterId);
  for (const item of progress) {
    const p = periods.find((x) => x.id === item.periodId);
    if (!p || p.endTime !== null) continue;
    const stamp = `[${date}] ${item.progress}`;
    const prev = p.rollingSummary?.trim();
    const next = prev ? `${prev}\n${stamp}` : stamp;
    // 超出滚动累积上限时截断最旧段落，保持总量可控
    const lines = next.split("\n");
    let kept = lines;
    while (kept.join("\n").length > config.rollingAppendMax * 7) {
      kept = kept.slice(1);
    }
    await savePeriod({ ...p, rollingSummary: kept.join("\n"), updatedAt: new Date().toISOString() });
  }
}
