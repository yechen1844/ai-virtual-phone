"use client";

// 聊天顶栏的「角色当前日程」胶囊：
// ├ 读取该角色今天在日历里的日程，展示"现在进行中"或"下一个"的安排；
// └ 点击展开一张精致的今日日程底部弹层，可纵览角色今天的完整安排。
// 数据源与日历 App 同一套，角色日程在日历里生成后，顶栏会自动同步。

import { useEffect, useState } from "react";
import type { CalendarScheduleItem } from "@/lib/calendar-types";
import { useCharTodaySchedule } from "./use-char-today-schedule";
import { formatIsoDate, getWeekdayLabel, parseIsoDate } from "@/lib/calendar-utils";

type ChipProps = {
    contactId: string;
    /** 角色名，用于弹层标题 */
    charName: string;
};

export function CharScheduleChip({ contactId, charName }: ChipProps) {
    const { items, current, next } = useCharTodaySchedule(contactId);
    const [open, setOpen] = useState(false);
    const shown = current ?? next;

    // 今日没有任何日程 → 不占用顶栏空间
    if (!shown || items.length === 0) return null;

    const isCurrent = Boolean(current);

    return (
        <>
            <button
                type="button"
                className="char-schedule-chip cs-container"
                data-active={isCurrent ? "1" : "0"}
                data-color={shown.colorKey}
                onClick={() => setOpen(true)}
                aria-label={`查看${charName}今日日程`}
            >
                {isCurrent ? (
                    <span className="char-schedule-chip-live"><i /></span>
                ) : (
                    <span className="char-schedule-chip-clock" />
                )}
                {shown.emoji ? <span className="char-schedule-chip-emoji">{shown.emoji}</span> : null}
                <span className="char-schedule-chip-label">
                    <span className="char-schedule-chip-state">{isCurrent ? "现在" : "接下来"}</span>
                    <span className="char-schedule-chip-text">{shown.title}</span>
                </span>
                <span className="char-schedule-chip-time">{shown.startTime}</span>
            </button>

            {open && (
                <CharScheduleSheet
                    charName={charName}
                    items={items}
                    currentId={current?.id}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    );
}

type SheetProps = {
    charName: string;
    items: CalendarScheduleItem[];
    currentId?: string;
    onClose: () => void;
};

function CharScheduleSheet({ charName, items, currentId, onClose }: SheetProps) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const today = formatIsoDate(new Date());
    const date = parseIsoDate(today);
    const headerLabel = `${date.getMonth() + 1}月${date.getDate()}日 · ${getWeekdayLabel(today)}`;

    return (
        <div className="char-schedule-overlay" onClick={onClose}>
            <div className="char-schedule-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="char-schedule-grabber" />
                <header className="char-schedule-sheet-head">
                    <div className="char-schedule-sheet-heading">
                        <h3 className="char-schedule-sheet-title">{charName} · 今日日程</h3>
                        <p className="char-schedule-sheet-sub">
                            {headerLabel} · 共 {items.length} 项
                        </p>
                    </div>
                    <button type="button" className="char-schedule-sheet-close" onClick={onClose} aria-label="关闭">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                    </button>
                </header>

                <div className="char-schedule-sheet-body">
                    <div className="char-schedule-list">
                        {items.map((item) => (
                            <div
                                key={item.id}
                                className={`char-schedule-row${item.id === currentId ? " is-current" : ""}`}
                                data-color={item.colorKey}
                            >
                                <div className="char-schedule-row-time">
                                    <span className="cs-time-start">{item.startTime}</span>
                                    <span className="cs-time-end">{item.endTime}</span>
                                </div>
                                <div className="char-schedule-row-track">
                                    <i className="cs-track-dot" />
                                    {item.id === currentId && <span className="cs-now-badge">进行中</span>}
                                </div>
                                <div className="char-schedule-row-main">
                                    <span className="cs-row-title">
                                        {item.emoji ? <span className="cs-row-emoji">{item.emoji}</span> : null}
                                        {item.title}
                                    </span>
                                    {item.location ? <span className="cs-row-loc">{item.location}</span> : null}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}