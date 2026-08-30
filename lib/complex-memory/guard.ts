// lib/complex-memory/guard.ts
// 复杂记忆系统 · float 双守卫统一入口。
// 所有引擎的"活动计数"调用点统一走这里：
//   启用复杂记忆 → 记入 L1 环形缓冲（内部触发 L2 事件生成）；
//   未启用 → 维持 float 原计数与总结，行为与旧版完全一致。
// 非阻塞：内部 fire-and-forget，不等待 LLM，不抛错。

import { incrementEventCounter } from "../memory-storage";
import { maybeRunSummarization } from "../memory-summarizer";
import { isComplexMemoryEnabled, loadComplexMemoryConfig } from "./config";
import { recordEvents } from "./ring-buffer";
import { maybeTriggerDailySummary } from "./daily-generator";

export function recordCharacterActivity(
  characterId: string,
  characterName: string,
  count = 1,
  opts?: { trigger?: boolean },
): void {
  if (isComplexMemoryEnabled(characterId)) {
    // 自动总结开关：开启才把对话沉淀为事件记忆；关闭则复杂记忆不再自动生成事件。
    if (loadComplexMemoryConfig().autoSummarizeEnabled) {
      // 所有 app 都累加进同一个 count；
      // 但只有「主聊天」（trigger=true）才检查阈值触发事件总结 + 触发日记。
      // 副 app（阅读/朋友圈/游戏等）只累加、不触发——符合「阅读聊到200条不总结，主聊天+1才总结」的理想机制。
      recordEvents(characterId, characterName, count, opts?.trigger === true);
      if (opts?.trigger === true) {
        // 触发式日记：跨天（一天结束）时为该角色补生成「昨天」日记，不轮询；失败会标注供手动重生成。
        void maybeTriggerDailySummary(characterId, characterName).catch(() => {});
      }
    }
    return;
  }
  for (let i = 0; i < count; i++) {
    incrementEventCounter(characterId);
  }
  maybeRunSummarization(characterId, characterName).catch((err) => {
    console.warn("[ComplexMemory] float summarization check failed:", err);
  });
}
