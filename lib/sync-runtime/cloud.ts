// lib/sync-runtime/cloud.ts
// PC↔手机「实时同步」云文件读写。
// 复用 cloud-backup/storage-client 的 putObject/listObjects/getObject（匿名 anon key + REST + 超时重试），
// 但把读写范围限制到自有的 sync/ 前缀，与现有备份的 modules/media 隔离。

import { putObject, listObjects, getObject } from "../cloud-backup/storage-client";
import type { CloudBackupConfig } from "../cloud-backup/config";
import type { StardewSyncConfig } from "./config";

// 同步专用桶：沿用 ai-phone-backup（避免新建桶 + 策略），但所有同步对象都放 sync/ 前缀。
export const SYNC_BUCKET_PREFIX = "sync/";

export type SyncObject = {
  path: string;      // 完整对象路径，如 sync/upsert/user/<session>/<nonce>.json
  ts: string;        // 该对象内携带的时间戳（与 lastSyncedAt 水位比较用）
  name: string;      // 对象名（最后一个路径段）
};

/** 把 sync 配置映射成 storage-client 需要的 CloudBackupConfig（含 bucket）。 */
function toCloudConfig(cfg: StardewSyncConfig): CloudBackupConfig {
  return {
    url: cfg.url,
    key: cfg.anonKey, // 只用 publishable/anon，绝不携带 service_role
    enabled: true,
    intervalHours: 1,
    keepCount: 3,
    excludeMedia: true,
  };
}

function objectPath(prefix: string, key: string): string {
  return `${SYNC_BUCKET_PREFIX}${prefix.replace(/^\/+/, "")}/${key.replace(/^\/+/, "")}`;
}

/** 把一个 JSON 对象写到 sync/<prefix>/<key>.json。 */
export async function writeSyncObject(
  cfg: StardewSyncConfig,
  prefix: string,
  key: string,
  data: unknown,
): Promise<void> {
  const path = `${objectPath(prefix, key)}.json`;
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  await putObject(toCloudConfig(cfg), path, blob, "application/json");
}

/** 列出 sync/<prefix>/ 下所有对象（扁平列表）。返回带 key(去掉 .json) 与 ts(updatedAt)。 */
export async function listSyncObjects(cfg: StardewSyncConfig, prefix: string): Promise<SyncObject[]> {
  const base = `${SYNC_BUCKET_PREFIX}${prefix.replace(/^\/+/, "")}`;
  const objects = await listObjects(toCloudConfig(cfg), base);
  return objects.map(o => {
    const fullPath = `${base}/${o.name}`;
    const name = o.name.replace(/\.json$/, "");
    return { path: fullPath, ts: o.updatedAt ?? "", name };
  });
}

/** 读取并解析 sync/<prefix>/<key>.json。 */
export async function readSyncObject<T = unknown>(
  cfg: StardewSyncConfig,
  fullPath: string,
): Promise<T | null> {
  const blob = await getObject(toCloudConfig(cfg), fullPath);
  if (!blob) return null;
  try {
    return JSON.parse(await blob.text()) as T;
  } catch {
    return null;
  }
}