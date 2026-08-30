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
      // 事件记忆（L2）只有「主聊天」（trigger=true）才检查阈值触发；副 app 只累加不触发。
      // 每日日记（L3）则是「跨天即总结、不看主聊天」：只要有任意 app 活动发生并进入新的一天，
      // 就为该角色补「昨天」日记。因此日记检查在 trigger 之外无条件执行。
      recordEvents(characterId, characterName, count, opts?.trigger === true);
      // 触发式日记：跨天（进入新的一天）即为该角色补生成「昨天」日记，不轮询、不依赖主聊天；失败会标注供手动重生成。
      void maybeTriggerDailySummary(characterId, characterName).catch(() => {});
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
