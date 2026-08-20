"use client";

// components/complex-memory/explorer.tsx
// 复杂记忆系统 · 数据管理组块查看器。
// 角色选择 + 七页签：核心记忆 / 日记 / 周期 / 事件 / 情绪坐标 / 迁移 / 配置。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BookOpen,
  Brain,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Download,
  Edit3,
  Flame,
  Layers,
  ListTree,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import { dateString } from "@/lib/complex-memory/utils";
import {
  loadComplexMemoryConfig,
  saveComplexMemoryConfig,
  getMemoryPrompt,
  setMemoryPrompt,
  resetMemoryPrompt,
  isComplexMemoryEnabled,
  setComplexMemoryEnabled,
  getEnabledCharacterIds,
} from "@/lib/complex-memory/config";
import {
  PROMPT_VARIABLES,
  GLOBAL_MACRO_VARIABLES,
  findUnknownTemplateVariables,
} from "@/lib/complex-memory/prompts";
import {
  loadEvents,
  loadDailies,
  loadPeriods,
  loadCoreVersions,
  getCurrentCore,
  deleteEvent,
  deleteDaily,
  deletePeriod,
  getAllCharacterIds,
  countByCharacter,
  saveDaily,
  saveEvent,
} from "@/lib/complex-memory/storage";
import {
  manualUpdateCoreMemory,
  bootstrapCoreMemory,
  rebuildCoreMemory,
  sanitizeCoreContent,
} from "@/lib/complex-memory/core-builder";
import { generateDaily } from "@/lib/complex-memory/daily-generator";
import { distillPeriod } from "@/lib/complex-memory/period-distiller";
import { runEventGeneration } from "@/lib/complex-memory/event-generator";
import {
  getMigrationState,
  startMigration,
  pauseMigration,
  resumeMigration,
  resetMigration,
  runMigrationStep,
  estimateMigration,
} from "@/lib/complex-memory/migration";
import { boostedVoltage, effectiveVoltage } from "@/lib/complex-memory/voltage";
import type {
  ComplexCore,
  ComplexDaily,
  ComplexEvent,
  ComplexPeriod,
  ComplexMemoryConfig,
  MemoryPromptKey,
  MigrationState,
} from "@/lib/complex-memory/types";

const ACCENT = "#2F9E97";

type TabId = "core" | "daily" | "period" | "event" | "emotion" | "migration" | "config";

const TABS: Array<{ id: TabId; label: string; icon: typeof Brain }> = [
  { id: "core", label: "核心记忆", icon: Brain },
  { id: "daily", label: "日记", icon: BookOpen },
  { id: "period", label: "周期", icon: CalendarRange },
  { id: "event", label: "事件", icon: ListTree },
  { id: "emotion", label: "情绪坐标", icon: Activity },
  { id: "migration", label: "迁移", icon: Download },
  { id: "config", label: "配置", icon: Settings2 },
];

type Notice = { kind: "ok" | "err"; text: string };

function useNotice(): { notice: Notice | null; notify: (n: Notice) => void; clear: () => void } {
  const [notice, setNotice] = useState<Notice | null>(null);
  const notify = useCallback((n: Notice) => setNotice(n), []);
  const clear = useCallback(() => setNotice(null), []);
  return { notice, notify, clear };
}

function NoticeBar({ notice, onClear }: { notice: Notice | null; onClear: () => void }) {
  if (!notice) return null;
  return (
    <div className={`cm-notice cm-notice-${notice.kind}`} role="status">
      <span>{notice.text}</span>
      <button type="button" className="cm-notice-close" onClick={onClear} aria-label="关闭">×</button>
    </div>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function voltagePct(v: number): string {
  return `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
}

// ── 主组件 ──
export function ComplexMemoryExplorer() {
  const [characters, setCharacters] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [tab, setTab] = useState<TabId>("core");
  const [refreshKey, setRefreshKey] = useState(0);
  const { notice, notify, clear } = useNotice();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = loadCharacters();
      const enabled = new Set(getEnabledCharacterIds());
      const withData = new Set(await getAllCharacterIds());
      const candidates = all
        .filter((c) => enabled.has(c.id) || withData.has(c.id))
        .map((c) => ({ id: c.id, name: c.name }));
      if (cancelled) return;
      setCharacters(candidates);
      setSelectedId((prev) => {
        if (prev && candidates.some((c) => c.id === prev)) return prev;
        return candidates[0]?.id ?? "";
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const selected = characters.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="cm-explorer">
      <div className="cm-toolbar">
        <div className="cm-character-select">
          <span className="cm-toolbar-label">角色</span>
          <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} aria-label="选择角色">
            {characters.length === 0 && <option value="">暂无已启用/有数据的角色</option>}
            {characters.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        </div>
        <div className="cm-tabs" role="tablist" aria-label="复杂记忆页签">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`cm-tab ${tab === id ? "is-active" : ""}`}
              onClick={() => setTab(id)}
            >
              <Icon size={15} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <NoticeBar notice={notice} onClear={clear} />

      {!selected ? (
        <div className="cm-empty">
          <Layers size={28} strokeWidth={1.5} />
          <p>暂无已启用复杂记忆或已有数据的角色。请在聊天会话设置中开启「复杂记忆系统」。</p>
        </div>
      ) : (
        <div className="cm-tab-body">
          {tab === "core" && <CoreTab characterId={selected.id} characterName={selected.name} notify={notify} refresh={refresh} />}
          {tab === "daily" && <DailyTab characterId={selected.id} characterName={selected.name} notify={notify} refresh={refresh} />}
          {tab === "period" && <PeriodTab characterId={selected.id} characterName={selected.name} notify={notify} refresh={refresh} />}
          {tab === "event" && <EventTab characterId={selected.id} characterName={selected.name} notify={notify} refresh={refresh} />}
          {tab === "emotion" && <EmotionTab characterId={selected.id} />}
          {tab === "migration" && <MigrationTab characterId={selected.id} characterName={selected.name} notify={notify} />}
          {tab === "config" && <ConfigTab characterId={selected.id} notify={notify} />}
        </div>
      )}
    </div>
  );
}

// ── 核心记忆页 ──
function CoreTab({ characterId, characterName, notify, refresh }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
  refresh: () => void;
}) {
  const [core, setCore] = useState<ComplexCore | null>(null);
  const [versions, setVersions] = useState<ComplexCore[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sanitizeReport, setSanitizeReport] = useState<{ ok: boolean; banned: string[] } | null>(null);

  const load = useCallback(async () => {
    const [current, all] = await Promise.all([getCurrentCore(characterId), loadCoreVersions(characterId)]);
    setCore(current);
    setVersions(all);
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setBusy(true);
    const res = await manualUpdateCoreMemory(characterId, characterName, draft);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `核心记忆已保存为 v${res.version}` });
      setEditing(false);
      setDraft("");
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "保存失败" });
    }
  };

  const handleRebuild = async () => {
    setBusy(true);
    const res = await rebuildCoreMemory(characterId, characterName);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: "核心记忆定期重构完成" });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "重构失败" });
    }
  };

  const handleCheckSanitize = () => {
    setSanitizeReport(sanitizeCoreContent(draft, loadComplexMemoryConfig().sanitizerBanList));
  };

  const triggerLabel = core?.trigger === "bootstrap" ? "初始化"
    : core?.trigger === "scheduled" ? "定期重构"
    : core?.trigger === "period_driven" ? "周期驱动"
    : core?.trigger === "manual" ? "手动编辑"
    : "—";

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">当前版本</span>
        <div className="cm-actions">
          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={handleRebuild} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 定期重构
          </button>
          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => { setEditing(true); setDraft(core?.content ?? ""); }}>
            <Edit3 size={14} /> 手动编辑
          </button>
        </div>
      </div>

      {editing ? (
        <div className="cm-card">
          <Textarea
            className="cm-core-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            placeholder="P0-P3 五模块正文…"
          />
          <div className="cm-card-actions">
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={handleCheckSanitize}>
              <ShieldIcon /> 消毒检查
            </button>
            {sanitizeReport && (
              <span className={`cm-sanitize-report ${sanitizeReport.ok ? "is-ok" : "is-bad"}`}>
                {sanitizeReport.ok ? "通过，无禁用词" : `命中禁用词：${sanitizeReport.banned.join("、")}`}
              </span>
            )}
            <span className="cm-spacer" />
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setEditing(false)}>取消</button>
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleSave} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存为新版本
            </button>
          </div>
        </div>
      ) : core ? (
        <div className="cm-card">
          <div className="cm-meta-row">
            <span className="cm-badge">v{core.version}</span>
            <span className="cm-badge cm-badge-soft">触发：{triggerLabel}</span>
            <span className="cm-meta-text">更新于 {fmtTime(core.updatedAt)}</span>
          </div>
          <div className="cm-core-content">{core.content}</div>
        </div>
      ) : (
        <div className="cm-card cm-empty-inline">
          <p>该角色尚无核心记忆。</p>
          <button
            type="button"
            className="ui-btn ui-btn-primary ts-12"
            onClick={async () => {
              setBusy(true);
              const res = await bootstrapCoreMemory(characterId, characterName);
              setBusy(false);
              if (res.success) {
                notify({ kind: "ok", text: "核心记忆初始化完成" });
                await load();
                refresh();
              } else {
                notify({ kind: "err", text: res.error ?? "初始化失败" });
              }
            }}
            disabled={busy}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} 立即初始化
          </button>
        </div>
      )}

      <div className="cm-section-head" style={{ marginTop: 18 }}>
        <span className="cm-section-title">版本链</span>
      </div>
      <div className="cm-card">
        {versions.length === 0 ? (
          <p className="cm-muted">暂无历史版本</p>
        ) : (
          <div className="cm-version-list">
            {[...versions].reverse().map((v) => (
              <div key={v.id} className={`cm-version-item ${v.isCurrent ? "is-current" : ""}`}>
                <div className="cm-version-main">
                  <span className="cm-badge">v{v.version}</span>
                  <span className="cm-meta-text">{v.isCurrent ? "当前生效" : "历史版本"}</span>
                  <span className="cm-meta-text">{fmtTime(v.updatedAt)}</span>
                </div>
                <div className="cm-version-preview">{v.content.slice(0, 80)}{v.content.length > 80 ? "…" : ""}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ShieldIcon() {
  return <Lock size={14} />;
}

// ── 日记页 ──
function DailyTab({ characterId, characterName, notify, refresh }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
  refresh: () => void;
}) {
  const [dailies, setDailies] = useState<ComplexDaily[]>([]);
  const [periods, setPeriods] = useState<ComplexPeriod[]>([]);
  const [periodFilter, setPeriodFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ComplexDaily | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [ds, ps] = await Promise.all([loadDailies(characterId), loadPeriods(characterId)]);
    setDailies(ds);
    setPeriods(ps);
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const sorted = [...dailies].sort((a, b) => b.date.localeCompare(a.date));
    if (periodFilter === "all") return sorted;
    return sorted.filter((d) => d.belongsToPeriods.includes(periodFilter));
  }, [dailies, periodFilter]);

  const today = dateString(0);
  const todayExists = dailies.some((d) => d.date === today);

  const handleGenerate = async () => {
    setBusy(true);
    const res = await generateDaily(characterId, characterName, today);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: "今日日记已生成" });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "生成失败" });
    }
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    await saveDaily({ ...editing, content: draft });
    setBusy(false);
    setEditing(null);
    notify({ kind: "ok", text: "日记已更新" });
    await load();
  };

  const handleDelete = async (d: ComplexDaily) => {
    await deleteDaily(d.id);
    notify({ kind: "ok", text: "日记已删除" });
    await load();
  };

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">日记 · 共 {dailies.length} 篇</span>
        <div className="cm-actions">
          <Select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value)} className="cm-filter-select" aria-label="按周期筛选">
            <option value="all">全部周期</option>
            {periods.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </Select>
          {!todayExists && (
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleGenerate} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} 生成今日日记
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无日记</p></div>
      ) : (
        <div className="cm-daily-list">
          {filtered.map((d) => (
            <div key={d.id} className="cm-card cm-daily-item">
              <button type="button" className="cm-daily-head" onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}>
                <span className="cm-daily-date">{d.date}</span>
                <span className="cm-daily-periods">
                  {d.belongsToPeriods.map((pid) => periods.find((p) => p.id === pid)?.title).filter(Boolean).join("、") || "无周期"}
                </span>
                <span className="cm-daily-voltage">电压 {voltagePct(effectiveVoltage(d))}</span>
                {expandedId === d.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {expandedId === d.id && (
                <div className="cm-daily-body">
                  {editing?.id === d.id ? (
                    <>
                      <Textarea className="cm-core-editor" rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
                      <div className="cm-card-actions">
                        <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setEditing(null)}>取消</button>
                        <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleSaveEdit} disabled={busy}>
                          <Save size={14} /> 保存
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="cm-daily-content">{d.content}</div>
                      <div className="cm-card-actions">
                        <span className="cm-meta-text">情绪 {d.emotionVector.valence.toFixed(2)} / {d.emotionVector.arousal.toFixed(2)}</span>
                        <span className="cm-spacer" />
                        <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setEditing(d); setDraft(d.content); }}>
                          <Edit3 size={14} /> 编辑
                        </button>
                        <button type="button" className="ui-btn ui-btn-danger ts-12" onClick={() => void handleDelete(d)}>
                          <Trash2 size={14} /> 删除
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 周期页 ──
function PeriodTab({ characterId, characterName, notify, refresh }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
  refresh: () => void;
}) {
  const [periods, setPeriods] = useState<ComplexPeriod[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setPeriods(await loadPeriods(characterId));
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => {
    const active = periods.filter((p) => p.status === "active");
    const rest = periods.filter((p) => p.status !== "active").sort((a, b) => (b.endTime ?? "").localeCompare(a.endTime ?? ""));
    return [...active, ...rest];
  }, [periods]);

  const handleDistill = async (p: ComplexPeriod) => {
    setBusy(true);
    const res = await distillPeriod(characterId, characterName, p.id);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `周期「${p.title}」提炼完成` });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "提炼失败" });
    }
  };

  const statusLabel: Record<ComplexPeriod["status"], string> = { active: "进行中", stabilized: "已稳定", archived: "已归档" };

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">周期 · 共 {periods.length} 个</span>
      </div>
      {sorted.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无周期</p></div>
      ) : (
        <div className="cm-period-list">
          {sorted.map((p) => (
            <div key={p.id} className="cm-card cm-period-item">
              <button type="button" className="cm-period-head" onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}>
                <span className={`cm-status-dot is-${p.status}`} />
                <span className="cm-period-title">{p.title}</span>
                <span className="cm-period-range">{p.startTime} ~ {p.endTime ?? "至今"}</span>
                <span className="cm-badge cm-badge-soft">{statusLabel[p.status]}</span>
                {expandedId === p.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {expandedId === p.id && (
                <div className="cm-period-body">
                  {p.summary ? (
                    <div className="cm-period-summary">{p.summary}</div>
                  ) : (
                    <p className="cm-muted">尚未提炼总结</p>
                  )}
                  {Object.keys(p.timelineIndex).length > 0 && (
                    <div className="cm-timeline-index">
                      {Object.entries(p.timelineIndex).map(([day, line]) => (
                        <div key={day} className="cm-tl-row"><span className="cm-tl-day">{day}</span><span>{line}</span></div>
                      ))}
                    </div>
                  )}
                  {p.linkedPeriods.length > 0 && (
                    <p className="cm-meta-text">丝线关联：{p.linkedPeriods.join("、")}</p>
                  )}
                  <div className="cm-card-actions">
                    <span className="cm-meta-text">覆盖事件 {p.coveredEventIds.length} 条 · 电压 {voltagePct(effectiveVoltage(p))}</span>
                    <span className="cm-spacer" />
                    {p.status === "active" && (
                      <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleDistill(p)} disabled={busy}>
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Flame size={14} />} 立即提炼
                      </button>
                    )}
                    <button type="button" className="ui-btn ui-btn-danger ts-12" onClick={async () => { await deletePeriod(p.id); notify({ kind: "ok", text: "周期已删除" }); await load(); }}>
                      <Trash2 size={14} /> 删除
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 事件页 ──
function EventTab({ characterId, characterName, notify, refresh }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
  refresh: () => void;
}) {
  const [events, setEvents] = useState<ComplexEvent[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setEvents(await loadEvents(characterId));
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp)), [events]);
  const config = loadComplexMemoryConfig();

  const handleGenerate = async () => {
    setBusy(true);
    const res = await runEventGeneration(characterId, characterName);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: "事件记忆已生成" });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "生成失败" });
    }
  };

  const handleBoost = async (e: ComplexEvent) => {
    const boosted = boostedVoltage(e, config.voltageRecallBoost);
    await saveEvent({ ...e, voltage: boosted.voltage, lastAccessedAt: boosted.lastAccessedAt });
    notify({ kind: "ok", text: "电压已充能" });
    await load();
  };

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">事件记忆 · 共 {events.length} 条</span>
        <div className="cm-actions">
          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleGenerate} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} 立即压缩
          </button>
        </div>
      </div>
      {sorted.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无事件记忆</p></div>
      ) : (
        <div className="cm-event-list">
          {sorted.map((e) => {
            const v = effectiveVoltage(e);
            const pendingErase = e.coveredByPeriod && v < config.voltageEraseThreshold;
            return (
              <div key={e.id} className="cm-card cm-event-item">
                <button type="button" className="cm-event-head" onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}>
                  <span className="cm-event-time">{e.timestamp.slice(0, 16).replace("T", " ")}</span>
                  <span className="cm-event-importance">重要 {Math.round(e.importanceScore * 100)}%</span>
                  {pendingErase && <span className="cm-badge cm-badge-warn">待消磨</span>}
                  {e.coveredByPeriod && <span className="cm-badge cm-badge-soft">已覆盖</span>}
                  <span className="cm-event-voltage">
                    <span className="cm-voltage-track"><span className="cm-voltage-fill" style={{ width: voltagePct(v) }} /></span>
                    <span className="cm-voltage-num">{voltagePct(v)}</span>
                  </span>
                  {expandedId === e.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                {expandedId === e.id && (
                  <div className="cm-event-body">
                    <div className="cm-event-content">{e.content}</div>
                    <div className="cm-card-actions">
                      <span className="cm-meta-text">情绪 {e.emotion.valence.toFixed(2)} / {e.emotion.arousal.toFixed(2)}</span>
                      <span className="cm-spacer" />
                      <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleBoost(e)}>
                        <Zap size={14} /> 充能
                      </button>
                      <button type="button" className="ui-btn ui-btn-danger ts-12" onClick={async () => { await deleteEvent(e.id); notify({ kind: "ok", text: "事件已删除" }); await load(); }}>
                        <Trash2 size={14} /> 删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 情绪坐标页 ──
function EmotionTab({ characterId }: { characterId: string }) {
  const [dailies, setDailies] = useState<ComplexDaily[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadDailies(characterId).then((ds) => {
      if (!cancelled) setDailies(ds);
    });
    return () => {
      cancelled = true;
    };
  }, [characterId]);

  const W = 560;
  const H = 380;
  const padL = 46;
  const padR = 20;
  const padT = 24;
  const padB = 40;
  const x = (valence: number) => padL + ((valence + 1) / 2) * (W - padL - padR);
  const y = (arousal: number) => padT + (1 - arousal) * (H - padT - padB);

  const oldest = dailies.length ? Math.min(...dailies.map((d) => new Date(d.date).getTime())) : Date.now();
  const newest = dailies.length ? Math.max(...dailies.map((d) => new Date(d.date).getTime())) : Date.now();
  const ageRatio = (d: ComplexDaily) => {
    if (newest === oldest) return 0;
    return (new Date(d.date).getTime() - oldest) / (newest - oldest);
  };

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">情绪坐标 · {dailies.length} 篇日记</span>
      </div>
      <div className="cm-card">
        {dailies.length === 0 ? (
          <p className="cm-muted">暂无日记数据</p>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="cm-emotion-scatter" role="img" aria-label="情绪坐标散点图">
            {[-1, -0.5, 0, 0.5, 1].map((v) => (
              <line key={`vx${v}`} x1={x(v)} y1={padT} x2={x(v)} y2={H - padB} className="cm-scatter-grid" />
            ))}
            {[0, 0.25, 0.5, 0.75, 1].map((a) => (
              <line key={`hy${a}`} x1={padL} y1={y(a)} x2={W - padR} y2={y(a)} className="cm-scatter-grid" />
            ))}
            <line x1={x(0)} y1={padT} x2={x(0)} y2={H - padB} className="cm-scatter-axis" />
            <line x1={padL} y1={y(0.5)} x2={W - padR} y2={y(0.5)} className="cm-scatter-axis" />
            {[-1, -0.5, 0, 0.5, 1].map((v) => (
              <text key={`tx${v}`} x={x(v)} y={H - padB + 18} textAnchor="middle" className="cm-scatter-label">{v}</text>
            ))}
            {[0, 0.25, 0.5, 0.75, 1].map((a) => (
              <text key={`ty${a}`} x={padL - 8} y={y(a) + 4} textAnchor="end" className="cm-scatter-label">{a}</text>
            ))}
            <text x={(W - padR + padL) / 2} y={H - 6} textAnchor="middle" className="cm-scatter-caption">效价 valence（消极 → 积极）</text>
            <text x={14} y={(padT + H - padB) / 2} textAnchor="middle" transform={`rotate(-90 14 ${(padT + H - padB) / 2})`} className="cm-scatter-caption">唤醒度 arousal</text>
            {dailies.map((d) => {
              const ratio = ageRatio(d);
              const alpha = 0.35 + ratio * 0.65;
              return (
                <circle
                  key={d.id}
                  cx={x(d.emotionVector.valence)}
                  cy={y(d.emotionVector.arousal)}
                  r={5}
                  fill={ACCENT}
                  opacity={alpha}
                >
                  <title>{`${d.date} · 效价 ${d.emotionVector.valence.toFixed(2)} · 唤醒 ${d.emotionVector.arousal.toFixed(2)}`}</title>
                </circle>
              );
            })}
          </svg>
        )}
        <p className="cm-muted cm-scatter-legend">颜色深浅表示日期新旧：越深越近。一期为静态展示。</p>
      </div>
    </div>
  );
}

// ── 迁移页：一键迁移向导（float → 复杂记忆） ──
const MIGRATION_DAY_OPTIONS = [
  { label: "7 天", value: 7 },
  { label: "30 天", value: 30 },
  { label: "90 天", value: 90 },
  { label: "全量", value: 0 },
];

const PHASE_LABEL: Record<MigrationState["phase"], string> = {
  legacy: "压缩历史素材",
  dailies: "回溯生成日记",
  distill: "提炼周期",
  core: "构建核心记忆",
  done: "已完成",
};

function MigrationTab({ characterId, characterName, notify }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
}) {
  const [counts, setCounts] = useState<{ events: number; dailies: number; periods: number; cores: number } | null>(null);
  const [state, setState] = useState<MigrationState | null>(() => getMigrationState(characterId));
  const [days, setDays] = useState<number>(() => loadComplexMemoryConfig().migrationDefaultDays);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadCounts = useCallback(async () => {
    setCounts(await countByCharacter(characterId));
  }, [characterId]);

  const refreshState = useCallback(() => {
    setState(getMigrationState(characterId));
  }, [characterId]);

  useEffect(() => {
    void loadCounts();
    refreshState();
    return () => stopAuto();
  }, [characterId, loadCounts, refreshState]);

  const stopAuto = () => {
    if (autoRef.current) {
      clearInterval(autoRef.current);
      autoRef.current = null;
    }
  };

  const startAuto = () => {
    if (autoRef.current) return;
    autoRef.current = setInterval(async () => {
      const res = await runMigrationStep(characterId, characterName);
      refreshState();
      if (res.done) {
        stopAuto();
        return;
      }
      // 上一步 LLM 仍在执行时 runMigrationStep 会返回 busy 错误，属正常轮询，跳过即可
      if (res.error && res.error !== "迁移步骤执行中") {
        stopAuto();
        notify({ kind: "err", text: res.error });
      }
    }, 400);
  };

  const handleStart = async () => {
    setBusy(true);
    const res = await startMigration(characterId, characterName, days);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `迁移已启动，预估约 ${fmtTokens(res.estimate ?? 0)}` });
      refreshState();
      startAuto();
    } else {
      notify({ kind: "err", text: res.error ?? "迁移启动失败" });
    }
  };

  const handlePause = () => {
    stopAuto();
    pauseMigration(characterId);
    refreshState();
    notify({ kind: "ok", text: "迁移已暂停，可随时继续" });
  };

  const handleResume = () => {
    resumeMigration(characterId);
    refreshState();
    startAuto();
  };

  const handleReset = () => {
    stopAuto();
    resetMigration(characterId);
    setState(null);
    void loadCounts();
    notify({ kind: "ok", text: "迁移记录已重置" });
  };

  const handleEstimate = () => {
    setEstimate(estimateMigration(characterId, days));
  };

  const running = state?.status === "running";
  const paused = state?.status === "paused";
  const done = state?.status === "done";
  const progress = state && state.totalDays > 0 ? Math.min(100, Math.round((state.doneDays / state.totalDays) * 100)) : 0;

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">一键迁移</span>
        {state && (
          <span className={`cm-badge ${done ? "" : "cm-badge-soft"}`}>
            {done ? "已完成" : paused ? "已暂停" : running ? "进行中" : "未开始"}
          </span>
        )}
      </div>

      {!state || state.status === "idle" ? (
        <div className="cm-card">
          <p className="cm-muted">
            将「{characterName}」的历史聊天记录回溯生成复杂记忆（日记 / 周期 / 核心），
            旧 float 长期与核心记忆会压缩为一条「历史沉淀」周期素材，不逐条搬运。
            迁移从最近日期向过去推进，可随时暂停并断点续跑。
          </p>
          <div className="cm-mig-setup">
            <span className="cm-config-label">回溯范围</span>
            <div className="cm-mig-day-options">
              {MIGRATION_DAY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`cm-mig-day ${days === o.value ? "is-active" : ""}`}
                  onClick={() => { setDays(o.value); setEstimate(null); }}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={handleEstimate}>
              估算 token
            </button>
            {estimate !== null && (
              <span className="cm-meta-text">预估约 {fmtTokens(estimate)}</span>
            )}
          </div>
          {counts && (
            <div className="cm-meta-row">
              <span className="cm-badge cm-badge-soft">事件 {counts.events}</span>
              <span className="cm-badge cm-badge-soft">日记 {counts.dailies}</span>
              <span className="cm-badge cm-badge-soft">周期 {counts.periods}</span>
              <span className="cm-badge cm-badge-soft">核心 v{counts.cores}</span>
            </div>
          )}
          <div className="cm-card-actions">
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleStart()} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 开始迁移
            </button>
          </div>
        </div>
      ) : (
        <div className="cm-card">
          <div className="cm-meta-row">
            <span className="cm-badge cm-badge-soft">阶段：{PHASE_LABEL[state.phase]}</span>
            <span className="cm-meta-text">
              {state.doneDays} / {state.totalDays} 天 · {state.currentDate ?? "—"}
            </span>
          </div>
          <div className="cm-mig-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="cm-mig-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          {state.error && <p className="cm-sanitize-report is-bad">{state.error}</p>}
          {done && state.report && (
            <div className="cm-mig-report-grid">
              <div className="cm-mig-report-item"><span className="cm-mig-report-num">{state.report.events}</span><span className="cm-mig-report-label">事件</span></div>
              <div className="cm-mig-report-item"><span className="cm-mig-report-num">{state.report.dailies}</span><span className="cm-mig-report-label">日记</span></div>
              <div className="cm-mig-report-item"><span className="cm-mig-report-num">{state.report.periods}</span><span className="cm-mig-report-label">周期</span></div>
              <div className="cm-mig-report-item"><span className="cm-mig-report-num">v{state.report.cores}</span><span className="cm-mig-report-label">核心</span></div>
            </div>
          )}
          {done && state.report && (
            <p className="cm-muted">
              预估消耗 {fmtTokens(state.report.tokenEstimate)}
              {state.report.failedDates.length > 0 ? ` · ${state.report.failedDates.length} 天失败（${state.report.failedDates.join("、")}）` : " · 无失败项"}。
              核对通过后可在会话设置中开启复杂记忆开关。
            </p>
          )}
          <div className="cm-card-actions">
            {running && (
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={handlePause}>
                <RotateCcw size={14} /> 暂停
              </button>
            )}
            {paused && (
              <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleResume}>
                <RefreshCw size={14} /> 继续迁移
              </button>
            )}
            {!done && (
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void runMigrationStep(characterId, characterName).then((r) => { refreshState(); if (r.error) notify({ kind: "err", text: r.error }); })}>
                <Zap size={14} /> 执行一步
              </button>
            )}
            <span className="cm-spacer" />
            <button type="button" className="ui-btn ui-btn-danger ts-12" onClick={handleReset}>
              <Trash2 size={14} /> 重置
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── 配置页 ──
function ConfigTab({ characterId, notify }: { characterId: string; notify: (n: Notice) => void }) {
  const [config, setConfig] = useState<ComplexMemoryConfig>(() => loadComplexMemoryConfig());
  const [promptKey, setPromptKey] = useState<MemoryPromptKey>("core");
  const [promptDraft, setPromptDraft] = useState<string>(() => getMemoryPrompt("core"));
  const [unknownVars, setUnknownVars] = useState<string[]>([]);

  const update = (patch: Partial<ComplexMemoryConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveComplexMemoryConfig(next);
  };

  const numField = (key: keyof ComplexMemoryConfig, label: string, hint?: string) => (
    <div className="cm-config-row">
      <span className="cm-config-label">{label}</span>
      <Input
        type="number"
        value={String(config[key] as number)}
        onChange={(e) => update({ [key]: Number(e.target.value) } as Partial<ComplexMemoryConfig>)}
        className="cm-config-input"
      />
      {hint && <span className="cm-config-hint">{hint}</span>}
    </div>
  );

  const boolField = (key: keyof ComplexMemoryConfig, label: string, hint?: string) => (
    <div className="cm-config-row">
      <span className="cm-config-label">{label}</span>
      <span className="cm-config-hint">{hint}</span>
      <Toggle checked={Boolean(config[key])} onChange={(v) => update({ [key]: v } as Partial<ComplexMemoryConfig>)} />
    </div>
  );

  const switchPrompt = (key: MemoryPromptKey) => {
    setPromptKey(key);
    setPromptDraft(getMemoryPrompt(key));
    setUnknownVars(findUnknownTemplateVariables(getMemoryPrompt(key)));
  };

  const handlePromptSave = () => {
    setMemoryPrompt(promptKey, promptDraft);
    notify({ kind: "ok", text: `模板「${promptKey}」已保存` });
  };

  const handlePromptReset = () => {
    resetMemoryPrompt(promptKey);
    setPromptDraft(getMemoryPrompt(promptKey));
    setUnknownVars([]);
    notify({ kind: "ok", text: `模板「${promptKey}」已恢复默认` });
  };

  const insertVar = (name: string) => {
    setPromptDraft((prev) => `${prev}{{${name}}}`);
    setUnknownVars(findUnknownTemplateVariables(`${promptDraft}{{${name}}}`));
  };

  const banListText = config.sanitizerBanList.join("、");

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">数值与开关</span>
        <span className="cm-meta-text">角色开关：{isComplexMemoryEnabled(characterId) ? "已启用" : "未启用"}</span>
      </div>
      <div className="cm-card cm-config-grid">
        {numField("ringBufferMaxEntries", "L1 活跃窗口条数", "建议 100-200")}
        {numField("eventTriggerCount", "事件压缩触发数")}
        {numField("eventTargetLength", "事件篇幅目标（字）")}
        {numField("dailyTargetLength", "日记篇幅目标（字）")}
        {numField("dailyQuietMinutes", "日记静默判定（分钟）")}
        {numField("coreMinLength", "核心篇幅下限（字）")}
        {numField("coreMaxLength", "核心篇幅上限（字）")}
        {numField("coreUpdateDiaryCount", "定期重构日记累计数")}
        {numField("voltageDecayFactor", "电压衰减系数", "每 24h 未使用")}
        {numField("voltageRecallBoost", "召回回升量")}
        {numField("voltageEraseThreshold", "消磨电压阈值")}
        {numField("fixedShortTermEntries", "固定注入短期条数")}
        {numField("fixedRecentEventCount", "固定注入最新事件数")}
        {numField("recallTopK", "向量召回候选数")}
        {numField("rerankKeepMax", "重排保留上限")}
        {numField("totalInjectTokenBudget", "总注入预算（token）")}
        {numField("migrationDefaultDays", "迁移默认回溯天数")}
        {boolField("vectorRecallEnabled", "向量召回")}
        {boolField("rerankEnabled", "重排序")}
        {boolField("silkAssociationEnabled", "丝线联想")}
        {boolField("mirrorToFloatEnabled", "镜像到 float")}
      </div>

      <div className="cm-section-head" style={{ marginTop: 18 }}>
        <span className="cm-section-title">消毒禁词表</span>
      </div>
      <div className="cm-card">
        <Input
          value={banListText}
          onChange={(e) => update({ sanitizerBanList: e.target.value.split(/[、,，\s]+/).filter(Boolean) })}
          placeholder="用顿号或空格分隔禁词"
        />
        <p className="cm-muted cm-config-hint">核心记忆生成与手动编辑时命中即拒绝入库。</p>
      </div>

      <div className="cm-section-head" style={{ marginTop: 18 }}>
        <span className="cm-section-title">模板编辑器</span>
      </div>
      <div className="cm-card">
        <div className="cm-prompt-tabs">
          {(["event", "daily", "period", "core", "rerank"] as MemoryPromptKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`cm-prompt-tab ${promptKey === k ? "is-active" : ""}`}
              onClick={() => switchPrompt(k)}
            >
              {k}
            </button>
          ))}
        </div>
        <Textarea
          className="cm-core-editor cm-prompt-editor"
          rows={12}
          value={promptDraft}
          onChange={(e) => {
            setPromptDraft(e.target.value);
            setUnknownVars(findUnknownTemplateVariables(e.target.value));
          }}
        />
        {unknownVars.length > 0 && (
          <p className="cm-sanitize-report is-bad">未识别变量：{unknownVars.join("、")}（保存不阻止，但可能原样输出）</p>
        )}
        <div className="cm-card-actions">
          <span className="cm-meta-text">变量速查</span>
          <span className="cm-spacer" />
          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={handlePromptReset}>
            <RotateCcw size={14} /> 恢复默认
          </button>
          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handlePromptSave}>
            <Save size={14} /> 保存模板
          </button>
        </div>
        <div className="cm-var-panel">
          <p className="cm-var-caption">模板专属变量（点击插入）</p>
          <div className="cm-var-chips">
            {PROMPT_VARIABLES.filter((v) => v.templates.includes(promptKey)).map((v) => (
              <button key={v.name} type="button" className="cm-var-chip" title={v.description} onClick={() => insertVar(v.name)}>
                {`{{${v.name}}}`}
              </button>
            ))}
          </div>
          <p className="cm-var-caption">全局宏（点击插入）</p>
          <div className="cm-var-chips">
            {GLOBAL_MACRO_VARIABLES.map((v) => (
              <button key={v.name} type="button" className="cm-var-chip" title={v.description} onClick={() => insertVar(v.name)}>
                {`{{${v.name}}}`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
