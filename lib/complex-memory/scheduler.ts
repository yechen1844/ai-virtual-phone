// lib/complex-memory/scheduler.ts
// 复杂记忆系统 · 后台调度器。
// 复刻 diary-entry-timer-service 的 Web Worker 定时 + 页面可见性补偿模式，每分钟检查：
//   1. 日记补生成（跨天后首次活跃且静默 X 分钟）
//   2. 周期维护（重试未提炼的结束周期；stabilized 30 天无引用 → archived）
//   3. 电压落库（每天一次懒计算结果物理化 + 消磨扫描）

import { bgSetInterval } from "../bg-timer";
import { loadCharacters } from "../character-storage";
import { getEnabledCharacterIds, loadCharacterState } from "./config";
import { maybeGenerateDaily } from "./daily-generator";
import { runPeriodMaintenance } from "./period-distiller";
import { runVoltageMaintenance } from "./voltage";
import { getCurrentCore } from "./storage";

const CHECK_INTERVAL_MS = 60_000;
const VOLTAGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_COOLDOWN_MS = 10 * 60 * 1000;

let stopInterval: (() => void) | null = null;
let running = false;
const bootstrapCooldown = new Map<string, number>();

async function runSchedulerCheck(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const characterIds = getEnabledCharacterIds();
    if (characterIds.length === 0) return;

    const characters = loadCharacters();
    const nameById = new Map(characters.map((c) => [c.id, c.name]));

    for (const characterId of characterIds) {
      const characterName = nameById.get(characterId) ?? "角色";
      try {
        await maybeGenerateDaily(characterId, characterName);
      } catch (err) {
        console.warn("[ComplexMemory] 日记补生成失败:", characterId, err);
      }
      try {
        await runPeriodMaintenance(characterId, characterName);
      } catch (err) {
        console.warn("[ComplexMemory] 周期维护失败:", characterId, err);
      }
      await maybeBootstrapCore(characterId, characterName);
      await maybeRunVoltageMaintenance(characterId);
    }
  } finally {
    running = false;
  }
}

async function maybeBootstrapCore(characterId: string, characterName: string): Promise<void> {
  const now = Date.now();
  const last = bootstrapCooldown.get(characterId) ?? 0;
  if (now - last < BOOTSTRAP_COOLDOWN_MS) return;
  bootstrapCooldown.set(characterId, now);

  try {
    const core = await getCurrentCore(characterId);
    if (core) return;
    const { bootstrapCoreMemory } = await import("./core-builder");
    const result = await bootstrapCoreMemory(characterId, characterName);
    if (!result.success) {
      console.warn("[ComplexMemory] 核心记忆 bootstrap 未完成:", result.error);
    }
  } catch (err) {
    console.warn("[ComplexMemory] 核心记忆 bootstrap 失败:", characterId, err);
  }
}

async function maybeRunVoltageMaintenance(characterId: string): Promise<void> {
  const state = loadCharacterState(characterId);
  const last = state.lastVoltageRunAt ? new Date(state.lastVoltageRunAt).getTime() : 0;
  if (Date.now() - last < VOLTAGE_INTERVAL_MS) return;
  try {
    await runVoltageMaintenance(characterId);
  } catch (err) {
    console.warn("[ComplexMemory] 电压维护失败:", characterId, err);
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
