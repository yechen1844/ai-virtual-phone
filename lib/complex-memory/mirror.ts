// lib/complex-memory/mirror.ts
// 复杂记忆系统 · float 镜像写入。
// 事件记忆生成成功时同步注入 float 长期记忆库，保证两个系统并行兼容。
// 核心记忆条目化：active 条目逐条建立 float core 记录（整体替换式同步）。

import { loadMemoryEntriesByType, saveMemoryEntry, deleteMemoryEntries } from "../memory-storage";
import { loadComplexMemoryConfig } from "./config";
import type { ComplexCoreEntry, ComplexEvent, ComplexPeriod } from "./types";

export async function mirrorEventToFloat(
  event: ComplexEvent,
  meta: { earliest: string; latest: string; entryCount: number },
): Promise<void> {
  const now = new Date().toISOString();
  await saveMemoryEntry({
    id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    characterId: event.characterId,
    sourceApp: "chat",
    type: "long_term",
    content: event.content,
    embedding: event.embedding,
    importance: event.importanceScore,
    createdAt: now,
    updatedAt: now,
    metadata: {
      complexMemoryEvent: true,
      complexEventId: event.id,
      timeSpan: `${meta.earliest} ~ ${meta.latest}`,
      summarizedEvents: meta.entryCount,
    },
  });
}

/** 条目级镜像：整体替换式。先删所有复杂来源的 float core 记录，再按 active 条目逐条重建。 */
export async function mirrorCoreEntriesToFloat(
  characterId: string,
  activeEntries: ComplexCoreEntry[],
): Promise<void> {
  const config = loadComplexMemoryConfig();
  if (!config.mirrorToFloatEnabled) return;

  const existing = await loadMemoryEntriesByType(characterId, "core");
  const complexSourced = existing.filter((e) => e.metadata?.complexMemoryCore === true);
  if (complexSourced.length > 0) {
    await deleteMemoryEntries(complexSourced.map((e) => e.id));
  }

  const now = new Date().toISOString();
  for (const entry of activeEntries) {
    await saveMemoryEntry({
      id: `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      characterId,
      sourceApp: "chat",
      type: "core",
      content: entry.text,
      importance: 1,
      createdAt: now,
      updatedAt: now,
      metadata: {
        complexMemoryCore: true,
        complexCoreEntryId: entry.id,
        category: entry.category,
        sourceTrigger: entry.sourceTrigger,
      },
    });
  }
}

/** 周期总结镜像到 float long_term（复杂→原生导出复用）。 */
export async function mirrorPeriodToFloat(period: ComplexPeriod): Promise<void> {
  const now = new Date().toISOString();
  await saveMemoryEntry({
    id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    characterId: period.characterId,
    sourceApp: "chat",
    type: "long_term",
    content: `【${period.title}】${period.startTime} ~ ${period.endTime ?? "至今"}\n${period.summary}`,
    importance: 0.9,
    createdAt: now,
    updatedAt: now,
    metadata: {
      complexMemoryPeriod: true,
      complexPeriodId: period.id,
      timeSpan: `${period.startTime} ~ ${period.endTime ?? ""}`,
    },
  });
}
