// lib/dwelling-history.ts
// 栖所历史记录：只存轻量元数据（类型/标题/时间），不存 HTML 正文，避免存储膨胀。
// 数据按角色分 key 存 localStorage，且仅在打开历史面板时读取（懒加载）。

import { kvGet, kvRemove, kvSet, registerDynamicPrefix } from "./kv-db";

const EVENT_PREFIX = "ai_phone_dwelling_events_";
/** 每个角色最多保留的历史条数（超出自动淘汰最旧的） */
const MAX_EVENTS_PER_CHARACTER = 150;

registerDynamicPrefix(EVENT_PREFIX);

export type DwellingHistoryKind = "layout" | "refresh_items" | "explore" | "explore_batch";

export type DwellingHistoryEntry = {
    id: string;
    kind: DwellingHistoryKind;
    timestamp: string;
    title: string;
    detail?: string;
};

function storageKey(characterId: string): string {
    return `${EVENT_PREFIX}${characterId}`;
}

function cleanText(value: unknown, maxLength: number): string {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function loadByKey(key: string): DwellingHistoryEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(key);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const kinds: DwellingHistoryKind[] = ["layout", "refresh_items", "explore", "explore_batch"];
        return parsed
            .filter((entry): entry is DwellingHistoryEntry =>
                entry
                && typeof entry.id === "string"
                && kinds.includes(entry.kind)
                && typeof entry.timestamp === "string"
                && typeof entry.title === "string"
            )
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
        return [];
    }
}

function saveByKey(key: string, entries: DwellingHistoryEntry[]): void {
    if (typeof window === "undefined") return;
    const compacted = [...entries]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(-MAX_EVENTS_PER_CHARACTER);
    kvSet(key, JSON.stringify(compacted));
}

/** 读取某角色的历史记录（最新在前）。仅在打开历史面板时调用。 */
export function loadDwellingHistoryEntries(characterId: string): DwellingHistoryEntry[] {
    if (!characterId) return [];
    return loadByKey(storageKey(characterId)).reverse();
}

let eventSeq = 0;

/** 记录一条历史事件（生成布局/刷新物品/探索物品/批量探索）。 */
export function recordDwellingHistoryEvent(
    characterId: string,
    event: { kind: DwellingHistoryKind; title: string; detail?: string },
): void {
    if (!characterId || typeof window === "undefined") return;
    const title = cleanText(event.title, 80);
    if (!title) return;
    const timestamp = new Date().toISOString();
    const entry: DwellingHistoryEntry = {
        id: `dw_${Date.parse(timestamp) || Date.now()}_${eventSeq++}`,
        kind: event.kind,
        timestamp,
        title,
        detail: event.detail ? cleanText(event.detail, 80) : undefined,
    };
    const key = storageKey(characterId);
    const current = loadByKey(key);
    saveByKey(key, [entry, ...current.filter((item) => item.id !== entry.id)]);
}

/** 删除一条历史记录。 */
export function removeDwellingHistoryEntry(characterId: string, entryId: string): void {
    if (!characterId || typeof window === "undefined") return;
    const key = storageKey(characterId);
    const remaining = loadByKey(key).filter((entry) => entry.id !== entryId);
    if (remaining.length === 0) {
        kvRemove(key);
        return;
    }
    saveByKey(key, remaining);
}

/** 清空某角色的全部历史记录。 */
export function clearDwellingHistory(characterId: string): void {
    if (!characterId || typeof window === "undefined") return;
    kvRemove(storageKey(characterId));
}
