// lib/complex-memory/event-generator.ts
// 复杂记忆系统 · L2 事件记忆生成与向量化。
// 读取水位线之后的时间线 → LLM 压缩为第一人称叙事 → 向量化 → 入库 → 镜像 float。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "../settings-storage";
import { formatTimelineForSummarization, type NativeTimelineEntry } from "../short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "../memory-embedding";
import {
  acquireGenerationLock,
  releaseGenerationLock,
  loadComplexMemoryConfig,
  getRingBuffer,
  updateRingBuffer,
} from "./config";
import { ensureWatermarkAnchored } from "./watermark";
import { loadSourceTimeline } from "./source";
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

    // 水位线自愈锚定：首次生成前兜底，杜绝 null 全量回读吞历史（启用开关处已同步锚定）
    ensureWatermarkAnchored(characterId);

    const ring = getRingBuffer(characterId);
    const afterTimestamp = ring.watermarkTimestamp ?? undefined;
    const allEntries = loadSourceTimeline(characterId, {
      afterTimestamp: afterTimestamp ?? undefined,
    });

    if (allEntries.length < 4) {
      updateRingBuffer(characterId, { pendingCount: 0 });
      return { success: false, error: "事件不足 4 条" };
    }

    // 分窗生成：超过窗口上限按窗切分，逐窗生成一条事件、逐窗推进水位线。
    // 整段在互斥锁内串行执行，避免中途被打断造成窗口漏读。
    const windowSize = Math.max(20, config.eventWindowMaxEntries);
    const windows = sliceWindows(allEntries, windowSize);
    let generated = 0;

    for (const windowEntries of windows) {
      const event = await generateEventForWindow(
        characterId,
        characterName,
        config.eventTargetLength,
        windowEntries,
      );
      if (!event) {
        // 某一窗失败即停：已成功的前序窗已随各自水位线持久化，断点续跑天然成立
        console.warn(`[ComplexMemory] 第 ${generated + 1} 窗事件生成失败，停止后续窗口`);
        break;
      }

      const winLast = windowEntries[windowEntries.length - 1];
      updateRingBuffer(characterId, {
        watermarkEventId: winLast.id,
        watermarkTimestamp: winLast.timestamp,
      });
      generated += 1;
    }

    if (generated === 0) {
      updateRingBuffer(characterId, { pendingCount: 0 });
      return { success: false, error: "事件生成失败（无任何窗口产出）" };
    }

    updateRingBuffer(characterId, { pendingCount: 0 });
    console.log(
      `[ComplexMemory] 事件生成成功: ${allEntries.length} 条时间线 → ${generated} 条事件记忆（${windows.length} 窗）`,
    );
    return { success: true };
  } finally {
    releaseGenerationLock(characterId, "event");
  }
}

/** 按窗口上限切分（严格正序切分，不重叠）。 */
function sliceWindows(entries: NativeTimelineEntry[], size: number): NativeTimelineEntry[][] {
  const out: NativeTimelineEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    out.push(entries.slice(i, i + size));
  }
  return out;
}

/** 对单个窗口执行：格式化 → LLM → 解析 → 向量化 → 入库 → 镜像 float。失败返回 null。 */
async function generateEventForWindow(
  characterId: string,
  characterName: string,
  targetLength: number,
  windowEntries: NativeTimelineEntry[],
  opts?: { suppressMirror?: boolean },
): Promise<ComplexEvent | null> {
  const config = loadComplexMemoryConfig();
  const formatted = formatTimelineForSummarization(windowEntries);
  if (!formatted) return null;

  const { eventsText, earliest, latest } = formatted;
  const template = config.prompts.event?.trim() || DEFAULT_PROMPTS.event;
  const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
    earliest,
    latest,
    eventCount: String(formatted.count),
    length: String(targetLength),
    events: eventsText,
  });

  const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) return null;

  const result = await simpleLLMCall(
    apiConfig,
    [{ role: "user", content: prompt }],
    { temperature: 0.3, label: `复杂记忆·事件·${characterName}` },
  );
  if (!result.content) {
    console.warn("[ComplexMemory] 事件生成 LLM 返回空:", result.error);
    return null;
  }
  if (result.wasTruncated) return null;

  const parsed = parseEventJson(result.content);
  if (!parsed) return null;

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

  if (config.mirrorToFloatEnabled && !opts?.suppressMirror) {
    await mirrorEventToFloat(event, { earliest, latest, entryCount: formatted.count });
  }

  return event;
}

/**
 * 迁移用：按窗口索引生成单个事件窗口（全量时间线，从最早正向推进）。
 * 每窗一次 LLM 调用，返回下一窗索引与是否完成，天然支持断点续跑。
 * 迁移期间抑制 float 镜像，避免与既有 float 长期记忆重复。
 */
export async function generateEventWindow(
  characterId: string,
  characterName: string,
  windowIndex: number,
): Promise<{
  success: boolean;
  error?: string;
  totalWindows: number;
  nextIndex: number;
  done: boolean;
}> {
  const config = loadComplexMemoryConfig();
  const allEntries = loadSourceTimeline(characterId, {});
  if (allEntries.length < 4) {
    return { success: false, error: "事件不足 4 条", totalWindows: 0, nextIndex: windowIndex, done: true };
  }

  const windowSize = Math.max(20, config.eventWindowMaxEntries);
  const windows = sliceWindows(allEntries, windowSize);
  if (windowIndex >= windows.length) {
    return { success: true, totalWindows: windows.length, nextIndex: windows.length, done: true };
  }

  const event = await generateEventForWindow(
    characterId,
    characterName,
    config.eventTargetLength,
    windows[windowIndex],
    { suppressMirror: true },
  );
  if (!event) {
    return { success: false, error: "事件窗口生成失败", totalWindows: windows.length, nextIndex: windowIndex, done: false };
  }

  const nextIndex = windowIndex + 1;
  return { success: true, totalWindows: windows.length, nextIndex, done: nextIndex >= windows.length };
}
