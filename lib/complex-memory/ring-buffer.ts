// lib/complex-memory/ring-buffer.ts
// 复杂记忆系统 · L1 逻辑环形缓冲：水位线管理、事件计数、触发 L2 事件生成。
// L1 无物理存储：素材本就持久化在各内容 app 数据库，这里只维护压缩水位线与累计计数。

import { loadComplexMemoryConfig, getRingBuffer, updateRingBuffer } from "./config";
import { runEventGeneration } from "./event-generator";

/** 进行中的生成任务（防并发重复触发） */
const generatingSet = new Set<string>();

/**
 * 记录角色新发生的活动（对话轮次等），累计到阈值后触发事件生成。
 * @param count 本轮新增事件数（单聊每轮 user+AI 各一条 = 2；群聊/其他 app 每轮 = 1）
 * 非阻塞：内部 fire-and-forget 触发生成，不等待 LLM。
 */
export function recordEvents(characterId: string, characterName: string, count: number): void {
  const config = loadComplexMemoryConfig();
  const ring = getRingBuffer(characterId);
  const pendingCount = ring.pendingCount + count;
  updateRingBuffer(characterId, { pendingCount });

  if (pendingCount >= config.eventTriggerCount && !generatingSet.has(characterId)) {
    generatingSet.add(characterId);
    runEventGeneration(characterId, characterName)
      .then((r) => {
        if (r && !r.success && r.error) {
          console.warn("[ComplexMemory] 事件生成失败:", r.error);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("global-notice", { detail: `复杂记忆·事件生成失败：${r.error}` }));
          }
        }
      })
      .catch((err) => console.warn("[ComplexMemory] 事件生成失败(异常):", err))
      .finally(() => generatingSet.delete(characterId));
  }
}
