"use client";

import { useLayoutEffect, type RefObject } from "react";

// 软键盘遮挡高度（布局视口被键盘压住的部分）。默认 interactive-widget=resizes-visual：
// 布局视口不缩水，position:absolute;bottom:0 的输入栏会被键盘压住下半截（发送按钮只露一半）。
// 把遮挡高度写成 CSS 变量，让输入栏的 bottom 跟着抬起，按钮就完整落在键盘上方。
// 公式天然兼容 resizes-content：那种模式下 innerHeight 会一起缩水，算出来就是 0，不会重复抬高。
const CHAT_KEYBOARD_INSET_CSS_VAR = "--chat-keyboard-inset";

export function useChatKeyboardInset(wrapperRef: RefObject<HTMLElement | null>): void {
    useLayoutEffect(() => {
        if (typeof window === "undefined") return;
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const viewport = window.visualViewport;
        if (!viewport) return;

        let frame = 0;

        const apply = () => {
            frame = 0;
            const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
            if (inset > 1) {
                wrapper.style.setProperty(CHAT_KEYBOARD_INSET_CSS_VAR, `${Math.round(inset)}px`);
            } else {
                wrapper.style.removeProperty(CHAT_KEYBOARD_INSET_CSS_VAR);
            }
        };

        // 键盘动画会连续触发多次 visualViewport 事件：逐帧写 CSS 变量只是重排一个绝对定位的
        // 小元素（输入栏），成本极低，故不做节流——逐帧跟随才能让输入栏平稳贴着键盘一起抬。
        const schedule = () => {
            if (frame) return;
            frame = window.requestAnimationFrame(apply);
        };

        apply();
        viewport.addEventListener("resize", schedule);
        viewport.addEventListener("scroll", schedule);
        window.addEventListener("resize", schedule);
        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            viewport.removeEventListener("resize", schedule);
            viewport.removeEventListener("scroll", schedule);
            window.removeEventListener("resize", schedule);
            wrapper.style.removeProperty(CHAT_KEYBOARD_INSET_CSS_VAR);
        };
    }, [wrapperRef]);
}
