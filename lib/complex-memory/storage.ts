// lib/complex-memory/storage.ts
// 复杂记忆系统 · IndexedDB ai_phone_complex_memory_db_v1 封装。
// 四 store：events / dailies / periods / core_entries。

import { openIndexedDbAtLeast } from "../idb-open";
import type {
  ComplexCore,
  ComplexDaily,
  ComplexEvent,
  ComplexPeriod,
} from "./types";

export const COMPLEX_MEMORY_DB_NAME = "ai_phone_complex_memory_db_v1";
const DB_VERSION = 1;

export const STORE_EVENTS = "events";
export const STORE_DAILIES = "dailies";
export const STORE_PERIODS = "periods";
export const STORE_CORE = "core_entries";

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
    if (!store.indexNames.contains("by_character_version")) store.createIndex("by_character_version", ["characterId", "version"], { unique: false });
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
    for (const name of [STORE_EVENTS, STORE_DAILIES, STORE_PERIODS, STORE_CORE]) {
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
export async function saveEvent(event: ComplexEvent): Promise<void> {
  await put(STORE_EVENTS, event);
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
  const dailies = await loadDailies(characterId);
  return dailies.find((d) => d.date === date) ?? null;
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

// ── Core entries ──
export async function saveCore(core: ComplexCore): Promise<void> {
  await put(STORE_CORE, core);
}
export async function loadCoreVersions(characterId: string): Promise<ComplexCore[]> {
  const cores = await getAllByIndex<ComplexCore>(STORE_CORE, "by_character", characterId);
  cores.sort((a, b) => a.version - b.version);
  return cores;
}
export async function loadAllCores(): Promise<ComplexCore[]> {
  return getAll<ComplexCore>(STORE_CORE);
}
export async function getCurrentCore(characterId: string): Promise<ComplexCore | null> {
  const cores = await loadCoreVersions(characterId);
  return cores.find((c) => c.isCurrent) ?? cores[cores.length - 1] ?? null;
}
export async function getCoreVersion(characterId: string, version: number): Promise<ComplexCore | null> {
  const cores = await loadCoreVersions(characterId);
  return cores.find((c) => c.version === version) ?? null;
}
export async function deleteCore(id: string): Promise<void> {
  await remove(STORE_CORE, id);
}
export async function deleteCharacterCores(characterId: string): Promise<void> {
  const cores = await loadCoreVersions(characterId);
  await bulkRemove(STORE_CORE, cores.map((c) => c.id));
}
export async function clearCores(): Promise<void> {
  await clearStore(STORE_CORE);
}

// ── 角色级聚合 ──
export async function deleteCharacterAll(characterId: string): Promise<void> {
  await Promise.all([
    deleteCharacterEvents(characterId),
    deleteCharacterDailies(characterId),
    deleteCharacterPeriods(characterId),
    deleteCharacterCores(characterId),
  ]);
}

export async function countByCharacter(characterId: string): Promise<{
  events: number;
  dailies: number;
  periods: number;
  cores: number;
}> {
  const [events, dailies, periods, cores] = await Promise.all([
    loadEvents(characterId),
    loadDailies(characterId),
    loadPeriods(characterId),
    loadCoreVersions(characterId),
  ]);
  return { events: events.length, dailies: dailies.length, periods: periods.length, cores: cores.length };
}

export async function getAllCharacterIds(): Promise<string[]> {
  const [events, dailies, periods, cores] = await Promise.all([
    loadAllEvents(),
    loadAllDailies(),
    loadAllPeriods(),
    loadAllCores(),
  ]);
  const ids = new Set<string>();
  for (const e of events) ids.add(e.characterId);
  for (const d of dailies) ids.add(d.characterId);
  for (const p of periods) ids.add(p.characterId);
  for (const c of cores) ids.add(c.characterId);
  return Array.from(ids);
}
