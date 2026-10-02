// lib/chat-export.ts
// 聊天记录导出：按角色/会话勾选，产出两种文件——
//   ① JSON：保留结构化字段（角色、会话、消息、状态值、内心、状态栏等），便于日后导入/迁移；
//   ② Markdown：给人阅读的排版文本。
// 媒体一律只取「文字」：语音导出其文字、表情包导出名称，不导出图片/音频等二进制文件。

import { loadChatMessages, loadChatSessions, type ChatMessage, type ChatMessageRole } from "./chat-storage";
import { loadCharacters } from "./character-storage";

export const CHAT_EXPORT_APP = "float";
export const CHAT_EXPORT_VERSION = 1;

export type ChatExportStateValue = { name: string; value: number };

export type ChatExportMessage = {
    id: string;
    role: ChatMessageRole;
    createdAt: string;
    senderName?: string;
    /** 正文文本；媒体消息的正文可能为空，文字化说明见 mediaText */
    content: string;
    /** 媒体类型（image / audio / sticker / red_packet …） */
    mediaType?: string;
    /** 媒体的文字化描述：语音=其文字，表情=表情名，红包=金额… */
    mediaText?: string;
    /** 滑动引用的预览文本 */
    quote?: string;
    /** 角色内心独白 */
    innerMonologue?: string;
    /** 状态栏原文 */
    statusPanel?: string;
    /** 本轮回复实际输出的状态值 */
    stateValues?: ChatExportStateValue[];
    origin?: string;
};

export type ChatExportSession = {
    sessionId: string;
    characterId: string;
    characterName: string;
    /** 单聊=角色名（有备注则用备注）；群聊=群名 */
    title: string;
    isGroup: boolean;
    /** 群聊成员名（仅群聊） */
    groupMembers?: string[];
    userName: string;
    messageCount: number;
    firstMessageAt?: string;
    lastMessageAt?: string;
    messages: ChatExportMessage[];
};

export type ChatExportBundle = {
    app: typeof CHAT_EXPORT_APP;
    version: number;
    exportedAt: string;
    sessionCount: number;
    messageCount: number;
    sessions: ChatExportSession[];
};

/** 会话选择列表用的一行摘要（打开弹窗时算一次，避免反复读消息） */
export type ChatExportSessionOption = {
    sessionId: string;
    characterId: string;
    characterName: string;
    title: string;
    isGroup: boolean;
    messageCount: number;
    lastMessageAt?: string;
};

const MEDIA_TEXT_LABELS: Record<string, string> = {
    image: "图片",
    audio: "语音",
    video: "视频",
    red_packet: "红包",
    transfer: "转账",
    location: "位置",
    poke: "拍一拍",
    sticker: "表情包",
    quote: "引用",
    dice: "掷骰子",
    voice_call: "语音通话",
    video_call: "视频通话",
    accept_red_packet: "已领取红包",
    decline_red_packet: "已拒收红包",
    accept_transfer: "已收款",
    decline_transfer: "已退回转账",
    payment_request: "代付请求",
    accept_payment_request: "已接受代付",
    decline_payment_request: "已拒绝代付",
    music: "音乐",
    music_share: "音乐分享",
    music_notify: "音乐状态",
    music_not_found: "音乐未找到",
    xiaohongshu_note_share: "小红书帖子",
    gift: "礼物",
    contact_card: "名片",
    app_card: "应用卡片",
    tool_notice: "工具提示",
    tool_call: "工具调用",
    tool_result: "工具结果",
    memory_write_request: "记忆写入",
    reading_discuss: "阅读讨论",
    reading_note: "阅读笔记",
    movie_discuss: "观影讨论",
    system_instruction: "系统指令",
    group_admin_notice: "群管理通知",
    media_file: "文件",
};

function trimmed(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** 把一条消息的媒体转成文字描述（语音取其文字、表情取表情名；不涉及二进制） */
export function describeMessageMedia(msg: ChatMessage): string | undefined {
    const type = msg.mediaType;
    if (!type) return undefined;
    if (type.startsWith("plugin:")) return `插件消息（${type.slice(7)}）`;
    const data = msg.mediaData ?? {};
    const base = MEDIA_TEXT_LABELS[type] ?? type;

    // 语音与表情包的「文字」就存在 label 里（语音条文字 / 表情名）
    if (type === "audio" || type === "sticker" || type === "image") {
        const label = trimmed(data.label);
        return label ? `${base}（${label}）` : base;
    }
    if (type === "red_packet" || type === "transfer" || type === "payment_request") {
        const amount = typeof data.amount === "number" ? `¥${data.amount}` : "";
        const label = trimmed(data.label);
        return [base, amount, label].filter(Boolean).join(" ");
    }
    if (type === "location") {
        const label = trimmed(data.label);
        return label ? `${base}（${label}）` : base;
    }
    if (type === "music" || type === "music_share" || type === "music_notify") {
        const label = trimmed(data.label);
        return label ? `${base}（${label}）` : base;
    }
    if (type === "gift") {
        const name = trimmed(data.giftName);
        return name ? `${base}（${name}）` : base;
    }
    if (type === "contact_card") {
        const name = trimmed(data.contactCardName);
        return name ? `${base}（${name}）` : base;
    }
    if (type === "dice") {
        return typeof data.diceFace === "number" ? `${base} ${data.diceFace}` : base;
    }
    if (type === "poke") {
        const from = trimmed(data.pokeSender);
        const to = trimmed(data.pokeTarget);
        return from && to ? `${from} 拍了拍 ${to}` : base;
    }
    const label = trimmed(data.label);
    return label ? `${base}（${label}）` : base;
}

function toExportMessage(msg: ChatMessage): ChatExportMessage {
    const mediaText = describeMessageMedia(msg);
    const quote = trimmed(msg.mediaData?.quotePreview);
    const stateValues = msg.freshStateValues?.length ? msg.freshStateValues : msg.stateValues;
    return {
        id: msg.id,
        role: msg.role,
        createdAt: msg.createdAt,
        ...(msg.senderName ? { senderName: msg.senderName } : {}),
        content: msg.content ?? "",
        ...(msg.mediaType ? { mediaType: msg.mediaType } : {}),
        ...(mediaText ? { mediaText } : {}),
        ...(quote ? { quote } : {}),
        ...(msg.innerMonologue ? { innerMonologue: msg.innerMonologue } : {}),
        ...(msg.statusPanel ? { statusPanel: msg.statusPanel } : {}),
        ...(stateValues?.length ? { stateValues: stateValues.map(v => ({ name: v.name, value: v.value })) } : {}),
        ...(msg.origin ? { origin: msg.origin } : {}),
    };
}

function resolveSessionMeta(session: ReturnType<typeof loadChatSessions>[number]) {
    const characters = loadCharacters();
    const byId = new Map(characters.map(character => [character.id, character]));
    const contact = byId.get(session.contactId);
    const memberNames = (session.participantIds ?? [])
        .map(id => byId.get(id)?.name)
        .filter((name): name is string => Boolean(name));
    const characterName = contact?.name || "未知角色";
    const isGroup = session.isGroup === true;
    const title = isGroup
        ? (session.groupName?.trim() || "群聊")
        : (session.alias?.trim() || characterName);
    return { characterName, isGroup, title, memberNames };
}

/** 列出可导出的会话（含消息条数），供选择界面使用 */
export function listChatExportSessions(): ChatExportSessionOption[] {
    return loadChatSessions()
        .map(session => {
            const meta = resolveSessionMeta(session);
            const messages = loadChatMessages(session.id);
            return {
                sessionId: session.id,
                characterId: session.contactId,
                characterName: meta.characterName,
                title: meta.title,
                isGroup: meta.isGroup,
                messageCount: messages.length,
                lastMessageAt: messages[messages.length - 1]?.createdAt ?? session.updatedAt,
            };
        })
        .sort((a, b) => (b.lastMessageAt || "").localeCompare(a.lastMessageAt || ""));
}

/** 组装导出数据（JSON 结构的来源；Markdown 也从它渲染，保证两种格式内容一致） */
export function buildChatExport(sessionIds: readonly string[], userName: string): ChatExportBundle {
    const wanted = new Set(sessionIds);
    const sessions = loadChatSessions()
        .filter(session => wanted.has(session.id))
        .map(session => {
            const meta = resolveSessionMeta(session);
            const rawMessages = loadChatMessages(session.id);
            const messages = rawMessages.map(toExportMessage);
            return {
                sessionId: session.id,
                characterId: session.contactId,
                characterName: meta.characterName,
                title: meta.title,
                isGroup: meta.isGroup,
                ...(meta.isGroup && meta.memberNames.length ? { groupMembers: meta.memberNames } : {}),
                userName,
                messageCount: messages.length,
                ...(rawMessages[0] ? { firstMessageAt: rawMessages[0].createdAt } : {}),
                ...(rawMessages.length ? { lastMessageAt: rawMessages[rawMessages.length - 1].createdAt } : {}),
                messages,
            };
        });

    const messageCount = sessions.reduce((sum, session) => sum + session.messages.length, 0);
    return {
        app: CHAT_EXPORT_APP,
        version: CHAT_EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        sessionCount: sessions.length,
        messageCount,
        sessions,
    };
}

export function chatExportToJson(bundle: ChatExportBundle): string {
    return JSON.stringify(bundle, null, 2);
}

function formatLocalTime(iso: string): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function speakerOf(message: ChatExportMessage, session: ChatExportSession): string {
    if (message.role === "user") return message.senderName?.trim() || session.userName || "我";
    if (message.role === "assistant") return message.senderName?.trim() || session.characterName;
    return message.senderName?.trim() || "系统";
}

/** 渲染可读 Markdown：正文 + 媒体文字 + 引用 + 内心（状态栏等结构化字段只进 JSON） */
export function chatExportToMarkdown(bundle: ChatExportBundle): string {
    const lines: string[] = [];
    lines.push("# float 聊天记录导出");
    lines.push("");
    lines.push(`- 导出时间：${formatLocalTime(bundle.exportedAt)}`);
    lines.push(`- 会话数：${bundle.sessionCount}`);
    lines.push(`- 消息数：${bundle.messageCount}`);
    lines.push("");
    lines.push("> 媒体只保留文字：语音为其文字内容、表情包为表情名，不含图片/音频文件；");
    lines.push("> 状态栏、状态值等结构化字段保留在同时导出的 JSON 里。");
    lines.push("");

    for (const session of bundle.sessions) {
        lines.push("---");
        lines.push("");
        lines.push(`## ${session.title}${session.isGroup ? "（群聊）" : ""}`);
        lines.push("");
        lines.push(`- 角色：${session.characterName}`);
        if (session.isGroup && session.groupMembers?.length) {
            lines.push(`- 群成员：${session.groupMembers.join("、")}`);
        }
        lines.push(`- 消息数：${session.messageCount}`);
        if (session.firstMessageAt && session.lastMessageAt) {
            lines.push(`- 时间范围：${formatLocalTime(session.firstMessageAt)} ~ ${formatLocalTime(session.lastMessageAt)}`);
        }
        lines.push("");

        if (session.messages.length === 0) {
            lines.push("（暂无消息）");
            lines.push("");
            continue;
        }

        for (const message of session.messages) {
            lines.push(`### ${formatLocalTime(message.createdAt)} · ${speakerOf(message, session)}`);
            lines.push("");
            if (message.quote) lines.push(`> 引用：${message.quote}`);
            if (message.mediaText) lines.push(`> ${message.mediaText}`);
            if (message.content.trim()) {
                lines.push(message.content.trim());
                lines.push("");
            }
            if (message.innerMonologue?.trim()) {
                lines.push(`> 内心：${message.innerMonologue.trim().replace(/\n+/g, " ")}`);
                lines.push("");
            }
        }
    }

    return lines.join("\n");
}

/** 导出文件名：float-聊天记录-YYYYMMDD-HHmm.json / .md */
export function chatExportFilename(extension: "json" | "md"): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `float-聊天记录-${stamp}.${extension}`;
}
