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
import { getUserName, dateString, extractJsonObject } from "./utils";
import { runEraseScan } from "./voltage";
import { fineTuneCoreMemory } from "./core-builder";
import type { ComplexPeriod } from "./types";

export async function distillPeriod(
  characterId: string,
  characterName: string,
  periodId: string,
  opts?: { suppressChain?: boolean },
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
    const periodDailies = dailies.filter((d) => d.belongsToPeriods.includes(periodId));
    const periodEvents = events.filter((e) => e.periodsRef.includes(periodId));

    const dailiesText = periodDailies.map((d) => `[${d.date}] ${d.content}`).join("\n\n");
    const eventsText = periodEvents.map((e) => `[${e.timestamp.slice(0, 10)}] ${e.content}`).join("\n\n");

    const template = config.prompts.period?.trim() || DEFAULT_PROMPTS.period;
    const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
      title: period.title,
      startTime: period.startTime,
      endTime: period.endTime ?? dateString(0),
      dailies: dailiesText,
      events: eventsText,
    });

    const result = await simpleLLMCall(
      apiConfig,
      [{ role: "user", content: prompt }],
      { temperature: 0.3, label: `复杂记忆·周期·${characterName}` },
    );
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
