"use client";

import { useRef, useState, type ReactNode } from "react";

type CallMiniWindowProps = {
  title: string;
  subtitle?: string;
  avatar?: string;
  /** 视频通话时传入实时的本地摄像头画面（<video>）节点；未传则显示头像。 */
  preview?: ReactNode;
  muted?: boolean;
  speakerMuted?: boolean;
  showMute?: boolean;
  showSpeaker?: boolean;
  onToggleMute?: () => void;
  onToggleSpeaker?: () => void;
  onHangup: () => void;
  onMaximize: () => void;
};

const WIN_W = 236;
const WIN_H = 288;

/** 通话小窗：可拖动、保持通话继续、提供挂断/静音/最大化等基本控制（模仿微信通话小窗）。 */
export function CallMiniWindow({
  title,
  subtitle,
  avatar,
  preview,
  muted,
  speakerMuted,
  showMute = true,
  showSpeaker = true,
  onToggleMute,
  onToggleSpeaker,
  onHangup,
  onMaximize,
}: CallMiniWindowProps) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(8, (typeof window !== "undefined" ? window.innerWidth : 340) - WIN_W - 12),
    y: 96,
  }));
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  function onHeaderDown(e: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos.x,
      baseY: pos.y,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function onHeaderMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    next(d.baseX + (e.clientX - d.startX), d.baseY + (e.clientY - d.startY));
  }

  function next(x: number, y: number) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nx = Math.max(4, Math.min(vw - WIN_W - 4, x));
    const ny = Math.max(4, Math.min(vh - WIN_H - 4, y));
    setPos({ x: nx, y: ny });
  }

  function onHeaderUp() {
    dragRef.current = null;
  }

  return (
    <div
      className="call-mini-window"
      style={{ left: pos.x, top: pos.y, width: WIN_W, height: WIN_H }}
      role="dialog"
      aria-modal="false"
      aria-label={`通话小窗：${title}`}
    >
      <div
        className="call-mini-header"
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        onPointerCancel={onHeaderUp}
      >
        <span className="call-mini-header-dot" aria-hidden="true" />
        <span className="call-mini-header-title">{title}</span>
        {subtitle && <span className="call-mini-header-sub">{subtitle}</span>}
        <button type="button" className="call-mini-btn call-mini-max" onClick={onMaximize} aria-label="最大化通话" title="最大化">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
          </svg>
        </button>
      </div>

      <div className="call-mini-preview">
        {preview ??
          (avatar ? (
            <img src={avatar} alt={title} className="call-mini-preview-img" />
          ) : (
            <span className="call-mini-preview-fallback">{title.slice(0, 1) || "?"}</span>
          ))}
        <span className="call-mini-duration">{subtitle || "通话中"}</span>
      </div>

      <div className="call-mini-controls">
        {showMute && (
          <button
            type="button"
            className="call-mini-btn call-mini-cmd"
            data-checked={muted ? "" : undefined}
            onClick={onToggleMute}
            aria-label={muted ? "取消静音麦克风" : "静音麦克风"}
            title={muted ? "取消静音麦克风" : "静音麦克风"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
        )}
        {showSpeaker && (
          <button
            type="button"
            className="call-mini-btn call-mini-cmd"
            data-checked={speakerMuted ? "" : undefined}
            onClick={onToggleSpeaker}
            aria-label={speakerMuted ? "取消扬声器静音" : "静音扬声器"}
            title={speakerMuted ? "取消扬声器静音" : "静音扬声器"}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              {speakerMuted ? <line x1="23" y1="9" x2="17" y2="15" /> : <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />}
            </svg>
          </button>
        )}
        <button type="button" className="call-mini-btn call-mini-cmd call-mini-hangup" onClick={onHangup} aria-label="挂断" title="挂断">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
            <line x1="23" y1="1" x2="1" y2="23" />
          </svg>
        </button>
      </div>
    </div>
  );
}
