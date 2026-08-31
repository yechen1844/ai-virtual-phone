"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

// 临时诊断 HUD：真机键盘黑屏定位用。默认关闭，右上角按钮开关。
// 每 ~280ms 采样一次并**追加进日志**（带时间戳），黑屏结束后可暂停、滚动查看、一键复制、清除。
const SAMPLE_MS = 280;
const MAX_ENTRIES = 220;

type Entry = {
  t: string;
  text: string;
};

function fmtClock(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function sample(): { kb: boolean; text: string } {
  const vp = window.visualViewport;
  const iw = window.innerHeight;
  const vh = vp?.height ?? iw;
  const ot = vp?.offsetTop ?? 0;
  const delta = Math.max(0, iw - vh - ot);
  let blur = 0;
  const all = document.querySelectorAll("*");
  const cap = Math.min(all.length, 3000);
  for (let i = 0; i < cap; i += 1) {
    const el = all[i] as HTMLElement;
    const s = window.getComputedStyle(el);
    if (s.backdropFilter && s.backdropFilter !== "none") blur += 1;
  }
  const memAny = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  const mem = memAny?.usedJSHeapSize ? (memAny.usedJSHeapSize / 1048576).toFixed(1) : "?";
  const doc = document.documentElement;
  const busy = doc.getAttribute("data-glass-busy") ?? "-";
  const kb = doc.classList.contains("kb-open") ? "1" : "0";
  const kbCover = delta > 120;
  const text =
    `iw=${iw} vh=${vh} ot=${ot} busy=${busy} kb=${kb} blur=${blur} mem=${mem}MB`;
  return { kb: kbCover, text };
}

export function BlackScreenDiag() {
  const [on, setOn] = useState(false);
  const [paused, setPaused] = useState(false);
  const [log, setLog] = useState<Entry[]>([]);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!on || paused) return;
    let timer = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const { text } = sample();
      const entry: Entry = { t: fmtClock(new Date()), text };
      setLog((prev) => {
        const next = [...prev, entry];
        if (next.length > MAX_ENTRIES) next.splice(0, next.length - MAX_ENTRIES);
        return next;
      });
      timer = window.setTimeout(tick, SAMPLE_MS);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [on, paused]);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const doCopy = async () => {
    const all = log.map((e) => `${e.text}`).join("\n");
    if (!all) return;
    try {
      await navigator.clipboard.writeText(all);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = all;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
  };

  const doClear = () => setLog([]);

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: 6,
          right: 6,
          zIndex: 2147483000,
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          maxWidth: "56vw",
          justifyContent: "flex-end",
        }}
      >
        <button onClick={() => setOn((v) => !v)} style={{ ...btn, background: on ? "#2F9E97" : "rgba(0,0,0,0.35)" }}>
          诊断 {on ? "●" : "○"}
        </button>
        <button onClick={() => setPaused((v) => !v)} style={{ ...btn, background: paused ? "#b45309" : "rgba(0,0,0,0.35)" }}>
          {paused ? "继续 ▶" : "暂停 ■"}
        </button>
        <button onClick={() => void doCopy()} style={{ ...btn, background: copied ? "#2F9E97" : "rgba(0,0,0,0.35)" }}>
          {copied ? "已复制 ✓" : "复制 ⧉"}
        </button>
        <button onClick={doClear} style={{ ...btn, background: "rgba(0,0,0,0.35)" }}>
          清除 🗑
        </button>
      </div>

      {on && (
        <div
          style={{
            position: "fixed",
            top: 34,
            right: 6,
            zIndex: 2147483000,
            background: "rgba(0,0,0,0.85)",
            color: "#4FEA8C",
            fontSize: 10,
            lineHeight: 1.5,
            padding: "6px 8px",
            borderRadius: 8,
            fontFamily: "monospace",
            maxWidth: "80vw",
          }}
        >
          <div style={{ opacity: 0.75, marginBottom: 2 }}>共 {log.length} 条（键=iw-vh &gt; 120）</div>
          <div
            ref={boxRef}
            style={{
              maxHeight: "58vh",
              overflowY: "auto",
              WebkitOverflowScrolling: "touch",
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {log.map((e, i) => (
              <div key={i} style={{ whiteSpace: "pre", wordBreak: "break-all" }}>
                {`${e.t}  ${e.text}`}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const btn: CSSProperties = {
  fontSize: 10,
  padding: "3px 8px",
  borderRadius: 999,
  border: "1px solid rgba(0,0,0,0.25)",
  color: "#fff",
  cursor: "pointer",
};
