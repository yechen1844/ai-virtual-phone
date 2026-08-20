// lib/complex-memory/scheduler.ts
// 复杂记忆系统 · 后台调度器。
// 复刻 diary-entry-timer-service 的 Web Worker 定时 + 页面可见性补偿模式，每分钟检查：
//   1. 日记补生成（跨天即补；当天需静默 X 分钟）
//   2. 周期维护（重试未提炼的结束周期；stabilized 30 天无引用 → archived）
//   3. 核心记忆 bootstrap / 定期重构检查
//   4. 电压落库（每天一次懒计算结果物理化 + 消磨扫描）
// 全角色并行检查（并发上限 maxParallel 防限流）；任务失败先静默重试（指数退避），
// 仍失败则弹窗报错（复用应用全局通知机制），绝不静默跳过。

import { bgSetInterval } from "../bg-timer";
import { loadCharacters } from "../character-storage";
import { getEnabledCharacterIds, loadCharacterState, loadComplexMemoryConfig } from "./config";
import { maybeGenerateDaily } from "./daily-generator";
import { runPeriodMaintenance } from "./period-distiller";
import { runVoltageMaintenance } from "./voltage";
import { getCurrentCoreView } from "./storage";

const CHECK_INTERVAL_MS = 60_000;
const VOLTAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_COOLDOWN_MS = 10 * 60 * 1000;

/** 复杂记忆调度失败上报事件：explorer 查看器监听后于页内展示。 */
export const COMPLEX_MEMORY_SCHEDULER_ERROR_EVENT = "complex-memory-scheduler-error";

let stopInterval: (() => void) | null = null;
let running = false;
const bootstrapCooldown = new Map<string, number>();

function dispatchGlobalNotice(message: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("global-notice", { detail: message }));
  window.dispatchEvent(new CustomEvent(COMPLEX_MEMORY_SCHEDULER_ERROR_EVENT, { detail: message }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TaskResult = { ok: boolean; error?: string };

/** 任务执行：失败先静默重试（指数退避），仍失败则弹窗报错，绝不静默跳过。 */
async function runTaskWithRetry(
  characterName: string,
  label: string,
  task: () => Promise<TaskResult>,
): Promise<void> {
  const config = loadComplexMemoryConfig();
  const retries = Math.max(0, config.retryCount);
  let lastError = "未知错误";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await task();
      if (result.ok) return;
      lastError = result.error || "未知错误";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < retries) {
      await sleep(500 * 2 ** attempt);
    }
  }
  const msg = `复杂记忆·${characterName}·${label}失败：${lastError}`;
  console.warn(`[ComplexMemory] ${msg}`);
  dispatchGlobalNotice(msg);
}

async function runCharacterTasks(characterId: string, characterName: string): Promise<void> {
  // 迁移驱动：状态为 running 时确保后台驱动循环存在（页面刷新/切换后自动恢复推进，幂等）
  await runTaskWithRetry(characterName, "迁移驱动", async () => {
    const { getMigrationState, driveMigration } = await import("./migration");
    const ms = getMigrationState(characterId);
    if (ms?.status === "running") {
      void driveMigration(characterId, characterName);
    }
    return { ok: true };
  });
  await runTaskWithRetry(characterName, "日记补生成", async () => {
    const r = await maybeGenerateDaily(characterId, characterName);
    return { ok: r.generated || !r.error, error: r.error };
  });
  await runTaskWithRetry(characterName, "周期维护", async () => {
    await runPeriodMaintenance(characterId, characterName);
    return { ok: true };
  });
  await runTaskWithRetry(characterName, "核心记忆检查", async () => {
    await maybeBootstrapCore(characterId, characterName);
    return { ok: true };
  });
  await runTaskWithRetry(characterName, "电压维护", async () => {
    await maybeRunVoltageMaintenance(characterId);
    return { ok: true };
  });
}

async function runSchedulerCheck(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const characterIds = getEnabledCharacterIds();
    if (characterIds.length === 0) return;

    const characters = loadCharacters();
    const nameById = new Map(characters.map((c) => [c.id, c.name]));
    const config = loadComplexMemoryConfig();
    const maxParallel = Math.max(1, config.maxParallel);

    // 全角色并行检查：并发上限防限流；轮询期间新触发不丢弃，状态持久化下轮自然拾取
    const queue = characterIds.slice();
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(maxParallel, queue.length); i++) {
      workers.push(workerLoop(queue, nameById));
    }
    await Promise.all(workers);
  } finally {
    running = false;
  }
}

async function workerLoop(queue: string[], nameById: Map<string, string>): Promise<void> {
  while (queue.length > 0) {
    const characterId = queue.shift()!;
    const characterName = nameById.get(characterId) ?? "角色";
    await runCharacterTasks(characterId, characterName);
  }
}

async function maybeBootstrapCore(characterId: string, characterName: string): Promise<void> {
  const now = Date.now();
  const last = bootstrapCooldown.get(characterId) ?? 0;
  if (now - last < BOOTSTRAP_COOLDOWN_MS) return;
  bootstrapCooldown.set(characterId, now);

  const core = await getCurrentCoreView(characterId);
  if (core.snapshot) return;
  const { bootstrapCoreMemory } = await import("./core-builder");
  const result = await bootstrapCoreMemory(characterId, characterName);
  if (!result.success) {
    throw new Error(result.error || "bootstrap 未完成");
  }
}

async function maybeRunVoltageMaintenance(characterId: string): Promise<void> {
  const state = loadCharacterState(characterId);
  const last = state.lastVoltageRunAt ? new Date(state.lastVoltageRunAt).getTime() : 0;
  if (Date.now() - last < VOLTAGE_INTERVAL_MS) return;
  await runVoltageMaintenance(characterId);
}

function handleVisibilityChange(): void {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  void runSchedulerCheck();
}

export function startComplexMemoryScheduler(): void {
  if (typeof window === "undefined" || stopInterval) return;
  stopInterval = bgSetInterval(() => {
    void runSchedulerCheck();
  }, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  void runSchedulerCheck();
}

export function stopComplexMemoryScheduler(): void {
  if (stopInterval) {
    stopInterval();
    stopInterval = null;
  }
  if (typeof window === "undefined") return;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
}
