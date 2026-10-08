"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import {
    DEFAULT_STATE_EXPIRE_MINUTES,
    SCHEDULE_NOTE_KINDS,
    SCHEDULE_NOTE_KIND_LABELS,
    addScheduleNote,
    clearDoneScheduleNotes,
    formatClockLabel,
    formatDurationLabel,
    loadScheduleNotesByCharacter,
    removeScheduleNote,
    resolveStateNoteEnd,
    updateScheduleNote,
    type ScheduleNote,
    type ScheduleNoteKind,
} from "@/lib/schedule-note-storage";

type ScheduleNotePanelProps = {
    characterId: string;
    characterName: string;
    sessionId: string;
    onClose: () => void;
};

type Draft = {
    id?: string;
    kind: ScheduleNoteKind;
    title: string;
    at: string;
    until: string;
    expireMinutes: number;
    note: string;
};

const INPUT_CLS = "w-full rounded-lg bg-[var(--c-input)] px-3 py-2 ts-13 text-[var(--c-text)] outline-none";

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

/** ISO → datetime-local 输入值（本地时区） */
function isoToLocalInput(iso?: string): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function emptyDraft(): Draft {
    const now = new Date();
    now.setMinutes(now.getMinutes() + 30, 0, 0);
    return {
        kind: "instant",
        title: "",
        at: isoToLocalInput(now.toISOString()),
        until: "",
        expireMinutes: DEFAULT_STATE_EXPIRE_MINUTES,
        note: "",
    };
}

/** 面板里展示的「还有多久 / 已进行多久」文案 */
function describeNote(note: ScheduleNote, now: Date): string {
    const atMs = new Date(note.at).getTime();
    const nowMs = now.getTime();
    const clock = formatClockLabel(note.at, now);
    if (note.kind === "state") {
        const endMs = resolveStateNoteEnd(note);
        if (nowMs < atMs) return `${clock} 开始（还有 ${formatDurationLabel(atMs - nowMs)}）`;
        if (nowMs < endMs) return `从 ${clock} 开始，已进行 ${formatDurationLabel(nowMs - atMs)}，预计 ${formatClockLabel(new Date(endMs).toISOString(), now)} 结束`;
        return `已结束（${clock} 开始）`;
    }
    if (nowMs < atMs) return `${clock}（还有 ${formatDurationLabel(atMs - nowMs)}）`;
    return `${clock} 已过去 ${formatDurationLabel(nowMs - atMs)}`;
}

export function ScheduleNotePanel({ characterId, characterName, sessionId, onClose }: ScheduleNotePanelProps) {
    const [notes, setNotes] = useState<ScheduleNote[]>([]);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [error, setError] = useState("");
    const [showDone, setShowDone] = useState(false);

    const reload = useCallback(() => {
        setNotes(loadScheduleNotesByCharacter(characterId));
    }, [characterId]);

    useEffect(() => {
        reload();
    }, [reload]);

    const { activeNotes, doneNotes } = useMemo(() => {
        const now = new Date();
        return {
            activeNotes: notes.filter(note => !note.done).sort((a, b) => a.at.localeCompare(b.at)),
            doneNotes: notes.filter(note => note.done).sort((a, b) => b.at.localeCompare(a.at)),
        };
    }, [notes]);

    const saveDraft = () => {
        if (!draft) return;
        const title = draft.title.trim();
        if (!title) {
            setError("请填写事项");
            return;
        }
        const atIso = localInputToIso(draft.at);
        if (!atIso) {
            setError("请选择时间");
            return;
        }
        if (draft.kind === "state" && draft.until) {
            const untilIso = localInputToIso(draft.until);
            if (!untilIso || new Date(untilIso).getTime() <= new Date(atIso).getTime()) {
                setError("预计结束时间必须晚于开始时间");
                return;
            }
        }
        const untilIso = draft.kind === "state" ? localInputToIso(draft.until) ?? undefined : undefined;
        const patch = {
            kind: draft.kind,
            title,
            at: atIso,
            until: untilIso,
            ...(draft.kind === "state" ? { expireMinutes: draft.expireMinutes } : {}),
            note: draft.note.trim() || undefined,
        };
        if (draft.id) {
            updateScheduleNote(draft.id, patch);
        } else {
            addScheduleNote({ characterId, sessionId, ...patch });
        }
        setDraft(null);
        setError("");
        reload();
    };

    const now = new Date();

    return (
        <div
            className="fixed inset-0 z-[10030] flex items-end justify-center bg-black/45 sm:items-center"
            role="dialog"
            aria-modal="true"
            aria-label="日程便签"
        >
            <div className="flex max-h-[86vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-[var(--c-page-body-bg)] text-[var(--c-text)] shadow-2xl sm:rounded-2xl">
                <div className="flex items-center justify-between px-5 pb-2 pt-4">
                    <div className="font-bold text-[var(--c-text-title)]">日程便签</div>
                    <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="关闭" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-4 pb-5">
                    <p className="menu-desc !mt-0 mb-3">
                        {characterName} 自己记下的、关于你的时间安排。每轮对话会自动把这些换算成「还有多久 / 已进行多久」告诉 TA。你可以在这里直接改或删。
                    </p>

                    {draft ? (
                        <div className="mb-3 flex flex-col gap-2 rounded-xl p-3" style={{ background: "color-mix(in srgb, var(--c-text) 6%, transparent)" }}>
                            <div className="font-semibold ts-13 text-[var(--c-text-title)]">{draft.id ? "修改便签" : "新增便签"}</div>
                            <label className="flex flex-col gap-1">
                                <span className="menu-desc !mt-0">事项</span>
                                <input
                                    className={INPUT_CLS}
                                    value={draft.title}
                                    placeholder="例如：下课"
                                    onChange={e => setDraft({ ...draft, title: e.target.value })}
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="menu-desc !mt-0">类型</span>
                                <select
                                    className={INPUT_CLS}
                                    value={draft.kind}
                                    onChange={e => setDraft({ ...draft, kind: e.target.value as ScheduleNoteKind })}
                                >
                                    {SCHEDULE_NOTE_KINDS.map(kind => (
                                        <option key={kind} value={kind}>{SCHEDULE_NOTE_KIND_LABELS[kind]}</option>
                                    ))}
                                </select>
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="menu-desc !mt-0">{draft.kind === "state" ? "开始时间" : "时间"}</span>
                                <input
                                    type="datetime-local"
                                    className={INPUT_CLS}
                                    value={draft.at}
                                    onChange={e => setDraft({ ...draft, at: e.target.value })}
                                />
                            </label>
                            {draft.kind === "state" && (
                                <>
                                    <label className="flex flex-col gap-1">
                                        <span className="menu-desc !mt-0">预计结束时间（留空则用兜底时长）</span>
                                        <input
                                            type="datetime-local"
                                            className={INPUT_CLS}
                                            value={draft.until}
                                            onChange={e => setDraft({ ...draft, until: e.target.value })}
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1">
                                        <span className="menu-desc !mt-0">兜底时长（分钟）</span>
                                        <input
                                            type="number"
                                            min={1}
                                            max={1440}
                                            className={INPUT_CLS}
                                            value={draft.expireMinutes}
                                            onChange={e => setDraft({ ...draft, expireMinutes: Number(e.target.value) || DEFAULT_STATE_EXPIRE_MINUTES })}
                                        />
                                    </label>
                                </>
                            )}
                            <label className="flex flex-col gap-1">
                                <span className="menu-desc !mt-0">备注（可选）</span>
                                <input
                                    className={INPUT_CLS}
                                    value={draft.note}
                                    onChange={e => setDraft({ ...draft, note: e.target.value })}
                                />
                            </label>
                            {error && <div className="ts-12 text-[var(--c-danger)]">{error}</div>}
                            <div className="flex gap-2">
                                <button type="button" className="ui-btn ui-btn-primary flex-1" onClick={saveDraft}>
                                    <Check size={15} /> 保存
                                </button>
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => { setDraft(null); setError(""); }}>
                                    取消
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="ui-btn ui-btn-outline mb-3 w-full"
                            onClick={() => { setDraft(emptyDraft()); setError(""); }}
                        >
                            <Plus size={15} /> 新增便签
                        </button>
                    )}

                    {activeNotes.length === 0 && !draft && (
                        <div className="ts-12 opacity-45">还没有便签。等 TA 在对话里记下你的日程后，这里就会出现。</div>
                    )}

                    <div className="flex flex-col gap-2">
                        {activeNotes.map(note => (
                            <div key={note.id} className="flex items-start gap-2 rounded-xl p-3" style={{ background: "color-mix(in srgb, var(--c-text) 6%, transparent)" }}>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate font-semibold ts-13 text-[var(--c-text-title)]">{note.title}</span>
                                        <span className="shrink-0 rounded-md bg-[var(--c-input)] px-1.5 py-0.5 ts-11 opacity-70">{SCHEDULE_NOTE_KIND_LABELS[note.kind]}</span>
                                    </div>
                                    <div className="menu-desc !mt-1">{describeNote(note, now)}</div>
                                    {note.note && <div className="menu-desc !mt-1 opacity-70">{note.note}</div>}
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                    <button
                                        type="button"
                                        className="modal-header-btn modal-header-btn-muted"
                                        aria-label="修改"
                                        onClick={() => {
                                            setError("");
                                            setDraft({
                                                id: note.id,
                                                kind: note.kind,
                                                title: note.title,
                                                at: isoToLocalInput(note.at),
                                                until: isoToLocalInput(note.until),
                                                expireMinutes: note.expireMinutes ?? DEFAULT_STATE_EXPIRE_MINUTES,
                                                note: note.note ?? "",
                                            });
                                        }}
                                    >
                                        <Pencil size={14} />
                                    </button>
                                    <button
                                        type="button"
                                        className="modal-header-btn modal-header-btn-muted"
                                        aria-label="删除"
                                        onClick={() => { removeScheduleNote(note.id); reload(); }}
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {doneNotes.length > 0 && (
                        <div className="mt-4">
                            <button type="button" className="menu-desc !mt-0" onClick={() => setShowDone(v => !v)}>
                                {showDone ? "收起" : "查看"}已归档 {doneNotes.length} 条
                            </button>
                            {showDone && (
                                <div className="mt-2 flex flex-col gap-1.5">
                                    {doneNotes.map(note => (
                                        <div key={note.id} className="flex items-center gap-2 opacity-55">
                                            <span className="min-w-0 flex-1 truncate ts-12">{note.title}（{SCHEDULE_NOTE_KIND_LABELS[note.kind]}）{formatClockLabel(note.at, now)}</span>
                                            <button
                                                type="button"
                                                className="modal-header-btn modal-header-btn-muted"
                                                aria-label="删除"
                                                onClick={() => { removeScheduleNote(note.id); reload(); }}
                                            >
                                                <Trash2 size={13} />
                                            </button>
                                        </div>
                                    ))}
                                    <button
                                        type="button"
                                        className="ui-btn ui-btn-outline mt-1 w-full"
                                        onClick={() => { clearDoneScheduleNotes(characterId); reload(); }}
                                    >
                                        清空已归档
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
