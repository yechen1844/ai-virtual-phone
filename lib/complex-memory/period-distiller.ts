// lib/complex-memory/period-distiller.ts
// 复杂记忆系统 · L4 周期提炼与维护。
// 周期被判定结束后：生成 summary + timeline_index，置 stabilized，标记 coveredEventIds，消磨低电压事件。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "../memory-embedding";
import {
  acquireGenerationLock,
  releaseGenerationLock,
  loadComplexMemoryConfig,
} from "./config";
import { renderMemoryPrompt, DEFAULT_PROMPTS } from "./prompts";
import {
  getPeriod,
  loadDailies,
  loadEvents,
  loadPeriods,
  saveEvent,
  savePeriod,
} from "./storage";
import { getUserName, dateString, dateFromTimestamp, extractJsonObject, capSourceMaterials } from "./utils";
import { pushFeedAudit } from "./feed-audit";
import { runEraseScan } from "./voltage";
import { fineTuneCoreMemory } from "./core-builder";
import type { ComplexDaily, ComplexPeriod } from "./types";

export async function distillPeriod(
  characterId: string,
  characterName: string,
  periodId: string,
  opts?: { suppressChain?: boolean; userBrief?: string; migrated?: boolean },
): Promise<{ success: boolean; error?: string }> {
  const config = loadComplexMemoryConfig();
  const period = await getPeriod(periodId);
  if (!period) return { success: false, error: "周期不存在" };
  if (period.status === "archived") return { success: false, error: "周期已归档" };

  if (!acquireGenerationLock(characterId, "period")) {
    return { success: false, error: "已有生成任务进行中" };
  }

  let outcome: { success: boolean; error?: string } = { success: false, error: "未知错误" };
  let fineTune: { title: string; summary: string } | null = null;

  try {
    const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
    if (!apiConfig) return { success: false, error: "未配置复杂记忆生成 API" };

    const [dailies, events] = await Promise.all([loadDailies(characterId), loadEvents(characterId)]);
    const coverageSet = new Set(buildPeriodCoverage(period, dailies));
    const periodDailies = dailies.filter((d) => d.belongsToPeriods.includes(periodId) || coverageSet.has(d.date));
    const periodEvents = events.filter((e) => e.periodsRef.includes(periodId) || coverageSet.has(String(e.timestamp).slice(0, 10)));

    const dailiesText = periodDailies.map((d) => `[${d.date}] ${d.content}`).join("\n\n");
    const eventsText = periodEvents.map((e) => `[${dateFromTimestamp(e.timestamp)}] ${e.content}`).join("\n\n");
    const rollingSummary = period.rollingSummary?.trim() || "（无滚动累积，以下为关联日记与事件全文）";
    const durationDays = Math.max(1, Math.round((new Date(period.endTime ?? dateString(0)).getTime() - new Date(period.startTime).getTime()) / 86_400_000) + 1);

    const template = config.prompts.period?.trim() || DEFAULT_PROMPTS.period;
    let prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
      title: period.title,
      startTime: period.startTime,
      endTime: period.endTime ?? dateString(0),
      durationDays: String(durationDays),
      rollingSummary,
      periodDairies: dailiesText,
      events: eventsText,
    });
    // 手动总结：用户补充主线作为额外素材注入
    if (opts?.userBrief?.trim()) {
      prompt += `\n\n【用户补充主线】\n${opts.userBrief.trim()}`;
    }

    const result = await simpleLLMCall(
      apiConfig,
      [{ role: "user", content: prompt }],
      { temperature: 0.3, label: `复杂记忆·周期·${characterName}` },
    );
    // 投喂审计：记录本次周期提炼实际发给模型的完整 prompt
    pushFeedAudit({
      characterId,
      characterName,
      kind: "period",
      date: period.endTime ?? undefined,
      prompt,
      response: result.content ?? (result.error ?? ""),
      model: apiConfig.defaultModel,
    });
    if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };

    const parsed = parsePeriodJson(result.content);
    if (!parsed) return { success: false, error: "周期 JSON 解析失败" };

    const now = new Date().toISOString();
    const updated: ComplexPeriod = {
      ...period,
      summary: parsed.summary,
      timelineIndex: parsed.timelineIndex,
      status: "stabilized",
      coveredEventIds: periodEvents.map((e) => e.id),
      // 原始素材截断存储（供查看器回查「总结的原始记录」）
      sourceMaterials: capSourceMaterials(
        [rollingSummary.startsWith("（无滚动累积") ? "" : `[滚动累积]\n${rollingSummary}`, dailiesText && `[关联日记]\n${dailiesText}`, eventsText && `[关联事件]\n${eventsText}`]
          .filter(Boolean)
          .join("\n\n"),
      ),
      migrated: opts?.migrated === true ? true : undefined,
      updatedAt: now,
    };
    await savePeriod(updated);

    for (const e of periodEvents) {
      if (e.coveredByPeriod !== periodId) {
        await saveEvent({ ...e, coveredByPeriod: periodId });
      }
    }

    if (config.vectorRecallEnabled && !updated.embedding) {
      const embApi = resolveAuxiliaryApiConfig("embeddingApiConfigId");
      if (embApi && resolveEmbeddingModel(embApi)) {
        try {
          const emb = await generateEmbedding(parsed.summary, embApi);
          if (emb) await savePeriod({ ...updated, embedding: emb });
        } catch {
          /* 向量失败不阻断 */
        }
      }
    }

    await runEraseScan(characterId, periodId);

    fineTune = { title: period.title, summary: parsed.summary };
    outcome = { success: true };

    console.log(`[ComplexMemory] 周期提炼成功: ${period.title}`);
  } finally {
    releaseGenerationLock(characterId, "period");
  }

  // 锁释放后再触发核心记忆微调，避免与当前任务争抢互斥锁
  if (fineTune && !opts?.suppressChain) {
    fineTuneCoreMemory(characterId, characterName, fineTune.title, fineTune.summary).catch((err) =>
      console.warn("[ComplexMemory] 核心记忆微调失败:", fineTune?.title, err),
    );
  }

  return outcome;
}

/** 周期提炼素材覆盖日期：优先用已关联日期；未关联时回退到周期起止范围内有日记的日期（活跃期只取到今天，避免误取未来）。 */
function buildPeriodCoverage(period: ComplexPeriod, dailies: ComplexDaily[]): string[] {
  const set = new Set<string>(period.associatedDates ?? []);
  const start = period.startTime;
  const end = period.endTime;
  const today = dateString(0);
  for (const d of dailies) {
    if (d.date < start) continue;
    if (end) {
      if (d.date <= end) set.add(d.date);
    } else {
      // 活跃期（未结束）：只取 start ~ 今天，避免误取未来/遥远日期
      if (d.date <= today) set.add(d.date);
    }
  }
  return [...set].sort();
}

function parsePeriodJson(text: string): { summary: string; timelineIndex: Record<string, string> } | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    if (!summary) return null;
    const ti = (obj.timelineIndex ?? {}) as Record<string, unknown>;
    const timelineIndex: Record<string, string> = {};
    for (const [k, v] of Object.entries(ti)) {
      if (typeof v === "string") timelineIndex[k] = v;
    }
    return { summary, timelineIndex };
  } catch {
    return null;
  }
}

/** 周期维护：重试未提炼的结束周期；stabilized 且 30 天无再引用 → archived。 */
export async function runPeriodMaintenance(characterId: string, characterName: string): Promise<void> {
  const periods = await loadPeriods(characterId);
  const now = Date.now();

  for (const p of periods) {
    if (p.endTime !== null && p.status === "active") {
      distillPeriod(characterId, characterName, p.id).catch((err) =>
        console.warn("[ComplexMemory] 周期提炼重试失败:", p.id, err),
      );
      continue;
    }
    if (p.status === "stabilized") {
      const daysSince = (now - new Date(p.updatedAt).getTime()) / 86_400_000;
      if (daysSince >= 30) {
        await savePeriod({ ...p, status: "archived", updatedAt: new Date(now).toISOString() });
      }
    }
  }
}

// ── 周期手动化：手动创建骨架周期（M6） ──
export async function createPeriodManual(
  characterId: string,
  title: string,
  startTime: string,
  endTime?: string | null,
  opts?: { dates?: string[]; timeline?: Record<string, string> },
): Promise<{ success: boolean; error?: string; periodId?: string }> {
  if (!title.trim()) return { success: false, error: "周期标题不能为空" };
  if (!startTime) return { success: false, error: "起始日期不能为空" };
  const now = new Date().toISOString();
  const dates = opts?.dates?.length ? opts.dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [startTime];
  const period: ComplexPeriod = {
    id: `period_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    characterId,
    title: title.trim(),
    startTime,
    endTime: endTime || null,
    status: "active",
    summary: "",
    timelineIndex: opts?.timeline ?? {},
    associatedDates: dates,
    linkedPeriods: [],
    coveredEventIds: [],
    voltage: 1,
    lastAccessedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await savePeriod(period);
  return { success: true, periodId: period.id };
}
