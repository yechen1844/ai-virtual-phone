// lib/complex-memory/migration.ts
// 复杂记忆系统 · 一键迁移（双向）+ 外部导入占位。
// 动态回放状态机（M7）：完全仿照正常动态生成机制，从最早时刻按时间正序回放历史短期记录。
//   stream（素材时间线按条切窗生成事件记忆，每窗注入当时核心/周期/昨日日记/短期上下文；
//         某天消息处理完毕 → 生成当日日记（周期开合判定 + 进度累积）；
//         周期关闭 → 立即提炼并微调核心；日记满 N 篇 → 定期重构核心；空白天跳过）
//   → legacy（旧 float 压缩为历史沉淀周期）→ done。
// 迁移产物标记 migrated：电压半衰减（无召回对抗衰减，减少失真）。
// 迁移作为可中断的后台任务执行：断点存于角色 state 键，随时续跑。

import { loadNativeTimeline } from "../short-term-assembler";
import { loadMemoryEntriesByType } from "../memory-storage";
import { estimateTokens } from "../token-counter";
import { loadComplexMemoryConfig, loadCharacterState, saveCharacterState } from "./config";
import { generateDaily } from "./daily-generator";
import { distillPeriod } from "./period-distiller";
import { rebuildCoreMemory, fineTuneCoreMemory, bootstrapCoreMemory } from "./core-builder";
import { generateEventWindow } from "./event-generator";
import { mirrorCoreEntriesToFloat, mirrorEventToFloat, mirrorPeriodToFloat } from "./mirror";
import { loadSourceTimeline } from "./source";
import {
  getCurrentCoreView,
  countCores,
  deleteCharacterAll,
  loadDailies,
  loadEvents,
  loadPeriods,
  savePeriod,
} from "./storage";
import { dateFromTimestamp, dateString } from "./utils";
import type {
  ComplexPeriod,
  ExternalImportPayload,
  MigrationReport,
  MigrationState,
} from "./types";

// 单页内并发防护：迁移步骤逐条执行，避免双击/重复调度并发跑。
let running = false;

// ── 后台驱动循环（M7 修复：一键迁移自动按批次跑完，不依赖页面轮询） ──
// 每个角色一个驱动标记；startMigration / 调度器 / UI 均可调用，幂等。
const drivers = new Map<string, boolean>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 驱动迁移自推进：状态为 running 时逐批执行直到 done / paused / 失败。
 * 幂等：同一角色已有驱动循环在跑则直接返回。
 */
export async function driveMigration(characterId: string, characterName: string): Promise<void> {
  if (drivers.get(characterId)) return;
  drivers.set(characterId, true);
  try {
    // 防止驱动循环饿死调度器：每批之间让出事件循环
    for (let guard = 0; guard < 100_000; guard += 1) {
      const ms = getMigrationState(characterId);
      if (!ms || ms.status !== "running") break;
      const res = await runMigrationStep(characterId, characterName);
      if (!res.success) {
        if (res.error === "迁移步骤执行中") {
          await sleep(500); // 并发保护命中，等上一步收尾
          continue;
        }
        break; // 失败已置 paused，交由 UI 展示错误
      }
      if (res.done) break;
      await sleep(200); // 让出事件循环 + 给 UI 刷新进度的机会
    }
  } finally {
    drivers.set(characterId, false);
  }
}

const ESTIMATE_PERIOD_FIXED = 1500; // 每个周期提炼固定开销
const ESTIMATE_CORE_FIXED = 2000;   // 核心 bootstrap 固定开销

export function getMigrationState(characterId: string): MigrationState | null {
  return loadCharacterState(characterId).migration ?? null;
}

/** 动态 token 估算：基于真实时间线条数，替换固定 1400/天。 */
export function estimateMigration(characterId: string, days: number, range?: { start?: string; end?: string }): number {
  const dates = computeDates(characterId, days, range);
  const timeline = loadNativeTimeline(characterId);
  const config = loadComplexMemoryConfig();
  const windowSize = config.eventWindowMaxEntries;

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
      .filter((e) => dateFromTimestamp(e.timestamp) === date)
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

/** 启动迁移：计算回溯日期（最近 N 天，正序），落断点，返回预估 token。 */
export async function startMigration(
  characterId: string,
  characterName: string,
  days: number,
  force = false,
  range?: { start?: string; end?: string },
): Promise<{ success: boolean; error?: string; estimate?: number }> {
  const existing = getMigrationState(characterId);
  if (existing && !force) {
    if (existing.status === "running" || existing.status === "paused") {
      return { success: false, error: "已有迁移任务进行中，可继续或重置后重来" };
    }
  }

  const dates = computeDates(characterId, days, range);
  const timeline = loadSourceTimeline(characterId);
  if (dates.length === 0 && timeline.length < 4) {
    return { success: false, error: "该角色没有可回溯的聊天/时间线历史" };
  }

  const estimate = estimateMigration(characterId, days);
  const now = new Date().toISOString();
  const config = loadComplexMemoryConfig();
  const windowSize = config.eventWindowMaxEntries;
  const state: MigrationState = {
    status: "running",
    phase: "stream",
    dates,                              // 有消息日期，正序（最早 → 最近）
    totalDays: dates.length,
    doneDays: 0,
    currentDate: null,
    timelineCursor: 0,
    windowIndex: 0,
    totalWindows: Math.max(1, Math.ceil(timeline.length / windowSize)),
    pendingDates: [],
    nextDailyIndex: 0,
    dayIndex: 0,
    coreDailyCounter: 0,
    startedAt: now,
    updatedAt: now,
    tokenEstimate: estimate,
  };
  const cs = loadCharacterState(characterId);
  saveCharacterState({ ...cs, migration: state });
  // 一键迁移：自动按批次推进到底，无需手动点下一步（驱动循环幂等，UI/调度器重复调用安全）
  void driveMigration(characterId, characterName);
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

/** 彻底重置：删除该角色全部长期记忆（事件/日记/周期/核心/快照），并清空迁移断点与关键运行态。
 *  保留短期记忆（float 原生最近聊天时间线 + ringBuffer 事件缓冲），记忆从此重新积累。
 *  不可逆：调用方（UI）必须二次确认后触发。 */
export async function hardResetCharacterMemory(characterId: string): Promise<void> {
  await deleteCharacterAll(characterId);
  const cs = loadCharacterState(characterId);
  const { migration: _mig, ...rest } = cs;
  void _mig;
  saveCharacterState(rest);
}

/** 执行一步迁移：事件窗 / 单日日记（含周期链与核心链）逐步推进。失败自动重试 N 次（指数退避），
 *  全部失败才置 paused 并记录错误，用户可随时「继续」从断点续跑（重试期间状态保持 running，不落盘失败）。 */
export async function runMigrationStep(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string; done?: boolean; state?: MigrationState; aborted?: boolean }> {
  if (running) return { success: false, error: "迁移步骤执行中" };
  const state = getMigrationState(characterId);
  if (!state) return { success: false, error: "尚未启动迁移" };
  if (state.status !== "running") {
    return { success: false, error: state.status === "paused" ? "迁移已暂停" : "迁移已结束" };
  }

  const maxRetries = Math.max(1, loadComplexMemoryConfig().retryCount || 3);
  let lastError: unknown;

  running = true;
  try {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      try {
        const next = await executeStep(characterId, characterName, state);
        // 竞态防护：executeStep 耗时（可能几十秒）期间用户可能点了暂停/重置，甚至重置后立刻新启一次迁移。
        // 重读最新状态校验（任务 task 与 startedAt 都须一致）：
        //   1) 状态已非 running（被暂停）或 migration 已删（被重置）→ 丢弃本次结果，驱动循环读到 paused/null 正常退出；
        //   2) startedAt 不同（重置后已新启另一迁移）→ 丢弃旧步骤的产物上下文，避免旧快照覆盖/污染新迁移。
        const newest = getMigrationState(characterId);
        if (!newest || newest.status !== "running" || newest.startedAt !== state.startedAt) {
          return { success: false, error: "迁移上下文已变化（暂停/重置/重启），本次结果已丢弃", aborted: true };
        }
        const cs = loadCharacterState(characterId);
        saveCharacterState({ ...cs, migration: next });
        return { success: true, done: next.status === "done", state: next };
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries - 1) {
          // 指数退避：800ms → 1600ms → 3200ms …（重试使用同一状态快照，幂等续试）
          await sleep(800 * Math.pow(2, attempt));
        }
      }
    }
    // 重试耗尽：置 paused 并记录错误，驱动循环退出，可随时「继续」从断点续跑
    const failed: MigrationState = {
      ...state,
      status: "paused",
      error: lastError instanceof Error ? lastError.message : String(lastError),
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
    case "stream": {
      // 0) 周期链统一入口：存在「关闭但未提炼」的周期（日记 closedPeriods 判定后）立即提炼一个，
      //    提炼后 status → stabilized 天然幂等；含同步核心微调，保证后续生成读到最新核心。
      const periods = await loadPeriods(characterId);
      const pendingPeriod = periods.find((p) => p.endTime !== null && p.status === "active");
      if (pendingPeriod) {
        const res = await distillPeriod(characterId, characterName, pendingPeriod.id, {
          suppressChain: true,
          migrated: true,
        });
        if (!res.success) {
          console.warn("[ComplexMemory] 迁移周期提炼失败:", pendingPeriod.id, res.error);
        } else {
          await fineTuneCoreMemory(characterId, characterName, pendingPeriod.title, pendingPeriod.summary).catch(
            (err) => console.warn("[ComplexMemory] 迁移核心微调失败:", err),
          );
        }
        return { ...base, phase: "stream" };
      }
      // 1) 先补上一日日记：每完成一天事件即生成当日日记，保证「昨日日记」参考链完整、
      //    周期开合与核心重构按日推进（与正常逐日累积机制一致，避免事件先全出、日记后补齐造成跨日错位）。
      if (state.pendingDates.length > 0) {
        return await stepDaily(characterId, characterName, base, state);
      }
      // 2) 事件窗推进（按日期逐日回放）：当天事件全部完成会自动把该日期移交日记队列。
      if (state.dayIndex !== undefined ? state.dayIndex < state.dates.length : state.windowIndex < state.totalWindows) {
        return await stepEventWindow(characterId, characterName, base, state);
      }
      // 3) 事件与日记全部完成：核心全程无触发点（无周期关闭、日记不足 N 篇）时 bootstrap 兜底，
      //    保证与正常机制一致——正常启用时核心一定存在
      const view = await getCurrentCoreView(characterId);
      if (!view.snapshot) {
        await bootstrapCoreMemory(characterId, characterName).catch((err) =>
          console.warn("[ComplexMemory] 迁移核心 bootstrap 兜底失败:", err),
        );
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
      // 旧版批处理状态（events/dailies/distill/core）不再支持：暂停并提示重置，避免驱动循环空转
      throw new Error("迁移状态为旧版本格式，请「重置」后重新开始");
  }
}

/** 推进一个事件窗：按日期逐日回放。每天切窗生成事件，当天完成即移交日记并推进下一天。
 *  事件素材严格限定在当天（generateEventWindow 传 date），杜绝跨日期窗口把 7/21 污染成 8/15。 */
async function stepEventWindow(
  characterId: string,
  characterName: string,
  base: MigrationState,
  state: MigrationState,
): Promise<MigrationState> {
  const dates = state.dates;
  const dayIndex = state.dayIndex ?? 0;
  if (dayIndex >= dates.length) return { ...base, phase: "legacy" };
  const date = dates[dayIndex];

  const res = await generateEventWindow(characterId, characterName, state.windowIndex, {
    migrated: true,
    date,
  });
  if (!res.success) {
    if (res.error === "事件不足 4 条") {
      // 当天素材不足 4 条：跳过的日期直接移交日记（空天不计），推进下一天
      return {
        ...base,
        phase: "stream",
        windowIndex: 0,
        dayIndex: dayIndex + 1,
        pendingDates: [...state.pendingDates, date],
        nextDailyIndex: dayIndex + 1,
        doneDays: state.doneDays,
        currentDate: date,
      };
    }
    throw new Error(res.error ?? "事件窗口生成失败");
  }

  // 当天窗口未全部完成 → 继续同一天下一窗；j
  if (res.nextIndex < res.totalWindows) {
    return {
      ...base,
      phase: "stream",
      windowIndex: res.nextIndex,
      dayIndex,
      pendingDates: state.pendingDates,
      nextDailyIndex: state.nextDailyIndex,
      doneDays: state.doneDays,
      currentDate: date,
    };
  }

  // 当天全部窗口完成 → 日期移交日记队列，推进下一天
  return {
    ...base,
    phase: "stream",
    windowIndex: 0,
    dayIndex: dayIndex + 1,
    pendingDates: [...state.pendingDates, date],
    nextDailyIndex: dayIndex + 1,
    doneDays: state.doneDays,
    currentDate: date,
  };
}

/** 生成一篇当日日记，并同步编排周期链（关闭即提炼 + 微调核心）与核心链（满 N 篇定期重构）。 */
async function stepDaily(
  characterId: string,
  characterName: string,
  base: MigrationState,
  state: MigrationState,
): Promise<MigrationState> {
  const date = state.pendingDates[0];
  const res = await generateDaily(characterId, characterName, date, { suppressChain: true, migrated: true });
  const failedDates = [...(state.failedDates ?? [])];
  if (!res.success && res.error !== "当日日记已存在（幂等）") failedDates.push(date);

  const next: MigrationState = {
    ...base,
    phase: "stream",
    pendingDates: state.pendingDates.slice(1),
    doneDays: state.doneDays + 1,
    currentDate: date,
    failedDates,
  };

  // 核心链在迁移内同步 await，保证下一步事件/日记生成读到最新核心
  return await runMigrationChain(characterId, characterName, next);
}

/** 迁移内核心定期重构：迁移内日记计数满 coreDailyInterval 篇 → 重构核心（与正常双触发之一一致）。 */
async function runMigrationChain(
  characterId: string,
  characterName: string,
  state: MigrationState,
): Promise<MigrationState> {
  const config = loadComplexMemoryConfig();
  const counter = state.coreDailyCounter + 1;
  if (counter >= config.coreDailyInterval) {
    await rebuildCoreMemory(characterId, characterName).catch((err) =>
      console.warn("[ComplexMemory] 迁移核心定期重构失败:", err),
    );
    return { ...state, coreDailyCounter: 0 };
  }
  return { ...state, coreDailyCounter: counter };
}

/** 单独重跑某个失败日期（从 failedDates 移除后重新生成当日日记）。 */
export async function retryFailedDate(
  characterId: string,
  characterName: string,
  date: string,
): Promise<{ success: boolean; error?: string }> {
  const state = getMigrationState(characterId);
  if (!state) return { success: false, error: "尚未启动迁移" };
  const res = await generateDaily(characterId, characterName, date, { suppressChain: true, migrated: true });
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
    migrated: true, // 迁移产物：半衰减
    lastAccessedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await savePeriod(period);
}

function computeDates(characterId: string, days: number, range?: { start?: string; end?: string }): string[] {
  const today = dateString(0);
  const timeline = loadNativeTimeline(characterId);
  const byDate = new Map<string, number>();
  for (const e of timeline) {
    const d = dateFromTimestamp(e.timestamp);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (d >= today) continue;
    if (range?.start && d < range.start) continue;
    if (range?.end && d > range.end) continue;
    const ts = new Date(e.timestamp).getTime();
    const prev = byDate.get(d);
    if (prev === undefined || ts > prev) byDate.set(d, ts);
  }
  const all = [...byDate.keys()].sort(); // 正序（最早 → 最近）
  return days > 0 ? all.slice(-days) : all; // 取最近 N 天，保持正序
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
