// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryEntriesByType, saveMemoryEntry } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";

/**
 * Retrieve relevant long-term memories for prompt injection.
 * Strategy:
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    let totalTokens = 0;
    for (const entry of longTermEntries) {
        totalTokens += estimateTokens(entry.content) + 4;
    }

    // Strategy 1: all fit within budget → return all
    if (totalTokens <= budget) {
        return longTermEntries;
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}

/**
 * 静默补向量：把某个角色所有「尚无向量」的长期记忆逐条补生成 embedding。
 * 用户编辑/新增长期记忆时会主动生成向量；若当时未配 embedding API 或生成失败，
 * 条目会保持无向量状态——本函数在打开记忆库详情页时后台兜底重试。
 * 行为特征：
 *  - 不依赖 vectorRecallEnabled 开关（补向量是写入侧动作，检索开关只管读取）
 *  - 逐条串行生成，失败静默跳过，不中断整体
 *  - 每角色防重入（同一时刻只跑一轮）
 * @returns 该角色当前的全部长期记忆（含补向量后的最新状态）；无可补/未运行返回 null
 */
const backfillSet = new Set<string>();

export async function backfillMissingEmbeddings(characterId: string): Promise<MemoryEntry[] | null> {
    if (backfillSet.has(characterId)) return null;
    const apiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
    if (!apiConfig || !resolveEmbeddingModel(apiConfig)) return null;

    const entries = await loadMemoryEntriesByType(characterId, "long_term");
    const pending = entries.filter(entry => !entry.embedding || entry.embedding.length === 0);
    if (pending.length === 0) return entries;

    backfillSet.add(characterId);
    try {
        const updatedById = new Map<string, MemoryEntry>();
        for (const entry of pending) {
            try {
                const emb = await generateEmbedding(entry.content, apiConfig);
                if (emb && emb.length > 0) {
                    const next: MemoryEntry = {
                        ...entry,
                        embedding: emb,
                        updatedAt: new Date().toISOString(),
                    };
                    await saveMemoryEntry(next);
                    updatedById.set(entry.id, next);
                }
            } catch {
                // 静默：单条失败不影响其余条目
            }
        }
        if (updatedById.size === 0) return entries;
        return entries.map(entry => updatedById.get(entry.id) ?? entry);
    } finally {
        backfillSet.delete(characterId);
    }
}
