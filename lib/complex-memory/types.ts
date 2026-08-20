// lib/complex-memory/types.ts
// 复杂记忆系统 · 五层实体、配置与迁移状态的 TypeScript 类型。

// ── 情绪坐标 ──
export type EmotionVector = {
  valence: number;   // -1.0 ~ 1.0 积极/消极
  arousal: number;   // 0.0 ~ 1.0 唤醒度
};

// ── L2 事件记忆 ──
export type ComplexEvent = {
  id: string;                    // evt_ 前缀
  characterId: string;
  timestamp: string;             // 现实时间 ISO
  content: string;               // 250 字第一人称叙事
  emotion: EmotionVector;
  periodsRef: string[];          // 关联周期 ID（生成后由日记判定回填）
  voltage: number;               // 初始 1.0
  importanceScore: number;       // 0-1
  embedding?: number[];          // 生成即向量化
  lastAccessedAt: string;
  coveredByPeriod?: string;      // 已被某周期 summary 覆盖的标记
  createdAt: string;
};

// ── L3 每日日记 ──
export type ComplexDaily = {
  id: string;                    // day_YYYYMMDD
  characterId: string;
  date: string;                  // 2026-08-15
  content: string;               // 800 字日记全文
  belongsToPeriods: string[];    // 多对多，可为空数组
  emotionVector: EmotionVector;
  voltage: number;
  embedding?: number[];
  lastAccessedAt: string;
  createdAt: string;
};

// ── L4 周期记忆 ──
export type PeriodStatus = "active" | "stabilized" | "archived";

export type ComplexPeriod = {
  id: string;                    // period_ 前缀
  characterId: string;
  title: string;
  startTime: string;             // 2026-08-03
  endTime: string | null;        // 未结束为 null
  status: PeriodStatus;
  summary: string;               // 事件脉络 · 情绪曲线 · 角色成长 · 未解决事项
  timelineIndex: Record<string, string>;  // 日期 → "Day N: 要点"，含消磨指针
  associatedDates: string[];
  linkedPeriods: string[];       // 同时期关联周期（丝线联想）
  coveredEventIds: string[];     // summary 已覆盖的事件记忆
  embedding?: number[];
  voltage: number;               // 初始 1.0
  lastAccessedAt: string;
  createdAt: string;
  updatedAt: string;
};

// ── L5 核心记忆 ──
export type CoreTrigger = "bootstrap" | "scheduled" | "period_driven" | "manual";

export type ComplexCore = {
  id: string;                    // core_v 前缀
  characterId: string;
  version: number;
  content: string;               // P0-P3 五模块正文
  updatedAt: string;
  trigger: CoreTrigger;
  isCurrent: boolean;            // 版本链指针
};

// ── L1 环形缓冲状态（KV 持久化） ──
export type RingBufferState = {
  characterId: string;
  watermarkEventId: string | null;   // 已压缩至哪条时间线事件
  watermarkTimestamp: string | null;
  pendingCount: number;              // 水位线之后的累计事件数
};

// ── 角色调度状态（KV 持久化） ──
export type CharacterRuntimeState = {
  characterId: string;
  ringBuffer: RingBufferState;
  lastDailyDate: string | null;      // 最近已生成的日记日期 YYYY-MM-DD
  dailyCountSinceCoreUpdate: number; // 距上次核心定期重构的日记累计数
  lastVoltageRunAt: string | null;   // 电压落库时间
  migration?: MigrationState;         // 迁移断点
  generationLock?: {
    kind: "event" | "daily" | "period" | "core" | "migration";
    startedAt: string;
  };
};

// ── 迁移状态 ──
export type MigrationPhase = "legacy" | "dailies" | "distill" | "core" | "done";

export type MigrationReport = {
  events: number;
  dailies: number;
  periods: number;
  cores: number;
  tokenEstimate: number;
  failedDates: string[];
  checkpoint: { totalDays: number; doneDays: number; currentDate: string | null };
};

export type MigrationState = {
  status: "idle" | "running" | "paused" | "done";
  phase: MigrationPhase;
  dates: string[];              // 待迁移日期（从近到远）
  totalDays: number;
  doneDays: number;
  currentDate: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  error?: string;
  tokenEstimate?: number;
  failedDates?: string[];
  report?: MigrationReport;
};

// ── 配置 ──
export type MemoryPromptKey = "event" | "daily" | "period" | "core" | "rerank";

export type MemoryPrompts = {
  event: string;
  daily: string;
  period: string;
  core: string;
  rerank: string;
};

export type ComplexMemoryConfig = {
  // 角色级开关映射表（D1）
  enabledCharacters: Record<string, boolean>;
  // L1
  ringBufferMaxEntries: number;      // 150
  // L2
  eventTriggerCount: number;         // 100
  eventTargetLength: number;         // 250 字
  // L3
  dailyTargetLength: number;         // 800 字
  dailyQuietMinutes: number;         // 30
  // L5
  coreMinLength: number;             // 700 字
  coreMaxLength: number;             // 1000 字
  coreUpdateDiaryCount: number;      // 3
  // 电压
  voltageDecayFactor: number;        // 0.98
  voltageRecallBoost: number;        // 0.1
  voltageEraseThreshold: number;     // 0.1
  // 读取管线
  fixedShortTermEntries: number;     // 120
  fixedRecentEventCount: number;     // 2
  recallTopK: number;                // 10
  rerankKeepMax: number;             // 8
  totalInjectTokenBudget: number;    // 24000
  vectorRecallEnabled: boolean;      // true
  rerankEnabled: boolean;            // true
  silkAssociationEnabled: boolean;   // true
  // 镜像
  mirrorToFloatEnabled: boolean;     // true
  // 消毒
  sanitizerBanList: string[];
  // 迁移
  migrationDefaultDays: number;      // 30
  // 模板
  prompts: MemoryPrompts;
};

// ── 读取管线产物 ──
export type MemoryRecallItem = {
  kind: "event" | "daily" | "period";
  id: string;
  characterId: string;
  timestamp: string;
  content: string;
  score: number;
  voltage: number;
  belongsToPeriods?: string[];
};

export type MemoryContextBundle = {
  coreMemory: string;                 // 固定注入 · 核心记忆全文
  fixedShortTerm: string;             // 固定注入 · 短期上下文
  fixedEvents: string;                // 固定注入 · 最新事件记忆
  yesterdayDaily: string;             // 固定注入 · 昨日日记
  activePeriods: string;              // 固定注入 · 活跃周期摘要
  recalled: string;                   // 召回 + 重排 + 丝线联想 的格式化文本
  recalledItems: MemoryRecallItem[];  // 供电压回升
  tokenEstimate: number;
};

// ── 外部导入中间格式（占位） ──
export type ExternalImportPayload = {
  format: "complex-memory-import-format";
  version: 1;
  character: { id: string; name: string; source: string };
  events?: Array<Record<string, unknown>>;
  dailies?: Array<Record<string, unknown>>;
  periods?: Array<Record<string, unknown>>;
  core?: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
};
