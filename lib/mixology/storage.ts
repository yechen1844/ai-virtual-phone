// lib/mixology/storage.ts
// 独家特调 · 本地存取：酒柜（材料）/ 特调方案 / 对局，全部走 kv-db。
// 官方出厂件（基底/杯型）首次加载自动入柜，MIX_BUILTIN_VERSION 升版时按 id 刷新内容。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type {
    MixMaterial,
    MixMaterialKind,
    MixRecipe,
    MixSession,
} from "./types";
import {
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_GLASS_ID,
    MIX_BUILTIN_VERSION,
    createBuiltinBase,
    createBuiltinGlass,
} from "./builtin";

const CABINET_KEY = "mixology_cabinet_v1";
const RECIPES_KEY = "mixology_recipes_v1";
const SESSIONS_KEY = "mixology_sessions_v1";
const BUILTIN_VERSION_KEY = "mixology_builtin_version_v1";

registerKvMigration(CABINET_KEY);
registerKvMigration(RECIPES_KEY);
registerKvMigration(SESSIONS_KEY);
registerKvMigration(BUILTIN_VERSION_KEY);

/** 官方件不可删除、不可改名（内容随出厂版本刷新） */
export const MIX_BUILTIN_IDS: readonly string[] = [
    MIX_BUILTIN_BASE_ID,
    MIX_BUILTIN_GLASS_ID,
];

export function isMixBuiltinId(id: string): boolean {
    return MIX_BUILTIN_IDS.includes(id);
}

function readJson<T>(key: string, fallback: T): T {
    const raw = kvGet(key);
    if (!raw) return fallback;
    try {
        const parsed = JSON.parse(raw);
        return (parsed ?? fallback) as T;
    } catch {
        return fallback;
    }
}

function writeJson(key: string, value: unknown): void {
    kvSet(key, JSON.stringify(value));
}

// ---------- 酒柜（材料） ----------

/** 出厂件补种/刷新：缺则种入，版本落后则用出厂内容覆盖（保留玩家无法改的官方件语义） */
function ensureBuiltins(list: MixMaterial[]): { list: MixMaterial[]; changed: boolean } {
    const storedVersion = Number(kvGet(BUILTIN_VERSION_KEY) ?? "0");
    const factory: MixMaterial[] = [createBuiltinBase(), createBuiltinGlass()];
    let changed = false;
    const next = [...list];
    for (const item of factory) {
        const idx = next.findIndex((m) => m.id === item.id);
        if (idx < 0) {
            next.push(item);
            changed = true;
        } else if (storedVersion < MIX_BUILTIN_VERSION) {
            next[idx] = { ...item, createdAt: next[idx].createdAt };
            changed = true;
        }
    }
    if (storedVersion < MIX_BUILTIN_VERSION) {
        kvSet(BUILTIN_VERSION_KEY, String(MIX_BUILTIN_VERSION));
    }
    return { list: next, changed };
}

export function loadMixCabinet(): MixMaterial[] {
    const stored = readJson<MixMaterial[]>(CABINET_KEY, []);
    const { list, changed } = ensureBuiltins(Array.isArray(stored) ? stored : []);
    if (changed) writeJson(CABINET_KEY, list);
    return list;
}

export function listMixMaterials(kind: MixMaterialKind): MixMaterial[] {
    return loadMixCabinet()
        .filter((m) => m.kind === kind)
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixMaterial(id: string): MixMaterial | null {
    return loadMixCabinet().find((m) => m.id === id) ?? null;
}

/** 新增或整体覆盖一件材料（id 相同即覆盖） */
export function saveMixMaterial(material: MixMaterial): void {
    const list = loadMixCabinet();
    const idx = list.findIndex((m) => m.id === material.id);
    const stamped = { ...material, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(CABINET_KEY, list);
}

/** 删除材料（官方件拒删）。返回是否真的删了。 */
export function deleteMixMaterial(id: string): boolean {
    if (isMixBuiltinId(id)) return false;
    const list = loadMixCabinet();
    const next = list.filter((m) => m.id !== id);
    if (next.length === list.length) return false;
    writeJson(CABINET_KEY, next);
    return true;
}

// ---------- 特调方案 ----------

export function loadMixRecipes(): MixRecipe[] {
    const stored = readJson<MixRecipe[]>(RECIPES_KEY, []);
    return (Array.isArray(stored) ? stored : []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixRecipe(id: string): MixRecipe | null {
    return loadMixRecipes().find((r) => r.id === id) ?? null;
}

export function saveMixRecipe(recipe: MixRecipe): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    const idx = list.findIndex((r) => r.id === recipe.id);
    const stamped = { ...recipe, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(RECIPES_KEY, list);
}

export function deleteMixRecipe(id: string): void {
    const list = readJson<MixRecipe[]>(RECIPES_KEY, []);
    writeJson(RECIPES_KEY, list.filter((r) => r.id !== id));
}

// ---------- 对局 ----------

export function loadMixSessions(): MixSession[] {
    const stored = readJson<MixSession[]>(SESSIONS_KEY, []);
    return (Array.isArray(stored) ? stored : []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMixSession(id: string): MixSession | null {
    return loadMixSessions().find((s) => s.id === id) ?? null;
}

export function saveMixSession(session: MixSession): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    const idx = list.findIndex((s) => s.id === session.id);
    const stamped = { ...session, updatedAt: Date.now() };
    if (idx >= 0) list[idx] = stamped;
    else list.push(stamped);
    writeJson(SESSIONS_KEY, list);
}

export function deleteMixSession(id: string): void {
    const list = readJson<MixSession[]>(SESSIONS_KEY, []);
    writeJson(SESSIONS_KEY, list.filter((s) => s.id !== id));
}

/** 按方案槽位从酒柜取材料实体；缺失的槽（材料被删）静默跳过，角色卡缺失返回 null */
export function resolveMixRecipeMaterials(
    recipe: MixRecipe,
): { materials: Partial<Record<MixMaterialKind, MixMaterial>>; missing: MixMaterialKind[] } {
    const cabinet = loadMixCabinet();
    const materials: Partial<Record<MixMaterialKind, MixMaterial>> = {};
    const missing: MixMaterialKind[] = [];
    for (const [kind, id] of Object.entries(recipe.slots) as [MixMaterialKind, string][]) {
        if (!id) continue;
        const found = cabinet.find((m) => m.id === id && m.kind === kind);
        if (found) materials[kind] = found;
        else missing.push(kind);
    }
    return { materials, missing };
}
