// lib/schedule-note-storage.ts
// 日程便签：角色自己记下「user 什么时候要做什么」，逐轮换算成「还有多久 / 已经进行多久」注入上下文，
// 到点后按类型分流：
//   instant  瞬间事件（下课）  → 到点写一条一次性系统提示进聊天记录，然后归档
//   state    状态事件（吃饭）  → 进行中每轮注入「已进行 X」；三种结束方式（主动结束 / 预计结束时间到点 / 超时兜底）
//   reminder 提醒事件（吃药）  → 到点走「主动联系」管线，让角色真的发一条关于这件事的消息
//   future   未来事件（面试）  → 未到点每轮注入「还有 X」；到点后自动按瞬间事件处理一次，然后归档
//
// 归属：按角色独立。角色 A 记下的日程不会出现在角色 B 的上下文里。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const SCHEDULE_NOTES_KEY = "ai_phone_schedule_notes_v1";
registerKvMigration(SCHEDULE_NOTES_KEY);

export type ScheduleNoteKind = "instant" | "state" | "reminder" | "future";

export type ScheduleNote = {
    id: string;
    characterId: string;
    /** 记录时所在的会话，到点后往这个会话注入提示 / 发提醒 */
    sessionId: string;
    kind: ScheduleNoteKind;
    /** 事件短描述，如「下课」「吃饭」「提醒 user 吃药」 */
    title: string;
    /** 目标时间（ISO）。state 事件里是开始时间。 */
    at: string;
    /** state 事件的预计结束时间（ISO，可选） */
    until?: string;
    /** state 事件超时兜底（分钟）。缺省 DEFAULT_STATE_EXPIRE_MINUTES */
    expireMinutes?: number;
    /** 已归档：不再注入、不再触发 */
    done: boolean;
    /** 一次性提示已注入 / 提醒已触发的时间（instant、future、reminder 用） */
    firedAt?: string;
    /** 角色记录时的补充说明，UI 展示用 */
    note?: string;
    createdAt: string;
    updatedAt: string;
};

/** 状态事件没有 until 时的兜底时长：4 小时。防止「睡觉中」这类忘结束的永久挂着。 */
export const DEFAULT_STATE_EXPIRE_MINUTES = 240;

/** 单角色便签上限，超出后淘汰最旧的已归档条目，避免无限增长。 */
const MAX_NOTES_PER_CHARACTER = 60;

export const SCHEDULE_NOTE_KIND_LABELS: Record<ScheduleNoteKind, string> = {
    instant: "瞬间事件",
    state: "状态事件",
    reminder: "提醒事件",
    future: "未来事件",
};

export const SCHEDULE_NOTE_KINDS: ScheduleNoteKind[] = ["instant", "state", "reminder", "future"];

function isScheduleNoteKind(value: unknown): value is ScheduleNoteKind {
    return value === "instant" || value === "state" || value === "reminder" || value === "future";
}

function isScheduleNote(value: unknown): value is ScheduleNote {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<ScheduleNote>;
    return typeof item.id === "string"
        && typeof item.characterId === "string"
        && typeof item.title === "string"
        && typeof item.at === "string"
        && isScheduleNoteKind(item.kind);
}

export function loadScheduleNotes(): ScheduleNote[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(SCHEDULE_NOTES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isScheduleNote);
    } catch {
        return [];
    }
}

function saveScheduleNotes(notes: ScheduleNote[]): void {
    if (typeof window === "undefined") return;
    kvSet(SCHEDULE_NOTES_KEY, JSON.stringify(notes));
}

// ── 提醒事件的服务端离线兜底 ─────────────────────────
// 提醒到点时若 App 已被杀，前台 3 秒轮询不会跑，只能由服务端到点接管生成并推送。
// 复用「稍后主动联系」同一条 timed_task 通道，触发键 snote:<便签 id>。
// 动态引入避免模块环（push-bailout-client 会拉起 chat-engine，而本模块被多处静态引用）。

function armReminderBailout(note: ScheduleNote): void {
    if (note.kind !== "reminder" || note.done) return;
    void import("./push-bailout-client")
        .then(m => m.armScheduleReminderBailout(note))
        .catch(() => undefined);
}

function cancelReminderBailout(id: string): void {
    void import("./push-bailout-client")
        .then(m => m.cancelBailoutKey(`snote:${id}`))
        .catch(() => undefined);
}

export function loadScheduleNotesByCharacter(characterId: string): ScheduleNote[] {
    return loadScheduleNotes()
        .filter(note => note.characterId === characterId)
        .sort((a, b) => a.at.localeCompare(b.at));
}

export function makeScheduleNoteId(characterId: string): string {
    return `snote_${characterId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function addScheduleNote(
    input: Omit<ScheduleNote, "id" | "done" | "createdAt" | "updatedAt">,
): ScheduleNote {
    const now = new Date().toISOString();
    const note: ScheduleNote = {
        ...input,
        id: makeScheduleNoteId(input.characterId),
        done: false,
        createdAt: now,
        updatedAt: now,
    };
    const all = loadScheduleNotes();
    all.push(note);
    saveScheduleNotes(pruneNotes(all, note.characterId));
    armReminderBailout(note);
    return note;
}

export function updateScheduleNote(
    id: string,
    patch: Partial<Pick<ScheduleNote, "title" | "kind" | "at" | "until" | "expireMinutes" | "note" | "done">>,
): ScheduleNote | null {
    const all = loadScheduleNotes();
    const index = all.findIndex(note => note.id === id);
    if (index < 0) return null;
    const next: ScheduleNote = { ...all[index], ...patch, updatedAt: new Date().toISOString() };
    // 改时间 / 改类型后允许重新触发一次
    if (patch.at !== undefined || patch.kind !== undefined) delete next.firedAt;
    all[index] = next;
    saveScheduleNotes(all);
    // 提醒事件：重挂（同键先删后插，改时间即刷新）；不再是提醒 / 已归档则撤销
    if (next.kind === "reminder" && !next.done) armReminderBailout(next);
    else cancelReminderBailout(next.id);
    return next;
}

export function removeScheduleNote(id: string): boolean {
    const all = loadScheduleNotes();
    const next = all.filter(note => note.id !== id);
    if (next.length === all.length) return false;
    saveScheduleNotes(next);
    cancelReminderBailout(id);
    return true;
}

export function clearDoneScheduleNotes(characterId: string): void {
    const all = loadScheduleNotes();
    const kept = all.filter(note => note.characterId !== characterId || !note.done);
    for (const note of all) {
        if (note.characterId === characterId && note.done && !kept.includes(note)) cancelReminderBailout(note.id);
    }
    saveScheduleNotes(kept);
}

function pruneNotes(notes: ScheduleNote[], characterId: string): ScheduleNote[] {
    const mine = notes.filter(note => note.characterId === characterId);
    if (mine.length <= MAX_NOTES_PER_CHARACTER) return notes;
    // 优先淘汰已归档的、时间最早的
    const overflow = mine.length - MAX_NOTES_PER_CHARACTER;
    const victims = new Set(
        mine
            .filter(note => note.done)
            .sort((a, b) => a.at.localeCompare(b.at))
            .slice(0, overflow)
            .map(note => note.id),
    );
    if (victims.size >= overflow) return notes.filter(note => !victims.has(note.id));
    return notes;
}

// ── 时间换算 ─────────────────────────────────────────

/** 把毫秒差写成「X 分钟 / X 小时 Y 分钟 / X 天 Y 小时」。 */
export function formatDurationLabel(ms: number): string {
    const totalMinutes = Math.max(0, Math.round(Math.abs(ms) / 60_000));
    if (totalMinutes < 1) return "不到 1 分钟";
    if (totalMinutes < 60) return `${totalMinutes} 分钟`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours < 24) return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
    const days = Math.floor(hours / 24);
    const restHours = hours % 24;
    return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

/** 绝对时刻带日期前缀：今天 12:40 / 明天 09:00 / 08-12 09:00 */
export function formatClockLabel(iso: string, now = new Date()): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
    if (dayDiff === 0) return `今天 ${clock}`;
    if (dayDiff === 1) return `明天 ${clock}`;
    if (dayDiff === -1) return `昨天 ${clock}`;
    if (dayDiff === 2) return `后天 ${clock}`;
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${clock}`;
}

/** 状态事件的结束时间：until 优先，否则 at + expireMinutes 兜底。 */
export function resolveStateNoteEnd(note: ScheduleNote): number {
    if (note.until) {
        const ms = new Date(note.until).getTime();
        if (Number.isFinite(ms)) return ms;
    }
    const start = new Date(note.at).getTime();
    const minutes = note.expireMinutes && note.expireMinutes > 0 ? note.expireMinutes : DEFAULT_STATE_EXPIRE_MINUTES;
    return start + minutes * 60_000;
}

// ── 逐轮注入 ─────────────────────────────────────────

/**
 * 生成注入到角色上下文的日程便签块。
 * 即使一条便签都没有也会返回一小段——常驻的出现本身就是「你有这个功能」的提醒，
 * 否则角色永远不会主动去记第一条。
 * 注意：便签记的永远是「对方的」日程，块头必须写明归属，否则角色会把它当成自己的安排。
 */
export function buildScheduleNotePromptBlock(
    characterId: string,
    now = new Date(),
    userName?: string,
): string {
    const forWhom = userName?.trim() || "对方";
    const header = `[日程便签·关于${forWhom}]`;
    const notes = loadScheduleNotesByCharacter(characterId).filter(note => !note.done);
    if (notes.length === 0) {
        return [
            header,
            `（现在没有记下的日程。这里记的是${forWhom}的时间安排，不是你自己的事；听到${forWhom}提到跟时间有关的事——几点要做什么、还有多久下课、正在做什么、要提醒什么——就用「记录日程」记一条，之后每轮会自动帮你算还差多久。）`,
            "[/日程便签]",
        ].join("\n");
    }

    const nowMs = now.getTime();
    const lines: string[] = [];

    for (const note of notes) {
        const atMs = new Date(note.at).getTime();
        if (!Number.isFinite(atMs)) continue;
        const clock = formatClockLabel(note.at, now);
        const kindLabel = SCHEDULE_NOTE_KIND_LABELS[note.kind];

        if (note.kind === "state") {
            const endMs = resolveStateNoteEnd(note);
            if (nowMs < atMs) {
                lines.push(`· ${forWhom}「${note.title}」（状态事件）—— ${clock} 开始，距离现在还有 ${formatDurationLabel(atMs - nowMs)}`);
            } else {
                const endLabel = `预计 ${formatClockLabel(new Date(endMs).toISOString(), now)} 结束`;
                lines.push(`· ${forWhom}「${note.title}」（状态事件）—— 从 ${clock} 开始，已进行 ${formatDurationLabel(nowMs - atMs)}，${endLabel}`);
            }
            continue;
        }

        if (nowMs < atMs) {
            const suffix = note.kind === "reminder" ? "到点你会主动发消息提醒" : "";
            lines.push(
                `· ${forWhom}「${note.title}」（${kindLabel}）—— ${clock}，距离现在还有 ${formatDurationLabel(atMs - nowMs)}${suffix ? `，${suffix}` : ""}`,
            );
        } else {
            // 还没被 sweep 处理（例如刚过点），照实说明已经过去了
            lines.push(`· ${forWhom}「${note.title}」（${kindLabel}）—— ${clock} 已经过去 ${formatDurationLabel(nowMs - atMs)}`);
        }
    }

    if (lines.length === 0) return "";
    return [
        header,
        `（这些都是你替${forWhom}记下的时间安排，说的是${forWhom}的事，不是你自己的日程。请严格按它理解${forWhom}的时间线：没到点的事不要当成已经发生，进行中的事要按已进行时长理解，不要凭空跳到之后。）`,
        ...lines,
        "[/日程便签]",
    ].join("\n");
}

// ── 到点扫描 ─────────────────────────────────────────

export type ScheduleNoteSweep = {
    /** 瞬间/未来事件到点：需要往会话里写一条一次性系统提示 */
    instantNotices: ScheduleNote[];
    /** 状态事件结束：需要往会话里写一条「已结束」提示 */
    stateNotices: ScheduleNote[];
    /** 提醒事件到点：需要走主动联系管线发消息 */
    reminders: ScheduleNote[];
};

/**
 * 扫描所有便签，把到点的做状态推进（幂等：已 fired 的不会重复触发）。
 * 只负责改数据与返回待办清单，真正的写消息 / 发提醒由调用方执行（避免本模块依赖聊天存储）。
 */
export function sweepScheduleNotes(now = new Date()): ScheduleNoteSweep {
    const all = loadScheduleNotes();
    const nowMs = now.getTime();
    const firedAt = now.toISOString();
    const result: ScheduleNoteSweep = { instantNotices: [], stateNotices: [], reminders: [] };
    let changed = false;

    for (let i = 0; i < all.length; i += 1) {
        const note = all[i];
        if (note.done) continue;
        const atMs = new Date(note.at).getTime();
        if (!Number.isFinite(atMs)) continue;

        if (note.kind === "state") {
            if (nowMs >= resolveStateNoteEnd(note)) {
                all[i] = { ...note, done: true, firedAt, updatedAt: firedAt };
                result.stateNotices.push(all[i]);
                changed = true;
            }
            continue;
        }

        if (nowMs < atMs) continue;

        all[i] = { ...note, done: true, firedAt, updatedAt: firedAt };
        changed = true;
        if (note.kind === "reminder") {
            // 本地已接手触发：撤销服务端兜底预约，避免两边各发一条
            cancelReminderBailout(note.id);
            result.reminders.push(all[i]);
        } else {
            result.instantNotices.push(all[i]);
        }
    }

    if (changed) saveScheduleNotes(all);
    return result;
}

/** 瞬间/未来事件到点后写进聊天记录的那条一次性提示。 */
export function buildInstantNoticeText(note: ScheduleNote, now = new Date(), userName?: string): string {
    const forWhom = userName?.trim() || "对方";
    const atLabel = formatClockLabel(note.at, now);
    return `[日程便签·关于${forWhom}] ${forWhom}「${note.title}」—— ${atLabel} 已经到了（你之前替${forWhom}记下过这件事，现在它已经发生/开始了，不要再当成还没到）`;
}

/** 状态事件结束后的那条提示。 */
export function buildStateEndNoticeText(note: ScheduleNote, now = new Date(), userName?: string): string {
    const forWhom = userName?.trim() || "对方";
    const start = formatClockLabel(note.at, now);
    return `[日程便签·关于${forWhom}] ${forWhom}「${note.title}」—— 已经结束（从 ${start} 开始，持续了 ${formatDurationLabel(now.getTime() - new Date(note.at).getTime())}）`;
}

/** 提醒事件触发时喂给模型的上下文块。 */
export function buildReminderContext(note: ScheduleNote, now = new Date(), userName?: string): string {
    const forWhom = userName?.trim() || "对方";
    const atLabel = formatClockLabel(note.at, now);
    const late = formatDurationLabel(now.getTime() - new Date(note.at).getTime());
    return `⏰ 日程提醒：${forWhom}「${note.title}」（这是你替${forWhom}记下的事，不是你自己的安排；你在 ${atLabel} 记下它，现在到点了，已过 ${late}）`;
}
