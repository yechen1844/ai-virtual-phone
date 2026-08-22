// lib/complex-memory/feed-audit.ts
// 投喂审计：记录复杂记忆每次生成时「实际发给模型」的完整 prompt（不截断），
// 供查看器「投喂审计」页签回看，彻底定位到底给模型发了什么 —— 尤其排查时间/内容污染。
// 与底层调用日志不同：底层日志单条截断到 4000 字，这里保留全文用于审计。

import { kvGet, kvSet, kvRemove, registerDynamicPrefix } from "../kv-db";

export type FeedAuditKind = "event" | "daily" | "period" | "core";

export type FeedAuditEntry = {
  id: string;
  characterId: string;
  characterName: string;
  kind: FeedAuditKind;        // 生成环节类型
  date?: string;              // 归属日期（事件/日记为当天；周期/核心可能缺省）
  prompt: string;             // 完整投喂 prompt（不截断）
  response: string;           // 模型返回内容（截断到合理上限）
  model?: string;
  timestamp: string;          // 审计记录写入时刻
};

const AUDIT_KEY = "ai_phone_complex_memory_feed_audit_v1";
registerDynamicPrefix(AUDIT_KEY);

// 保留条数上限与总字符预算：控制 IndexedDB 常驻体积。
const MAX_ENTRIES = 50;
const MAX_SERIALIZED_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_CHARS = 8000;

function load(): FeedAuditEntry[] {
  try {
    const raw = typeof window !== "undefined" ? kvGet(AUDIT_KEY) : null;
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FeedAuditEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: FeedAuditEntry[]): void {
  // 从最新开始保留，直到超出条数或字符预算
  const picked: FeedAuditEntry[] = [];
  let chars = 2;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    const entryChars = JSON.stringify(e).length;
    if (picked.length >= MAX_ENTRIES || chars + entryChars > MAX_SERIALIZED_CHARS) break;
    picked.push(e);
    chars += entryChars;
  }
  picked.reverse();
  try {
    kvSet(AUDIT_KEY, JSON.stringify(picked));
  } catch {
    /* 审计写入失败不影响主流程 */
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[截断：原文共 ${text.length} 字符]`;
}

/** 追加一条投喂审计记录。 */
export function pushFeedAudit(
  entry: Omit<FeedAuditEntry, "id" | "timestamp">,
): void {
  const entries = load();
  entries.push({
    ...entry,
    response: truncate(entry.response, MAX_RESPONSE_CHARS),
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
  });
  save(entries);
}

/** 读取全部投喂审计（新→旧）。 */
export function getFeedAudit(): FeedAuditEntry[] {
  return load().slice().reverse();
}

/** 清空投喂审计。 */
export function clearFeedAudit(): void {
  try {
    kvRemove(AUDIT_KEY);
  } catch {
    /* 忽略 */
  }
}
