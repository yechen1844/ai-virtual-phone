"use client";

import { useEffect, useState } from "react";

// 临时诊断 HUD：真机键盘黑屏定位用。默认关闭，右上角按钮开关。
// 实时采样键盘开合时的视口几何 + data-glass-busy / kb-open 是否生效 + blur 元素数 + JS 堆内存。
export function BlackScreenDiag() {
  const [on, setOn] = useState(false);
  const [m, setM] = useState<string>("...");

  useEffect(() => {
    if (!on) return;
    let timer = 0;
    let cancelled = false;

    const sample = () => {
      if (cancelled) return;
      const vp = window.visualViewport;
      let blur = 0;
      const all = document.querySelectorAll("*");
      const cap = Math.min(all.length, 4000);
      for (let i = 0; i < cap; i += 1) {
        const el = all[i] as HTMLElement;
        const s = window.getComputedStyle(el);
        if (s.backdropFilter && s.backdropFilter !== "none") blur += 1;
      }
      const memAny = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
      const mem = memAny?.usedJSHeapSize ? (memAny.usedJSHeapSize / 1048576).toFixed(1) : "?";
      const doc = document.documentElement;
      setM(
        `iw=${window.innerHeight} vh=${vp?.height ?? "?"} ot=${vp?.offsetTop ?? "?"} ` +
          `busy=${doc.getAttribute("data-glass-busy") ?? "-"} kb=${doc.classList.contains("kb-open") ? "1" : "0"} ` +
          `blur=${blur} mem=${mem}MB`
      );
      timer = window.setTimeout(sample, 250);
    };

    sample();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [on]);

  return (
    <>
      <button
        onClick={() => setOn((v) => !v)}
        style={{
          position: "fixed",
          top: 6,
          right: 6,
          zIndex: 2147483000,
          fontSize: 10,
          padding: "3px 8px",
          borderRadius: 999,
          border: "1px solid rgba(0,0,0,0.2)",
          background: on ? "#2F9E97" : "rgba(0,0,0,0.35)",
          color: "#fff",
        }}
      >
        黑屏诊断 {on ? "●开" : "○关"}
      </button>
      {on && (
        <div
          style={{
            position: "fixed",
            top: 30,
            right: 6,
            zIndex: 2147483000,
            background: "rgba(0,0,0,0.82)",
            color: "#4FEA8C",
            fontSize: 10,
            lineHeight: 1.5,
            padding: "6px 8px",
            borderRadius: 6,
            fontFamily: "monospace",
            maxWidth: "78vw",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {m}
        </div>
      )}
    </>
  );
}
