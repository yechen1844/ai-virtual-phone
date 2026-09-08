// lib/complex-memory/voltage.ts
// 复杂记忆系统 · 电压懒计算、召回回升、每日落库与消磨扫描。
// 分层衰减（M5）：有效电压 = voltage × factor ^ (idleHours / 24)。
//   event → eventDecayFactor(0.94 快) ；period → periodDecayFactor(0.995 慢)；
//   daily → special ? specialDateDecayFactor(0.995 周期级) : voltageDecayFactor(0.98)。
// 被召回注入时 +0.1 并刷新 lastAccessedAt。
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
import { dateFromTimestamp } from "./utils";

export type VoltageEntity = {
  voltage: number;
  lastAccessedAt: string;
};

export type VoltageDecayKind = "event" | "daily" | "period";

export type VoltageOpts = {
  kind?: VoltageDecayKind;
  special?: boolean;
  now?: number;
};

function decayFactorOf(kind: VoltageDecayKind, special: boolean): number {
  const config = loadComplexMemoryConfig();
  if (kind === "event") return config.eventDecayFactor;
  if (kind === "period") return config.periodDecayFactor;
  return special ? config.specialDateDecayFactor : config.voltageDecayFactor;
}

export function effectiveVoltage(entity: VoltageEntity, opts?: VoltageOpts): number {
  const kind = opts?.kind ?? "daily";
  const now = opts?.now ?? Date.now();
  const idleMs = now - new Date(entity.lastAccessedAt).getTime();
  const idleHours = idleMs > 0 ? idleMs / 3_600_000 : 0;
  let factor = decayFactorOf(kind, opts?.special ?? false);
  // 迁移产物半衰减（M7）：迁移是瞬间回放、没有正常召回机制对抗衰减，
  // 衰减因子向 1 靠拢一半（如 0.98 → 0.99），减少失真但保留衰减。
  if ((entity as { migrated?: boolean }).migrated) factor = 1 - (1 - factor) / 2;
  const decayed = entity.voltage * Math.pow(factor, idleHours / 24);

  // 记忆保护期：保护期内（默认 90 天）电压衰减不低于下限（默认 0.5），
  // 保证三个月内的记忆始终保有基础活性、可被正常召回且不会进入消磨删除。
  // 超过保护期后从下限起按原衰减速率继续衰减（数学上连续，无跳崖）。
  const config = loadComplexMemoryConfig();
  const floor = config.voltageFloor;
  const floorDays = config.voltageFloorDays;
  let eff = decayed;
  if (floor > 0 && floorDays > 0) {
    const idleDays = idleHours / 24;
    if (idleDays <= floorDays) {
      eff = Math.max(floor, decayed);
    } else {
      eff = floor * Math.pow(factor, idleDays - floorDays);
    }
  }
  return Math.max(0, Math.min(1, eff));
}

export function boostedVoltage(entity: VoltageEntity, boost: number, opts?: VoltageOpts): { voltage: number; lastAccessedAt: string } {
  const now = opts?.now ?? Date.now();
  return {
    voltage: Math.min(1, effectiveVoltage(entity, { ...opts, now }) + boost),
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
  // 关键修复（双重衰减）：物理化衰减结果时必须同步把 lastAccessedAt 刷新到本次维护时刻。
  // 否则下次维护仍从旧 lastAccessedAt 起算闲置时长，把「从上次访问至今」的完整衰减因子
  // 又乘一遍，电压会逐日指数雪崩（0.157 → 0.022 → 0.003…），这正是「电压低得离谱」的根源。
  const stampedNow = new Date(now).toISOString();
  for (const e of events) {
    const v = effectiveVoltage(e, { kind: "event", now });
    if (Math.abs(v - e.voltage) > 0.0001) writes.push(saveEvent({ ...e, voltage: v, lastAccessedAt: stampedNow }));
  }
  for (const d of dailies) {
    const v = effectiveVoltage(d, { kind: "daily", special: d.special === true, now });
    if (Math.abs(v - d.voltage) > 0.0001) writes.push(saveDaily({ ...d, voltage: v, lastAccessedAt: stampedNow }));
  }
  for (const p of periods) {
    const v = effectiveVoltage(p, { kind: "period", now });
    if (Math.abs(v - p.voltage) > 0.0001) writes.push(savePeriod({ ...p, voltage: v, lastAccessedAt: stampedNow }));
  }
  await Promise.all(writes);

  saveCharacterState({ ...state, lastVoltageRunAt: new Date(now).toISOString() });

  await runEraseScan(characterId);
}

/**
 * 一键补电：把该角色所有电压不足 floor（默认 0.6）的记忆（事件/日记/周期）统一拉到 floor，
 * 并刷新 lastAccessedAt 使新电压立即生效（否则懒计算会立刻按旧基准衰减回去）。
 * 返回各类型实际补电条数，供 UI 提示。
 */
export async function rechargeCharacterVoltage(
  characterId: string,
  floor = 0.6,
): Promise<{ events: number; dailies: number; periods: number }> {
  const now = new Date().toISOString();
  const [events, dailies, periods] = await Promise.all([
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
  ]);

  const writes: Array<Promise<void>> = [];
  let eventCount = 0;
  let dailyCount = 0;
  let periodCount = 0;
  for (const e of events) {
    if (e.voltage >= floor) continue;
    eventCount += 1;
    writes.push(saveEvent({ ...e, voltage: floor, lastAccessedAt: now }));
  }
  for (const d of dailies) {
    if (d.voltage >= floor) continue;
    dailyCount += 1;
    writes.push(saveDaily({ ...d, voltage: floor, lastAccessedAt: now }));
  }
  for (const p of periods) {
    if (p.voltage >= floor) continue;
    periodCount += 1;
    writes.push(savePeriod({ ...p, voltage: floor, lastAccessedAt: now }));
  }
  await Promise.all(writes);
  return { events: eventCount, dailies: dailyCount, periods: periodCount };
}

/** 消磨扫描：covered 且低电压的事件删除，归属周期追加轻量指针，联动删除 float 镜像。 */
export async function runEraseScan(characterId: string, periodId?: string): Promise<void> {
  const config = loadComplexMemoryConfig();
  const events = await loadEvents(characterId);
  const now = Date.now();

  for (const e of events) {
    if (!e.coveredByPeriod) continue;
    if (periodId && e.coveredByPeriod !== periodId) continue;
    if (effectiveVoltage(e, { kind: "event", now }) >= config.voltageEraseThreshold) continue;

    const period = await getPeriod(e.coveredByPeriod);
    if (period) {
      const dayKey = dateFromTimestamp(e.timestamp);
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
