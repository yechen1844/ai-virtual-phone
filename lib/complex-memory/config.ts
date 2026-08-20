// lib/complex-memory/config.ts
// 复杂记忆系统 · 配置读写（KV）、角色级开关状态、全部默认值。

import { kvGet, kvSet, kvRemove, registerKvMigration, registerDynamicPrefix } from "../kv-db";
import { loadCharacters } from "../character-storage";
import type {
  CharacterRuntimeState,
  ComplexMemoryConfig,
  MemoryPromptKey,
  MemoryPrompts,
  RingBufferState,
} from "./types";
import { DEFAULT_PROMPTS } from "./prompts";

// ── 键名 ──
export const COMPLEX_MEMORY_CONFIG_KEY = "ai_phone_complex_memory_config_v1";
export const COMPLEX_MEMORY_STATE_PREFIX = "ai_phone_complex_memory_state_";

registerKvMigration(COMPLEX_MEMORY_CONFIG_KEY);
registerDynamicPrefix(COMPLEX_MEMORY_STATE_PREFIX);

// ── 默认配置 ──
export const DEFAULT_COMPLEX_MEMORY_CONFIG: ComplexMemoryConfig = {
  enabledCharacters: {},
  ringBufferMaxEntries: 150,
  eventTriggerCount: 100,
  eventTargetLength: 250,
  dailyTargetLength: 800,
  dailyQuietMinutes: 30,
  coreMinLength: 700,
  coreMaxLength: 1000,
  coreUpdateDiaryCount: 3,
  voltageDecayFactor: 0.98,
  voltageRecallBoost: 0.1,
  voltageEraseThreshold: 0.1,
  fixedShortTermEntries: 120,
  fixedRecentEventCount: 2,
  recallTopK: 10,
  rerankKeepMax: 8,
  totalInjectTokenBudget: 24000,
  vectorRecallEnabled: true,
  rerankEnabled: true,
  silkAssociationEnabled: true,
  mirrorToFloatEnabled: true,
  sanitizerBanList: [
    "爹味",
    "爹系",
    "超雄",
    "爹味发言",
    "爹味说教",
    "爹味十足",
    "爹味重",
    "爹味浓",
    "超雄综合症",
    "超雄人格",
    "超雄男",
    "超雄男宝",
    "超雄宝宝",
  ],
  migrationDefaultDays: 30,
  prompts: { ...DEFAULT_PROMPTS },
};

// ── 配置读写 ──
export function loadComplexMemoryConfig(): ComplexMemoryConfig {
  if (typeof window === "undefined") return { ...DEFAULT_COMPLEX_MEMORY_CONFIG };
  try {
    const raw = kvGet(COMPLEX_MEMORY_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_COMPLEX_MEMORY_CONFIG };
    const parsed = JSON.parse(raw) as Partial<ComplexMemoryConfig>;
    return normalizeConfig(parsed);
  } catch {
    return { ...DEFAULT_COMPLEX_MEMORY_CONFIG };
  }
}

export function saveComplexMemoryConfig(config: ComplexMemoryConfig): void {
  if (typeof window === "undefined") return;
  kvSet(COMPLEX_MEMORY_CONFIG_KEY, JSON.stringify(config));
}

export async function saveComplexMemoryConfigAsync(config: ComplexMemoryConfig): Promise<void> {
  if (typeof window === "undefined") return;
  const { kvSetAsync } = await import("../kv-db");
  await kvSetAsync(COMPLEX_MEMORY_CONFIG_KEY, JSON.stringify(config));
}

function normalizeConfig(parsed: Partial<ComplexMemoryConfig>): ComplexMemoryConfig {
  const d = DEFAULT_COMPLEX_MEMORY_CONFIG;
  const num = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

  return {
    enabledCharacters:
      parsed.enabledCharacters && typeof parsed.enabledCharacters === "object"
        ? parsed.enabledCharacters
        : {},
    ringBufferMaxEntries: num(parsed.ringBufferMaxEntries, d.ringBufferMaxEntries, 50, 1000),
    eventTriggerCount: num(parsed.eventTriggerCount, d.eventTriggerCount, 10, 10000),
    eventTargetLength: num(parsed.eventTargetLength, d.eventTargetLength, 50, 2000),
    dailyTargetLength: num(parsed.dailyTargetLength, d.dailyTargetLength, 100, 5000),
    dailyQuietMinutes: num(parsed.dailyQuietMinutes, d.dailyQuietMinutes, 1, 1440),
    coreMinLength: num(parsed.coreMinLength, d.coreMinLength, 100, 5000),
    coreMaxLength: num(parsed.coreMaxLength, d.coreMaxLength, 200, 10000),
    coreUpdateDiaryCount: num(parsed.coreUpdateDiaryCount, d.coreUpdateDiaryCount, 1, 100),
    voltageDecayFactor: num(parsed.voltageDecayFactor, d.voltageDecayFactor, 0.5, 1),
    voltageRecallBoost: num(parsed.voltageRecallBoost, d.voltageRecallBoost, 0, 1),
    voltageEraseThreshold: num(parsed.voltageEraseThreshold, d.voltageEraseThreshold, 0.001, 1),
    fixedShortTermEntries: num(parsed.fixedShortTermEntries, d.fixedShortTermEntries, 10, 1000),
    fixedRecentEventCount: num(parsed.fixedRecentEventCount, d.fixedRecentEventCount, 0, 50),
    recallTopK: num(parsed.recallTopK, d.recallTopK, 1, 100),
    rerankKeepMax: num(parsed.rerankKeepMax, d.rerankKeepMax, 1, 50),
    totalInjectTokenBudget: num(parsed.totalInjectTokenBudget, d.totalInjectTokenBudget, 1000, 1000000),
    vectorRecallEnabled: bool(parsed.vectorRecallEnabled, d.vectorRecallEnabled),
    rerankEnabled: bool(parsed.rerankEnabled, d.rerankEnabled),
    silkAssociationEnabled: bool(parsed.silkAssociationEnabled, d.silkAssociationEnabled),
    mirrorToFloatEnabled: bool(parsed.mirrorToFloatEnabled, d.mirrorToFloatEnabled),
    sanitizerBanList: Array.isArray(parsed.sanitizerBanList)
      ? parsed.sanitizerBanList.filter((s): s is string => typeof s === "string" && !!s.trim())
      : [...d.sanitizerBanList],
    migrationDefaultDays: num(parsed.migrationDefaultDays, d.migrationDefaultDays, 1, 3650),
    prompts: normalizePrompts(parsed.prompts),
  };
}

function normalizePrompts(prompts: Partial<MemoryPrompts> | undefined): MemoryPrompts {
  const d = DEFAULT_PROMPTS;
  const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);
  return {
    event: str(prompts?.event, d.event),
    daily: str(prompts?.daily, d.daily),
    period: str(prompts?.period, d.period),
    core: str(prompts?.core, d.core),
    rerank: str(prompts?.rerank, d.rerank),
  };
}

// ── 模板读写 ──
export function getMemoryPrompt(key: MemoryPromptKey): string {
  const config = loadComplexMemoryConfig();
  const custom = config.prompts[key];
  return custom && custom.trim() ? custom : DEFAULT_PROMPTS[key];
}

export function setMemoryPrompt(key: MemoryPromptKey, template: string): void {
  const config = loadComplexMemoryConfig();
  config.prompts[key] = template;
  saveComplexMemoryConfig(config);
}

export function resetMemoryPrompt(key: MemoryPromptKey): void {
  const config = loadComplexMemoryConfig();
  config.prompts[key] = DEFAULT_PROMPTS[key];
  saveComplexMemoryConfig(config);
}

// ── 角色级开关 ──
export function isComplexMemoryEnabled(characterId: string): boolean {
  const config = loadComplexMemoryConfig();
  return config.enabledCharacters[characterId] === true;
}

export function setComplexMemoryEnabled(characterId: string, enabled: boolean): void {
  const config = loadComplexMemoryConfig();
  if (enabled) {
    config.enabledCharacters[characterId] = true;
    // 首次启用：异步 bootstrap 核心记忆（幂等，已存在则跳过）
    void import("./core-builder").then((m) => {
      const name = loadCharacters().find((c) => c.id === characterId)?.name ?? "角色";
      m.bootstrapCoreMemory(characterId, name).catch((err) =>
        console.warn("[ComplexMemory] 核心记忆 bootstrap 失败:", characterId, err),
      );
    });
  } else {
    delete config.enabledCharacters[characterId];
  }
  saveComplexMemoryConfig(config);
}

export function getEnabledCharacterIds(): string[] {
  const config = loadComplexMemoryConfig();
  return Object.entries(config.enabledCharacters)
    .filter(([, enabled]) => enabled)
    .map(([id]) => id);
}

// ── 角色运行时状态（KV） ──
export function loadCharacterState(characterId: string): CharacterRuntimeState {
  const fallback: CharacterRuntimeState = {
    characterId,
    ringBuffer: {
      characterId,
      watermarkEventId: null,
      watermarkTimestamp: null,
      pendingCount: 0,
    },
    lastDailyDate: null,
    dailyCountSinceCoreUpdate: 0,
    lastVoltageRunAt: null,
  };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = kvGet(COMPLEX_MEMORY_STATE_PREFIX + characterId);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<CharacterRuntimeState>;
    return {
      ...fallback,
      ...parsed,
      ringBuffer: {
        ...fallback.ringBuffer,
        ...(parsed.ringBuffer ?? {}),
      },
    };
  } catch {
    return fallback;
  }
}

export function saveCharacterState(state: CharacterRuntimeState): void {
  if (typeof window === "undefined") return;
  kvSet(COMPLEX_MEMORY_STATE_PREFIX + state.characterId, JSON.stringify(state));
}

export function updateRingBuffer(characterId: string, patch: Partial<RingBufferState>): void {
  const state = loadCharacterState(characterId);
  state.ringBuffer = { ...state.ringBuffer, ...patch };
  saveCharacterState(state);
}

export function getRingBuffer(characterId: string): RingBufferState {
  return loadCharacterState(characterId).ringBuffer;
}

export function clearCharacterState(characterId: string): void {
  if (typeof window === "undefined") return;
  kvRemove(COMPLEX_MEMORY_STATE_PREFIX + characterId);
}

// ── 生成互斥锁 ──
export function acquireGenerationLock(
  characterId: string,
  kind: NonNullable<CharacterRuntimeState["generationLock"]>["kind"],
): boolean {
  const state = loadCharacterState(characterId);
  if (state.generationLock) return false;
  state.generationLock = { kind, startedAt: new Date().toISOString() };
  saveCharacterState(state);
  return true;
}

export function releaseGenerationLock(characterId: string, kind?: string): void {
  const state = loadCharacterState(characterId);
  if (!state.generationLock) return;
  if (kind && state.generationLock.kind !== kind) return;
  delete state.generationLock;
  saveCharacterState(state);
}

export function getGenerationLock(characterId: string): CharacterRuntimeState["generationLock"] {
  return loadCharacterState(characterId).generationLock;
}
