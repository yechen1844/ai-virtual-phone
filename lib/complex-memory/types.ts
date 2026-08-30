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
  sourceMaterials?: string;      // 生成时的原始素材（时间线窗口原文，截断存储，可回查）
  migrated?: boolean;            // 一键迁移产物标记：电压半衰减（无召回对抗衰减，减少失真）
  lastAccessedAt: string;
  coveredByPeriod?: string;      // 已被某周期 summary 覆盖的标记
  createdAt: string;
};

// ── L3 每日日记 ──
export type ComplexDaily = {
  id: string;                    // day_<characterId>_YYYYMMDD（含角色前缀，避免不同角色同日互相覆盖）
  characterId: string;
  date: string;                  // 2026-08-15
  content: string;               // 800 字日记全文
  belongsToPeriods: string[];    // 多对多，可为空数组
  emotionVector: EmotionVector;
  voltage: number;
  special?: boolean;             // 特殊日期标记：周期级慢衰减 + 固定注入优先生效
  embedding?: number[];
  sourceMaterials?: string;      // 生成时的原始素材（当日时间线+事件，截断存储）
  migrated?: boolean;            // 一键迁移产物标记：电压半衰减
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
  rollingSummary?: string;       // 活跃期滚动累积：每日追加「该周期今日进展」（带日期戳）
  embedding?: number[];
  sourceMaterials?: string;      // 提炼时的原始素材（滚动累积/关联日记与事件，截断存储）
  migrated?: boolean;            // 一键迁移产物标记：电压半衰减
  voltage: number;               // 初始 1.0
  lastAccessedAt: string;
  createdAt: string;
  updatedAt: string;
};

// ── L5 核心记忆（条目式，与 float 原生 core 同构） ──
export type CoreTrigger = "bootstrap" | "scheduled" | "period_driven" | "manual";

export type CoreCategory = "identity" | "bond" | "principle" | "milestone";

/** 核心记忆条目：一条独立事实，对应 float 的一条 core 记录。条目不可变，编辑=新建+旧条软删。 */
export type ComplexCoreEntry = {
  id: string;                       // centry_ 前缀
  characterId: string;
  text: string;                     // 一句话事实，建议 30–80 字
  category: CoreCategory;
  createdAt: string;
  sourceTrigger: CoreTrigger;
  active: boolean;
};

/** 核心记忆版本快照：一组条目 id 构成一个版本（回退 = isCurrent 指针移动）。 */
export type ComplexCoreSnapshot = {
  id: string;                       // cver_ 前缀
  characterId: string;
  version: number;
  entryIds: string[];               // 该版本包含的条目 id
  note: string;                     // 版本备注：触发来源 / 用户改进意见
  trigger: CoreTrigger;
  sourceMaterials?: string;         // 生成该版本时的素材（人设+既有核心+新材料，截断存储）
  createdAt: string;
  isCurrent: boolean;
};

/** 存量整块核心记忆（DB v1 遗留，迁移拆条用）。 */
export type LegacyComplexCore = {
  id: string;
  characterId: string;
  version: number;
  content: string;
  updatedAt: string;
  trigger: CoreTrigger;
  isCurrent: boolean;
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
// 动态回放状态机（M7）：素材时间线按条正序推进 → 事件窗 → 到一天结束生成日记 →
// 周期开合 → 周期关闭即提炼并微调核心 → 日记满 N 篇定期重构核心 → 推进到"现在"。
export type MigrationPhase = "stream" | "legacy" | "done";

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
  dates: string[];              // 有消息的日期（正序，最早 → 最近）
  totalDays: number;
  doneDays: number;             // 已生成日记数
  currentDate: string | null;   // 最近处理到的日期
  // 动态回放游标（断点续跑）
  timelineCursor: number;       // 已纳入事件窗的时间线条目数（0 起）
  windowIndex: number;          // 已完成的窗口数
  totalWindows: number;         // 事件窗总数（素材条数 ÷ 窗宽，向上取整）
  pendingDates: string[];       // 已完全处理、待生成日记的日期（正序队列）
  nextDailyIndex: number;       // dates 中已覆盖完成并移交 pendingDates 的指针
  dayIndex?: number;            // 按日期逐日回放时，当前处理到的 dates 下标（最早起）
  coreDailyCounter: number;     // 迁移内核心定期重构日记计数
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
  eventWindowMaxEntries: number;     // 200 条/窗：单窗素材上限，超限分窗生成
  // L3
  dailyTargetLength: number;         // 800 字
  dailyQuietMinutes: number;         // 30（仅约束当天日记）
  // L4 周期滚动累积
  rollingAppendMax: number;          // 400 字/日：活跃周期每日进展追加上限
  // L5
  coreMinLength: number;             // 700 字
  coreMaxLength: number;             // 1000 字
  coreDailyInterval: number;         // 7：核心双触发之一（日记数满 N 篇）
  // 调度器
  maxParallel: number;               // 2：全角色并行检查并发上限
  retryCount: number;                // 3：任务失败静默重试次数（指数退避）
  autoGenerationEnabled: boolean;    // 后台自动补生成（日记/核心/周期）开关；关闭后仅手动迁移可生成。迁移进行中会强制跳过。
  autoSummarizeEnabled: boolean;     // 自动总结开关：聊天对话自动沉淀为事件记忆；关闭后复杂记忆不再自动生成事件。
  // 电压
  voltageDecayFactor: number;        // 0.98（普通日记）
  voltageRecallBoost: number;        // 0.1
  voltageEraseThreshold: number;     // 0.1
  // 分层电压衰减（M5）
  eventDecayFactor: number;          // 0.94：事件衰减快
  periodDecayFactor: number;         // 0.995：周期衰减慢
  specialDateDecayFactor: number;    // 0.995：特殊日期日记享受周期级慢衰减
  // 读取管线
  fixedShortTermEntries: number;     // 120
  fixedRecentEventCount: number;     // 2
  recallTopK: number;                // 10
  rerankKeepMax: number;             // 8
  totalInjectTokenBudget: number;    // 24000
  vectorRecallEnabled: boolean;      // true
  rerankEnabled: boolean;            // true
  silkAssociationEnabled: boolean;   // true
  // 每日记忆时间窗（M5）：近 full 天全额，full-floor 天线性衰减至底值
  recallTimeWindowFullDays: number;  // 30
  recallTimeWindowFloorDays: number; // 180
  recallTimeWindowFloor: number;     // 0.2
  // 情绪参与召回（M5）
  emotionRecallLambda: number;       // 0.15：score × (1 + λ × 情绪相似度)
  // 特殊日期固定注入（M5）：最近 N 篇被标记日记进固定注入区
  fixedSpecialDateCount: number;     // 1
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
  specialDateDailies: string;         // 固定注入 · 最近被标记的特殊日期日记
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
