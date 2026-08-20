// lib/complex-memory/guard.ts
// 复杂记忆系统 · float 双守卫统一入口。
// 所有引擎的"活动计数"调用点统一走这里：
//   启用复杂记忆 → 记入 L1 环形缓冲（内部触发 L2 事件生成）；
//   未启用 → 维持 float 原计数与总结，行为与旧版完全一致。
// 非阻塞：内部 fire-and-forget，不等待 LLM，不抛错。

import { incrementEventCounter } from "../memory-storage";
import { maybeRunSummarization } from "../memory-summarizer";
import { isComplexMemoryEnabled } from "./config";
import { recordEvents } from "./ring-buffer";

export function recordCharacterActivity(
  characterId: string,
  characterName: string,
  count = 1,
): void {
  if (isComplexMemoryEnabled(characterId)) {
    recordEvents(characterId, characterName, count);
    return;
  }
  for (let i = 0; i < count; i++) {
    incrementEventCounter(characterId);
  }
  maybeRunSummarization(characterId, characterName).catch((err) => {
    console.warn("[ComplexMemory] float summarization check failed:", err);
  });
}
