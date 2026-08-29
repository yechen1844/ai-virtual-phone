"use client";

import { useEffect } from "react";

// 软键盘弹出会占用视口底部，据此判断打开/收起，给 <html> 加/移除 `kb-open`。
// 键盘期间全局临时禁用 backdrop-filter，避免 WebView 在视口 resize 时把
// 毛玻璃层重合成黑屏闪烁（全 App 通用，预设/工坊/聊天/阅读等都受影响）。
const KEYBOARD_THRESHOLD = 150;

function hasEditableFocus(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

function applyKeyboardClass(next: boolean): void {
  const root = document.documentElement;
  if (next) root.classList.add("kb-open");
  else root.classList.remove("kb-open");
}

export function KeyboardGlassGuard() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const viewport = window.visualViewport;

    const update = () => {
      if (!viewport || !hasEditableFocus()) {
        applyKeyboardClass(false);
        return;
      }
      const occluded = window.innerHeight - viewport.height - viewport.offsetTop;
      applyKeyboardClass(occluded > KEYBOARD_THRESHOLD);
    };

    // 键盘收起动画期、焦点切换期间分批重算，避免过早移除类导致闪回。
    const timers: number[] = [];
    const scheduleUpdate = () => {
      update();
      for (const delay of [50, 250, 600]) {
        timers.push(window.setTimeout(update, delay));
      }
    };

    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("focusin", scheduleUpdate);
    window.addEventListener("focusout", scheduleUpdate);

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("focusin", scheduleUpdate);
      window.removeEventListener("focusout", scheduleUpdate);
      applyKeyboardClass(false);
    };
  }, []);

  return null;
}
