// lib/complex-memory/migration.ts
// 复杂记忆系统 · 一键迁移（双向）+ 外部导入占位。
// 原生 → 复杂：events（从最早分窗生成事件）→ dailies（从近到远补日记）→ distill（提炼周期）
//             → core（条目化 bootstrap）→ legacy（旧 float 压缩为历史沉淀周期）→ done。
// 复杂 → 原生：一键导出，核心条目写 float core、事件与周期总结写 float long_term。
// 迁移作为可中断的后台任务执行：断点存于角色 state 键，随时续跑。

import { loadNativeTimeline } from "../short-term-assembler";
import { loadMemoryEntriesByType } from "../memory-storage";
import { estimateTokens } from "../token-counter";
import { loadComplexMemoryConfig, loadCharacterState, saveCharacterState } from "./config";
import { generateDaily } from "./daily-generator";
import { distillPeriod } from "./period-distiller";
import { bootstrapCoreMemory } from "./core-builder";
import { generateEventWindow } from "./event-generator";
import { mirrorCoreEntriesToFloat, mirrorEventToFloat, mirrorPeriodToFloat } from "./mirror";
import {
  getCurrentCoreView,
  countCores,
  loadDailies,
  loadEvents,
  loadPeriods,
  savePeriod,
} from "./storage";
import { dateString } from "./utils";
import type {
  ComplexPeriod,
  ExternalImportPayload,
  MigrationReport,
  MigrationState,
} from "./types";

// 单页内并发防护：迁移步骤逐条执行，避免双击/重复调度并发跑。
let running = false;

const ESTIMATE_PERIOD_FIXED = 1500; // 每个周期提炼固定开销
const ESTIMATE_CORE_FIXED = 2000;   // 核心 bootstrap 固定开销

export function getMigrationState(characterId: string): MigrationState | null {
  return loadCharacterState(characterId).migration ?? null;
}

/** 动态 token 估算：基于真实时间线条数，替换固定 1400/天。 */
export function estimateMigration(characterId: string, days: number): number {
  const dates = computeDates(characterId, days);
  const timeline = loadNativeTimeline(characterId);
  const config = loadComplexMemoryConfig();
  const windowSize = Math.max(20, config.eventWindowMaxEntries);

  // 事件：全量时间线 ÷ 窗口上限 × 单窗输入输出均值
  const joined = timeline.map((e) => e.content ?? "").join("\n");
  const totalInputTokens = estimateTokens(joined);
  const numWindows = Math.max(1, Math.ceil(timeline.length / windowSize));
  const perWindowInput = totalInputTokens / numWindows;
  const perWindowOutput = config.eventTargetLength * 1.5;
  const eventsTokens = numWindows * (perWindowInput + perWindowOutput);

  // 日记：逐日素材实测 + 输出
  let dailiesTokens = 0;
  for (const date of dates) {
    const dayText = timeline
      .filter((e) => e.timestamp.slice(0, 10) === date)
      .map((e) => e.content ?? "")
      .join("\n");
    dailiesTokens += estimateTokens(dayText) + config.dailyTargetLength * 1.5;
  }

  // 周期与核心：按篇数 × 固定系数
  const periodCount = dates.length > 0 ? Math.ceil(dates.length / 7) : 0;
  const periodsTokens = periodCount * ESTIMATE_PERIOD_FIXED;
  const coreTokens = ESTIMATE_CORE_FIXED;

  return Math.round(eventsTokens + dailiesTokens + periodsTokens + coreTokens);
}

/** 启动迁移：计算回溯日期（从近到远），落断点，返回预估 token。 */
export async function startMigration(
  characterId: string,
  characterName: string,
  days: number,
  force = false,
): Promise<{ success: boolean; error?: string; estimate?: number }> {
  const existing = getMigrationState(characterId);
  if (existing && !force) {
    if (existing.status === "running" || existing.status === "paused") {
      return { success: false, error: "已有迁移任务进行中，可继续或重置后重来" };
    }
  }

  const dates = computeDates(characterId, days);
  const timeline = loadNativeTimeline(characterId);
  if (dates.length === 0 && timeline.length < 4) {
    return { success: false, error: "该角色没有可回溯的聊天/时间线历史" };
  }

  const estimate = estimateMigration(characterId, days);
  const now = new Date().toISOString();
  const state: MigrationState = {
    status: "running",
    phase: "events",
    dates,
    totalDays: dates.length,
    doneDays: 0,
    currentDate: null,
    eventWindowIndex: 0,
    startedAt: now,
    updatedAt: now,
    tokenEstimate: estimate,
  };
  const cs = loadCharacterState(characterId);
  saveCharacterState({ ...cs, migration: state });
  return { success: true, estimate };
}

export function pauseMigration(characterId: string): void {
  const state = getMigrationState(characterId);
  if (!state || state.status !== "running") return;
  saveCharacterState({
    ...loadCharacterState(characterId),
    migration: { ...state, status: "paused", updatedAt: new Date().toISOString() },
  });
}

export function resumeMigration(characterId: string): void {
  const state = getMigrationState(characterId);
  if (!state || state.status !== "paused") return;
  saveCharacterState({
    ...loadCharacterState(characterId),
    migration: { ...state, status: "running", updatedAt: new Date().toISOString() },
  });
}

export function resetMigration(characterId: string): void {
  const state = getMigrationState(characterId);
  if (!state) return;
  const cs = loadCharacterState(characterId);
  const { migration: _drop, ...rest } = cs;
  void _drop;
  saveCharacterState(rest);
}

/** 执行一步迁移：events 单窗 → 单日日记 → 单周期提炼 → core → legacy → done。 */
export async function runMigrationStep(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string; done?: boolean; state?: MigrationState }> {
  if (running) return { success: false, error: "迁移步骤执行中" };
  const state = getMigrationState(characterId);
  if (!state) return { success: false, error: "尚未启动迁移" };
  if (state.status !== "running") {
    return { success: false, error: state.status === "paused" ? "迁移已暂停" : "迁移已结束" };
  }

  running = true;
  try {
    const next = await executeStep(characterId, characterName, state);
    const cs = loadCharacterState(characterId);
    saveCharacterState({ ...cs, migration: next });
    return { success: true, done: next.status === "done", state: next };
  } catch (err) {
    const failed: MigrationState = {
      ...state,
      status: "paused",
      error: err instanceof Error ? err.message : String(err),
      updatedAt: new Date().toISOString(),
    };
    const cs = loadCharacterState(characterId);
    saveCharacterState({ ...cs, migration: failed });
    return { success: false, error: failed.error };
  } finally {
    running = false;
  }
}

async function executeStep(
  characterId: string,
  characterName: string,
  state: MigrationState,
): Promise<MigrationState> {
  const now = new Date().toISOString();
  const base = { ...state, updatedAt: now };

  switch (state.phase) {
    case "events": {
      const windowIndex = state.eventWindowIndex ?? 0;
      const res = await generateEventWindow(characterId, characterName, windowIndex);
      if (!res.success) {
        if (res.error === "事件不足 4 条") {
          // 无足够历史，跳过事件阶段直接进入日记
          return { ...base, phase: "dailies" };
        }
        throw new Error(res.error ?? "事件窗口生成失败");
      }
      if (res.done) {
        return { ...base, phase: "dailies", eventWindowIndex: res.nextIndex };
      }
      return {
        ...base,
        eventWindowIndex: res.nextIndex,
        currentDate: `事件窗 ${res.nextIndex}/${res.totalWindows}`,
      };
    }
    case "dailies": {
      const dates = [...state.dates];
      if (dates.length === 0) return { ...base, phase: "distill" };
      const date = dates[0];
      const res = await generateDaily(characterId, characterName, date, { suppressChain: true });
      const remaining = dates.slice(1);
      const failedDates = [...(state.failedDates ?? [])];
      if (!res.success && res.error !== "当日日记已存在（幂等）") {
        failedDates.push(date);
      }
      return {
        ...base,
        phase: remaining.length === 0 ? "distill" : "dailies",
        dates: remaining,
        doneDays: state.doneDays + 1,
        currentDate: date,
        failedDates,
      };
    }
    case "distill": {
      const periods = await loadPeriods(characterId);
      const pending = periods.find((p) => p.endTime !== null && p.status === "active");
      if (pending) {
        await distillPeriod(characterId, characterName, pending.id, { suppressChain: true });
        return { ...base, currentDate: pending.title };
      }
      return { ...base, phase: "core" };
    }
    case "core": {
      const view = await getCurrentCoreView(characterId);
      if (!view.snapshot) {
        await bootstrapCoreMemory(characterId, characterName);
      }
      return { ...base, phase: "legacy" };
    }
    case "legacy": {
      await createLegacyPeriod(characterId);
      return { ...base, phase: "done" };
    }
    case "done": {
      const report = await buildReport(characterId, state);
      return { ...base, status: "done", report };
    }
    default:
      return base;
  }
}

/** 单独重跑某个失败日期（从 failedDates 移除后重新生成当日日记）。 */
export async function retryFailedDate(
  characterId: string,
  characterName: string,
  date: string,
): Promise<{ success: boolean; error?: string }> {
  const state = getMigrationState(characterId);
  if (!state) return { success: false, error: "尚未启动迁移" };
  const res = await generateDaily(characterId, characterName, date, { suppressChain: true });
  if (!res.success && res.error !== "当日日记已存在（幂等）") {
    return { success: false, error: res.error ?? "重跑失败" };
  }
  const failedDates = (state.failedDates ?? []).filter((d) => d !== date);
  const cs = loadCharacterState(characterId);
  saveCharacterState({
    ...cs,
    migration: { ...state, failedDates, updatedAt: new Date().toISOString() },
  });
  return { success: true };
}

/** 复杂 → 原生：核心条目写 float core、事件与周期总结写 float long_term。 */
export async function exportToFloat(
  characterId: string,
): Promise<{ success: boolean; error?: string; counts?: { cores: number; events: number; periods: number } }> {
  const view = await getCurrentCoreView(characterId);
  if (view.activeEntries.length > 0) {
    await mirrorCoreEntriesToFloat(characterId, view.activeEntries);
  }

  const [events, periods] = await Promise.all([loadEvents(characterId), loadPeriods(characterId)]);
  for (const e of events) {
    await mirrorEventToFloat(e, { earliest: e.timestamp, latest: e.timestamp, entryCount: 1 });
  }
  const summarized = periods.filter((p) => p.summary && p.summary.trim());
  for (const p of summarized) {
    await mirrorPeriodToFloat(p);
  }

  return {
    success: true,
    counts: {
      cores: view.activeEntries.length,
      events: events.length,
      periods: summarized.length,
    },
  };
}

async function buildReport(characterId: string, state: MigrationState): Promise<MigrationReport> {
  const [events, dailies, periods, cores] = await Promise.all([
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
    countCores(characterId),
  ]);
  return {
    events: events.length,
    dailies: dailies.length,
    periods: periods.length,
    cores: cores.entries,
    tokenEstimate: state.tokenEstimate ?? 0,
    failedDates: state.failedDates ?? [],
    checkpoint: { totalDays: state.totalDays, doneDays: state.doneDays, currentDate: state.currentDate },
  };
}

/** 旧 float 长期 + 核心记忆压缩为一条「历史沉淀」周期素材，不逐条搬运。 */
async function createLegacyPeriod(characterId: string): Promise<void> {
  const existing = await loadPeriods(characterId);
  if (existing.some((p) => p.id === `period_legacy_${characterId}`)) return;

  const [floatLongTerm, floatCore] = await Promise.all([
    loadMemoryEntriesByType(characterId, "long_term"),
    loadMemoryEntriesByType(characterId, "core"),
  ]);
  const parts: string[] = [];
  for (const m of floatLongTerm) parts.push(m.content);
  for (const m of floatCore) parts.push(m.content);
  const joined = parts.join("\n").trim();
  if (!joined) return;

  const now = new Date().toISOString();
  const period: ComplexPeriod = {
    id: `period_legacy_${characterId}`,
    characterId,
    title: "历史沉淀",
    startTime: "0000-00-00",
    endTime: null,
    status: "active",
    summary: joined.slice(0, 2000),
    timelineIndex: {},
    associatedDates: [],
    linkedPeriods: [],
    coveredEventIds: [],
    voltage: 1,
    lastAccessedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await savePeriod(period);
}

function computeDates(characterId: string, days: number): string[] {
  const today = dateString(0);
  const timeline = loadNativeTimeline(characterId);
  const byDate = new Map<string, number>();
  for (const e of timeline) {
    const d = e.timestamp.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (d >= today) continue;
    const ts = new Date(e.timestamp).getTime();
    const prev = byDate.get(d);
    if (prev === undefined || ts > prev) byDate.set(d, ts);
  }
  const all = [...byDate.keys()].sort().reverse();
  return days > 0 ? all.slice(0, days) : all;
}

// ── 外部小手机记忆规范（占位） ──
export const EXTERNAL_IMPORT_FORMAT = "complex-memory-import-format";

export async function importExternal(
  payload: ExternalImportPayload,
): Promise<{ success: boolean; error?: string }> {
  if (payload.format !== EXTERNAL_IMPORT_FORMAT) {
    return { success: false, error: `未知导入格式：${payload.format}` };
  }
  if (payload.version !== 1) {
    return { success: false, error: `不支持的格式版本：${payload.version}` };
  }
  // 一期仅校验结构，转换器二期实现。
  return { success: false, error: "外部记忆规范转换器暂未开放（二期实现）" };
}
