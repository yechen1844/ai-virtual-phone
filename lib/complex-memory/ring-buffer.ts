// lib/complex-memory/ring-buffer.ts
// 复杂记忆系统 · L1 逻辑环形缓冲：水位线管理、事件计数、触发 L2 事件生成。
// L1 无物理存储：素材本就持久化在各内容 app 数据库，这里只维护压缩水位线与累计计数。

import { loadComplexMemoryConfig, getRingBuffer, updateRingBuffer } from "./config";
import { runEventGeneration } from "./event-generator";

/** 进行中的生成任务（防并发重复触发） */
const generatingSet = new Set<string>();

/** 是否属于「等待更多素材」而非真正失败——这类不需要重试，等新对话自然再触发即可。 */
function isWaitForMore(error?: string): boolean {
  return !!error && error.includes("事件不足 4 条");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 记录角色新发生的活动（对话轮次等），累计到阈值后触发事件生成。
 * @param count 本轮新增事件数（单聊每轮 user+AI 各一条 = 2；群聊/其他 app 每轮 = 1）
 * 非阻塞：内部 fire-and-forget 触发生成，不等待 LLM。
 */
export function recordEvents(characterId: string, characterName: string, count: number, checkTrigger = true): void {
  const config = loadComplexMemoryConfig();
  const ring = getRingBuffer(characterId);
  const pendingCount = ring.pendingCount + count;
  updateRingBuffer(characterId, { pendingCount });
  console.log(`[ComplexMemory:DIAG] recordEvents 角色=${characterName} 本次+${count} → pendingCount=${pendingCount} 阈值=${config.eventTriggerCount} 检查=${checkTrigger} 触发=${checkTrigger && pendingCount >= config.eventTriggerCount && !generatingSet.has(characterId)}`);

  if (checkTrigger && pendingCount >= config.eventTriggerCount && !generatingSet.has(characterId)) {
    generatingSet.add(characterId);
    runEventGenerationWithRetry(characterId, characterName)
      .finally(() => generatingSet.delete(characterId));
  }
}

/**
 * 触发式事件生成：失败时按 retryCount 静默指数退避重试（800ms → 1600ms → 3200ms …）。
 * 重试期间保持 generatingSet 占用，避免并发重复触发；只重试真正失败，不重试「素材不足」。
 * 全部耗尽才给一次全局提示，避免每次失败都吵用户。
 */
async function runEventGenerationWithRetry(characterId: string, characterName: string): Promise<void> {
  const config = loadComplexMemoryConfig();
  const maxRetries = Math.max(0, config.retryCount || 0);

  for (let attempt = 0; ; attempt++) {
    let result: { success: boolean; error?: string } | null = null;
    let thrown: unknown = null;
    try {
      result = await runEventGeneration(characterId, characterName);
    } catch (err) {
      thrown = err;
    }

    const failedReason = result?.error ?? (thrown instanceof Error ? thrown.message : String(thrown ?? ""));
    if (result?.success) return;
    if (isWaitForMore(result?.error)) {
      // 素材不足：非法失败，等待新对话自然再次触发；静默返回即可
      return;
    }

    if (attempt >= maxRetries) {
      console.warn(`[ComplexMemory] 事件生成重试已耗尽（${maxRetries} 次）: ${characterName} ${failedReason}`);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("global-notice", { detail: `复杂记忆·事件生成多次重试仍失败（${characterName}）。请检查复杂记忆生成 API 配置。` }));
      }
      return;
    }

    const delay = 800 * Math.pow(2, attempt);
    console.warn(`[ComplexMemory] 事件生成失败（第 ${attempt + 1} 次），${Math.round(delay / 1000)}s 后静默重试: ${failedReason}`);
    await sleep(delay);
  }
}
