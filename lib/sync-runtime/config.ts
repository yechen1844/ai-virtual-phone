// lib/sync-runtime/config.ts
// PC↔手机「实时同步」配置：总开关 / 游玩端选择 / 轮询间隔 / 已同步水位。
// 复用微信回收的两端配置存法（kv-db 的 kvGet/kvSet + registerKvMigration）。
// 密钥（Supabase URL + anon key）放到这里，值由用户在设置里填，引擎据此连接云。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";

const SYNC_CONFIG_KEY = "ai_phone_stardew_sync_config_v1";
registerKvMigration(SYNC_CONFIG_KEY);

/** 本端在同步链路里的角色。 */
export type SyncRole = "play" | "remote";

export type StardewSyncConfig = {
  /** 实时同步总开关（手动）。两端都必须打开才真正同步。 */
  enabled: boolean;
  /** 本端角色：play = 游玩端(生成/工具/自由活动)；remote = 遥控端(只读+转发 user)。 */
  role: SyncRole;
  /** 轮询间隔（秒），默认 4。 */
  pollIntervalSeconds: number;
  /** 已同步水位：拉取时只处理晚于该时间戳的新文件，避免重复与全量重扫。 */
  lastSyncedAt: string;
  /** Supabase 项目地址，如 https://xxxx.supabase.co */
  url: string;
  /** Supabase anon public key（浏览器端只用 anon，不携带 service_role）。 */
  anonKey: string;
};

export const DEFAULT_SYNC_CONFIG: StardewSyncConfig = {
  enabled: false,
  role: "play",
  pollIntervalSeconds: 2,
  lastSyncedAt: "",
  url: "",
  anonKey: "",
};

function normalizeUrl(url: string): string {
  const t = (url || "").trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(t) ? t : (t ? `https://${t}` : "");
}

function clampPoll(n: number): number {
  return Math.min(30, Math.max(2, Number.isFinite(n) ? Math.round(n) : 4));
}

export function loadSyncConfig(): StardewSyncConfig {
  try {
    const raw = kvGet(SYNC_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_SYNC_CONFIG };
    const p = JSON.parse(raw) as Partial<StardewSyncConfig>;
    return {
      enabled: Boolean(p.enabled),
      role: p.role === "remote" ? "remote" : "play",
      pollIntervalSeconds: clampPoll(p.pollIntervalSeconds ?? 4),
      lastSyncedAt: typeof p.lastSyncedAt === "string" ? p.lastSyncedAt : "",
      url: normalizeUrl(p.url ?? ""),
      anonKey: String(p.anonKey ?? "").trim(),
    };
  } catch {
    return { ...DEFAULT_SYNC_CONFIG };
  }
}

export function saveSyncConfig(config: StardewSyncConfig): void {
  kvSet(SYNC_CONFIG_KEY, JSON.stringify({
    ...DEFAULT_SYNC_CONFIG,
    ...config,
    url: normalizeUrl(config.url),
    anonKey: (config.anonKey || "").trim(),
    pollIntervalSeconds: clampPoll(config.pollIntervalSeconds),
  }));
}

export function isSyncConfigured(config: StardewSyncConfig): boolean {
  return Boolean(normalizeUrl(config.url) && config.anonKey.trim());
}