// lib/complex-memory/event-generator.ts
// 复杂记忆系统 · L2 事件记忆生成与向量化。
// 读取水位线之后的时间线 → LLM 压缩为第一人称叙事 → 向量化 → 入库 → 镜像 float。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { formatTimelineForSummarization, type NativeTimelineEntry } from "../short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "../memory-embedding";
import {
  acquireGenerationLock,
  releaseGenerationLock,
  loadComplexMemoryConfig,
  getRingBuffer,
  updateRingBuffer,
} from "./config";
import { buildGenerationContext } from "./context-builder";
import { ensureWatermarkAnchored } from "./watermark";
import { loadSourceTimeline } from "./source";
import { renderMemoryPrompt, DEFAULT_PROMPTS } from "./prompts";
import { saveEvent, getCurrentCoreView, loadActivePeriods, getDaily } from "./storage";
import { mirrorEventToFloat } from "./mirror";
import { pushFeedAudit } from "./feed-audit";
import { getUserName, capSourceMaterials, dateString, dateFromTimestamp, formatLocalDateTime } from "./utils";
import type { ComplexEvent, EmotionVector } from "./types";

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
    // 窗口条数 = 配置 eventWindowMaxEntries（加载时已钳制到 [20, 5000]，此处直接用配置值）。
    const windowSize = config.eventWindowMaxEntries;
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
      // 生成失败但素材充足：不再重置 pendingCount。
      // 否则失败一次就把计数清零，用户聊得再多也只显示很小的值，且 wm 不推进、今天永远无法被总结。
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

/** 给定日期（YYYY-MM-DD）的前一天（本地日期，避免 UTC 跨天偏差）。 */
function prevDateStr(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** 对单个窗口执行：格式化 → LLM → 解析 → 向量化 → 入库 → 镜像 float。失败返回 null。 */
async function generateEventForWindow(
  characterId: string,
  characterName: string,
  targetLength: number,
  windowEntries: NativeTimelineEntry[],
  opts?: { suppressMirror?: boolean; migrated?: boolean; contextDate?: string },
): Promise<ComplexEvent | null> {
  const config = loadComplexMemoryConfig();
  const formatted = formatTimelineForSummarization(windowEntries);
  if (!formatted) return null;

  // 注入参考上下文：人设/规则/user人设/世界观 + 核心记忆 + 活跃周期 + 昨日日记（与正常生成机制一致）
  const ctx = buildGenerationContext(characterId);
  const [coreView, activePeriods] = await Promise.all([
    getCurrentCoreView(characterId),
    loadActivePeriods(characterId),
  ]);
  const coreText = coreView.text;
  const periodsText = activePeriods.map((p) => `【${p.title}】${p.startTime} 起${p.endTime ? `至 ${p.endTime}` : "至今"}：${p.summary}`).join("\n");
  // 昨日日记：正常机制读真实日历昨天；迁移回放时读「窗口时间点的前一天」，保持与当时一致
  const yesterdayDaily = await getDaily(characterId, opts?.contextDate ? prevDateStr(opts.contextDate) : dateString(-1));

  const { eventsText, earliest, latest } = formatted;
  // 给模型看本地时间而非 UTC 尾缀 Z，避免模型把时间跨度写错/换算错位
  const localEarliest = formatLocalDateTime(earliest);
  const localLatest = formatLocalDateTime(latest);
  const template = config.prompts.event?.trim() || DEFAULT_PROMPTS.event;
  const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
    earliest: localEarliest,
    latest: localLatest,
    eventCount: String(formatted.count),
    length: String(targetLength),
    events: eventsText,
    persona: ctx.persona,
    personality: ctx.personality,
    rules: ctx.rules,
    userPersona: ctx.userPersona,
    worldContext: ctx.worldContext,
    coreMemory: coreText,
    activePeriods: periodsText,
    yesterdayDaily: yesterdayDaily?.content ?? "",
  }, opts?.contextDate);

  const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) return null;

  const result = await simpleLLMCall(
    apiConfig,
    [{ role: "user", content: prompt }],
    { temperature: 0.3, label: `复杂记忆·事件·${characterName}` },
  );
  // 投喂审计：记录本次事件生成实际发给模型的完整 prompt
  pushFeedAudit({
    characterId,
    characterName,
    kind: "event",
    date: opts?.contextDate ? dateFromTimestamp(opts.contextDate) : undefined,
    prompt,
    response: result.content ?? (result.error ?? ""),
    model: apiConfig.defaultModel,
  });
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
  // 事件时间戳归属：优先用窗口所属日期（迁移按日回放时为当天），否则取窗口最早素材日期。
  // 归一为本地日历日期（YYYY-MM-DD），避免 UTC 尾缀在 UI/过滤里错一天。
  const eventTimestamp = opts?.contextDate
    ? dateFromTimestamp(opts.contextDate)
    : dateFromTimestamp(earliest);
  const event: ComplexEvent = {
    // 事件 id 必须绝对唯一，否则同一毫秒内分窗生成的多个事件会因 id 相同互相覆盖，只剩最后一条。
    // 用「字符 id + 时间戳 + crypto 随机串」保证在同一毫秒多窗并发生成时也绝不撞。
    id: `evt_${characterId}_${Date.now()}_${(globalThis?.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)).replace(/-/g, "").slice(0, 12)}`,
    characterId,
    timestamp: eventTimestamp,
    content: parsed.content,
    emotion: parsed.emotion,
    periodsRef: [],
    voltage: 1,
    importanceScore: parsed.importanceScore,
    embedding,
    // 原始素材截断存储（供查看器回查「总结的原始记录」）
    sourceMaterials: capSourceMaterials(eventsText),
    migrated: opts?.migrated === true ? true : undefined,
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
/** 手动重新总结单条事件：基于该事件的原始素材重新提炼并替换内容（自选事件重新总结）。 */
export async function regenerateEvent(
  characterId: string,
  characterName: string,
  event: ComplexEvent,
): Promise<{ success: boolean; error?: string }> {
  const config = loadComplexMemoryConfig();
  const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) return { success: false, error: "未配置复杂记忆生成 API" };
  const material = event.sourceMaterials?.trim() || event.content;
  const prompt = `请把下面的原始素材重新提炼为一条约 ${config.eventTargetLength} 字的第一人称事件记忆，保留关键情节、情绪与延续性；只需输出事件正文，不要多余解释：\n\n【原始素材】\n${material}\n\n【现有事件(可参考可改写)】\n${event.content}`;
  const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], {
    temperature: 0.4,
    label: `复杂记忆·事件重写·${characterName}`,
  });
  if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };
  const content = result.content.trim();
  const updated: ComplexEvent = { ...event, content, lastAccessedAt: new Date().toISOString() };
  await saveEvent(updated);
  if (config.vectorRecallEnabled) {
    const embApi = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (embApi && resolveEmbeddingModel(embApi)) {
      try {
        const emb = await generateEmbedding(content, embApi);
        if (emb) await saveEvent({ ...updated, embedding: emb });
      } catch {
        /* 向量失败不阻断 */
      }
    }
  }
  return { success: true };
}

export async function generateEventWindow(
  characterId: string,
  characterName: string,
  windowIndex: number,
  opts?: { migrated?: boolean; date?: string },
): Promise<{
  success: boolean;
  error?: string;
  totalWindows: number;
  nextIndex: number;
  done: boolean;
}> {
  const config = loadComplexMemoryConfig();
  // 迁移按日回放：date 限定只读当天素材，杜绝跨日期窗口（7/21 内容被 8/15 污染）。
  // 正常增量生成（无 date）仍读水位线之后的全量，但窗口切分不受影响。
  const allEntries = loadSourceTimeline(characterId, { date: opts?.date, full: true });
  if (allEntries.length < 4) {
    return { success: false, error: "事件不足 4 条", totalWindows: 0, nextIndex: windowIndex, done: true };
  }

  const windowSize = config.eventWindowMaxEntries;
  const windows = sliceWindows(allEntries, windowSize);
  if (windowIndex >= windows.length) {
    return { success: true, totalWindows: windows.length, nextIndex: windows.length, done: true };
  }

  const contextDate = opts?.date ?? dateFromTimestamp(windows[windowIndex][windows[windowIndex].length - 1]?.timestamp);
  const event = await generateEventForWindow(
    characterId,
    characterName,
    config.eventTargetLength,
    windows[windowIndex],
    {
      suppressMirror: true,
      migrated: opts?.migrated === true,
      contextDate,
    },
  );
  if (!event) {
    return { success: false, error: "事件窗口生成失败", totalWindows: windows.length, nextIndex: windowIndex, done: false };
  }

  const nextIndex = windowIndex + 1;
  return { success: true, totalWindows: windows.length, nextIndex, done: nextIndex >= windows.length };
}
