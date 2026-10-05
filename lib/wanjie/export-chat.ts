// lib/wanjie/export-chat.ts
// 万界 · 聊天记录导出接口（float 侧）
//
// 作用：把 float 里某个角色的聊天记录，原样导出成一个 JSON 文件，交给外部（sully）整理成记忆。
//
// 四条约束：
//   1. 只读——全部走 chat-storage 的公开读接口，不写任何存储。
//   2. 保序——按会话内 order / createdAt 排出真实先后。
//   3. 保真——正文原样，只附带 role、时间、媒体类型、来源；**不做任何摘要或改写**。
//   4. 幂等友好——每条都带原 id，对方按 id 去重即可。
//
// 触发方式：
//   浏览器控制台执行 `__wanjieExportChat()`——默认导出第一个角色；
//   或 `__wanjieExportChat("角色ID")` 指定角色；`__wanjieExportChat.list()` 先看有哪些角色。

import { loadCharacters } from "../character-storage";
import {
    loadChatContacts,
    loadChatSessions,
    loadChatMessages,
    compareChatMessages,
    type ChatMessage,
} from "../chat-storage";

export const WANJIE_CHAT_EXPORT_FORMAT = "wanjie-chat-export";
export const WANJIE_CHAT_EXPORT_VERSION = 1;

/** 导出的一条消息（只保留重建"聊天记录"所需的字段） */
export type WanjieExportMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    createdAt: string;
    /** 非文字气泡的类型（文字消息没有这个字段） */
    mediaType?: string;
    /** 非文字气泡的人话摘要：金额 / 位置名 / 表情名 / 引用预览…… */
    mediaLabel?: string;
    /** 来源：chat / reading_discuss / movie_discuss / reading_note… */
    origin?: string;
    /** 已撤回的消息：正文不导出，只留时间 */
    retracted?: boolean;
};

export type WanjieChatExport = {
    format: typeof WANJIE_CHAT_EXPORT_FORMAT;
    version: number;
    sourceApp: "float";
    exportedAt: number;
    character: { id: string; name: string; handle?: string };
    sessions: Array<{
        id: string;
        kind: "private" | "group";
        name?: string;
        messageCount: number;
    }>;
    messageCount: number;
    earliest: string | null;
    latest: string | null;
    /** 按时间升序，已合并全部会话 */
    messages: WanjieExportMessage[];
};

/** 把一条原生消息压成导出形状。返回 null 表示这条不该导出。 */
function toExportMessage(m: ChatMessage): WanjieExportMessage | null {
    if (!m || typeof m.id !== "string") return null;
    const retracted = m.isRetracted === true;
    const content = retracted ? "" : (m.content ?? "");
    const hasMedia = typeof m.mediaType === "string" && m.mediaType.length > 0;
    // 既没正文也没媒体壳的消息（例如纯 loading 壳）——丢掉，免得污染对方的聊天记录
    if (!content && !hasMedia) return null;

    const out: WanjieExportMessage = {
        id: m.id,
        role: m.role,
        content,
        createdAt: m.createdAt,
    };
    if (hasMedia) out.mediaType = m.mediaType;
    if (m.mediaData?.label) out.mediaLabel = m.mediaData.label;
    else if (m.mediaData?.quotePreview) out.mediaLabel = m.mediaData.quotePreview;
    if (m.origin) out.origin = m.origin;
    if (retracted) out.retracted = true;
    return out;
}

/**
 * 纯函数：构造导出包（不触发下载，方便测试与二次加工）。
 *
 * @param characterId 目标角色 id
 * @param options.includeGroups 是否包含群聊（默认 false——搬给 sully 的是 1 对 1 的私聊）
 */
export function buildWanjieChatExport(
    characterId: string,
    options: { includeGroups?: boolean } = {},
): { ok: true; data: WanjieChatExport } | { ok: false; error: string } {
    const char = loadCharacters().find((c) => c.id === characterId);
    if (!char) return { ok: false, error: `找不到角色 ${characterId}` };

    const contacts = loadChatContacts().filter((c) => c.characterId === characterId);
    if (contacts.length === 0) {
        return { ok: false, error: `角色「${char.name}」还没有任何会话，没有可导出的聊天记录` };
    }
    const contactIds = new Set(contacts.map((c) => c.id));

    const sessions = loadChatSessions().filter((s) => {
        if (!contactIds.has(s.contactId)) return false;
        if (s.isGroup && !options.includeGroups) return false;
        return true;
    });
    if (sessions.length === 0) {
        return { ok: false, error: `角色「${char.name}」只有群聊会话，当前设置不导出群聊` };
    }

    const collected: WanjieExportMessage[] = [];
    const sessionMeta: WanjieChatExport["sessions"] = [];

    for (const session of sessions) {
        const raw = loadChatMessages(session.id);
        const sorted = [...raw].sort(compareChatMessages);
        let count = 0;
        for (const m of sorted) {
            const item = toExportMessage(m);
            if (!item) continue;
            collected.push(item);
            count += 1;
        }
        sessionMeta.push({
            id: session.id,
            kind: session.isGroup ? "group" : "private",
            name: session.groupName || session.alias,
            messageCount: count,
        });
    }

    collected.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return {
        ok: true,
        data: {
            format: WANJIE_CHAT_EXPORT_FORMAT,
            version: WANJIE_CHAT_EXPORT_VERSION,
            sourceApp: "float",
            exportedAt: Date.now(),
            character: { id: char.id, name: char.name },
            sessions: sessionMeta,
            messageCount: collected.length,
            earliest: collected[0]?.createdAt ?? null,
            latest: collected[collected.length - 1]?.createdAt ?? null,
            messages: collected,
        },
    };
}

function safeFileName(name: string): string {
    return (name || "character").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
}

/** 触发浏览器下载。返回一句给用户看的结果。 */
export function downloadWanjieChatExport(
    characterId: string,
    options: { includeGroups?: boolean } = {},
): { ok: boolean; message: string } {
    const built = buildWanjieChatExport(characterId, options);
    if (!built.ok) return { ok: false, message: built.error };
    const { data } = built;

    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const fileName = `wanjie-chat-${safeFileName(data.character.name)}-${stamp}.json`;
    const text = JSON.stringify(data, null, 2);

    try {
        const blob = new Blob([text], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
        return { ok: false, message: `下载失败：${(e as Error)?.message || e}` };
    }

    return {
        ok: true,
        message: `已导出 ${data.messageCount} 条（${data.earliest || "?"} ~ ${data.latest || "?"}）→ ${fileName}`,
    };
}

/** 列出可以导出的角色，方便挑 id。 */
export function listExportableCharacters(): Array<{ id: string; name: string }> {
    return loadCharacters().map((c) => ({ id: c.id, name: c.name }));
}

type WanjieExportApi = ((characterId?: string) => string) & {
    list: typeof listExportableCharacters;
    build: typeof buildWanjieChatExport;
    all: (options?: { includeGroups?: boolean }) => string;
};

/**
 * 把导出接口挂到 window，供控制台/万界壳直接调用。
 * 幂等：重复调用只覆盖同一个 key。
 */
export function attachWanjieChatExportToWindow(): void {
    if (typeof window === "undefined") return;

    const api = ((characterId?: string): string => {
        const chars = listExportableCharacters();
        const target = characterId || chars[0]?.id;
        if (!target) return "没有可导出的角色";
        const r = downloadWanjieChatExport(target);
        return r.message;
    }) as WanjieExportApi;

    api.list = listExportableCharacters;
    api.build = buildWanjieChatExport;
    /** 一次性导出全部角色（每个角色一个文件） */
    api.all = (options) => {
        const chars = listExportableCharacters();
        const lines: string[] = [];
        for (const c of chars) {
            const r = downloadWanjieChatExport(c.id, options);
            if (r.ok) lines.push(`· ${c.name}: ${r.message}`);
        }
        return lines.length ? lines.join("\n") : "没有可导出的聊天记录";
    };

    (window as unknown as Record<string, unknown>).__wanjieExportChat = api;
    console.log(
        "[万界] 聊天记录导出已就绪：\n" +
        "  __wanjieExportChat.list()          看有哪些角色\n" +
        "  __wanjieExportChat()               导出第一个角色\n" +
        "  __wanjieExportChat('角色ID')       导出指定角色\n" +
        "  __wanjieExportChat.all()           导出全部角色",
    );
}

/** 与 installWanjieBridge 命名保持一致，供 main-app 调用。 */
export const installWanjieChatExporter = attachWanjieChatExportToWindow;
