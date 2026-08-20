// lib/complex-memory/core-builder.ts
// 复杂记忆系统 · L5 核心记忆构建与更新。
// bootstrap（首次启用）→ v1；定期重构（每 N 篇日记）→ 新版本；事件驱动微调（周期提炼后）→ 新版本；
// 手动编辑 → 新版本。所有新版本过消毒检查后整段替换式镜像到 float 核心库。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { loadCharacters } from "../character-storage";
import { loadMemoryEntriesByType, saveMemoryEntry } from "../memory-storage";
import {
  loadComplexMemoryConfig,
  acquireGenerationLock,
  releaseGenerationLock,
  loadCharacterState,
  saveCharacterState,
} from "./config";
import { renderMemoryPrompt, DEFAULT_PROMPTS } from "./prompts";
import {
  getCurrentCore,
  loadCoreVersions,
  saveCore,
  loadEvents,
  loadDailies,
  loadPeriods,
} from "./storage";
import { getUserName } from "./utils";
import type { ComplexCore, CoreTrigger } from "./types";

// ── 消毒检查 ──
export function sanitizeCoreContent(content: string, banList: string[]): { ok: boolean; banned: string[] } {
  const banned = banList.filter((w) => w && content.includes(w));
  return { ok: banned.length === 0, banned };
}

function getCharacterPersona(characterId: string): string {
  try {
    return loadCharacters().find((c) => c.id === characterId)?.persona ?? "";
  } catch {
    return "";
  }
}

async function generateCoreVersion(
  characterId: string,
  characterName: string,
  trigger: CoreTrigger,
  newMaterials: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  const config = loadComplexMemoryConfig();
  const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) return { success: false, error: "未配置复杂记忆生成 API" };

  const current = await getCurrentCore(characterId);
  const existingCore = current?.content ?? "";
  const persona = getCharacterPersona(characterId);

  const template = config.prompts.core?.trim() || DEFAULT_PROMPTS.core;
  const prompt = renderMemoryPrompt(template, characterName, getUserName(characterId), {
    persona,
    existingCore,
    newMaterials,
    minLength: String(config.coreMinLength),
    maxLength: String(config.coreMaxLength),
    banList: config.sanitizerBanList.join("、"),
  });

  const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], {
    temperature: 0.3,
    label: `复杂记忆·核心·${characterName}`,
  });
  if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };
  if (result.wasTruncated) return { success: false, error: "核心记忆生成疑似被截断，已取消入库" };

  const content = result.content.trim();
  if (!content) return { success: false, error: "核心记忆生成结果为空" };

  const { ok, banned } = sanitizeCoreContent(content, config.sanitizerBanList);
  if (!ok) return { success: false, error: `核心记忆含禁用词（${banned.join("、")}），已拒绝入库` };

  const versions = await loadCoreVersions(characterId);
  const nextVersion = versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.version)) + 1;
  const now = new Date().toISOString();

  for (const v of versions) {
    if (v.isCurrent) await saveCore({ ...v, isCurrent: false });
  }

  const core: ComplexCore = {
    id: `core_v${nextVersion}`,
    characterId,
    version: nextVersion,
    content,
    updatedAt: now,
    trigger,
    isCurrent: true,
  };
  await saveCore(core);

  await mirrorCoreToFloat(characterId, content, nextVersion);

  console.log(`[ComplexMemory] 核心记忆 ${trigger} 生成成功: v${nextVersion}`);
  return { success: true, version: nextVersion };
}

// ── bootstrap：首次启用时从人设 + 既有素材生成 v1 ──
export async function bootstrapCoreMemory(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string }> {
  const existing = await getCurrentCore(characterId);
  if (existing) return { success: false, error: "核心记忆已存在（幂等）" };
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const [events, dailies, floatLongTerm] = await Promise.all([
      loadEvents(characterId),
      loadDailies(characterId),
      loadMemoryEntriesByType(characterId, "long_term"),
    ]);
    const materials: string[] = [];
    for (const e of events) materials.push(`[事件 ${e.timestamp.slice(0, 10)}] ${e.content}`);
    for (const d of dailies) materials.push(`[日记 ${d.date}] ${d.content}`);
    for (const m of floatLongTerm) materials.push(`[长期记忆] ${m.content}`);
    const newMaterials = materials.slice(-30).join("\n\n");
    return await generateCoreVersion(characterId, characterName, "bootstrap", newMaterials);
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 定期重构：每 N 篇日记触发一次全量重构，成功后重置计数 ──
export async function rebuildCoreMemory(
  characterId: string,
  characterName: string,
): Promise<{ success: boolean; error?: string }> {
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const [dailies, periods] = await Promise.all([loadDailies(characterId), loadPeriods(characterId)]);
    const materials: string[] = [];
    for (const d of dailies.slice(-5)) materials.push(`[日记 ${d.date}] ${d.content}`);
    for (const p of periods.filter((x) => x.status !== "active").slice(-3)) {
      materials.push(`[周期 ${p.title}] ${p.summary}`);
    }
    const newMaterials = materials.join("\n\n");
    const result = await generateCoreVersion(characterId, characterName, "scheduled", newMaterials);
    if (result.success) {
      const state = loadCharacterState(characterId);
      saveCharacterState({ ...state, dailyCountSinceCoreUpdate: 0 });
    }
    return result;
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 事件驱动微调：周期提炼完成后，只允许修改相关段落 ──
export async function fineTuneCoreMemory(
  characterId: string,
  characterName: string,
  periodTitle: string,
  periodSummary: string,
): Promise<{ success: boolean; error?: string }> {
  if (!acquireGenerationLock(characterId, "core")) {
    return { success: false, error: "已有生成任务进行中" };
  }
  try {
    const newMaterials = `【周期「${periodTitle}」总结】\n${periodSummary}`;
    return await generateCoreVersion(characterId, characterName, "period_driven", newMaterials);
  } finally {
    releaseGenerationLock(characterId, "core");
  }
}

// ── 手动编辑：用户编辑/新增 → manual 触发新版本 ──
export async function manualUpdateCoreMemory(
  characterId: string,
  characterName: string,
  newContent: string,
): Promise<{ success: boolean; error?: string; version?: number }> {
  const config = loadComplexMemoryConfig();
  const content = newContent.trim();
  if (!content) return { success: false, error: "核心记忆内容为空" };
  const { ok, banned } = sanitizeCoreContent(content, config.sanitizerBanList);
  if (!ok) return { success: false, error: `核心记忆含禁用词（${banned.join("、")}），已拒绝入库` };

  const versions = await loadCoreVersions(characterId);
  const nextVersion = versions.length === 0 ? 1 : Math.max(...versions.map((v) => v.version)) + 1;
  const now = new Date().toISOString();
  for (const v of versions) {
    if (v.isCurrent) await saveCore({ ...v, isCurrent: false });
  }
  const core: ComplexCore = {
    id: `core_v${nextVersion}`,
    characterId,
    version: nextVersion,
    content,
    updatedAt: now,
    trigger: "manual",
    isCurrent: true,
  };
  await saveCore(core);
  await mirrorCoreToFloat(characterId, content, nextVersion);
  return { success: true, version: nextVersion };
}

// ── 替换式镜像：新版本写入，旧镜像标记 active=false ──
async function mirrorCoreToFloat(characterId: string, content: string, version: number): Promise<void> {
  try {
    const config = loadComplexMemoryConfig();
    if (!config.mirrorToFloatEnabled) return;
    const entries = await loadMemoryEntriesByType(characterId, "core");
    for (const e of entries) {
      if (e.metadata?.complexMemoryCore === true) {
        await saveMemoryEntry({ ...e, metadata: { ...e.metadata, active: false } });
      }
    }
    const now = new Date().toISOString();
    await saveMemoryEntry({
      id: `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      characterId,
      sourceApp: "chat",
      type: "core",
      content,
      importance: 0.95,
      createdAt: now,
      updatedAt: now,
      metadata: { complexMemoryCore: true, complexCoreVersion: version, active: true },
    });
  } catch (err) {
    console.warn("[ComplexMemory] 核心记忆镜像 float 失败:", err);
  }
}
