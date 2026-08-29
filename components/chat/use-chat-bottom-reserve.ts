"use client";

import { useLayoutEffect, type RefObject } from "react";

const CHAT_BOTTOM_RESERVE_CSS_VAR = "--chat-bottom-reserve";
const STICK_TO_BOTTOM_THRESHOLD = 120;

function findBottomOverlay(wrapper: HTMLElement): HTMLElement | null {
    for (const child of Array.from(wrapper.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const ui = child.dataset.ui;
        if (ui === "input" || ui === "multi-select") return child;
    }
    return null;
}

export function useChatBottomReserve<TWrapper extends HTMLElement, TScroll extends HTMLElement>(
    wrapperRef: RefObject<TWrapper | null>,
    scrollRef: RefObject<TScroll | null>,
    refreshKey: string,
) {
    useLayoutEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;

        let frame = 0;
        let bottomScrollFrame = 0;
        let observer: ResizeObserver | null = null;
        let viewportTimer = 0;

        const scheduleStickToBottom = () => {
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            bottomScrollFrame = window.requestAnimationFrame(() => {
                bottomScrollFrame = 0;
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
            });
        };

        const measure = () => {
            frame = 0;
            const overlay = findBottomOverlay(wrapper);
            if (!overlay) {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
                return;
            }

            const el = scrollRef.current;
            const wasNearBottom = el
                ? el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD
                : false;
            const height = Math.ceil(overlay.getBoundingClientRect().height);

            if (height > 0) {
                wrapper.style.setProperty(CHAT_BOTTOM_RESERVE_CSS_VAR, `${height}px`);
            } else {
                wrapper.style.removeProperty(CHAT_BOTTOM_RESERVE_CSS_VAR);
            }

            if (wasNearBottom) scheduleStickToBottom();
        };

        const requestMeasure = () => {
            if (frame) window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(measure);
        };

        // 视口（键盘开合）重测量做尾随节流：键盘动画会连续触发多次 visualViewport resize，
        // 逐帧重测量会让大消息区在每帧重排导致黑屏/卡顿。等动画稳定后一次性重排到位。
        const requestViewportMeasure = () => {
            if (viewportTimer) window.clearTimeout(viewportTimer);
            viewportTimer = window.setTimeout(() => {
                viewportTimer = 0;
                requestMeasure();
            }, 120);
        };

        const overlay = findBottomOverlay(wrapper);
        if (overlay && typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(requestMeasure);
            observer.observe(overlay);
        }

        measure();
        window.addEventListener("resize", requestViewportMeasure);
        window.visualViewport?.addEventListener("resize", requestViewportMeasure);
        window.visualViewport?.addEventListener("scroll", requestViewportMeasure);

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            if (bottomScrollFrame) window.cancelAnimationFrame(bottomScrollFrame);
            if (viewportTimer) window.clearTimeout(viewportTimer);
            observer?.disconnect();
            window.removeEventListener("resize", requestViewportMeasure);
            window.visualViewport?.removeEventListener("resize", requestViewportMeasure);
            window.visualViewport?.removeEventListener("scroll", requestViewportMeasure);
        };
    }, [wrapperRef, scrollRef, refreshKey]);
}
