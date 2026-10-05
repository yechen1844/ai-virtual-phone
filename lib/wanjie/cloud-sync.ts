// lib/wanjie/cloud-sync.ts
// 万界云水库 · 双向同步客户端 (Float 侧)

import { exportShortTerm, importForeignMessages, type ForeignMessageInput } from "./bridge";

export const DEFAULT_CANAL_SERVER_URL = "https://wanjie-canal.luyi90720.workers.dev";
const STORAGE_KEY_SERVER_URL = "wanjie_canal_server_url";
const STORAGE_KEY_LAST_UPLOAD_TS = "wanjie_canal_last_upload_ts_";
const STORAGE_KEY_LAST_PULL_TS = "wanjie_canal_last_pull_ts_";

export interface CanalMessage {
    id: string;
    source: "float" | "sullyos" | string;
    char_id: string;
    char_name?: string;
    role: "user" | "assistant" | "system" | string;
    content: string;
    timestamp: number;
    meta?: Record<string, unknown> | string | null;
    created_at?: number;
}

export interface CanalStatus {
    ok: boolean;
    stats: {
        total_messages: number;
        oldest_timestamp: number | null;
        latest_timestamp: number | null;
        by_source: { source: string; count: number }[];
    };
}

export function getCanalServerUrl(): string {
    if (typeof window === "undefined") return DEFAULT_CANAL_SERVER_URL;
    try {
        const saved = localStorage.getItem(STORAGE_KEY_SERVER_URL);
        if (saved && saved.trim()) return saved.trim().replace(/\/+$/, "");
    } catch {}
    return DEFAULT_CANAL_SERVER_URL;
}

export function setCanalServerUrl(url: string): void {
    if (typeof window === "undefined") return;
    try {
        if (!url || !url.trim()) {
            localStorage.removeItem(STORAGE_KEY_SERVER_URL);
        } else {
            localStorage.setItem(STORAGE_KEY_SERVER_URL, url.trim().replace(/\/+$/, ""));
        }
    } catch {}
}

export async function fetchCanalStatus(serverUrl?: string): Promise<CanalStatus> {
    const base = serverUrl || getCanalServerUrl();
    const res = await fetch(`${base}/api/sync/status`);
    if (!res.ok) throw new Error(`云端状态查询失败 (HTTP ${res.status})`);
    return res.json();
}

/**
 * 上传 Float 本机经历（聊天 + 活动卡片时间线）到云端
 */
export async function uploadFloatMessages(
    characterId: string,
    characterName: string,
    options?: { full?: boolean; serverUrl?: string }
): Promise<{ success: boolean; uploadedCount: number; totalFound: number }> {
    const base = options?.serverUrl || getCanalServerUrl();

    // 导出该角色的短期经历（聊天 + 活动时间线）
    const { items } = await exportShortTerm(characterId);

    const lastUploadTs = options?.full ? 0 : (() => {
        try {
            return Number(localStorage.getItem(STORAGE_KEY_LAST_UPLOAD_TS + characterId) || 0);
        } catch {
            return 0;
        }
    })();

    const toUpload = items.filter((item) => {
        const ts = new Date(item.createdAt).getTime();
        if (lastUploadTs > 0 && ts <= lastUploadTs) return false;
        return true;
    });

    if (toUpload.length === 0) {
        return { success: true, uploadedCount: 0, totalFound: items.length };
    }

    const canalMessages: CanalMessage[] = toUpload.map((item) => {
        const ts = new Date(item.createdAt).getTime();
        return {
            id: `float:${characterId}:${item.id}`,
            source: "float",
            char_id: characterId,
            char_name: characterName,
            role: item.role,
            content: item.content,
            timestamp: ts,
            meta: {
                kind: item.kind,
                sourceApp: item.sourceApp,
            },
        };
    });

    // 分批上传，每批 100 条
    const BATCH_SIZE = 100;
    let insertedTotal = 0;
    for (let i = 0; i < canalMessages.length; i += BATCH_SIZE) {
        const batch = canalMessages.slice(i, i + BATCH_SIZE);
        const res = await fetch(`${base}/api/sync/upload`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source: "float",
                messages: batch,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`上传失败 (HTTP ${res.status}): ${err.message || "未知错误"}`);
        }
        const data = await res.json();
        insertedTotal += data.inserted || batch.length;
    }

    // 记录最新上传时间戳
    const maxTs = Math.max(...canalMessages.map((m) => m.timestamp));
    try {
        localStorage.setItem(STORAGE_KEY_LAST_UPLOAD_TS + characterId, String(maxTs));
    } catch {}

    return { success: true, uploadedCount: canalMessages.length, totalFound: items.length };
}

/**
 * 从云端拉取其它端（如 SullyOS）的消息供预览
 */
export async function pullCloudMessages(
    characterId: string,
    options?: { since?: number; limit?: number; serverUrl?: string; targetSource?: string }
): Promise<{ messages: CanalMessage[]; latestTimestamp: number; count: number }> {
    const base = options?.serverUrl || getCanalServerUrl();
    const since = options?.since ?? (() => {
        try {
            return Number(localStorage.getItem(STORAGE_KEY_LAST_PULL_TS + characterId) || 0);
        } catch {
            return 0;
        }
    })();

    const limit = options?.limit || 1000;
    const url = new URL(`${base}/api/sync/pull`);
    url.searchParams.set("source", "float"); // 拉取非 float 来源
    if (options?.targetSource) url.searchParams.set("target_source", options.targetSource);
    url.searchParams.set("since", String(since));
    url.searchParams.set("limit", String(limit));

    const res = await fetch(url.toString());
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`拉取失败 (HTTP ${res.status}): ${err.message || "未知错误"}`);
    }

    const data = await res.json();
    return {
        messages: data.messages || [],
        latestTimestamp: data.latest_timestamp || since,
        count: data.count || 0,
    };
}

/**
 * 用户手动确认后：把拉取到的消息导入进 Float 聊天会话
 */
export async function importPulledMessagesToFloat(
    characterId: string,
    messages: CanalMessage[]
): Promise<{ imported: number; total: number }> {
    if (messages.length === 0) return { imported: 0, total: 0 };

    const foreignItems: ForeignMessageInput[] = messages.map((m) => {
        let metaObj: Record<string, unknown> = {};
        if (m.meta) {
            try {
                metaObj = typeof m.meta === "string" ? JSON.parse(m.meta) : m.meta;
            } catch {}
        }
        return {
            id: m.id,
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
            createdAt: new Date(m.timestamp).toISOString(),
            kind: metaObj.kind === "card" ? "card" : "text",
        };
    });

    const res = await importForeignMessages(characterId, "sullyos", foreignItems);
    if (!res.success) {
        throw new Error(res.error || "导入外来记录失败");
    }

    // 更新已拉取的时间戳游标
    const maxTs = Math.max(...messages.map((m) => m.timestamp));
    try {
        localStorage.setItem(STORAGE_KEY_LAST_PULL_TS + characterId, String(maxTs));
    } catch {}

    return { imported: res.imported ?? foreignItems.length, total: foreignItems.length };
}
