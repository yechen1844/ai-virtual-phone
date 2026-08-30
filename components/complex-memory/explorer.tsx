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
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  Flame,
  Languages,
  Layers,
  ListTree,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Zap,
  Link,
} from "lucide-react";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { MemoryTimeline } from "@/components/memory/memory-timeline";
import { dateString } from "@/lib/complex-memory/utils";
import {
  loadComplexMemoryConfig,
  saveComplexMemoryConfig,
  getMemoryPrompt,
  setMemoryPrompt,
  resetMemoryPrompt,
  isComplexMemoryEnabled,
  setComplexMemoryEnabled,
  loadCharacterState,
  clearFailedDaily,
  getEnabledCharacterIds,
  loadCharacterRules,
  saveCharacterRules,
} from "@/lib/complex-memory/config";
import {
  PROMPT_VARIABLES,
  GLOBAL_MACRO_VARIABLES,
  findUnknownTemplateVariables,
} from "@/lib/complex-memory/prompts";
import {
  loadEvents,
  loadEventSaveLog,
  loadDailies,
  loadPeriods,
  getCurrentCoreView,
  loadCoreSnapshots,
  loadCoreEntries,
  getCoreSnapshotByVersion,
  deleteEvent,
  deleteDaily,
  deletePeriod,
  getAllCharacterIds,
  countByCharacter,
  saveDaily,
  saveEvent,
  savePeriod,
  type CurrentCoreView,
} from "@/lib/complex-memory/storage";
import {
  bootstrapCoreMemory,
  rebuildCoreMemory,
  regenerateCoreWithFeedback,
  rollbackCoreVersion,
  addCoreEntry,
  editCoreEntry,
  deleteCoreEntry,
  sanitizeCoreEntryText,
} from "@/lib/complex-memory/core-builder";
import { generateDaily, regenerateDaily, summarizeDailyRange } from "@/lib/complex-memory/daily-generator";
import { distillPeriod, createPeriodManual } from "@/lib/complex-memory/period-distiller";
import { runEventGeneration, regenerateEvent, uncoverEvent } from "@/lib/complex-memory/event-generator";
import {
  getMigrationState,
  startMigration,
  pauseMigration,
  resumeMigration,
  resetMigration,
  hardResetCharacterMemory,
  runMigrationStep,
  driveMigration,
  estimateMigration,
  retryFailedDate,
  exportToFloat,
} from "@/lib/complex-memory/migration";
import {
  scanCleanupClusters,
  mergeCluster,
  mergeClusterIntoPeriod,
  createPeriodFromCluster,
  rollbackCleanup,
  listCleanupSnapshots,
  type CleanupCluster,
  type CleanupSnapshot,
} from "@/lib/complex-memory/cleanup";
import { boostedVoltage, effectiveVoltage } from "@/lib/complex-memory/voltage";
import type {
  ComplexCoreEntry,
  ComplexCoreSnapshot,
  CoreCategory,
  ComplexDaily,
  ComplexEvent,
  ComplexPeriod,
  ComplexMemoryConfig,
  MemoryPromptKey,
  MigrationState,
} from "@/lib/complex-memory/types";
import { getFeedAudit, clearFeedAudit, type FeedAuditEntry, type FeedAuditKind } from "@/lib/complex-memory/feed-audit";
import { translateMemoryText } from "@/lib/complex-memory/memory-translate";
import { runPeriodThinking, type PeriodThinkResult, type PeriodThinkNew } from "@/lib/complex-memory/period-thinking";

const ACCENT = "#2F9E97";

type TabId = "core" | "daily" | "period" | "event" | "emotion" | "cleanup" | "native" | "migration" | "config" | "feed";

const TABS: Array<{ id: TabId; label: string; icon: typeof Brain }> = [
  { id: "core", label: "核心记忆", icon: Brain },
  { id: "daily", label: "日记", icon: BookOpen },
  { id: "period", label: "周期", icon: CalendarRange },
  { id: "event", label: "事件", icon: ListTree },
  { id: "emotion", label: "情绪坐标", icon: Activity },
  { id: "cleanup", label: "记忆清洗", icon: Sparkles },
  { id: "native", label: "原生记忆", icon: Layers },
  { id: "migration", label: "迁移", icon: Download },
  { id: "config", label: "配置", icon: Settings2 },
  { id: "feed", label: "投喂审计", icon: Activity },
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
  const [resetBusy, setResetBusy] = useState(false);

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

  // 调度器失败上报：页内展示（全局弹窗由 desktop-shell 负责）
  useEffect(() => {
    const onSchedulerError = (e: Event) => {
      const text = (e as CustomEvent).detail;
      if (text) notify({ kind: "err", text });
    };
    window.addEventListener("complex-memory-scheduler-error", onSchedulerError);
    return () => window.removeEventListener("complex-memory-scheduler-error", onSchedulerError);
  }, [notify]);

  const selected = characters.find((c) => c.id === selectedId) ?? null;

  // 彻底重置记忆：常驻全局操作（不依赖迁移状态），删除该角色全部长期记忆、保留短期，不可逆需二次确认。
  const handleHardReset = async () => {
    if (!selected || resetBusy) return;
    const ok = window.confirm(
      "确定要彻底重置该角色的所有长期记忆吗？\n\n将删除：事件记忆、每日日记、周期、核心记忆、核心快照。\n保留：短期聊天上下文。\n\n此操作不可逆，建议先「导出到 float」备份。",
    );
    if (!ok) return;
    setResetBusy(true);
    try {
      await hardResetCharacterMemory(selected.id);
      notify({ kind: "ok", text: `已彻底重置「${selected.name}」的长期记忆，短期沟通上下文保留` });
      refresh();
    } catch (err) {
      notify({ kind: "err", text: `重置失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setResetBusy(false);
    }
  };

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
        {selected && (
          <button
            type="button"
            className="ui-btn ui-btn-danger ts-12 cm-toolbar-reset"
            onClick={() => void handleHardReset()}
            disabled={resetBusy}
            title="删除该角色全部长期记忆（事件/日记/周期/核心），保留短期沟通上下文；不可逆，建议先导出到 float 备份"
          >
            {resetBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 重置记忆
          </button>
        )}
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
          {tab === "cleanup" && <CleanupTab characterId={selected.id} characterName={selected.name} notify={notify} refresh={refresh} />}
          {tab === "native" && <NativeMemoryTab characterId={selected.id} />}
          {tab === "migration" && <MigrationTab characterId={selected.id} characterName={selected.name} notify={notify} />}
          {tab === "config" && <ConfigTab characterId={selected.id} notify={notify} />}
          {tab === "feed" && <FeedAuditTab />}
        </div>
      )}
    </div>
  );
}

// ── 核心记忆页（条目式 + 版本时间线） ──
const CORE_CATEGORY_ORDER: CoreCategory[] = ["identity", "bond", "principle", "milestone"];
const CORE_CATEGORY_LABEL: Record<CoreCategory, string> = {
  identity: "身份认知",
  bond: "关系纽带",
  principle: "原则承诺",
  milestone: "里程碑事件",
};
const CORE_TRIGGER_LABEL: Record<string, string> = {
  bootstrap: "初始化",
  scheduled: "定期重构",
  period_driven: "周期驱动",
  manual: "手动编辑",
};

type EntryEditor = { mode: "add" } | { mode: "edit"; entry: ComplexCoreEntry };

// ── 向量化标志 + 原始记录折叠（供四类记忆卡片复用） ──
function VecBadge({ embedding }: { embedding?: number[] }) {
  return embedding && embedding.length > 0 ? (
    <span className="cm-badge cm-badge-soft" title="已向量化，可参与向量召回">已向量化</span>
  ) : (
    <span className="cm-badge cm-badge-warn" title="未向量化">未向量化</span>
  );
}

function SourceMaterialsView({ materials }: { materials?: string }) {
  const [open, setOpen] = useState(false);
  if (!materials) return null;
  return (
    <div className="cm-source-materials">
      <button type="button" className="cm-source-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {open ? "收起" : "查看"}原始记录（生成素材）
      </button>
      {open && <pre className="cm-source-text">{materials}</pre>}
    </div>
  );
}

// ── 记忆翻译查看（原文 ↔ 译文切换，仅展示，不写库、不改动原文、不参与投喂） ──
function Translatable({ text, textClass }: { text: string; textClass?: string }) {
  const [busy, setBusy] = useState(false);
  const [translated, setTranslated] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (show) { setShow(false); return; }
    if (translated) { setShow(true); return; }
    setBusy(true);
    setError("");
    const res = await translateMemoryText(text);
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    setTranslated(res.content ?? "");
    setShow(true);
  };

  return (
    <div className="cm-translatable">
      <div className={textClass}>{show && translated ? translated : text}</div>
      <div className="cm-translate-row">
        <button type="button" className="ui-btn ui-btn-ghost ts-12 cm-translate-btn" onClick={toggle} disabled={busy} title="译为中文查看（不写入记忆，不改动原文）">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
          {show ? "显示原文" : "译为中文"}
        </button>
        {error && <span className="cm-meta-text cm-translate-err" title={error}>翻译失败</span>}
      </div>
    </div>
  );
}

function CoreTab({ characterId, characterName, notify, refresh }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
  refresh: () => void;
}) {
  const [view, setView] = useState<CurrentCoreView | null>(null);
  const [snapshots, setSnapshots] = useState<ComplexCoreSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [editor, setEditor] = useState<EntryEditor | null>(null);
  const [entryDraft, setEntryDraft] = useState("");
  const [entryCategory, setEntryCategory] = useState<CoreCategory>("principle");
  const [compareVersion, setCompareVersion] = useState<number | null>(null);
  const [compareEntries, setCompareEntries] = useState<ComplexCoreEntry[]>([]);

  const load = useCallback(async () => {
    const [v, snaps] = await Promise.all([getCurrentCoreView(characterId), loadCoreSnapshots(characterId)]);
    setView(v);
    setSnapshots(snaps);
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCompare = useCallback(async (version: number) => {
    setCompareVersion(version);
    const snap = await getCoreSnapshotByVersion(characterId, version);
    if (!snap) { setCompareEntries([]); return; }
    const all = await loadCoreEntries(characterId);
    const byId = new Map(all.map((e) => [e.id, e]));
    setCompareEntries(snap.entryIds.map((id) => byId.get(id)).filter((e): e is ComplexCoreEntry => !!e));
  }, [characterId]);

  const run = async (
    task: () => Promise<{ success: boolean; error?: string; version?: number }>,
    okText: string,
  ) => {
    setBusy(true);
    const res = await task();
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `${okText}${res.version ? ` · v${res.version}` : ""}` });
      setEditor(null);
      setEntryDraft("");
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "操作失败" });
    }
  };

  const handleBootstrap = () => {
    void run(() => bootstrapCoreMemory(characterId, characterName), "核心记忆初始化完成");
  };

  const handleRebuild = () => {
    void run(() => rebuildCoreMemory(characterId, characterName), "核心记忆定期重构完成");
  };

  const handleRegenerate = () => {
    if (!feedback.trim()) { notify({ kind: "err", text: "请先输入改进意见" }); return; }
    const text = feedback;
    setFeedback("");
    setShowFeedback(false);
    void run(() => regenerateCoreWithFeedback(characterId, characterName, text), "核心记忆按反馈重生成成功");
  };

  const handleRollback = (snap: ComplexCoreSnapshot) => {
    void run(() => rollbackCoreVersion(characterId, characterName, snap.version), `已回退到 v${snap.version}`);
  };

  const startAdd = () => { setEditor({ mode: "add" }); setEntryCategory("principle"); setEntryDraft(""); };
  const startEdit = (entry: ComplexCoreEntry) => { setEditor({ mode: "edit", entry }); setEntryCategory(entry.category); setEntryDraft(entry.text); };

  const handleSaveEntry = () => {
    const text = entryDraft.trim();
    if (!text) { notify({ kind: "err", text: "条目内容为空" }); return; }
    if (!sanitizeCoreEntryText(text, loadComplexMemoryConfig().sanitizerBanList)) {
      notify({ kind: "err", text: "条目含禁用词" });
      return;
    }
    if (editor?.mode === "edit") {
      void run(() => editCoreEntry(characterId, characterName, editor.entry.id, entryCategory, text), "条目已更新");
    } else {
      void run(() => addCoreEntry(characterId, characterName, entryCategory, text), "条目已新增");
    }
  };

  const handleDeleteEntry = (entry: ComplexCoreEntry) => {
    void run(() => deleteCoreEntry(characterId, characterName, entry.id), "条目已删除");
  };

  const triggers = view?.snapshot ? (view.snapshot.trigger ?? "bootstrap") : "bootstrap";
  const grouped = useMemo(() => {
    const map = new Map<CoreCategory, ComplexCoreEntry[]>();
    for (const id of CORE_CATEGORY_ORDER) map.set(id, []);
    for (const e of view?.activeEntries ?? []) map.get(e.category)?.push(e);
    return map;
  }, [view]);

  const currentEntryIds = useMemo(() => new Set((view?.activeEntries ?? []).map((e) => e.id)), [view]);

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">
          当前版本
          <span className="cm-meta-text" style={{ marginLeft: 8 }}>
            {view?.snapshot ? `v${view.snapshot.version}` : "—"}
          </span>
        </span>
        <div className="cm-actions">
          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={handleRebuild} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 定期重构
          </button>
          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setShowFeedback((s) => !s)}>
            <Sparkles size={14} /> 按反馈重生成
          </button>
          {view?.snapshot && (
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={startAdd} disabled={busy}>
              <Plus size={14} /> 新增条目
            </button>
          )}
        </div>
      </div>

      {/* 反馈重生成输入 */}
      {showFeedback && (
        <div className="cm-card">
          <Textarea
            className="cm-core-editor"
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="例如：把「恋人」关系的约定更明确一些，去掉泛泛的句子…"
          />
          <div className="cm-card-actions">
            <span className="cm-meta-text">将作为当前版本条目的改进意见生成一个新版本</span>
            <span className="cm-spacer" />
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setShowFeedback(false)}>取消</button>
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleRegenerate} disabled={busy || !feedback.trim()}>
              <Sparkles size={14} /> 生成新版本
            </button>
          </div>
        </div>
      )}

      {/* 条目编辑表单 */}
      {editor && (
        <div className="cm-card">
          <div className="cm-meta-row">
            {CORE_CATEGORY_ORDER.map((c) => (
              <button
                key={c}
                type="button"
                className={`cm-cat-chip ${entryCategory === c ? "is-active" : ""}`}
                onClick={() => setEntryCategory(c)}
              >
                {CORE_CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
          <Textarea
            className="cm-core-editor"
            rows={3}
            value={entryDraft}
            onChange={(e) => setEntryDraft(e.target.value)}
            placeholder="一句话事实（建议 30–80 字），例如：我们约定每年一起看一场电影。"
          />
          <div className="cm-card-actions">
            <span className="cm-spacer" />
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setEditor(null)}>取消</button>
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleSaveEntry} disabled={busy || !entryDraft.trim()}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存
            </button>
          </div>
        </div>
      )}

      {/* 当前条目展示 */}
      {view?.snapshot ? (
        <div className="cm-card">
          <div className="cm-meta-row">
            <span className="cm-badge">v{view.snapshot.version}</span>
            <span className="cm-badge cm-badge-soft">触发：{CORE_TRIGGER_LABEL[triggers] ?? "—"}</span>
            <span className="cm-meta-text">更新于 {fmtTime(view.snapshot.createdAt)}</span>
            {view.snapshot.note && <span className="cm-meta-text">{view.snapshot.note}</span>}
          </div>
          {CORE_CATEGORY_ORDER.map((cat) => {
            const list = grouped.get(cat) ?? [];
            if (list.length === 0) return null;
            return (
              <div key={cat} className="cm-entry-group">
                <div className="cm-entry-group-title">{CORE_CATEGORY_LABEL[cat]}</div>
                {list.map((e) => (
                  <div key={e.id} className="cm-entry-item">
                    <Translatable text={e.text} textClass="cm-entry-text" />
                    <span className="cm-entry-actions">
                      <button type="button" className="ui-btn ui-btn-ghost ts-12" onClick={() => startEdit(e)} disabled={busy}>
                        <Edit3 size={13} /> 编辑
                      </button>
                      <button type="button" className="ui-btn ui-btn-ghost ts-12 is-danger" onClick={() => handleDeleteEntry(e)} disabled={busy}>
                        <Trash2 size={13} /> 删除
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
          {view.activeEntries.length === 0 && <p className="cm-muted">当前版本没有任何条目，可新增或回退到历史版本。</p>}
        </div>
      ) : (
        <div className="cm-card cm-empty-inline">
          <p>该角色尚无核心记忆。</p>
          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleBootstrap} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} 立即初始化
          </button>
        </div>
      )}

      {/* 版本时间线 + 对比 */}
      <div className="cm-section-head" style={{ marginTop: 18 }}>
        <span className="cm-section-title">版本时间线 · 共 {snapshots.length} 版</span>
      </div>
      <div className="cm-card">
        {snapshots.length === 0 ? (
          <p className="cm-muted">暂无历史版本</p>
        ) : (
          <div className="cm-version-list">
            {[...snapshots].reverse().map((s) => (
              <div key={s.id} className={`cm-version-item ${s.isCurrent ? "is-current" : ""}`}>
                <div className="cm-version-main">
                  <span className="cm-badge">v{s.version}</span>
                  <span className={`cm-badge cm-badge-soft`}>{s.isCurrent ? "当前生效" : "历史版本"}</span>
                  <span className="cm-meta-text">{CORE_TRIGGER_LABEL[s.trigger] ?? s.trigger}</span>
                  <span className="cm-meta-text">{fmtTime(s.createdAt)}</span>
                  {s.note && <span className="cm-meta-text">· {s.note}</span>}
                </div>
                <SourceMaterialsView materials={s.sourceMaterials} />
                <div className="cm-version-actions">
                  <button type="button" className="ui-btn ui-btn-ghost ts-12" onClick={() => void openCompare(s.version)}>
                    <Layers size={13} /> 对比
                  </button>
                  {!s.isCurrent && (
                    <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => handleRollback(s)} disabled={busy}>
                      <RotateCcw size={13} /> 回退到此版
                    </button>
                  )}
                </div>
                {compareVersion === s.version && (
                  <div className="cm-compare-panel">
                    {compareEntries.length === 0 ? (
                      <p className="cm-muted">该版本无可比对条目</p>
                    ) : (
                      compareEntries.map((e) => {
                        const current = currentEntryIds.has(e.id);
                        return (
                          <div key={e.id} className={`cm-compare-row ${current ? "is-kept" : "is-changed"}`}>
                            <span className={`cm-badge cm-badge-soft`}>{CORE_CATEGORY_LABEL[e.category]}</span>
                            <span className="cm-compare-text">{e.text}</span>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
  const [selectMode, setSelectMode] = useState(false);
  const [selectedDailies, setSelectedDailies] = useState<Set<string>>(new Set());
  // 按日期范围总结（对范围内有聊天的每一天生成/补生成）
  const [rangeOpen, setRangeOpen] = useState(false);
  const [dailyStart, setDailyStart] = useState("");
  const [dailyEnd, setDailyEnd] = useState("");
  const [rangeBusy, setRangeBusy] = useState(false);
  // 日历视图（M6）
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const nowRef = new Date();
  const [calYear, setCalYear] = useState(nowRef.getFullYear());
  const [calMonth, setCalMonth] = useState(nowRef.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ds, ps] = await Promise.all([loadDailies(characterId), loadPeriods(characterId)]);
    setDailies(ds);
    setPeriods(ps);
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const [failedDailies, setFailedDailies] = useState<{ date: string; reason: string; at: string }[]>(() => loadCharacterState(characterId).failedDailyDates ?? []);
  const handleRetryFailedDaily = async (date: string) => {
    const res = await generateDaily(characterId, characterName, date);
    if (res.success) {
      clearFailedDaily(characterId, date);
      setFailedDailies(loadCharacterState(characterId).failedDailyDates ?? []);
      void load();
      notify({ kind: "ok", text: `已重新生成 ${date} 日记` });
    } else {
      notify({ kind: "err", text: `重生成失败：${res.error ?? "未知原因"}` });
    }
  };

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

  const handleRegenerate = async (d: ComplexDaily) => {
    setBusy(true);
    const res = await regenerateDaily(characterId, characterName, d.date);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `「${d.date}」日记已重新总结` });
      await load();
      refresh();
    } else {
      await load();
      notify({ kind: "err", text: res.error ?? "重新总结失败" });
    }
  };

  const toggleSelectDaily = (id: string) =>
    setSelectedDailies((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const handleBulkRegenerateDailies = async () => {
    if (selectedDailies.size === 0) { notify({ kind: "err", text: "请先选择要重新总结的日记" }); return; }
    setBusy(true);
    const targets = filtered.filter((d) => selectedDailies.has(d.id));
    let ok = 0, fail = 0;
    for (const d of targets) {
      const res = await regenerateDaily(characterId, characterName, d.date);
      if (res.success) ok++; else fail++;
    }
    setBusy(false);
    setSelectedDailies(new Set());
    setSelectMode(false);
    await load();
    refresh();
    notify({ kind: ok > 0 ? "ok" : "err", text: `批量重新总结：成功 ${ok}，失败 ${fail}` });
  };

  const handleRangeSummarize = async () => {
    if (!dailyStart && !dailyEnd) { notify({ kind: "err", text: "请先选择起止日期" }); return; }
    setRangeBusy(true);
    const res = await summarizeDailyRange(characterId, characterName, dailyStart || undefined, dailyEnd || undefined);
    setRangeBusy(false);
    setRangeOpen(false);
    notify({ kind: "ok", text: `按日期总结完成：生成 ${res.generated} 篇${res.failedDates.length ? `，失败 ${res.failedDates.join("、")}` : ""}` });
    await load();
    refresh();
  };

  const handleToggleSpecial = async (d: ComplexDaily) => {
    await saveDaily({ ...d, special: d.special === true ? false : true });
    notify({ kind: "ok", text: d.special === true ? "已取消特殊日期标记" : "已标记为特殊一天" });
    await load();
  };

  // ── 日历视图计算（M6） ──
  const byDate = useMemo(() => new Map(dailies.map((d) => [d.date, d])), [dailies]);
  const calCells = useMemo(() => {
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const first = new Date(calYear, calMonth, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const cells: Array<{ date: string; day: number; inMonth: boolean }> = [];
    for (let i = startOffset - 1; i >= 0; i--) {
      const d = new Date(calYear, calMonth, -i);
      cells.push({ date: fmt(d), day: d.getDate(), inMonth: false });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(calYear, calMonth, day);
      cells.push({ date: fmt(d), day, inMonth: true });
    }
    let tail = 1;
    while (cells.length % 7 !== 0) {
      const d = new Date(calYear, calMonth + 1, tail++);
      cells.push({ date: fmt(d), day: d.getDate(), inMonth: false });
    }
    return cells;
  }, [calYear, calMonth]);

  const selectedDaily = selectedDate ? byDate.get(selectedDate) ?? null : null;

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">日记 · 共 {dailies.length} 篇</span>
        <div className="cm-actions">
          {selectMode ? (
            <>
              <span className="cm-meta-text">已选 {selectedDailies.size} 篇</span>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setSelectedDailies(new Set(filtered.map((d) => d.id)))}>全选</button>
              <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleBulkRegenerateDailies()} disabled={busy || selectedDailies.size === 0}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 批量重新总结
              </button>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setSelectMode(false); setSelectedDailies(new Set()); }}>退出</button>
            </>
          ) : (
            <>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setSelectMode(true)}>
                <RefreshCw size={14} /> 多选重总结
              </button>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setRangeOpen((v) => !v)}>
                <CalendarRange size={14} /> 按日期总结
              </button>
            </>
          )}
          <div className="cm-view-toggle" role="group" aria-label="视图切换">
            <button
              type="button"
              className={`cm-view-btn ${viewMode === "list" ? "is-active" : ""}`}
              onClick={() => setViewMode("list")}
            >列表</button>
            <button
              type="button"
              className={`cm-view-btn ${viewMode === "calendar" ? "is-active" : ""}`}
              onClick={() => setViewMode("calendar")}
            >日历</button>
          </div>
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

      {failedDailies.length > 0 && (
        <div className="cm-card" style={{ borderColor: "var(--c-warning, #d08770)" }}>
          <div className="cm-config-label" style={{ color: "var(--c-warning, #d08770)" }}>
            日记生成失败 · 点击「重新生成」补写
          </div>
          {failedDailies.map((f) => (
            <div key={f.date} className="cm-progress-row" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
              <span className="cm-tl-day">{f.date}</span>
              <span style={{ flex: 1 }}>{f.reason}</span>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleRetryFailedDaily(f.date)}>重新生成</button>
            </div>
          ))}
        </div>
      )}

      {rangeOpen && (
        <div className="cm-card cm-mig-range">
          <span className="cm-config-label">按日期总结日记（对范围内有聊天的每一天生成/补生成，无日记也会生成）</span>
          <div className="cm-mig-range">
            <Input type="date" value={dailyStart} onChange={(e) => setDailyStart(e.target.value)} aria-label="起始" className="cm-config-input" />
            <span className="cm-meta-text">至</span>
            <Input type="date" value={dailyEnd} onChange={(e) => setDailyEnd(e.target.value)} aria-label="结束" className="cm-config-input" />
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleRangeSummarize()} disabled={rangeBusy}>
              {rangeBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} 开始总结
            </button>
          </div>
        </div>
      )}

      {viewMode === "calendar" && (
        <div className="cm-card cm-calendar">
          <div className="cm-calendar-head">
            <button type="button" className="cm-cal-nav" onClick={() => { setCalMonth((m) => (m === 0 ? 11 : m - 1)); if (calMonth === 0) setCalYear((y) => y - 1); }} aria-label="上一月">
              <ChevronLeft size={15} />
            </button>
            <span className="cm-cal-title">{calYear} 年 {calMonth + 1} 月</span>
            <button type="button" className="cm-cal-nav" onClick={() => { setCalMonth((m) => (m === 11 ? 0 : m + 1)); if (calMonth === 11) setCalYear((y) => y + 1); }} aria-label="下一月">
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="cm-calendar-grid">
            {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
              <div key={w} className="cm-cal-weekday">{w}</div>
            ))}
            {calCells.map((cell) => {
              const daily = byDate.get(cell.date);
              return (
                <button
                  key={cell.date}
                  type="button"
                  className={`cm-cal-cell ${cell.inMonth ? "" : "is-outside"} ${daily ? "has-daily" : ""} ${daily?.special === true ? "is-special" : ""} ${selectedDate === cell.date ? "is-selected" : ""}`}
                  onClick={() => daily && setSelectedDate(selectedDate === cell.date ? null : cell.date)}
                  disabled={!daily}
                >
                  <span className="cm-cal-day">{cell.day}</span>
                  {daily && <span className="cm-cal-dot" />}
                  {daily?.special === true && <span className="cm-cal-star">★</span>}
                </button>
              );
            })}
          </div>
          {selectedDaily && (
            <div className="cm-cal-detail">
              <div className="cm-section-head">
                <span className="cm-section-title">{selectedDaily.date}{selectedDaily.special === true && <span className="cm-special-badge">★</span>}</span>
                <span className="cm-meta-text">情绪 {selectedDaily.emotionVector.valence.toFixed(2)} / {selectedDaily.emotionVector.arousal.toFixed(2)}</span>
              </div>
              <Translatable text={selectedDaily.content} textClass="cm-daily-content" />
              <div className="cm-card-actions">
                <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleToggleSpecial(selectedDaily)}>
                  <Flame size={14} /> {selectedDaily.special === true ? "取消特殊" : "标记特殊"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无日记</p></div>
      ) : (
        <div className="cm-daily-list">
          {filtered.map((d) => (
            <div key={d.id} className={`cm-card cm-daily-item${selectMode && selectedDailies.has(d.id) ? " is-selected" : ""}`}>
              <button type="button" className="cm-daily-head" onClick={() => { if (selectMode) { toggleSelectDaily(d.id); return; } setExpandedId(expandedId === d.id ? null : d.id); }}>
                <span className="cm-daily-date">
                  {d.date}
                  {d.special === true && <span className="cm-special-badge" title="特殊一天">★</span>}
                </span>
                <span className="cm-daily-periods">
                  {d.belongsToPeriods.map((pid) => periods.find((p) => p.id === pid)?.title).filter(Boolean).join("、") || "无周期"}
                </span>
                <VecBadge embedding={d.embedding} />
                <span className="cm-daily-voltage">电压 {voltagePct(effectiveVoltage(d, { kind: "daily", special: d.special === true }))}</span>
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
                        <Translatable text={d.content} textClass="cm-daily-content" />
                        <SourceMaterialsView materials={d.sourceMaterials} />
                        <div className="cm-card-actions">
                          <span className="cm-meta-text">情绪 {d.emotionVector.valence.toFixed(2)} / {d.emotionVector.arousal.toFixed(2)}</span>
                        <span className="cm-spacer" />
                        <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleRegenerate(d)} disabled={busy}>
                          <RefreshCw size={14} /> 重新总结
                        </button>
                        <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleToggleSpecial(d)}>
                          <Flame size={14} /> {d.special === true ? "取消特殊" : "标记特殊"}
                        </button>
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
  const [dailies, setDailies] = useState<ComplexDaily[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 周期手动化 + 时间轴（M6）
  const [viewMode, setViewMode] = useState<"list" | "timeline">("list");
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createStart, setCreateStart] = useState("");
  const [createEnd, setCreateEnd] = useState("");
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [briefForId, setBriefForId] = useState<string | null>(null);
  const [briefDraft, setBriefDraft] = useState("");
  // 周期思考（多选日记 → 模型综合判定是否开启长期事件）
  const [showThink, setShowThink] = useState(false);
  const [thinkSelected, setThinkSelected] = useState<Set<string>>(new Set());
  const [thinkBusy, setThinkBusy] = useState(false);
  const [thinkResult, setThinkResult] = useState<PeriodThinkResult | null>(null);
  const [thinkError, setThinkError] = useState("");
  // 手动关联：把日记挂到周期上（修正机器判断，供提炼与按日期填充）
  const [linkDailyForId, setLinkDailyForId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [ps, ds] = await Promise.all([loadPeriods(characterId), loadDailies(characterId)]);
    setPeriods(ps);
    setDailies(ds);
  }, [characterId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(() => {
    const active = periods.filter((p) => p.status === "active");
    const rest = periods.filter((p) => p.status !== "active").sort((a, b) => (b.endTime ?? "").localeCompare(a.endTime ?? ""));
    return [...active, ...rest];
  }, [periods]);

  const handleDistill = async (p: ComplexPeriod, userBrief?: string) => {
    setBusy(true);
    const res = await distillPeriod(characterId, characterName, p.id, userBrief?.trim() ? { userBrief } : undefined);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `周期「${p.title}」提炼完成` });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "提炼失败" });
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    const res = await createPeriodManual(characterId, createTitle, createStart, createEnd || null);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: "周期已创建" });
      setShowCreate(false);
      setCreateTitle("");
      setCreateStart("");
      setCreateEnd("");
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "创建失败" });
    }
  };

  const handleSaveTitle = async (p: ComplexPeriod) => {
    await savePeriod({ ...p, title: titleDraft.trim() || p.title });
    setEditingTitleId(null);
    notify({ kind: "ok", text: "周期主线已更新" });
    await load();
  };

  const handleSaveSummary = async (p: ComplexPeriod) => {
    await savePeriod({ ...p, summary: summaryDraft });
    setEditingSummaryId(null);
    notify({ kind: "ok", text: "周期总结已保存" });
    await load();
  };

  const handleLinkDaily = async (p: ComplexPeriod, daily: ComplexDaily, link: boolean) => {
    const belongs = new Set(daily.belongsToPeriods);
    if (link) belongs.add(p.id); else belongs.delete(p.id);
    await saveDaily({ ...daily, belongsToPeriods: [...belongs] });
    const dates = new Set(p.associatedDates);
    if (link) dates.add(daily.date); else dates.delete(daily.date);
    await savePeriod({ ...p, associatedDates: [...dates].sort() });
    await load();
  };

  // ── 周期思考：多选日记 → 模型综合判定是否开启长期事件 ──
  const toggleThink = () => {
    setShowThink((v) => {
      const next = !v;
      if (!next) { setThinkResult(null); setThinkError(""); }
      return next;
    });
  };

  const toggleThinkDate = (date: string) => {
    setThinkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const handleThink = async () => {
    if (thinkSelected.size === 0) { setThinkError("请先选中至少一天日记"); return; }
    setThinkBusy(true);
    setThinkError("");
    setThinkResult(null);
    const res = await runPeriodThinking(characterId, characterName, [...thinkSelected]);
    setThinkBusy(false);
    if (!res.success) {
      setThinkError(res.error ?? "周期思考失败");
      return;
    }
    setThinkResult(res.result ?? { periods: [], existing: [] });
  };

  const handleCreateFromThink = async (np: PeriodThinkNew) => {
    setBusy(true);
    const start = np.startDate || [...thinkSelected].sort()[0] || "";
    const end = np.endDate || null;
    const res = await createPeriodManual(characterId, np.title, start, end, {
      dates: np.dates?.length ? np.dates : undefined,
      timeline: np.timeline,
    });
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `周期「${np.title}」已创建（${start} ~ ${end ?? "至今"}）` });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "创建失败" });
    }
  };

  const statusLabel: Record<ComplexPeriod["status"], string> = { active: "进行中", stabilized: "已稳定", archived: "已归档" };

  // 时间轴：以最早周期起点为左端，今天为右端
  const timeline = useMemo(() => {
    if (periods.length === 0) return null;
    const min = Math.min(...periods.map((p) => new Date(p.startTime).getTime()));
    const max = Date.now();
    const span = Math.max(1, max - min);
    const pct = (ts: number) => `${Math.max(0, Math.min(100, ((ts - min) / span) * 100))}%`;
    return {
      min,
      max,
      pct,
      bars: periods.map((p) => {
        const start = new Date(p.startTime).getTime();
        const end = p.endTime ? new Date(p.endTime).getTime() : max;
        const left = pct(start);
        const width = `${Math.max(2, Math.min(100, ((end - start) / span) * 100))}%`;
        return { p, left, width };
      }),
    };
  }, [periods]);

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">周期 · 共 {periods.length} 个</span>
        <div className="cm-actions">
          <div className="cm-view-toggle" role="group" aria-label="视图切换">
            <button type="button" className={`cm-view-btn ${viewMode === "list" ? "is-active" : ""}`} onClick={() => setViewMode("list")}>列表</button>
            <button type="button" className={`cm-view-btn ${viewMode === "timeline" ? "is-active" : ""}`} onClick={() => setViewMode("timeline")}>时间轴</button>
          </div>
          <button type="button" className={`ui-btn ts-12 ${showThink ? "ui-btn-primary" : "ui-btn-outline"}`} onClick={toggleThink} title="选中若干天日记，让模型综合判定这段时间是否开启了新的长期事件（周期）">
            <Brain size={14} /> 周期思考
          </button>
          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setShowCreate((v) => !v)}>
            <Plus size={14} /> 新建周期
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="cm-card cm-create-period">
          <div className="cm-create-row">
            <Input value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} placeholder="周期标题（主线描述）" className="cm-config-input" />
          </div>
          <div className="cm-create-row">
            <Input type="date" value={createStart} onChange={(e) => setCreateStart(e.target.value)} aria-label="起始日期" className="cm-config-input" />
            <span className="cm-meta-text">至</span>
            <Input type="date" value={createEnd} onChange={(e) => setCreateEnd(e.target.value)} aria-label="结束日期（可选）" className="cm-config-input" />
            <span className="cm-meta-text">（结束日期可选）</span>
          </div>
          <div className="cm-card-actions">
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setShowCreate(false)}>取消</button>
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleCreate()} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 创建
            </button>
          </div>
        </div>
      )}

      {showThink && (
        <div className="cm-card cm-think-period">
          <div className="cm-think-head">
            <span className="cm-section-title">周期思考</span>
            <span className="cm-meta-text">选中若干天日记，让模型结合人设/规则词/user 人设/核心记忆，综合判定这段时间是否开启了新的长期事件（周期）。</span>
          </div>
          <div className="cm-think-days">
            <div className="cm-think-day-list">
              {[...dailies].sort((a, b) => b.date.localeCompare(a.date)).map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`cm-think-day ${thinkSelected.has(d.date) ? "is-selected" : ""}`}
                  onClick={() => toggleThinkDate(d.date)}
                >
                  {thinkSelected.has(d.date) ? "✓ " : ""}{d.date}
                </button>
              ))}
            </div>
          </div>
          <div className="cm-card-actions">
            <span className="cm-meta-text">已选 {thinkSelected.size} 天（最多 40）</span>
            <span className="cm-spacer" />
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setThinkSelected(new Set()); setThinkResult(null); setThinkError(""); }}>
              <RotateCcw size={14} /> 清空
            </button>
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleThink()} disabled={thinkBusy || thinkSelected.size === 0}>
              {thinkBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} 开始分析
            </button>
          </div>
          {thinkError && <p className="cm-muted cm-think-error">周期思考失败：{thinkError}</p>}
          {thinkResult && (
            <div className="cm-think-result">
              <div className="cm-think-result-group">
                <div className="cm-meta-text cm-think-group-title">建议开启的新周期（{thinkResult.periods.length}）</div>
                {thinkResult.periods.length === 0 && <p className="cm-muted">这段时间未检出值得作为长期事件的新周期。</p>}
                {thinkResult.periods.map((np, i) => (
                  <div key={`${np.title}-${i}`} className="cm-think-period-item">
                    <div className="cm-think-item-head">
                      <span className="cm-badge">新周期</span>
                      <strong>{np.title}</strong>
                    </div>
                    {np.startDate && (
                      <p className="cm-meta-text">起止：{np.startDate} ~ {np.endDate || "至今"} · 覆盖 {np.dates?.length ?? 0} 天</p>
                    )}
                    <p className="cm-meta-text">{np.reason}</p>
                    {np.dates && np.dates.length > 0 && (
                      <div className="cm-think-timeline-preview">
                        {np.dates.slice(0, 10).map((d) => (
                          <span key={d} className="cm-badge cm-badge-soft">{d}</span>
                        ))}
                        {np.dates.length > 10 && <span className="cm-meta-text">+{np.dates.length - 10} 天</span>}
                      </div>
                    )}
                    <div className="cm-card-actions">
                      <span className="cm-spacer" />
                      <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleCreateFromThink(np)} disabled={busy}>
                        <Plus size={14} /> 创建周期
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="cm-think-result-group">
                <div className="cm-meta-text cm-think-group-title">与进行中周期的关联（{thinkResult.existing.length}）</div>
                {thinkResult.existing.map((ex, i) => (
                  <div key={`${ex.title}-${i}`} className="cm-think-period-item">
                    <div className="cm-think-item-head"><span className="cm-badge cm-badge-soft">已有进度</span><strong>{ex.title}</strong></div>
                    <p className="cm-meta-text">{ex.note}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {viewMode === "timeline" && timeline && (
        <div className="cm-card cm-timeline">
          <div className="cm-timeline-track">
            {timeline.bars.map(({ p, left, width }) => (
              <div
                key={p.id}
                className={`cm-tl-bar is-${p.status}`}
                style={{ left, width }}
                title={`${p.title} · ${p.startTime} ~ ${p.endTime ?? "至今"}`}
                onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
              >
                <span className="cm-tl-bar-label">{p.title}</span>
              </div>
            ))}
          </div>
          <p className="cm-muted cm-timeline-legend">横轴为时间：起点 = 最早周期开始，终点 = 今天。点击色块展开周期。</p>
        </div>
      )}

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
                <VecBadge embedding={p.embedding} />
                <span className="cm-badge cm-badge-soft">{statusLabel[p.status]}</span>
                {expandedId === p.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {expandedId === p.id && (
                <div className="cm-period-body">
                  {editingTitleId === p.id ? (
                    <div className="cm-period-edit-row">
                      <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} className="cm-config-input" />
                      <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleSaveTitle(p)}><Save size={14} /> 保存</button>
                      <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setEditingTitleId(null)}>取消</button>
                    </div>
                  ) : (
                    <div className="cm-period-summary">
                      <strong>{p.title}</strong>（主线）&nbsp;
                      <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setEditingTitleId(p.id); setTitleDraft(p.title); }}>
                        <Edit3 size={14} /> 编辑主线
                      </button>
                    </div>
                  )}
                  {editingSummaryId === p.id ? (
                    <div className="cm-period-edit-col">
                      <Textarea className="cm-core-editor" rows={6} value={summaryDraft} onChange={(e) => setSummaryDraft(e.target.value)} />
                      <div className="cm-card-actions">
                        <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setEditingSummaryId(null)}>取消</button>
                        <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleSaveSummary(p)}><Save size={14} /> 保存总结</button>
                      </div>
                    </div>
                  ) : p.summary ? (
                    <div className="cm-period-summary">
                      <Translatable text={p.summary} textClass="cm-period-summary" />
                      <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setEditingSummaryId(p.id); setSummaryDraft(p.summary); }}>
                        <Edit3 size={14} /> 编辑总结
                      </button>
                    </div>
                  ) : (
                    <p className="cm-muted">尚未提炼总结
                      <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setEditingSummaryId(p.id); setSummaryDraft(""); }}>
                        <Edit3 size={14} /> 直接书写
                      </button>
                    </p>
                  )}
                  {p.rollingSummary && p.rollingSummary.trim() && (
                    <div className="cm-progress-list">
                      <div className="cm-meta-text cm-progress-title">周期进展（每日日记填充）</div>
                      {p.rollingSummary.split("\n").filter((l) => l.trim()).map((line, i) => {
                        const m = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/);
                        return m
                          ? <div key={i} className="cm-tl-row"><span className="cm-tl-day">{m[1]}</span><span>{m[2]}</span></div>
                          : <div key={i} className="cm-tl-row"><span className="cm-tl-day">·</span><span>{line}</span></div>;
                      })}
                    </div>
                  )}
                  {Object.keys(p.timelineIndex).length > 0 && (
                    <div className="cm-timeline-index">
                      {Object.entries(p.timelineIndex).map(([day, line]) => (
                        <div key={day} className="cm-tl-row"><span className="cm-tl-day">{day}</span><span>{line}</span></div>
                      ))}
                    </div>
                  )}
                  <SourceMaterialsView materials={p.sourceMaterials} />
                  {p.linkedPeriods.length > 0 && (
                    <p className="cm-meta-text">丝线关联：{p.linkedPeriods.join("、")}</p>
                  )}
                  {linkDailyForId === p.id && (
                    <div className="cm-period-edit-col">
                      <div className="cm-meta-text">关联日记（勾选归属该周期，供提炼与按日期填充；共 {dailies.length} 篇，可修正机器判断）</div>
                      <div className="cm-link-daily-list">
                        {[...dailies].sort((a, b) => b.date.localeCompare(a.date)).map((d) => {
                          const linked = d.belongsToPeriods.includes(p.id) || p.associatedDates.includes(d.date);
                          return (
                            <label key={d.id} className="cm-link-daily-row">
                              <input type="checkbox" checked={linked} onChange={(e) => void handleLinkDaily(p, d, e.target.checked)} />
                              <span className="cm-meta-text cm-link-daily-date">{d.date}</span>
                              <span className="cm-link-daily-content">{d.content.slice(0, 40)}</span>
                            </label>
                          );
                        })}
                      </div>
                      <div className="cm-card-actions">
                        <span className="cm-spacer" />
                        <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => setLinkDailyForId(null)}>完成</button>
                      </div>
                    </div>
                  )}
                  {briefForId === p.id ? (
                    <div className="cm-period-edit-col">
                      <Textarea className="cm-core-editor" rows={3} value={briefDraft} onChange={(e) => setBriefDraft(e.target.value)} placeholder="补充该周期的主线/重点，作为提炼输入（可选）" />
                      <div className="cm-card-actions">
                        <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setBriefForId(null)}>取消</button>
                        <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => { const b = briefDraft; setBriefForId(null); setBriefDraft(""); void handleDistill(p, b); }} disabled={busy}>
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Flame size={14} />} 提炼（含主线）
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="cm-card-actions">
                      <span className="cm-meta-text">覆盖事件 {p.coveredEventIds.length} 条 · 电压 {voltagePct(effectiveVoltage(p, { kind: "period" }))}</span>
                      <span className="cm-spacer" />
                      <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setLinkDailyForId(linkDailyForId === p.id ? null : p.id)}>
                        <Link size={14} /> 关联日记
                      </button>
                      <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setBriefForId(p.id); setBriefDraft(""); }}>
                        <Flame size={14} /> 手动总结
                      </button>
                      {p.status === "active" && (
                        <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleDistill(p)} disabled={busy}>
                          {busy ? <Loader2 size={14} className="animate-spin" /> : <Flame size={14} />} 立即提炼
                        </button>
                      )}
                      <button type="button" className="ui-btn ui-btn-danger ts-12" onClick={async () => { await deletePeriod(p.id); notify({ kind: "ok", text: "周期已删除" }); await load(); }}>
                        <Trash2 size={14} /> 删除
                      </button>
                    </div>
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

// ── 事件页 ──
function EventTab({ characterId, characterName, notify, refresh }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
  refresh: () => void;
}) {
  const [events, setEvents] = useState<ComplexEvent[]>([]);
  const [saveLog, setSaveLog] = useState<Array<{ id: string; timestamp: string; content: string; at: string }>>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setEvents(await loadEvents(characterId));
    setSaveLog(loadEventSaveLog());
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

  const toggleSelectEvent = (id: string) =>
    setSelectedEvents((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const handleBulkRegenerateEvents = async () => {
    if (selectedEvents.size === 0) { notify({ kind: "err", text: "请先选择要重新总结的事件" }); return; }
    setBusy(true);
    const targets = events.filter((e) => selectedEvents.has(e.id));
    let ok = 0, fail = 0;
    for (const e of targets) {
      const res = await regenerateEvent(characterId, characterName, e);
      if (res.success) ok++; else fail++;
    }
    setBusy(false);
    setSelectedEvents(new Set());
    setSelectMode(false);
    await load();
    refresh();
    notify({ kind: ok > 0 ? "ok" : "err", text: `批量重新总结：成功 ${ok}，失败 ${fail}` });
  };

  const handleBoost = async (e: ComplexEvent) => {
    const boosted = boostedVoltage(e, config.voltageRecallBoost, { kind: "event" });
    await saveEvent({ ...e, voltage: boosted.voltage, lastAccessedAt: boosted.lastAccessedAt });
    notify({ kind: "ok", text: "电压已充能" });
    await load();
  };

  const handleSaveEdit = async (e: ComplexEvent) => {
    setBusy(true);
    await saveEvent({ ...e, content: draft.trim() || e.content });
    setBusy(false);
    setEditingId(null);
    notify({ kind: "ok", text: "事件已更新" });
    await load();
  };

  const handleDelete = async (e: ComplexEvent) => {
    await deleteEvent(e.id);
    notify({ kind: "ok", text: "事件已删除" });
    await load();
  };

  const handleRegenerate = async (e: ComplexEvent) => {
    setBusy(true);
    const res = await regenerateEvent(characterId, characterName, e);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: "事件已重新总结" });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "重新总结失败" });
    }
  };

  const handleUncoverEvent = async (e: ComplexEvent) => {
    setBusy(true);
    const res = await uncoverEvent(characterId, e.id);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: "已撤销覆盖，恢复为可召回记忆" });
      await load();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "撤销覆盖失败" });
    }
  };

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">事件记忆 · 共 {events.length} 条</span>
        <div className="cm-actions">
          {selectMode ? (
            <>
              <span className="cm-meta-text">已选 {selectedEvents.size} 条</span>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setSelectedEvents(new Set(events.map((e) => e.id)))}>全选</button>
              <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleBulkRegenerateEvents()} disabled={busy || selectedEvents.size === 0}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 批量重新总结
              </button>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setSelectMode(false); setSelectedEvents(new Set()); }}>退出</button>
            </>
          ) : (
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setSelectMode(true)}>
              <RefreshCw size={14} /> 多选重总结
            </button>
          )}
          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={handleGenerate} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} 立即压缩
          </button>
        </div>
      </div>
      {saveLog && saveLog.length > 0 && (
        <div className="cm-card" style={{ marginBottom: 10, padding: 8 }}>
          <div className="cm-meta-text" style={{ fontWeight: 600 }}>最近事件保存日志（排查覆盖问题）</div>
          <div style={{ maxHeight: 120, overflow: "auto", fontSize: 11 }}>
            {saveLog.slice(-10).map((s, i) => (
              <div key={i} style={{ color: "var(--c-text-dim, rgba(255,255,255,0.55))", marginTop: 2 }}>
                [{new Date(s.at).toLocaleTimeString()}] id={s.id} · 时={s.timestamp || "（空）"} · {s.content}
              </div>
            ))}
          </div>
        </div>
      )}
      {sorted.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无事件记忆</p></div>
      ) : (
        <div className="cm-event-list">
          {sorted.map((e) => {
            const v = effectiveVoltage(e, { kind: "event" });
            const pendingErase = e.coveredByPeriod && v < config.voltageEraseThreshold;
            return (
              <div key={e.id} className={`cm-card cm-event-item${selectMode && selectedEvents.has(e.id) ? " is-selected" : ""}`}>
                <button type="button" className="cm-event-head" onClick={() => { if (selectMode) { toggleSelectEvent(e.id); return; } setExpandedId(expandedId === e.id ? null : e.id); }}>
                  <span className="cm-event-time">{e.timestamp.slice(0, 16).replace("T", " ")}</span>
                  <span className="cm-event-importance">重要 {Math.round(e.importanceScore * 100)}%</span>
                  <VecBadge embedding={e.embedding} />
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
                    {editingId === e.id ? (
                      <>
                        <Textarea className="cm-core-editor" rows={6} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
                        <div className="cm-card-actions">
                          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setEditingId(null)}>取消</button>
                          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleSaveEdit(e)} disabled={busy}>
                            <Save size={14} /> 保存
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <Translatable text={e.content} textClass="cm-event-content" />
                        <SourceMaterialsView materials={e.sourceMaterials} />
                        <div className="cm-card-actions">
                          <span className="cm-meta-text">情绪 {e.emotion.valence.toFixed(2)} / {e.emotion.arousal.toFixed(2)}</span>
                          <span className="cm-spacer" />
                          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleRegenerate(e)} disabled={busy}>
                            <RefreshCw size={14} /> 重新总结
                          </button>
                          {e.coveredByPeriod && (
                            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleUncoverEvent(e)} disabled={busy}>
                              <Undo2 size={14} /> 撤销覆盖
                            </button>
                          )}
                          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleBoost(e)}>
                            <Zap size={14} /> 充能
                          </button>
                          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => { setEditingId(e.id); setDraft(e.content); }}>
                            <Edit3 size={14} /> 编辑
                          </button>
                          <button type="button" className="ui-btn ui-btn-danger ts-12" onClick={() => void handleDelete(e)}>
                            <Trash2 size={14} /> 删除
                          </button>
                        </div>
                      </>
                    )}
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

// ── 情绪坐标页（可交互：点击散点查看对应日记） ──
function EmotionTab({ characterId }: { characterId: string }) {
  const [dailies, setDailies] = useState<ComplexDaily[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const selected = dailies.find((d) => d.id === selectedId) ?? null;

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
              const isSel = selectedId === d.id;
              return (
                <circle
                  key={d.id}
                  cx={x(d.emotionVector.valence)}
                  cy={y(d.emotionVector.arousal)}
                  r={isSel ? 8 : 5}
                  fill={isSel ? "#F59E0B" : ACCENT}
                  opacity={alpha}
                  className="cm-scatter-point"
                  onClick={() => setSelectedId(isSel ? null : d.id)}
                >
                  <title>{`${d.date} · 效价 ${d.emotionVector.valence.toFixed(2)} · 唤醒 ${d.emotionVector.arousal.toFixed(2)}${d.special === true ? " · ★特殊一天" : ""}`}</title>
                </circle>
              );
            })}
          </svg>
        )}
        <p className="cm-muted cm-scatter-legend">颜色深浅表示日期新旧：越深越近。点击散点查看当天日记。</p>
      </div>
      {selected && (
        <div className="cm-card cm-scatter-detail">
          <div className="cm-section-head">
            <span className="cm-section-title">{selected.date}{selected.special === true && <span className="cm-special-badge">★</span>}</span>
            <span className="cm-meta-text">效价 {selected.emotionVector.valence.toFixed(2)} · 唤醒 {selected.emotionVector.arousal.toFixed(2)}</span>
          </div>
          <div className="cm-daily-content">{selected.content}</div>
        </div>
      )}
    </div>
  );
}

// ── 原生记忆页（M6 修复：短期上下文 + 共享事件，与 float 原生记忆查看器同构） ──
const NATIVE_TIMELINE_ENTRY_CAP = 2000;

function NativeMemoryTab({ characterId }: { characterId: string }) {
  const [sub, setSub] = useState<"short" | "shared">("short");
  const [shortEvents, setShortEvents] = useState<NativeTimelineEntry[]>([]);
  const [sharedEvents, setSharedEvents] = useState<NativeTimelineEntry[]>([]);
  const [userName, setUserName] = useState("用户");

  useEffect(() => {
    // 与 float memory-bank 完全一致的取材口径：
    // 短期 = 全量时间线剔除「用户自己的朋友圈」与「访谈共享期」；
    // 共享 = 用户朋友圈 + 群聊 + 访谈共享期
    const timeline = loadNativeTimeline(characterId).slice(-NATIVE_TIMELINE_ENTRY_CAP);
    setShortEvents(
      timeline.filter(
        (e) =>
          !(e.sourceApp === "moments" && e.postAuthorType === "user") &&
          !(e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue"),
      ),
    );
    setSharedEvents(
      timeline.filter(
        (e) =>
          (e.sourceApp === "moments" && e.postAuthorType === "user") ||
          (e.sourceApp === "chat" && e.sourceDetail === "group") ||
          (e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue"),
      ),
    );
    setUserName(resolveUserIdentity(characterId, "chat")?.name || "用户");
  }, [characterId]);

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">原生记忆 · 短期 {shortEvents.length} 条 / 共享 {sharedEvents.length} 条</span>
        <div className="cm-actions">
          <div className="cm-view-toggle" role="group" aria-label="原生记忆视图">
            <button type="button" className={`cm-view-btn ${sub === "short" ? "is-active" : ""}`} onClick={() => setSub("short")}>短期上下文</button>
            <button type="button" className={`cm-view-btn ${sub === "shared" ? "is-active" : ""}`} onClick={() => setSub("shared")}>共享事件</button>
          </div>
        </div>
      </div>
      <div className="cm-card">
        {sub === "short" ? (
          shortEvents.length === 0 ? (
            <p className="cm-muted">暂无短期上下文</p>
          ) : (
            <MemoryTimeline events={shortEvents} userName={userName} />
          )
        ) : sharedEvents.length === 0 ? (
          <p className="cm-muted">暂无共享事件。用户发朋友圈或参与群聊后会自动显示。</p>
        ) : (
          <MemoryTimeline events={sharedEvents} userName={userName} />
        )}
      </div>
    </div>
  );
}

// ── 投喂审计页（查看发给模型的完整记录） ──
function FeedAuditTab() {
  const [entries, setEntries] = useState<FeedAuditEntry[]>([]);
  const [kindFilter, setKindFilter] = useState<FeedAuditKind | "all">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(() => setEntries(getFeedAudit()), []);

  useEffect(() => {
    load();
  }, [load]);

  const sorted = useMemo(() => entries.filter((e) => kindFilter === "all" || e.kind === kindFilter), [entries, kindFilter]);
  const KIND_LABEL: Record<FeedAuditKind, string> = { event: "事件", daily: "日记", period: "周期", core: "核心" };

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">投喂审计 · 共 {entries.length} 条</span>
        <div className="cm-actions">
          <div className="cm-view-toggle" role="group" aria-label="按类型筛选">
            {(["all", "event", "daily", "period", "core"] as Array<FeedAuditKind | "all">).map((k) => (
              <button key={k} type="button" className={`cm-view-btn ${kindFilter === k ? "is-active" : ""}`} onClick={() => setKindFilter(k)}>
                {k === "all" ? "全部" : KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <button type="button" className="ui-btn ui-btn-danger ts-12" onClick={() => { clearFeedAudit(); setEntries([]); }}>
            <Trash2 size={14} /> 清空
          </button>
        </div>
      </div>
      <p className="cm-muted">这里记录复杂记忆每次生成「实际发给模型」的完整提示词（不截断）。用于定位时间/内容污染。底层调用日志只保留 4000 字摘要，此处为全文。</p>
      {sorted.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无投喂记录。生成事件/日记/周期/核心后会自动记录。</p></div>
      ) : (
        <div className="cm-event-list">
          {sorted.map((e) => (
            <div key={e.id} className="cm-card cm-event-item">
              <button type="button" className="cm-event-head" onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}>
                <span className={`cm-badge ${kindFilter === "all" ? "cm-badge-soft" : ""}`}>{KIND_LABEL[e.kind]}</span>
                <span className="cm-event-time">{e.date ?? "—"}</span>
                <span className="cm-event-importance">{e.characterName}</span>
                <span className="cm-event-voltage">{fmtTime(e.timestamp)}</span>
                {expandedId === e.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {expandedId === e.id && (
                <div className="cm-event-body">
                  <div className="cm-audit-prompt">
                    <div className="cm-audit-label">发给模型的完整 prompt（{e.prompt.length} 字符）</div>
                    <pre className="cm-audit-pre">{e.prompt}</pre>
                  </div>
                  <div className="cm-audit-prompt">
                    <div className="cm-audit-label">模型返回</div>
                    <pre className="cm-audit-pre">{e.response}</pre>
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

// ── 记忆清洗页（M6） ──
function CleanupTab({ characterId, characterName, notify, refresh }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
  refresh: () => void;
}) {
  const [clusters, setClusters] = useState<CleanupCluster[]>([]);
  const [snapshots, setSnapshots] = useState<CleanupSnapshot[]>([]);
  const [periods, setPeriods] = useState<ComplexPeriod[]>([]);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [targetPeriods, setTargetPeriods] = useState<Record<string, string>>({});

  const loadSnaps = useCallback(async () => {
    setSnapshots(listCleanupSnapshots(characterId));
  }, [characterId]);

  useEffect(() => {
    void loadSnaps();
    void loadPeriods(characterId).then(setPeriods);
  }, [characterId, loadSnaps]);

  const handleScan = async () => {
    setScanning(true);
    const found = await scanCleanupClusters(characterId);
    setScanning(false);
    setClusters(found);
    notify({ kind: found.length > 0 ? "ok" : "err", text: found.length > 0 ? `发现 ${found.length} 组相似记忆` : "未发现相似记忆簇" });
  };

  const runOp = async (fn: () => Promise<{ success: boolean; error?: string }>, okText: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: okText });
      setClusters([]);
      await loadSnaps();
      refresh();
    } else {
      notify({ kind: "err", text: res.error ?? "操作失败" });
    }
  };

  const opLabel: Record<CleanupSnapshot["operation"], string> = {
    merge: "融合更新",
    into_period: "并入周期",
    new_period: "合并为新周期",
  };

  return (
    <div className="cm-section">
      <div className="cm-section-head">
        <span className="cm-section-title">记忆清洗</span>
        <div className="cm-actions">
          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleScan()} disabled={scanning || busy}>
            {scanning ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} 扫描相似记忆
          </button>
        </div>
      </div>
      <p className="cm-muted cm-cleanup-hint">对事件与日记做向量相似度聚类，找出「召回时容易互相干扰/混淆」的记忆组；可融合更新、并入周期或合并为新周期。所有操作前自动生成快照，可一键回退（按角色保留最近 3 次）。</p>

      {clusters.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无扫描结果，点击「扫描相似记忆」开始</p></div>
      ) : (
        <div className="cm-cleanup-list">
          {clusters.map((c, idx) => (
            <div key={c.clusterId} className="cm-card cm-cleanup-cluster">
              <div className="cm-section-head">
                <span className="cm-section-title">簇 {idx + 1} · {c.entries.length} 条 · 相似度 {c.similarity.toFixed(2)}</span>
                <span className="cm-meta-text">{c.reasons.join(" · ")}</span>
              </div>
              <div className="cm-cleanup-members">
                {c.entries.map((e) => (
                  <div key={e.id} className="cm-cleanup-member">
                    <span className={`cm-badge cm-badge-soft`}>{e.kind === "daily" ? "日记" : "事件"} {e.date}</span>
                    <span className="cm-cleanup-text">{e.content.slice(0, 90)}{e.content.length > 90 ? "…" : ""}</span>
                  </div>
                ))}
              </div>
              <div className="cm-card-actions">
                <button type="button" className="ui-btn ui-btn-outline ts-12" disabled={busy} onClick={() => void runOp(() => mergeCluster(characterId, characterName, c), "已融合更新")}>
                  <Sparkles size={14} /> 融合更新
                </button>
                <div className="cm-cleanup-target">
                  <Select value={targetPeriods[c.clusterId] ?? ""} onChange={(e) => setTargetPeriods((prev) => ({ ...prev, [c.clusterId]: e.target.value }))} aria-label="选择目标周期" className="cm-filter-select">
                    <option value="">选择周期…</option>
                    {periods.map((p) => (
                      <option key={p.id} value={p.id}>{p.title}</option>
                    ))}
                  </Select>
                  <button type="button" className="ui-btn ui-btn-outline ts-12" disabled={busy || !targetPeriods[c.clusterId]} onClick={() => void runOp(() => mergeClusterIntoPeriod(characterId, characterName, c, targetPeriods[c.clusterId]), "已并入周期")}>
                    并入周期
                  </button>
                </div>
                <button type="button" className="ui-btn ui-btn-outline ts-12" disabled={busy} onClick={() => void runOp(() => createPeriodFromCluster(characterId, characterName, c), "已生成新周期")}>
                  合并为新周期
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="cm-section-head" style={{ marginTop: 18 }}>
        <span className="cm-section-title">清洗快照 · 最近 {snapshots.length} 次</span>
      </div>
      {snapshots.length === 0 ? (
        <div className="cm-empty-inline cm-card"><p className="cm-muted">暂无清洗快照</p></div>
      ) : (
        <div className="cm-cleanup-snapshots">
          {snapshots.map((s) => (
            <div key={s.id} className="cm-card cm-cleanup-snapshot">
              <div className="cm-section-head">
                <span className="cm-section-title">{opLabel[s.operation]}</span>
                <span className="cm-meta-text">{s.createdAt.slice(0, 16).replace("T", " ")} · 影响 {s.affected.length} 条</span>
              </div>
              <div className="cm-card-actions">
                <button type="button" className="ui-btn ui-btn-danger ts-12" disabled={busy} onClick={() => void runOp(() => rollbackCleanup(characterId, s.id), "已回退清洗操作")}>
                  <RotateCcw size={14} /> 回退
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
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
  stream: "按日回放",
  legacy: "压缩旧记忆",
  done: "已完成",
};

function MigrationTab({ characterId, characterName, notify }: {
  characterId: string;
  characterName: string;
  notify: (n: Notice) => void;
}) {
  const [counts, setCounts] = useState<{ events: number; dailies: number; periods: number; coreEntries: number } | null>(null);
  const [state, setState] = useState<MigrationState | null>(() => getMigrationState(characterId));
  const [days, setDays] = useState<number>(() => loadComplexMemoryConfig().migrationDefaultDays);
  const [migMode, setMigMode] = useState<"fixed" | "custom">("fixed");
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [periods, setPeriods] = useState<ComplexPeriod[]>([]);
  const [regenPeriodId, setRegenPeriodId] = useState("");
  const [regenBusy, setRegenBusy] = useState(false);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadCounts = useCallback(async () => {
    setCounts(await countByCharacter(characterId));
    setPeriods(await loadPeriods(characterId));
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
    // 迁移由后台驱动循环自动按批次推进（幂等），此处只负责定时刷新进度
    void driveMigration(characterId, characterName);
    autoRef.current = setInterval(() => {
      const ms = getMigrationState(characterId);
      refreshState();
      if (!ms || ms.status !== "running") {
        stopAuto();
      }
    }, 1500);
  };

  const handleStart = async () => {
    setBusy(true);
    const custom = migMode === "custom" && (rangeStart || rangeEnd);
    const res = custom
      ? await startMigration(characterId, characterName, 0, false, { start: rangeStart || undefined, end: rangeEnd || undefined })
      : await startMigration(characterId, characterName, days);
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
    const custom = migMode === "custom" && (rangeStart || rangeEnd);
    setEstimate(custom ? estimateMigration(characterId, 0, { start: rangeStart || undefined, end: rangeEnd || undefined }) : estimateMigration(characterId, days));
  };

  const handleRegeneratePeriod = async () => {
    if (!regenPeriodId) { notify({ kind: "err", text: "请先选择一个周期" }); return; }
    const p = periods.find((x) => x.id === regenPeriodId);
    setRegenBusy(true);
    const res = await distillPeriod(characterId, characterName, regenPeriodId, {});
    setRegenBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `周期「${p?.title ?? ""}」已重新总结替换` });
      await loadCounts();
    } else {
      notify({ kind: "err", text: res.error ?? "重新总结失败" });
    }
  };

  const handleExport = async () => {
    setBusy(true);
    const res = await exportToFloat(characterId);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `已导出到 float：核心 ${res.counts?.cores ?? 0} 条 · 事件 ${res.counts?.events ?? 0} 条 · 周期 ${res.counts?.periods ?? 0} 条` });
    } else {
      notify({ kind: "err", text: res.error ?? "导出失败" });
    }
  };

  const handleRetryDate = async (date: string) => {
    setBusy(true);
    const res = await retryFailedDate(characterId, characterName, date);
    setBusy(false);
    if (res.success) {
      notify({ kind: "ok", text: `「${date}」已重跑成功` });
      refreshState();
    } else {
      notify({ kind: "err", text: res.error ?? "重跑失败" });
    }
  };

  const running = state?.status === "running";
  const paused = state?.status === "paused";
  const done = state?.status === "done";
  // 综合进度：按日期逐日回放，dayIndex 反映已开始推进的日期（含当天事件+日记），doneDays 为已完成日期
  const dayNow = state?.dayIndex ?? (state ? state.doneDays : 0);
  const eventPct = state && state.totalDays > 0 ? Math.min(1, dayNow / state.totalDays) : 0;
  const dailyPct = state && state.totalDays > 0 ? state.doneDays / state.totalDays : 0;
  const progress = state ? Math.min(100, Math.round((eventPct * 0.6 + dailyPct * 0.4) * 100)) : 0;

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
            将「{characterName}」的历史聊天记录按时间正序动态回放：逐窗生成事件记忆（每窗注入当时的核心记忆、
            活跃周期、前一日日记与短期上下文），到一天结束即生成当日日记并判定周期开合，周期关闭立即提炼并微调核心，
            日记满 {loadComplexMemoryConfig().coreDailyInterval} 篇定期重构核心，空白天跳过。产物与正常逐日累积完全一致，
            电压半衰减减少失真。全程自动推进，可随时暂停并断点续跑。
          </p>
          <div className="cm-mig-setup">
            <span className="cm-config-label">回溯范围</span>
            <div className="cm-mig-day-options">
              {MIGRATION_DAY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`cm-mig-day ${migMode === "fixed" && days === o.value ? "is-active" : ""}`}
                  onClick={() => { setDays(o.value); setMigMode("fixed"); setEstimate(null); }}
                >
                  {o.label}
                </button>
              ))}
              <button
                type="button"
                className={`cm-mig-day ${migMode === "custom" ? "is-active" : ""}`}
                onClick={() => { setMigMode("custom"); setEstimate(null); }}
              >
                自定义范围
              </button>
            </div>
            {migMode === "custom" && (
              <div className="cm-mig-range">
                <Input type="date" value={rangeStart} onChange={(e) => { setRangeStart(e.target.value); setEstimate(null); }} aria-label="起始日期" className="cm-config-input" />
                <span className="cm-meta-text">至</span>
                <Input type="date" value={rangeEnd} onChange={(e) => { setRangeEnd(e.target.value); setEstimate(null); }} aria-label="结束日期" className="cm-config-input" />
                <span className="cm-meta-text">（留空表示不限一端）</span>
              </div>
            )}
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={handleEstimate}>
              估算 token
            </button>
            {estimate !== null && (
              <span className="cm-meta-text">预估约 {fmtTokens(estimate)}</span>
            )}
          </div>
          <div className="cm-mig-regen">
            <span className="cm-config-label">重新总结指定周期（替换原总结）</span>
            <div className="cm-mig-range">
              <Select value={regenPeriodId} onChange={(e) => setRegenPeriodId(e.target.value)} className="cm-filter-select" aria-label="选择周期">
                <option value="">选择周期…</option>
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}（{p.startTime} ~ {p.endTime ?? "至今"}）</option>
                ))}
              </Select>
              <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleRegeneratePeriod()} disabled={regenBusy || !regenPeriodId}>
                {regenBusy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 重新总结替换
              </button>
            </div>
          </div>
          {counts && (
            <div className="cm-meta-row">
              <span className="cm-badge cm-badge-soft">事件 {counts.events}</span>
              <span className="cm-badge cm-badge-soft">日记 {counts.dailies}</span>
              <span className="cm-badge cm-badge-soft">周期 {counts.periods}</span>
              <span className="cm-badge cm-badge-soft">核心 {counts.coreEntries} 条</span>
            </div>
          )}
          <div className="cm-card-actions">
            <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={() => void handleStart()} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 开始迁移
            </button>
            <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleExport()} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} 导出到 float
            </button>
          </div>
        </div>
      ) : (
        <div className="cm-card">
          <div className="cm-meta-row">
            <span className="cm-badge cm-badge-soft">阶段：{PHASE_LABEL[state.phase]}</span>
            <span className="cm-meta-text">
              {state.phase === "legacy"
                ? "压缩旧 float 记忆…"
                : state.phase === "done"
                  ? `${state.doneDays} / ${state.totalDays} 天`
                  : `逐日回放 · 事件 ${state.doneDays}/${state.totalDays} 天 · 日记 ${state.doneDays}/${state.totalDays} 天 · ${state.currentDate ?? "准备中…"}`}
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
              {state.report.failedDates.length > 0 ? ` · ${state.report.failedDates.length} 天失败` : " · 无失败项"}。
              核对通过后可在会话设置中开启复杂记忆开关。
            </p>
          )}
          {done && state.report && state.report.failedDates.length > 0 && (
            <div className="cm-failed-dates">
              <span className="cm-meta-text">失败日期（可单独重跑）：</span>
              <div className="cm-failed-date-list">
                {state.report.failedDates.map((d) => (
                  <div key={d} className="cm-failed-date-item">
                    <span className="cm-meta-text">{d}</span>
                    <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => void handleRetryDate(d)} disabled={busy}>
                      <RefreshCw size={13} /> 重跑
                    </button>
                  </div>
                ))}
              </div>
            </div>
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
  const [rulesDraft, setRulesDraft] = useState<string>(() => loadCharacterRules(characterId));

  const saveRules = () => {
    saveCharacterRules(characterId, rulesDraft);
    notify({ kind: "ok", text: "角色规则词已保存（将注入事件/日记/核心提示词）" });
  };

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
        {numField("eventWindowMaxEntries", "事件分窗素材上限（条/窗）", "单窗素材上限，超限分窗生成；建议 50-500")}
        {numField("eventTargetLength", "事件篇幅目标（字）")}
        {numField("dailyTargetLength", "日记篇幅目标（字）")}
        {numField("dailyQuietMinutes", "日记静默判定（分钟）", "仅约束当天日记")}
        {numField("rollingAppendMax", "周期每日进展上限（字）")}
        {numField("coreMinLength", "核心篇幅下限（字）")}
        {numField("coreMaxLength", "核心篇幅上限（字）")}
        {numField("coreDailyInterval", "核心重构日记间隔（篇）", "双触发之一：满 N 篇或周期结束")}
        {numField("maxParallel", "调度并发上限", "防限流")}
        {numField("retryCount", "调度失败重试次数", "指数退避")}
        {numField("voltageDecayFactor", "电压衰减系数", "普通日记，每 24h 未使用")}
        {numField("eventDecayFactor", "事件衰减系数", "事件衰减快")}
        {numField("periodDecayFactor", "周期衰减系数", "周期衰减慢")}
        {numField("specialDateDecayFactor", "特殊日期衰减系数", "周期级慢衰减")}
        {numField("voltageRecallBoost", "召回回升量")}
        {numField("voltageEraseThreshold", "消磨电压阈值")}
        {numField("recallTimeWindowFullDays", "日记时间窗全额（天）")}
        {numField("recallTimeWindowFloorDays", "日记时间窗底值（天）")}
        {numField("recallTimeWindowFloor", "日记时间窗降权底值")}
        {numField("emotionRecallLambda", "情绪召回权重 λ")}
        {numField("fixedSpecialDateCount", "特殊日期固定注入篇数")}
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
        {boolField("autoSummarizeEnabled", "自动总结", "后台自动生成 事件/日记/周期/核心 记忆；关闭后仅一键迁移/手动可生成（迁移进行中自动暂停）")}
      </div>

      <div className="cm-section-head" style={{ marginTop: 18 }}>
        <span className="cm-section-title">角色规则词</span>
        <span className="cm-meta-text">按角色绑定，注入事件/日记/核心提示词的 {"{{rules}}"} 变量</span>
      </div>
      <div className="cm-card">
        <Textarea
          className="cm-core-editor"
          rows={5}
          value={rulesDraft}
          onChange={(e) => setRulesDraft(e.target.value)}
          placeholder="例如：她说话喜欢用括号补充内心想法；生气时会故意冷淡但希望被追问；聊到前任话题会回避。每行一条。"
        />
        <div className="cm-card-actions">
          <span className="cm-meta-text">留空即删除该角色的规则词</span>
          <span className="cm-spacer" />
          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={() => setRulesDraft("")}>
            <RotateCcw size={14} /> 清空
          </button>
          <button type="button" className="ui-btn ui-btn-primary ts-12" onClick={saveRules}>
            <Save size={14} /> 保存规则词
          </button>
        </div>
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
