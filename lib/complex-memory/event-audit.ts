// lib/complex-memory/event-audit.ts
// 复杂记忆系统 · 事件记忆自动审计（只读）：
// 找出「有失败记录但后来没成功」「水位之后仍有可总结数据却没在跑」的时段，供 UI 一键补总结。
// 本模块绝不写水位线或任何状态。

import { loadCharacterState, loadComplexMemoryConfig } from "./config";
import { loadSourceTimeline } from "./source";
import { dateFromTimestamp, formatLocalDateTime } from "./utils";

export type EventAuditSource = "failed" | "backlog" | "window-skip";

export type EventAuditItem = {
  id: string;
  source: EventAuditSource;
  startTs: string;
  endTs: string;
  count: number;
  reason: string;
  suggestion: string;
  attempts?: number;
  at?: string;
};

/** 事件生成的最小素材条数（与 event-generator 保持一致）。 */
const MIN_EVENT_ENTRIES = 4;
/** 旧版单会话时间线窗口上限：积压超过它时，早期消息可能曾被静默跳过。 */
const LEGACY_TAIL_LIMIT = 1500;

/** 时段的人类可读区间（本地时间）。 */
export function formatAuditRange(item: Pick<EventAuditItem, "startTs" | "endTs">): string {
  const start = formatLocalDateTime(item.startTs);
  const end = formatLocalDateTime(item.endTs);
  return start === end ? start : `${start} ~ ${end}`;
}

/**
 * 审计事件记忆覆盖情况。只读，不修改水位线/失败记录。
 * 判据：
 *  1. 有失败记录、且水位线还没越过该时段（后来没成功）；
 *  2. 水位线之后仍有 >= 4 条可总结素材，且当前没有事件生成任务在跑；
 *  3. 积压超过旧版 1500 条窗口时，标注早期内容可能曾被跳过。
 */
export function auditEventCoverage(characterId: string): EventAuditItem[] {
  const config = loadComplexMemoryConfig();
  const state = loadCharacterState(characterId);
  const ring = state.ringBuffer;
  const watermark = ring.watermarkTimestamp;
  const timeline = loadSourceTimeline(characterId, {
    full: true,
    afterTimestamp: watermark ?? undefined,
  });
  const pending = watermark ? timeline.filter((e) => e.timestamp > watermark) : timeline;

  const items: EventAuditItem[] = [];

  for (const failed of state.failedEventRanges ?? []) {
    if (failed.count < MIN_EVENT_ENTRIES) continue;
    // 水位线已越过该时段 = 后来成功总结过，不算漏网。
    if (watermark && failed.endTs <= watermark) continue;
    items.push({
      id: failed.id,
      source: "failed",
      startTs: failed.startTs,
      endTs: failed.endTs,
      count: failed.count,
      reason: failed.reason,
      suggestion: "点「补上这段」重新总结这段对话",
      attempts: failed.attempts,
      at: failed.at,
    });
  }

  const locked = state.generationLock?.kind === "event";
  if (pending.length >= MIN_EVENT_ENTRIES && !locked) {
    const startDate = dateFromTimestamp(pending[0].timestamp);
    const sameDayFailure = items.find(
      (item) => item.source === "failed" && dateFromTimestamp(item.startTs) === startDate,
    );
    if (sameDayFailure) {
      // 失败后又来了新消息：合并成同一条，条数与结束时间跟随最新水位之后的素材。
      sameDayFailure.endTs = pending[pending.length - 1].timestamp;
      sameDayFailure.count = Math.max(sameDayFailure.count, pending.length);
    } else {
      const hugeBacklog = pending.length > LEGACY_TAIL_LIMIT;
      items.push({
        id: `audit_backlog_${characterId}_${startDate}`,
        source: hugeBacklog ? "window-skip" : "backlog",
        startTs: pending[0].timestamp,
        endTs: pending[pending.length - 1].timestamp,
        count: pending.length,
        reason: hugeBacklog
          ? `水位后有 ${pending.length} 条没总结；超过旧版单会话 1500 条窗口，更早的消息可能曾被静默跳过`
          : `水位后有 ${pending.length} 条聊天一直没总结`,
        suggestion: config.autoSummarizeEnabled
          ? "点「补上这段」立即总结"
          : "自动总结已关闭，点「补上这段」手动总结",
      });
    }
  }

  items.sort((a, b) => a.startTs.localeCompare(b.startTs));
  return items;
}
