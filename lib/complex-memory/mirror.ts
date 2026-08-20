// lib/complex-memory/mirror.ts
// 复杂记忆系统 · float 镜像写入。
// 事件记忆生成成功时同步注入 float 长期记忆库，保证两个系统并行兼容。
// 联动删除与替换式更新在 M4/M5（日记/核心）实现。

import { saveMemoryEntry } from "../memory-storage";
import type { ComplexEvent } from "./types";

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
