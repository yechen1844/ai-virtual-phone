// lib/complex-memory/event-generator.ts
// 复杂记忆系统 · L2 事件记忆生成与向量化。
// 读取水位线之后的时间线 → LLM 压缩为第一人称叙事 → 向量化 → 入库 → 镜像 float。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "../settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization } from "../short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "../memory-embedding";
import {
  acquireGenerationLock,
  releaseGenerationLock,
  loadComplexMemoryConfig,
  getRingBuffer,
  updateRingBuffer,
} from "./config";
import { renderMemoryPrompt, DEFAULT_PROMPTS } from "./prompts";
import { saveEvent } from "./storage";
import { mirrorEventToFloat } from "./mirror";
import type { ComplexEvent, EmotionVector } from "./types";

function getUserName(characterId: string): string {
  try {
    return resolveUserIdentity(characterId, "chat")?.name || "用户";
  } catch {
    return "用户";
  }
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

function parseEventJson(
  text: string,
): { content: string; emotion: EmotionVector; importanceScore: number } | null {
  const cleaned = text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const content = typeof obj.content === "string" ? obj.content.trim() : "";
    if (!content) return null;
    const emotionRaw = (obj.emotion ?? {}) as Record<string, unknown>;
    return {
      content,
      emotion: {
        valence: clampNum(emotionRaw.valence, -1, 1, 0),
        arousal: clampNum(emotionRaw.arousal, 0, 1, 0.5),
      },
      importanceScore: clampNum(obj.importanceScore, 0, 1, 0.5),
    };
  } catch {
    return null;
  }
}

export async function runEventGeneration(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string }> {
  const config = loadComplexMemoryConfig();

  if (!acquireGenerationLock(characterId, "event")) {
    return { success: false, error: "已有生成任务进行中" };
  }

  try {
    const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
    if (!apiConfig) {
      return { success: false, error: "未配置复杂记忆生成 API（辅助API绑定 → 复杂记忆生成）" };
    }

    const ring = getRingBuffer(characterId);
    const afterTimestamp = ring.watermarkTimestamp ?? undefined;
    const allEntries = loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined);

    if (allEntries.length < 4) {
      updateRingBuffer(characterId, { pendingCount: 0 });
      return { success: false, error: "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) {
      return { success: false, error: "格式化事件数据失败" };
    }

    const { eventsText, earliest, latest } = formatted;

    const template = config.prompts.event?.trim() || DEFAULT_PROMPTS.event;
    const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
      earliest,
      latest,
      eventCount: String(formatted.count),
      length: String(config.eventTargetLength),
      events: eventsText,
    });

    const result = await simpleLLMCall(
      apiConfig,
      [{ role: "user", content: prompt }],
      { temperature: 0.3, label: `复杂记忆·事件·${characterName}` },
    );
    if (!result.content) {
      return { success: false, error: result.error || "LLM 返回空内容" };
    }
    if (result.wasTruncated) {
      return { success: false, error: "事件生成疑似被截断，已取消入库" };
    }

    const parsed = parseEventJson(result.content);
    if (!parsed) {
      return { success: false, error: "事件 JSON 解析失败" };
    }

    let embedding: number[] | undefined;
    if (config.vectorRecallEnabled) {
      const embApi = resolveAuxiliaryApiConfig("embeddingApiConfigId");
      if (embApi && resolveEmbeddingModel(embApi)) {
        try {
          const emb = await generateEmbedding(parsed.content, embApi);
          if (emb) embedding = emb;
        } catch {
          /* 向量失败不阻断入库 */
        }
      }
    }

    const now = new Date().toISOString();
    const event: ComplexEvent = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      characterId,
      timestamp: latest,
      content: parsed.content,
      emotion: parsed.emotion,
      periodsRef: [],
      voltage: 1,
      importanceScore: parsed.importanceScore,
      embedding,
      lastAccessedAt: now,
      createdAt: now,
    };
    await saveEvent(event);

    if (config.mirrorToFloatEnabled) {
      await mirrorEventToFloat(event, { earliest, latest, entryCount: formatted.count });
    }

    updateRingBuffer(characterId, {
      watermarkEventId: allEntries[allEntries.length - 1].id,
      watermarkTimestamp: latest,
      pendingCount: 0,
    });

    console.log(`[ComplexMemory] 事件生成成功: ${formatted.count} 条时间线 → 1 条事件记忆`);
    return { success: true };
  } finally {
    releaseGenerationLock(characterId, "event");
  }
}
