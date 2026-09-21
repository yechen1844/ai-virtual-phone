// lib/wanjie/bridge.ts
// 万界 · 对接门（float 侧）
//
// 作用：把 float 的「角色 / 经历 / 复杂记忆内化」能力，以一组函数对外暴露，
// 供万界壳（同源页面）通过 `iframe.contentWindow.__wanjie` 直接调用。
//
// 导出分两路（对应「谁产生的」两种性质，与 sully 自己的做法一致）：
//
//   A. 聊天记录（私聊）              → kind: "text"，落成对方的普通文本消息
//      就像"在这个手机上聊的天"，说话人是真的说了那些话。
//
//   B. 其它活动（朋友圈 / 小红书 / 跑团 / 阅读 / 观影 / 便签 / 查手机 / 剧情 …）
//                                   → kind: "card"，落成对方的卡片消息
//      这些不是"谁说的话"，是"发生过的事"。float 的 loadNativeTimeline 已经把它们
//      逐条翻译成人话（含来源标签），我们原样搬过去即可。
//      sully 自己也正是这么做的：它的社交 / 小红书 / 跑团 / 音乐 / 生活记录
//      全是写成一类 `xxx_card` 消息进消息表，再由同一条总结链消化成记忆。
//
// 内化：走 float 自己的「一键迁移」（复杂记忆），并用 sinceTs 起始标记**只消化增量**。
// 铁律：全程只调公开函数，**绝不直接写 IndexedDB**（float 是"内存缓存为准 + 异步落盘"）。

import { loadCharacters } from "../character-storage";
import { importChatHistory, CHAT_IMPORT_FORMAT, type ChatImportPayload } from "../chat-import";
import { startMigration, getMigrationState } from "../complex-memory/migration";
import { isComplexMemoryEnabled } from "../complex-memory/config";

/** 来源标记：这些经历是从哪个小手机同步过来的 */
export const WANJIE_SOURCE_TAG = "float";

/** 跨系统游标（同一时刻可能有多条，所以带上 id 做二次比较；比较规则与排序规则一致） */
export interface WanjieCursor {
    iso: string;
    id: string;
}

/** 一条要同步出去的"经历" */
export interface ShortTermExport {
    /** text = 真的聊过的话；card = 发生过的事 */
    kind: "text" | "card";
    /** 说话人（card 时表示这件事跟谁有关） */
    role: "user" | "assistant";
    /** 正文：text 是原话；card 是人话描述（已含来源标签） */
    content: string;
    createdAt: string;
    /** float 侧唯一 id，用于幂等与游标 */
    id: string;
    /** 来源 App（card 才有意义，便于对方页面显示与排查） */
    sourceApp?: string;
}

export interface ForeignMessageInput {
    id: string;
    kind?: "text" | "card";
    role: "user" | "assistant";
    content: string;
    createdAt: string;
}

function toIso(value: unknown): string {
    if (typeof value === "string" && value) {
        const t = new Date(value).getTime();
        return Number.isFinite(t) ? new Date(t).toISOString() : value;
    }
    const t = typeof value === "number" ? value : Date.now();
    return new Date(t).toISOString();
}

function compareEntries(
    a: { createdAt: string; id: string },
    b: { createdAt: string; id: string },
): number {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 列出全部角色（供万界首页的「链接界面」用） */
export function listCharacters(): Array<{
    id: string;
    name: string;
    avatar: string;
    complexMemoryEnabled: boolean;
}> {
    return loadCharacters().map((c) => ({
        id: c.id,
        name: c.name,
        avatar: c.avatar ?? "",
        complexMemoryEnabled: isComplexMemoryEnabled(c.id),
    }));
}

/**
 * 导出某角色的"经历"（增量，两路合并）。
 *
 * - `after` 为空 = 从最早开始；返回的 `nextCursor` 直接作为下次的 `after` 传回。
 * - `limit` 用于分批；`remaining` 告诉你还有多少条没导出。
 * - 排序与游标比较都用 (createdAt, id)，因此不会漏也不会原地打转。
 */
export async function exportShortTerm(
    characterId: string,
    options?: { after?: WanjieCursor | null; limit?: number },
): Promise<{ items: ShortTermExport[]; nextCursor: WanjieCursor | null; remaining: number }> {
    const afterIso = options?.after?.iso ?? "";
    const afterId = options?.after?.id ?? "";
    const collected: ShortTermExport[] = [];

    // ── A. 聊天记录（私聊）：读原始消息，保留真实角色与时间 ──
    const { hydrateChatStorage, loadChatSessions, loadChatMessages } = await import("../chat-storage");
    await hydrateChatStorage();
    const sessions = loadChatSessions().filter((s) => !s.isGroup && s.contactId === characterId);
    for (const session of sessions) {
        const msgs = loadChatMessages(session.id);
        for (const m of msgs) {
            if (m.isRetracted) continue;
            if (m.role !== "user" && m.role !== "assistant") continue;
            // 只搬纯文本：带 mediaType 的是媒体 / 卡片，其正文往往是 URL 或结构化数据，
            // 原样搬过去只会给对方记忆添噪声（那类活动的"人话版本"在下面的时间线里已经有一条）。
            if (m.mediaType) continue;
            const content = (m.content ?? "").trim();
            if (!content) continue;
            collected.push({
                kind: "text",
                role: m.role,
                content,
                createdAt: toIso(m.createdAt),
                id: `chat:${m.id}`,
                sourceApp: "chat",
            });
        }
    }

    // ── B. 其它活动：直接用 float 已经翻译好的人话时间线，排除 chat（上面已覆盖） ──
    const { loadNativeTimeline } = await import("../short-term-assembler");
    const timeline = loadNativeTimeline(characterId, { full: true });
    for (const e of timeline) {
        if (e.sourceApp === "chat") continue;   // 含私聊 / 群聊 / 线下回合，统一不在这一路重复搬
        const content = (e.content ?? "").trim();
        if (!content) continue;
        collected.push({
            kind: "card",
            role: e.authorType === "user" ? "user" : "assistant",
            content,
            createdAt: toIso(e.timestamp),
            id: `tl:${e.id}`,
            sourceApp: e.sourceApp,
        });
    }

    // ── 排序 + 游标过滤 + 分批 ──
    collected.sort(compareEntries);
    const filtered = collected.filter((e) => {
        if (!afterIso) return true;
        if (e.createdAt < afterIso) return false;
        if (e.createdAt === afterIso && afterId && e.id <= afterId) return false;
        return true;
    });

    const limit = options?.limit && options.limit > 0 ? options.limit : 0;
    const items = limit > 0 ? filtered.slice(0, limit) : filtered;
    const last = items[items.length - 1];

    return {
        items,
        nextCursor: last ? { iso: last.createdAt, id: last.id } : null,
        remaining: filtered.length - items.length,
    };
}

/**
 * 把外来经历写进 float。
 *
 * 走 float 自带的「导入外部聊天记录」同一条路径（`importChatHistory`），
 * 因此**天然幂等**：消息 id 用 `wanjie:<来源>:<原消息id>`，重复导入同一批不会重复。
 *
 * 注意：这条路径是为**聊天记录**设计的，所以外来的"活动卡片"写进来会是一条
 * 普通文本消息（正文就是那句人话）。这在 float 里可以接受：它的时间线本来就会
 * 把这类内容当"事件"投影，来源标签也在正文里。
 */
export async function importForeignMessages(
    characterId: string,
    source: string,
    items: ForeignMessageInput[],
): Promise<{ success: boolean; error?: string; imported?: number; skipped?: number; total?: number }> {
    if (items.length === 0) {
        return { success: true, imported: 0, skipped: 0, total: 0 };
    }
    const payload: ChatImportPayload = {
        format: CHAT_IMPORT_FORMAT,
        version: 1,
        sourceApp: source,
        exportedAt: Date.now(),
        character: { sourceId: source },
        messageCount: items.length,
        earliest: items[0]?.createdAt ?? null,
        latest: items[items.length - 1]?.createdAt ?? null,
        messages: items.map((it) => ({
            id: `wanjie:${source}:${it.id}`,
            role: it.role,
            content: it.content,
            createdAt: it.createdAt,
            // 活动卡片标成 `wanjie_card`：它不是"谁说的话"，而是"发生过的事"。
            // 这不会影响记忆取数 —— 时间线只在**正文为空**时才用 mediaType 生成中括号标签，
            // 我们有正文，所以取到的就是这句人话；渲染层没有它的专门分支，
            // 会落到默认分支按文字渲染（不会白屏、不会显示"[插件未启用]"）。
            ...(it.kind === "card" ? { mediaType: "wanjie_card" as const } : {}),
        })),
    };
    return importChatHistory(characterId, payload);
}

/**
 * 触发内化 —— 走 float 自己的「一键迁移」（复杂记忆）。
 *
 * `sinceTs`（ISO 时间）是起始标记：只消化该时刻之后的条目，**起始那一天也精确到那一刻**，
 * 因此反复同步不会把已总结过的内容再总结一遍。
 *
 * 迁移是后台自推进的，本函数**立刻返回**；用 `migrationState()` 轮询进度。
 */
export async function internalize(
    characterId: string,
    options?: {
        sinceTs?: string | null;
        days?: number;
        range?: { start?: string; end?: string };
        force?: boolean;
    },
): Promise<{ success: boolean; error?: string; busy?: boolean; estimate?: number }> {
    const char = loadCharacters().find((c) => c.id === characterId);
    if (!char) return { success: false, error: "角色不存在" };

    const existing = getMigrationState(characterId);
    if (existing && (existing.status === "running" || existing.status === "paused") && options?.force !== true) {
        return {
            success: false,
            busy: true,
            error: `已有迁移任务在进行中（${existing.status}），请等它跑完再继续同步`,
        };
    }

    // days = 0 表示"不按天数截断"；配合 sinceTs 时，"全部"就等于"本次增量"。
    const days = Math.max(0, Math.floor(options?.days ?? 0));
    return startMigration(
        characterId,
        char.name,
        days,
        options?.force === true,
        options?.range,
        options?.sinceTs ?? null,
    );
}

/** 查询迁移进度（供壳轮询） */
export function migrationState(characterId: string): {
    status: string;
    doneDays: number;
    totalDays: number;
    currentDate: string | null;
    error?: string;
} | null {
    const state = getMigrationState(characterId);
    if (!state) return null;
    return {
        status: state.status,
        doneDays: state.doneDays,
        totalDays: state.totalDays,
        currentDate: state.currentDate,
        error: state.error,
    };
}

/** 把上面这些挂到 `window.__wanjie`，供万界壳调用（在 main-app 水合完成后调用一次） */
export function installWanjieBridge(): void {
    (window as unknown as Record<string, unknown>).__wanjie = {
        system: "float",
        listCharacters,
        exportShortTerm,
        importForeignMessages,
        internalize,
        migrationState,
    };
}
