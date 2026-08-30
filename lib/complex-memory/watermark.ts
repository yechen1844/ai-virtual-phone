// lib/complex-memory/watermark.ts
// 复杂记忆系统 · 水位线安全锚定。
// 修复 P0：水位线初始为 null 时，首次事件生成会用 < 4 条判定前就全量回读历史，
// 一次触发吞掉全部历史。锚定策略（计划书 D2）：
//   · 有历史时间线且水位线未设置 → 锚定到当前最新时间线，历史交给迁移流程回溯；
//   · 已锚定过 → 幂等跳过，保持既有的增量推进。

import { getRingBuffer, updateRingBuffer } from "./config";
import { loadSourceTimeline } from "./source";

/**
 * 幂等锚定水位线。若已锚定（watermarkTimestamp 非空）或素材为空则跳过。
 * 同步、无 LLM、无锁，可在启用开关时与事件生成前安全调用。
 */
export function ensureWatermarkAnchored(characterId: string): void {
  const ring = getRingBuffer(characterId);
  if (ring.watermarkTimestamp !== null || ring.watermarkEventId !== null) return;

  const timeline = loadSourceTimeline(characterId);
  if (timeline.length === 0) {
    // 时间线为空：锚定到「此刻」，此后新对话（时间戳 > now）才会被纳入自动总结。
    // 若此处不锚定，首次触发生成时才锚定到「当时最新」，会把开启后的首批对话一并吞掉、导致「聊了很多却不总结」。
    updateRingBuffer(characterId, {
      watermarkTimestamp: new Date().toISOString(),
      pendingCount: ring.pendingCount || 0,
    });
    return;
  }

  const last = timeline[timeline.length - 1];
  updateRingBuffer(characterId, {
    watermarkEventId: last.id,
    watermarkTimestamp: last.timestamp,
    pendingCount: ring.pendingCount || 0,
  });
  console.log(
    `[ComplexMemory] 水位线锚定到最新时间线 ${last.timestamp}（历史 ${timeline.length} 条交由迁移回溯）`,
  );
}