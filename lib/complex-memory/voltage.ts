// lib/complex-memory/voltage.ts
// 复杂记忆系统 · 电压懒计算、召回回升、每日落库与消磨扫描。
// 有效电压 = voltage × 0.98 ^ (idleHours / 24)；被召回注入时 +0.1 并刷新 lastAccessedAt。
// 消磨条件：effectiveVoltage < 阈值 且 coveredByPeriod 非空 → 删除事件 + 联动删除 float 镜像。

import { loadComplexMemoryConfig, loadCharacterState, saveCharacterState } from "./config";
import {
  loadEvents,
  loadDailies,
  loadPeriods,
  saveEvent,
  saveDaily,
  savePeriod,
  getPeriod,
  deleteEvent,
} from "./storage";
import { loadMemoryEntriesByType, deleteMemoryEntry } from "../memory-storage";

export type VoltageEntity = {
  voltage: number;
  lastAccessedAt: string;
};

export function effectiveVoltage(entity: VoltageEntity, now = Date.now()): number {
  const idleMs = now - new Date(entity.lastAccessedAt).getTime();
  const idleHours = idleMs > 0 ? idleMs / 3_600_000 : 0;
  const decayed = entity.voltage * Math.pow(0.98, idleHours / 24);
  return Math.max(0, Math.min(1, decayed));
}

export function boostedVoltage(
  entity: VoltageEntity,
  boost = 0.1,
  now = Date.now(),
): { voltage: number; lastAccessedAt: string } {
  return {
    voltage: Math.min(1, effectiveVoltage(entity, now) + boost),
    lastAccessedAt: new Date(now).toISOString(),
  };
}

/** 每日电压落库：把懒计算结果物理化，并执行消磨扫描。 */
export async function runVoltageMaintenance(characterId: string): Promise<void> {
  const state = loadCharacterState(characterId);
  const now = Date.now();

  const [events, dailies, periods] = await Promise.all([
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
  ]);

  const writes: Array<Promise<void>> = [];
  for (const e of events) {
    const v = effectiveVoltage(e, now);
    if (Math.abs(v - e.voltage) > 0.0001) writes.push(saveEvent({ ...e, voltage: v }));
  }
  for (const d of dailies) {
    const v = effectiveVoltage(d, now);
    if (Math.abs(v - d.voltage) > 0.0001) writes.push(saveDaily({ ...d, voltage: v }));
  }
  for (const p of periods) {
    const v = effectiveVoltage(p, now);
    if (Math.abs(v - p.voltage) > 0.0001) writes.push(savePeriod({ ...p, voltage: v }));
  }
  await Promise.all(writes);

  saveCharacterState({ ...state, lastVoltageRunAt: new Date(now).toISOString() });

  await runEraseScan(characterId);
}

/** 消磨扫描：covered 且低电压的事件删除，归属周期追加轻量指针，联动删除 float 镜像。 */
export async function runEraseScan(characterId: string, periodId?: string): Promise<void> {
  const config = loadComplexMemoryConfig();
  const events = await loadEvents(characterId);
  const now = Date.now();

  for (const e of events) {
    if (!e.coveredByPeriod) continue;
    if (periodId && e.coveredByPeriod !== periodId) continue;
    if (effectiveVoltage(e, now) >= config.voltageEraseThreshold) continue;

    const period = await getPeriod(e.coveredByPeriod);
    if (period) {
      const dayKey = e.timestamp.slice(0, 10);
      const pointer = `消磨: ${e.content.slice(0, 40)}${e.content.length > 40 ? "…" : ""}`;
      const existing = period.timelineIndex[dayKey] ?? "";
      await savePeriod({
        ...period,
        timelineIndex: { ...period.timelineIndex, [dayKey]: existing ? `${existing}\n${pointer}` : pointer },
        updatedAt: new Date(now).toISOString(),
      });
    }

    if (config.mirrorToFloatEnabled) {
      await deleteFloatMirror(characterId, e.id);
    }

    await deleteEvent(e.id);
  }
}

async function deleteFloatMirror(characterId: string, complexEventId: string): Promise<void> {
  try {
    const entries = await loadMemoryEntriesByType(characterId, "long_term");
    const target = entries.find((m) => m.metadata?.complexEventId === complexEventId);
    if (target) await deleteMemoryEntry(target.id);
  } catch (err) {
    console.warn("[ComplexMemory] 联动删除 float 镜像失败:", err);
  }
}
