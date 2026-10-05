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

async function fetchWithRetry(url: string, init: RequestInit, retries = 2, timeoutMs = 15000): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...init, signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok && attempt < retries && (res.status >= 500 || res.status === 429)) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            return res;
        } catch (err: any) {
            clearTimeout(timer);
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                continue;
            }
            throw new Error(err.name === 'AbortError' ? '请求云端水库超时 (15s)' : `网络连接失败: ${err.message || err}`);
        }
    }
    throw new Error('网络请求异常');
}

export async function fetchCanalStatus(serverUrl?: string): Promise<CanalStatus> {
    const base = serverUrl || getCanalServerUrl();
    const res = await fetchWithRetry(`${base}/api/sync/status`, { method: "GET" });
    if (!res.ok) throw new Error(`云端状态查询失败 (HTTP ${res.status})`);
    return res.json();
}

/**
 * 上传 Float 本机经历（聊天 + 活动卡片时间线）到云端
 */
export async function uploadFloatMessages(
    characterId: string,
    characterName: string,
    options?: {
        full?: boolean;
        serverUrl?: string;
        onProgress?: (progress: { current: number; total: number; batchIndex: number; totalBatches: number }) => void;
    }
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
                mediaType: item.mediaType,
                mediaData: item.mediaData,
                mediaUrl: item.mediaUrl,
            },
        };
    });

    // 分批上传，每批 100 条
    const BATCH_SIZE = 100;
    const totalBatches = Math.ceil(canalMessages.length / BATCH_SIZE);
    let insertedTotal = 0;
    for (let i = 0; i < canalMessages.length; i += BATCH_SIZE) {
        const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
        const batch = canalMessages.slice(i, i + BATCH_SIZE);
        options?.onProgress?.({
            current: i + batch.length,
            total: canalMessages.length,
            batchIndex,
            totalBatches,
        });

        const res = await fetchWithRetry(`${base}/api/sync/upload`, {
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
 * 重置角色的拉取时间游标（默认重置为 2026-10-03 00:00:00）
 */
export function resetPullCursor(characterId: string, timestamp?: number): void {
    const ts = timestamp ?? new Date("2026-10-03T00:00:00.000Z").getTime();
    try {
        localStorage.setItem(STORAGE_KEY_LAST_PULL_TS + characterId, String(ts));
    } catch {}
}

/**
 * 从云端拉取其它端（如 SullyOS）的消息供预览
 * 支持全量分页拉取（杜绝 1000 条截断），自动过滤 2026-10-03 搬家分界线前的历史
 */
export async function pullCloudMessages(
    characterId: string,
    options?: {
        since?: number;
        limit?: number;
        serverUrl?: string;
        targetSource?: string;
        onProgress?: (count: number) => void;
    }
): Promise<{ messages: CanalMessage[]; latestTimestamp: number; count: number }> {
    const base = options?.serverUrl || getCanalServerUrl();
    const OCT3_2026_TS = new Date("2026-10-03T00:00:00.000Z").getTime();

    let currentSince = options?.since ?? (() => {
        try {
            const saved = Number(localStorage.getItem(STORAGE_KEY_LAST_PULL_TS + characterId) || 0);
            return saved > 0 ? saved : OCT3_2026_TS;
        } catch {
            return OCT3_2026_TS;
        }
    })();

    // 严格限制：不能早于 2026-10-03 搬家分界线
    if (currentSince < OCT3_2026_TS) {
        currentSince = OCT3_2026_TS;
    }

    const batchLimit = 5000;
    const allMessages: CanalMessage[] = [];
    const maxFetchCount = options?.limit || 20000;
    let latestTs = currentSince;

    while (allMessages.length < maxFetchCount) {
        const url = new URL(`${base}/api/sync/pull`);
        url.searchParams.set("source", "float"); // 拉取非 float 来源
        if (options?.targetSource) url.searchParams.set("target_source", options.targetSource);
        url.searchParams.set("since", String(currentSince));
        url.searchParams.set("limit", String(batchLimit));

        const res = await fetchWithRetry(url.toString(), { method: "GET" });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`拉取失败 (HTTP ${res.status}): ${err.message || "未知错误"}`);
        }

        const data = await res.json();
        const batch: CanalMessage[] = data.messages || [];
        if (batch.length === 0) break;

        // 严格安全守卫：剔除任何早于 2026-10-03 的脏数据
        const validBatch = batch.filter((m) => m.timestamp >= OCT3_2026_TS);
        allMessages.push(...validBatch);

        const newLatest = data.latest_timestamp || batch[batch.length - 1].timestamp || currentSince;
        if (newLatest <= currentSince) {
            // 避免死循环
            break;
        }
        latestTs = newLatest;
        currentSince = latestTs;

        if (options?.onProgress) {
            options.onProgress(allMessages.length);
        }

        if (batch.length < batchLimit) break;
    }

    return {
        messages: allMessages,
        latestTimestamp: latestTs,
        count: allMessages.length,
    };
}

import type { ChatMessage } from "../chat-storage";

/**
 * 转换来自 SullyOS 等异构系统的双语标记为 Float 原生「原文 | 译文」格式
 */
export function convertForeignBilingualToFloat(content: string): string {
    if (!content) return content;
    // 形式 1: 原文\n%%BILINGUAL%%\n译文 (可能有多行)
    if (/%%BILINGUAL%%/i.test(content)) {
        const [origPart, transPart] = content.split(/%%BILINGUAL%%/i);
        const orig = (origPart || "").trim();
        const trans = (transPart || "").trim();
        if (orig && trans) {
            if (!orig.includes("\n") && !trans.includes("\n")) {
                return `${orig} | ${trans}`;
            }
            const origLines = orig.split("\n").map(l => l.trim()).filter(Boolean);
            const transLines = trans.split("\n").map(l => l.trim()).filter(Boolean);
            if (origLines.length === transLines.length && origLines.length > 1) {
                return origLines.map((ol, i) => `${ol} | ${transLines[i]}`).join("\n");
            }
            return `${orig.replace(/\n+/g, " ")} | ${trans.replace(/\n+/g, " ")}`;
        }
    }
    // 形式 2: <翻译><原文>A</原文><译文>B</译文></翻译>
    const tagMatch = content.match(/<原文>([\s\S]*?)<\/原文>[\s\S]*?<译文>([\s\S]*?)<\/译文>/i);
    if (tagMatch) {
        const orig = tagMatch[1].trim();
        const trans = tagMatch[2].trim();
        if (orig && trans) {
            return `${orig} | ${trans}`;
        }
    }
    // 形式 3: 结尾另起一行的【中】译文块
    const zhBlockMatch = content.match(/^([\s\S]*?)(?:\n[ \t]*【中】([\s\S]*))$/);
    if (zhBlockMatch) {
        const orig = zhBlockMatch[1].trim();
        const trans = (zhBlockMatch[2] || "").trim();
        if (orig && trans) {
            return `${orig} | ${trans}`;
        }
    }
    return content;
}

/**
 * 用户手动确认后：把拉取到的消息导入进 Float 聊天会话
 */
export async function importPulledMessagesToFloat(
    characterId: string,
    messages: CanalMessage[]
): Promise<{ imported: number; total: number }> {
    const OCT3_2026_TS = new Date("2026-10-03T00:00:00.000Z").getTime();
    const safeMessages = messages.filter((m) => m.timestamp >= OCT3_2026_TS);
    if (safeMessages.length === 0) return { imported: 0, total: 0 };

    const foreignItems: ForeignMessageInput[] = safeMessages.map((m) => {
        let metaObj: Record<string, unknown> = {};
        if (m.meta) {
            try {
                metaObj = typeof m.meta === "string" ? JSON.parse(m.meta) : (m.meta as Record<string, unknown>);
            } catch {}
        }

        const type = (metaObj.type as string) || "";
        let content = convertForeignBilingualToFloat(m.content);
        let mediaType: ChatMessage["mediaType"] | undefined;
        let mediaData: ChatMessage["mediaData"] | undefined;
        let mediaUrl: string | undefined;
        let kind: "text" | "card" = "text";

        // 1. 表情包 (SullyOS: type === 'emoji')
        if (type === "emoji" || type === "sticker") {
            const stickerUrl = (metaObj.url as string) || m.content;
            const emojiName = (metaObj.emojiName as string) || "表情包";
            mediaType = "sticker";
            mediaUrl = stickerUrl;
            mediaData = {
                stickerUrl,
                label: emojiName,
            };
            content = `[表情包:${emojiName}]`;
        }
        // 2. 转账卡 (SullyOS: type === 'transfer')
        else if (type === "transfer") {
            const amount = Number(metaObj.amount) || 0;
            const label = (metaObj.receipt as string) || "转账";
            const status = (metaObj.status as any) || "received";
            mediaType = "transfer";
            mediaData = {
                amount,
                label,
                status,
            };
            content = `[转账:${amount}:${label}]`;
        }
        // 3. 拍一拍 / 戳一戳 (SullyOS: type === 'interaction')
        else if (type === "interaction") {
            mediaType = "poke";
            content = content || "[系统: 拍了拍]";
        }
        // 4. 其他各类卡片 (score_card, music_card, reading_card, movie_card, xhs_card, theater_card 等)
        else if (metaObj.isCard || type.endsWith("_card") || metaObj.scoreCard) {
            kind = "card";
            mediaType = "wanjie_card";
        }

        return {
            id: m.id,
            role: m.role === "assistant" ? "assistant" : "user",
            content,
            createdAt: new Date(m.timestamp).toISOString(),
            kind,
            mediaType,
            mediaData,
            mediaUrl,
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
