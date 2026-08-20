// lib/complex-memory/daily-generator.ts
// 复杂记忆系统 · L3 每日日记生成（补生成语义）+ 周期开合判定。
// 调度器每分钟检查：发现"最近已结束且有活动、日记未生成、已静默 X 分钟"的日期即补生成。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization } from "../short-term-assembler";
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
} from "./storage";
import { getUserName, dateString, extractJsonObject, clampNum } from "./utils";
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
  const config = loadComplexMemoryConfig();
  const today = dateString(0);
  const timeline = loadNativeTimeline(characterId);

  const byDate = new Map<string, { lastTs: number }>();
  for (const e of timeline) {
    const d = e.timestamp.slice(0, 10);
    const rec = byDate.get(d);
    if (rec) {
      rec.lastTs = Math.max(rec.lastTs, new Date(e.timestamp).getTime());
    } else {
      byDate.set(d, { lastTs: new Date(e.timestamp).getTime() });
    }
  }
  if (byDate.size === 0) return { generated: false };

  const dates = [...byDate.keys()].sort().reverse();
  const quietMs = config.dailyQuietMinutes * 60_000;
  for (const d of dates) {
    const existing = await getDaily(characterId, d);
    if (existing) continue;
    const rec = byDate.get(d)!;
    // 静默条件只约束当天：跨天日期已结束，直接视为可补
    if (d === today && Date.now() - rec.lastTs < quietMs) continue;
    const result = await generateDaily(characterId, characterName, d);
    if (!result.success) return { generated: false, error: result.error };
    return { generated: true };
  }
  return { generated: false };
}

export async function generateDaily(
  characterId: string,
  characterName: string,
  date: string,
  opts?: { suppressChain?: boolean },
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

    const dayTimeline = loadNativeTimeline(characterId).filter((e) => e.timestamp.slice(0, 10) === date);
    const dayEvents = (await loadEvents(characterId)).filter((e) => e.timestamp.slice(0, 10) === date);
    const [core, activePeriods] = await Promise.all([getCurrentCoreView(characterId), loadActivePeriods(characterId)]);

    const timelineText = formatTimelineForSummarization(dayTimeline)?.eventsText ?? "";
    const eventsText = dayEvents.map((e) => `- ${e.content}`).join("\n");
    const coreText = core.text;
    const periodsText = activePeriods.map((p) => `【${p.title}】${p.summary}`).join("\n");

    const template = config.prompts.daily?.trim() || DEFAULT_PROMPTS.daily;
    const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
      date,
      timeline: timelineText,
      events: eventsText,
      todayTimeline: timelineText,
      todayEvents: eventsText,
      coreMemory: coreText,
      activePeriods: periodsText,
      length: String(config.dailyTargetLength),
      rollingAppendMax: String(config.rollingAppendMax),
    });

    const result = await simpleLLMCall(
      apiConfig,
      [{ role: "user", content: prompt }],
      { temperature: 0.4, label: `复杂记忆·日记·${characterName}` },
    );
    if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };

    const parsed = parseDailyJson(result.content);
    if (!parsed) return { success: false, error: "日记 JSON 解析失败" };

    const periodResult = await applyPeriodCheck(characterId, date, parsed.periodCheck, activePeriods);
    await applyPeriodProgress(characterId, date, parsed.periodProgress);

    const now = new Date().toISOString();
    const daily: ComplexDaily = {
      id: `day_${date.replace(/-/g, "")}`,
      characterId,
      date,
      content: parsed.diary,
      belongsToPeriods: periodResult.belongsToPeriods,
      emotionVector: parsed.emotion,
      voltage: 1,
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
