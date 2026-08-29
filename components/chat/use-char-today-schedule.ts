"use client";

// 读取某角色在本周的日历日程，且关注「今天」的安排。
// 用于聊天顶栏展示角色的「当前日程」，点击可展开今天的完整安排。
// 数据源与日历 App 同一套（role=character 拥有者），每分钟自动刷新一次，
// 让顶栏与日历里生成/修改的日程保持同步。

import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarScheduleItem } from "@/lib/calendar-types";
import { loadCalendarWeekPlan } from "@/lib/calendar-storage";
import {
    formatIsoDate,
    getWeekStartIso,
    sortScheduleItems,
    timeToMinutes,
} from "@/lib/calendar-utils";

export type CharScheduleSnapshot = {
    /** 今日全部日程（按开始时间正序） */
    items: CalendarScheduleItem[];
    /** 当前正在进行的日程（若此刻落在某个时间窗内） */
    current?: CalendarScheduleItem;
    /** 下一个将要开始的今日日程（没有进行中时兜底展示） */
    next?: CalendarScheduleItem;
    refresh: () => void;
};

function pickActiveItems(items: CalendarScheduleItem[], now: Date) {
    const minute = now.getHours() * 60 + now.getMinutes();
    let current: CalendarScheduleItem | undefined;
    let next: CalendarScheduleItem | undefined;
    for (const item of items) {
        const start = timeToMinutes(item.startTime);
        const end = timeToMinutes(item.endTime);
        if (Number.isNaN(start) || Number.isNaN(end)) continue;
        if (start <= minute && minute < end) {
            current = item;
        } else if (start > minute && !next) {
            next = item;
        }
    }
    return { current, next };
}

export function useCharTodaySchedule(contactId: string): CharScheduleSnapshot {
    const [items, setItems] = useState<CalendarScheduleItem[]>([]);
    const nowRef = useRef(new Date());

    const refresh = useCallback(() => {
        if (!contactId) {
            setItems([]);
            return;
        }
        const now = new Date();
        nowRef.current = now;
        const today = formatIsoDate(now);
        const plan = loadCalendarWeekPlan("character", contactId, getWeekStartIso(now));
        const todays = sortScheduleItems((plan?.items ?? []).filter(item => item.date === today));
        setItems(todays);
    }, [contactId]);

    useEffect(() => {
        refresh();
        const timer = window.setInterval(refresh, 60_000);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const { current, next } = pickActiveItems(items, nowRef.current);
    return { items, current, next, refresh };
}