// lib/complex-memory/source.ts
// 复杂记忆系统 · 统一素材源入口。
// 所有生成环节（事件/日记/迁移）统一从这里取短期上下文素材，
// 内部完全复用 float 原生的 loadNativeTimeline + filterTimelineByAllowedSources，
// 并遵循同一份 shortTermAllowedSources 来源开关配置，保证两系统口径一致。

import {
  loadNativeTimeline,
  filterTimelineByAllowedSources,
  type NativeTimelineEntry,
} from "../short-term-assembler";
import { dateFromTimestamp } from "./utils";

export type SourceTimelineOptions = {
  /** 只取该时间戳之后的时间线（水位线语义） */
  afterTimestamp?: string;
  /** 只取某一天（YYYY-MM-DD）的时间线，用于日记/迁移 */
  date?: string;
  /** 完整模式：忽略 1500 条截断，读取全部消息（用于迁移/日记/事件/日期统计）。 */
  full?: boolean;
};

/**
 * 加载经过来源开关过滤的短期上下文时间线。
 * 与 float runSummarizationPipeline 完全同构：相同获取函数 + 相同来源开关。
 * 过滤掉来源（如小红书）后，float 与复杂记忆同步停止摄取该来源。
 */
export function loadSourceTimeline(
  characterId: string,
  options?: SourceTimelineOptions,
): NativeTimelineEntry[] {
  const raw = loadNativeTimeline(
    characterId,
    { afterTimestamp: options?.afterTimestamp, full: options?.full },
  );
  const timeline = filterTimelineByAllowedSources(raw);
  if (!options?.date) return timeline;
  return timeline.filter((e) => dateFromTimestamp(e.timestamp) === options.date);
}

/**
 * 取某一天的素材条数（用于迁移动态 token 估算 / 空日判定）。
 */
export function countSourceTimelineForDate(characterId: string, date: string): number {
  return loadSourceTimelineDate(characterId, date).length;
}

function loadSourceTimelineDate(characterId: string, date: string): NativeTimelineEntry[] {
  return loadNativeTimeline(characterId).filter((e) => dateFromTimestamp(e.timestamp) === date);
}