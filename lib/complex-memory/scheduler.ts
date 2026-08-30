// lib/complex-memory/scheduler.ts
// 复杂记忆系统 · 后台调度器 —— 仅保留「电压维护」（记忆衰减/消磨，非生成）。
// 日记/周期/核心 的生成已改为「触发式」：
//   · 事件记忆：活动驱动（聊天攒够触发）；
//   · 每日日记：跨天触发（一天结束、进入新的一天后，为在用角色补「昨天」日记）；
//   · 周期/核心：由日记生成链式触发。
// 因此不再每分钟轮询全角色生成（避免与一键迁移/自动总结互相污染、避免反复补无意义历史）。

import { bgSetInterval } from "../bg-timer";
import { loadCharacters } from "../character-storage";
import { getEnabledCharacterIds, loadCharacterState, loadComplexMemoryConfig } from "./config";
import { runVoltageMaintenance } from "./voltage";

const CHECK_INTERVAL_MS = 60_000;
const VOLTAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 复杂记忆调度失败上报事件：explorer 查看器监听后于页内展示。 */
export const COMPLEX_MEMORY_SCHEDULER_ERROR_EVENT = "complex-memory-scheduler-error";

let stopInterval: (() => void) | null = null;
let running = false;

function dispatchGlobalNotice(message: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("global-notice", { detail: message }));
  window.dispatchEvent(new CustomEvent(COMPLEX_MEMORY_SCHEDULER_ERROR_EVENT, { detail: message }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TaskResult = { ok: boolean; error?: string };

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

async function runVoltageCheck(characterId: string): Promise<void> {
  const state = loadCharacterState(characterId);
  const last = state.lastVoltageRunAt ? new Date(state.lastVoltageRunAt).getTime() : 0;
  if (Date.now() - last < VOLTAGE_INTERVAL_MS) return;
  await runVoltageMaintenance(characterId);
}

async function workerLoop(queue: string[], nameById: Map<string, string>): Promise<void> {
  while (queue.length > 0) {
    const characterId = queue.shift()!;
    const characterName = nameById.get(characterId) ?? "角色";
    await runTaskWithRetry(characterName, "电压维护", async () => {
      await runVoltageCheck(characterId);
      return { ok: true };
    });
  }
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
