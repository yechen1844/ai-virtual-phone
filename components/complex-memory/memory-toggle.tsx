"use client";

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { Toggle } from "@/components/ui/form";
import {
  isComplexMemoryEnabled,
  setComplexMemoryEnabled,
  loadComplexMemoryConfig,
  getRingBuffer,
} from "@/lib/complex-memory/config";
import {
  countByCharacter,
  getCurrentCoreView,
  getDaily,
} from "@/lib/complex-memory/storage";

type ComplexMemoryToggleProps = {
  characterId: string;
  characterName?: string;
};

type StatusSummary = {
  coreVersion: number | null;
  lastDailyDate: string | null;
  eventCount: number;
  pendingCount: number;
  threshold: number;
  autoSummarize: boolean;
  watermark: string | null;
};

export function ComplexMemoryToggle({ characterId, characterName }: ComplexMemoryToggleProps) {
  const [enabled, setEnabled] = useState<boolean>(() => isComplexMemoryEnabled(characterId));
  const [status, setStatus] = useState<StatusSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [counts, core, yesterday, ring, config] = await Promise.all([
        countByCharacter(characterId),
        getCurrentCoreView(characterId),
        getDaily(characterId, todayDateString()),
        Promise.resolve(getRingBuffer(characterId)),
        Promise.resolve(loadComplexMemoryConfig()),
      ]);
      if (cancelled) return;
      setStatus({
        coreVersion: core.snapshot?.version ?? null,
        lastDailyDate: yesterday?.date ?? null,
        eventCount: counts.events,
        pendingCount: ring.pendingCount,
        threshold: config.eventTriggerCount,
        autoSummarize: config.autoSummarizeEnabled,
        watermark: ring.watermarkTimestamp,
      });
    };
    void refresh();
    // 无控制台也能看到实时变化：每 2 秒刷新一次
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [characterId, enabled]);

  const handleToggle = (next: boolean) => {
    setComplexMemoryEnabled(characterId, next);
    setEnabled(next);
  };

  return (
    <div className="menu-item">
      <span className="chat-info-icon" style={{ "--icon-color": "#2F9E97" } as React.CSSProperties}>
        <Layers size={22} strokeWidth={1.75} />
      </span>
      <div className="menu-label-group">
        <span className="menu-label">复杂记忆系统</span>
        <span className="menu-desc">
          {enabled
            ? status
              ? `核心 v${status.coreVersion ?? "—"} · 事件 ${status.eventCount} 条 · 最近日记 ${status.lastDailyDate ?? "无"}`
              : "已启用"
            : "未启用时使用 float 原生记忆"}
        </span>
        <span className="menu-desc" style={{ color: "var(--c-info, #6ab0ff)" }}>
          [诊断] enabled={String(enabled)} · autoSummary={String(status?.autoSummarize)} · count={String(status?.pendingCount)}/{String(status?.threshold)} · wm={status?.watermark ?? "null"} · ev={String(status?.eventCount)} · 今日日记={status?.lastDailyDate ?? "无"}
        </span>
        {enabled && status && (
          <span className="menu-desc" style={{ color: "var(--c-text-dim, rgba(255,255,255,0.55))" }}>
            自动总结 {status.autoSummarize ? "开" : "关"} · 事件计数 {status.pendingCount}/{status.threshold} · 上次总结到 {status.watermark ? new Date(status.watermark).toLocaleString() : "未开始"}
          </span>
        )}
        {enabled && !status?.coreVersion && (
          <span className="menu-desc" style={{ color: "var(--c-warning, #d08770)" }}>
            尚无核心记忆：将从未有过的记忆开始，或使用一键迁移
          </span>
        )}
      </div>
      <div className="menu-right">
        <Toggle checked={enabled} onChange={handleToggle} />
      </div>
    </div>
  );
}

function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
