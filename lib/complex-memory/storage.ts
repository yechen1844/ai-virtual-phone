// lib/complex-memory/storage.ts
// 复杂记忆系统 · IndexedDB ai_phone_complex_memory_db_v2 封装。
// 五个 store：events / dailies / periods / core_entries（条目式）/ core_snapshots。

import { openIndexedDbAtLeast } from "../idb-open";
import type {
  ComplexCoreEntry,
  ComplexCoreSnapshot,
  ComplexDaily,
  ComplexEvent,
  ComplexPeriod,
  LegacyComplexCore,
} from "./types";

export const COMPLEX_MEMORY_DB_NAME = "ai_phone_complex_memory_db_v1";
const DB_VERSION = 2;

export const STORE_EVENTS = "events";
export const STORE_DAILIES = "dailies";
export const STORE_PERIODS = "periods";
export const STORE_CORE = "core_entries";
export const STORE_CORE_SNAPSHOTS = "core_snapshots";

function hasBrowserApi(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function ensureIndexes(store: IDBObjectStore): void {
  if (store.name === STORE_EVENTS) {
    if (!store.indexNames.contains("by_character")) store.createIndex("by_character", "characterId", { unique: false });
    if (!store.indexNames.contains("by_character_created")) store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
    if (!store.indexNames.contains("by_covered")) store.createIndex("by_covered", "coveredByPeriod", { unique: false });
  } else if (store.name === STORE_DAILIES) {
    if (!store.indexNames.contains("by_character")) store.createIndex("by_character", "characterId", { unique: false });
    if (!store.indexNames.contains("by_character_date")) store.createIndex("by_character_date", ["characterId", "date"], { unique: false });
  } else if (store.name === STORE_PERIODS) {
    if (!store.indexNames.contains("by_character")) store.createIndex("by_character", "characterId", { unique: false });
    if (!store.indexNames.contains("by_character_status")) store.createIndex("by_character_status", ["characterId", "status"], { unique: false });
  } else if (store.name === STORE_CORE) {
    if (!store.indexNames.contains("by_character")) store.createIndex("by_character", "characterId", { unique: false });
    // 条目不可变、以快照组合引用，无需 version 索引
  } else if (store.name === STORE_CORE_SNAPSHOTS) {
    if (!store.indexNames.contains("by_character")) store.createIndex("by_character", "characterId", { unique: false });
  }
}

async function openDb(): Promise<IDBDatabase | null> {
  if (!hasBrowserApi()) return null;
  return openIndexedDbAtLeast(COMPLEX_MEMORY_DB_NAME, DB_VERSION, (db, _oldVersion, tx) => {
    const create = (name: string): void => {
      if (!db.objectStoreNames.contains(name)) {
        db.createObjectStore(name, { keyPath: "id" });
      }
    };
    create(STORE_EVENTS);
    create(STORE_DAILIES);
    create(STORE_PERIODS);
    create(STORE_CORE);
    create(STORE_CORE_SNAPSHOTS);
    for (const name of [STORE_EVENTS, STORE_DAILIES, STORE_PERIODS, STORE_CORE, STORE_CORE_SNAPSHOTS]) {
      const store = tx?.objectStore(name);
      if (store) ensureIndexes(store);
    }
  }).catch(() => null);
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getAllByIndex<T>(
  storeName: string,
  indexName: string,
  key: IDBValidKey,
): Promise<T[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    try {
      return await runRequest(store.index(indexName).getAll(key));
    } catch {
      const all: T[] = await runRequest(store.getAll());
      return all;
    }
  } finally {
    db.close();
  }
}

async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(storeName, "readonly");
    return await runRequest(tx.objectStore(storeName).getAll());
  } finally {
    db.close();
  }
}

async function put<T>(storeName: string, value: T): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function bulkPut<T>(storeName: string, values: T[]): Promise<void> {
  if (values.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const value of values) store.put(value);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function remove(storeName: string, id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(id);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function bulkRemove(storeName: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    for (const id of ids) store.delete(id);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function clearStore(storeName: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).clear();
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

// ── Events ──
function recordEventSaveLog(event: ComplexEvent): void {
  // 持久化记录最近一次事件保存（含 id / 时段 / 内容前40字），供「事件记忆」页顶部排查
  // 「生成了多个事件却只剩最后一条」的覆盖问题（浏览器无控制台时的可见证据）。
  try {
    if (typeof window === "undefined") return;
    const KEY = "ai_phone_cm_event_save_log_v1";
    let list: unknown[] = [];
    try { list = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown[]; } catch { list = []; }
    list.push({
      id: event.id,
      timestamp: event.timestamp,
      content: String(event.content).slice(0, 40),
      at: new Date().toISOString(),
    });
    if (list.length > 20) list = list.slice(-20);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch { /* 诊断不阻断保存 */ }
}

export async function saveEvent(event: ComplexEvent): Promise<void> {
  // 事件 id 覆盖检测 + 持久化生成日志（用于排查「生成了多个事件却只剩最后一条」）
  try {
    const db = await openDb();
    if (db) {
      const tx = db.transaction(STORE_EVENTS, "readonly");
      const existing = await runRequest(tx.objectStore(STORE_EVENTS).get(event.id));
      db.close();
      if (existing) {
        console.warn(`[ComplexMemory:DIAG] 事件 id 覆盖 id=${event.id} 时段=${event.timestamp} 旧=${String(existing.content).slice(0, 40)} 新=${String(event.content).slice(0, 40)}`);
      }
    }
  } catch {
    /* 诊断失败不阻断保存 */
  }
  recordEventSaveLog(event);
  await put(STORE_EVENTS, event);
}

/** 读取最近事件保存日志（供 UI 排查生成/覆盖问题）。 */
export function loadEventSaveLog(): Array<{ id: string; timestamp: string; content: string; at: string }> {
  try {
    if (typeof window === "undefined") return [];
    const raw = localStorage.getItem("ai_phone_cm_event_save_log_v1");
    return raw ? (JSON.parse(raw) as Array<{ id: string; timestamp: string; content: string; at: string }>) : [];
  } catch {
    return [];
  }
}
export async function saveEvents(events: ComplexEvent[]): Promise<void> {
  await bulkPut(STORE_EVENTS, events);
}
export async function loadEvents(characterId: string): Promise<ComplexEvent[]> {
  const events = await getAllByIndex<ComplexEvent>(STORE_EVENTS, "by_character", characterId);
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}
export async function loadAllEvents(): Promise<ComplexEvent[]> {
  return getAll<ComplexEvent>(STORE_EVENTS);
}
export async function deleteEvent(id: string): Promise<void> {
  await remove(STORE_EVENTS, id);
}
export async function deleteEvents(ids: string[]): Promise<void> {
  await bulkRemove(STORE_EVENTS, ids);
}
export async function deleteCharacterEvents(characterId: string): Promise<void> {
  const events = await loadEvents(characterId);
  await deleteEvents(events.map((e) => e.id));
}
export async function clearEvents(): Promise<void> {
  await clearStore(STORE_EVENTS);
}

// ── Dailies ──
export async function saveDaily(daily: ComplexDaily): Promise<void> {
  await put(STORE_DAILIES, daily);
}
export async function saveDailies(dailies: ComplexDaily[]): Promise<void> {
  await bulkPut(STORE_DAILIES, dailies);
}
export async function loadDailies(characterId: string): Promise<ComplexDaily[]> {
  const dailies = await getAllByIndex<ComplexDaily>(STORE_DAILIES, "by_character", characterId);
  dailies.sort((a, b) => a.date.localeCompare(b.date));
  return dailies;
}
export async function loadAllDailies(): Promise<ComplexDaily[]> {
  return getAll<ComplexDaily>(STORE_DAILIES);
}
export async function getDaily(characterId: string, date: string): Promise<ComplexDaily | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_DAILIES, "readonly");
    const store = tx.objectStore(STORE_DAILIES);
    try {
      // by_character_date 复合索引直查（DB v2 起已建）
      const list = await runRequest(
        store.index("by_character_date").getAll(IDBKeyRange.only([characterId, date])),
      );
      return (list as ComplexDaily[])[0] ?? null;
    } catch {
      // 索引缺失回退：全量扫描
      const all = await runRequest(store.getAll());
      return (all as ComplexDaily[]).find((d) => d.characterId === characterId && d.date === date) ?? null;
    }
  } finally {
    db.close();
  }
}
export async function deleteDaily(id: string): Promise<void> {
  await remove(STORE_DAILIES, id);
}
export async function deleteCharacterDailies(characterId: string): Promise<void> {
  const dailies = await loadDailies(characterId);
  await bulkRemove(STORE_DAILIES, dailies.map((d) => d.id));
}
export async function clearDailies(): Promise<void> {
  await clearStore(STORE_DAILIES);
}

// ── Periods ──
export async function savePeriod(period: ComplexPeriod): Promise<void> {
  await put(STORE_PERIODS, period);
}
export async function savePeriods(periods: ComplexPeriod[]): Promise<void> {
  await bulkPut(STORE_PERIODS, periods);
}
export async function loadPeriods(characterId: string): Promise<ComplexPeriod[]> {
  const periods = await getAllByIndex<ComplexPeriod>(STORE_PERIODS, "by_character", characterId);
  periods.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return periods;
}
export async function loadAllPeriods(): Promise<ComplexPeriod[]> {
  return getAll<ComplexPeriod>(STORE_PERIODS);
}
export async function loadActivePeriods(characterId: string): Promise<ComplexPeriod[]> {
  const periods = await loadPeriods(characterId);
  return periods.filter((p) => p.status === "active");
}
export async function getPeriod(id: string): Promise<ComplexPeriod | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_PERIODS, "readonly");
    const period = await runRequest(tx.objectStore(STORE_PERIODS).get(id));
    return (period as ComplexPeriod | undefined) ?? null;
  } finally {
    db.close();
  }
}
export async function deletePeriod(id: string): Promise<void> {
  await remove(STORE_PERIODS, id);
}
export async function deleteCharacterPeriods(characterId: string): Promise<void> {
  const periods = await loadPeriods(characterId);
  await bulkRemove(STORE_PERIODS, periods.map((p) => p.id));
}
export async function clearPeriods(): Promise<void> {
  await clearStore(STORE_PERIODS);
}

// ── Core entries（条目式，不可变） ──
export async function saveCoreEntry(entry: ComplexCoreEntry): Promise<void> {
  await put(STORE_CORE, entry);
}
export async function saveCoreEntries(entries: ComplexCoreEntry[]): Promise<void> {
  await bulkPut(STORE_CORE, entries);
}
export async function loadCoreEntries(characterId: string): Promise<ComplexCoreEntry[]> {
  const entries = await getAllByIndex<ComplexCoreEntry>(STORE_CORE, "by_character", characterId);
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return entries;
}
export async function loadAllCoreEntries(): Promise<ComplexCoreEntry[]> {
  return getAll<ComplexCoreEntry>(STORE_CORE);
}
export async function getCoreEntry(id: string): Promise<ComplexCoreEntry | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE_CORE, "readonly");
    const entry = await runRequest(tx.objectStore(STORE_CORE).get(id));
    return (entry as ComplexCoreEntry | undefined) ?? null;
  } finally {
    db.close();
  }
}
export async function deleteCoreEntry(id: string): Promise<void> {
  await remove(STORE_CORE, id);
}
export async function deleteCharacterCoreEntries(characterId: string): Promise<void> {
  const entries = await loadCoreEntries(characterId);
  await bulkRemove(STORE_CORE, entries.map((e) => e.id));
}
export async function clearCoreEntries(): Promise<void> {
  await clearStore(STORE_CORE);
}

// ── Core snapshots ──
export async function saveCoreSnapshot(snap: ComplexCoreSnapshot): Promise<void> {
  await put(STORE_CORE_SNAPSHOTS, snap);
}
export async function saveCoreSnapshots(snaps: ComplexCoreSnapshot[]): Promise<void> {
  await bulkPut(STORE_CORE_SNAPSHOTS, snaps);
}
export async function loadCoreSnapshots(characterId: string): Promise<ComplexCoreSnapshot[]> {
  const snaps = await getAllByIndex<ComplexCoreSnapshot>(STORE_CORE_SNAPSHOTS, "by_character", characterId);
  snaps.sort((a, b) => a.version - b.version);
  return snaps;
}
export async function loadAllCoreSnapshots(): Promise<ComplexCoreSnapshot[]> {
  return getAll<ComplexCoreSnapshot>(STORE_CORE_SNAPSHOTS);
}
export async function getCurrentCoreSnapshot(characterId: string): Promise<ComplexCoreSnapshot | null> {
  const snaps = await loadCoreSnapshots(characterId);
  return snaps.find((s) => s.isCurrent) ?? snaps[snaps.length - 1] ?? null;
}
export async function getCoreSnapshotByVersion(characterId: string, version: number): Promise<ComplexCoreSnapshot | null> {
  const snaps = await loadCoreSnapshots(characterId);
  return snaps.find((s) => s.version === version) ?? null;
}
export async function deleteCharacterCoreSnapshots(characterId: string): Promise<void> {
  const snaps = await loadCoreSnapshots(characterId);
  await bulkRemove(STORE_CORE_SNAPSHOTS, snaps.map((s) => s.id));
}
export async function clearCoreSnapshots(): Promise<void> {
  await clearStore(STORE_CORE_SNAPSHOTS);
}

// ── 存量整块核心记忆（DB v1 遗留读取，供一次性拆条迁移） ──
export async function loadLegacyCores(characterId: string): Promise<LegacyComplexCore[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(STORE_CORE, "readonly");
    const store = tx.objectStore(STORE_CORE);
    try {
      const all = await runRequest(store.getAll());
      const out: LegacyComplexCore[] = [];
      for (const rec of all as Array<Partial<LegacyComplexCore> & Partial<ComplexCoreEntry>>) {
        if (typeof rec.content !== "string") continue;  // 已是条目式（无 content 字段）
        if (rec.characterId !== characterId) continue;
        out.push(rec as LegacyComplexCore);
      }
      return out.sort((a, b) => a.version - b.version);
    } catch {
      return [];
    }
  } finally {
    db.close();
  }
}
export async function deleteLegacyCore(id: string): Promise<void> {
  await remove(STORE_CORE, id);
}

// ── 读取渲染：当前核心记忆文本（按 category 分组、P0→P3 稳定顺序） ──
const CORE_CATEGORY_ORDER: Array<ComplexCoreEntry["category"]> = ["identity", "bond", "principle", "milestone"];
const CORE_CATEGORY_LABEL: Record<ComplexCoreEntry["category"], string> = {
  identity: "身份认知",
  bond: "关系纽带",
  principle: "原则承诺",
  milestone: "里程碑事件",
};

export type CurrentCoreView = {
  snapshot: ComplexCoreSnapshot | null;
  entries: ComplexCoreEntry[];       // 当前快照引用的条目（含软删，供渲染与回退）
  activeEntries: ComplexCoreEntry[]; // 其中 active 的条目（供编辑/镜像）
  text: string;                      // 分组渲染文本
};

export async function getCurrentCoreView(characterId: string): Promise<CurrentCoreView> {
  const [snapshot, allEntries] = await Promise.all([
    getCurrentCoreSnapshot(characterId),
    loadCoreEntries(characterId),
  ]);
  const byId = new Map(allEntries.map((e) => [e.id, e]));
  if (snapshot && snapshot.entryIds.length > 0) {
    const entries = snapshot.entryIds.map((id) => byId.get(id)).filter((e): e is ComplexCoreEntry => !!e);
    return {
      snapshot,
      entries,
      activeEntries: entries.filter((e) => e.active),
      text: renderCoreEntriesText(entries),
    };
  }
  // 无快照但可能有 legacy 整块：由 core-builder 迁移层处理，这里返回空视图
  return { snapshot: null, entries: [], activeEntries: [], text: "" };
}

export function renderCoreEntriesText(entries: ComplexCoreEntry[]): string {
  const grouped = new Map<ComplexCoreEntry["category"], ComplexCoreEntry[]>();
  for (const e of entries) {
    if (!grouped.has(e.category)) grouped.set(e.category, []);
    grouped.get(e.category)!.push(e);
  }
  const parts: string[] = [];
  for (const cat of CORE_CATEGORY_ORDER) {
    const list = grouped.get(cat) ?? [];
    if (list.length === 0) continue;
    parts.push(`【${CORE_CATEGORY_LABEL[cat]}】`);
    for (const e of list) parts.push(`- ${e.text}`);
  }
  return parts.join("\n");
}

/** 列表页/迁移用：条目数 + 快照数。 */
export async function countCores(characterId: string): Promise<{ entries: number; snapshots: number }> {
  const [entries, snaps] = await Promise.all([
    loadCoreEntries(characterId),
    loadCoreSnapshots(characterId),
  ]);
  return { entries: entries.length, snapshots: snaps.length };
}

// ── 角色级聚合 ──
export async function deleteCharacterAll(characterId: string): Promise<void> {
  await Promise.all([
    deleteCharacterEvents(characterId),
    deleteCharacterDailies(characterId),
    deleteCharacterPeriods(characterId),
    deleteCharacterCoreEntries(characterId),
    deleteCharacterCoreSnapshots(characterId),
  ]);
}

export async function countByCharacter(characterId: string): Promise<{
  events: number;
  dailies: number;
  periods: number;
  coreEntries: number;
  coreSnapshots: number;
}> {
  const [events, dailies, periods, coreEntries, coreSnapshots] = await Promise.all([
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
    loadCoreEntries(characterId),
    loadCoreSnapshots(characterId),
  ]);
  return {
    events: events.length,
    dailies: dailies.length,
    periods: periods.length,
    coreEntries: coreEntries.length,
    coreSnapshots: coreSnapshots.length,
  };
}

export async function getAllCharacterIds(): Promise<string[]> {
  const [events, dailies, periods, coreEntries, coreSnapshots] = await Promise.all([
    loadAllEvents(),
    loadAllDailies(),
    loadAllPeriods(),
    loadAllCoreEntries(),
    loadAllCoreSnapshots(),
  ]);
  const ids = new Set<string>();
  for (const e of events) ids.add(e.characterId);
  for (const d of dailies) ids.add(d.characterId);
  for (const p of periods) ids.add(p.characterId);
  for (const e2 of coreEntries) ids.add(e2.characterId);
  for (const s of coreSnapshots) ids.add(s.characterId);
  return Array.from(ids);
}
