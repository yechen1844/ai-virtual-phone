// lib/complex-memory/migration.ts
// 复杂记忆系统 · 一键迁移（float → 复杂记忆）+ 外部导入占位。
// 迁移作为可中断的后台任务执行：断点存于角色 state 键，随时续跑。
// 阶段：legacy（旧 float 记忆压缩为历史周期）→ dailies（逐日回溯生成日记，从近到远）
//      → distill（提炼已结束周期）→ core（核心记忆 bootstrap）→ done（核对报告）。

import { loadNativeTimeline } from "../short-term-assembler";
import { loadMemoryEntriesByType } from "../memory-storage";
import { loadComplexMemoryConfig, loadCharacterState, saveCharacterState } from "./config";
import { generateDaily } from "./daily-generator";
import { distillPeriod } from "./period-distiller";
import { bootstrapCoreMemory } from "./core-builder";
import {
  getCurrentCore,
  loadCoreVersions,
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

const ESTIMATE_PER_DAY = 1400; // 每篇日记 prompt + 输出约 1400 token
const ESTIMATE_FIXED = 3000;   // legacy + distill + core 固定开销

export function getMigrationState(characterId: string): MigrationState | null {
  return loadCharacterState(characterId).migration ?? null;
}

export function estimateMigration(characterId: string, days: number): number {
  const dates = computeDates(characterId, days);
  return dates.length * ESTIMATE_PER_DAY + ESTIMATE_FIXED;
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
  if (dates.length === 0) {
    return { success: false, error: "该角色没有可回溯的聊天/时间线历史" };
  }

  const now = new Date().toISOString();
  const state: MigrationState = {
    status: "running",
    phase: "legacy",
    dates,
    totalDays: dates.length,
    doneDays: 0,
    currentDate: null,
    startedAt: now,
    updatedAt: now,
    tokenEstimate: dates.length * ESTIMATE_PER_DAY + ESTIMATE_FIXED,
  };
  const cs = loadCharacterState(characterId);
  saveCharacterState({ ...cs, migration: state });
  return { success: true, estimate: state.tokenEstimate };
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

/** 执行一步迁移：legacy → 单日日记 → 单周期提炼 → core → done。 */
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
    case "legacy": {
      await createLegacyPeriod(characterId);
      return { ...base, phase: "dailies" };
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
      const existing = await getCurrentCore(characterId);
      if (!existing) {
        await bootstrapCoreMemory(characterId, characterName);
      }
      const report = await buildReport(characterId, state);
      return { ...base, phase: "done", status: "done", report };
    }
    case "done":
    default:
      return base;
  }
}

async function buildReport(characterId: string, state: MigrationState): Promise<MigrationReport> {
  const [events, dailies, periods, cores] = await Promise.all([
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
    loadCoreVersions(characterId),
  ]);
  return {
    events: events.length,
    dailies: dailies.length,
    periods: periods.length,
    cores: cores.length,
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
