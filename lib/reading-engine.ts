// lib/reading-engine.ts — LLM integration for Reading feature.
// All prompts go through the preset system via assemblePromptPayload. No extra message push.

import type { Book, BookChapter, ReadingAnnotation, ReadingSummary } from "./reading-types";
import type { ChatSession } from "./chat-storage";
import { loadChatMessages, pushChatMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadReadingInteractionConfig, loadSummaries, saveSummary, getTotalSummaryChars, encodeReadingPosition } from "./reading-storage";
import {
    resolveBinding,
    loadBindingConfig,
    loadApiConfigs,
    loadPresets,
    loadWorldBooks,
    loadRegexes,
    resolveUserIdentity,
} from "./settings-storage";
import {
    assemblePromptPayload,
    type AssemblerInput,
    type LLMMessage,
} from "./llm-prompt-assembler";
import type { ApiConfig, PresetConfig, RegexConfig } from "./settings-types";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { simpleLLMCall } from "./api-helpers";
import { DEFAULT_READING_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";

export type ReadingDiscussAction =
    | { type: "add_annotation"; paragraphIndex: number; content: string }
    | { type: "delete_annotation"; annotationId: string }
    | { type: "update_annotation"; annotationId: string; content: string };

export type AnnotationTarget = {
    chapterIndex: number;
    paragraphIndex: number;
    text: string;
};

export type ReadingDiscussContext = {
    chapterTitle: string;
    chapterContent: string;
    annotations: ReadingAnnotation[];
};

function buildReadingBilingualInstruction(enabled: boolean, customPrompt?: string): string {
    return resolveBilingualPrompt(enabled, customPrompt, DEFAULT_READING_BILINGUAL_PROMPT);
}

// ── Resolve assembler input for reading context ──

async function resolveReadingInput(
    characterId: string,
    appTags: string[],
    options: {
        bookTitle: string;
        chapterTitle: string;
        chapterContent: string;
        annotationHistory: string;
        readingSummary?: string;
        history?: ReturnType<typeof loadChatMessages>;
    },
): Promise<{ input: AssemblerInput; apiConfig: ApiConfig | null; preset: PresetConfig | null } | null> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === characterId);
    if (!character) return null;

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "reading");

    const apiConfigId = slot.apiConfigId;
    const presetId = slot.presetId;
    const worldBookIds = slot.worldBookIds || [];
    const regexIds = slot.regexIds || [];
    const userIdentityId = slot.userIdentityId;

    let apiConfig: ApiConfig | null = null;
    if (apiConfigId) {
        apiConfig = loadApiConfigs().find(c => c.id === apiConfigId) ?? null;
    }
    if (!apiConfig) return null;

    const presets = loadPresets();
    let preset: PresetConfig | null = presetId
        ? presets.find(p => p.id === presetId) ?? null
        : null;
    if (!preset) preset = presets.find(p => p.builtIn) ?? presets[0] ?? null;

    const worldBooks = loadWorldBooks().filter(wb => worldBookIds.includes(wb.id));
    const regexes = loadRegexes().filter(r => regexIds.includes(r.id));

    const identities = (await import("./settings-storage")).loadUserIdentities();
    const userIdentity = userIdentityId
        ? identities.find(i => i.id === userIdentityId) || identities[0]
        : identities[0] || null;

    // Memory
    const memConfig = loadMemoryConfig();
    const coreMemories = await retrieveCoreMemoriesForPrompt(characterId, memConfig);
    const longTermMemories = await retrieveMemoriesForPrompt(characterId, options.bookTitle, memConfig);

    // Short-term context
    const { recentBlocks, truncatedHistory, unifiedRecentItems } = prepareShortTermContext(characterId, "chat", {
        history: options.history,
        userName: userIdentity?.name ?? "用户",
    });
    const readingConfig = loadReadingInteractionConfig();

    const input: AssemblerInput = {
        character,
        history: truncatedHistory,
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "reading",
        appTags,
        coreMemories: formatCoreMemories(coreMemories),
        longTermMemories: formatLongTermMemories(longTermMemories),
        recentBlocks,
        unifiedRecentItems,
        bookTitle: options.bookTitle,
        chapterTitle: options.chapterTitle,
        chapterContent: options.chapterContent,
        annotationHistory: options.annotationHistory,
        readingSummary: options.readingSummary,
        chatBilingualInstruction: buildReadingBilingualInstruction(
            readingConfig.bilingualTranslationEnabled === true,
            readingConfig.bilingualTranslationPrompt,
        ),
    };

    return { input, apiConfig, preset };
}

async function callReadingLLM(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    characterName: string,
    regexes?: RegexConfig[],
    appTags?: string[],
    userName?: string,
): Promise<string> {
    return sendLLMRequest(
        config,
        preset,
        messages,
        regexes ?? [],
        { characterName, userName },
        { appId: "reading", appTags },
    );
}

// ── Format helpers ──

function formatChapterContent(paragraphs: string[]): string {
    return paragraphs.map((p, i) => `[${i + 1}] ${p}`).join("\n\n");
}

function formatAnnotationHistory(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "（暂无批注）";
    return annotations.map(a => `[批注:${a.paragraphIndex + 1}] ${a.content}`).join("\n");
}

function formatBatchChapterContent(targets: AnnotationTarget[]): string {
    return targets.map((target, index) => `[${index + 1}] ${target.text}`).join("\n\n");
}

function formatBatchAnnotationHistory(annotations: ReadingAnnotation[], targets: AnnotationTarget[]): string {
    if (annotations.length === 0) return "（暂无批注）";

    const targetIndexMap = new Map<string, number>();
    targets.forEach((target, index) => {
        targetIndexMap.set(`${target.chapterIndex}:${target.paragraphIndex}`, index + 1);
    });

    const lines = annotations.flatMap((annotation) => {
        const relativeIndex = targetIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
        if (!relativeIndex) return [];
        return [`[批注:${relativeIndex}][角色:${annotation.characterName}] ${annotation.content}`];
    });

    return lines.length > 0 ? lines.join("\n") : "（暂无批注）";
}

function formatAnnotationActionContext(annotations: ReadingAnnotation[]): string {
    if (annotations.length === 0) return "（当前范围暂无批注）";
    return annotations
        .map((annotation) => `- ID=${annotation.id} | 段落=${annotation.paragraphIndex + 1} | 角色=${annotation.characterName} | 内容=${annotation.content}`)
        .join("\n");
}

// ── 共读讨论：批注操作解析 ──
// 兼容 char 把【新增/删除/修改批注】动作块放在回复任意位置、甚至与正文
// 挤在同一行（不换行），并容忍格式微偏（全角空格、= 两边空格、全角＝），
// 避免动作块漏解析后原样显示在讨论页正文里（"掉格式、全跑到讨论页"问题）。

// 全文正则：不依赖行首 ^，直接在全文里搜 【...】 动作块。
// 新增/修改的内容延伸到下一个 【 或行尾（取最短匹配，避免吞掉后续正文）。
const ACTION_ADD_GLOBAL_RE = /【\s*新增批注\s*段落\s*[=＝]\s*(\d+)\s*】([^【\n]*(?:\n[^【\n]*)*)/g;
const ACTION_DEL_GLOBAL_RE = /【\s*删除批注\s*ID\s*[=＝]\s*([^\s】]+)\s*】/g;
const ACTION_UPD_GLOBAL_RE = /【\s*修改批注\s*ID\s*[=＝]\s*([^\s】]+)\s*】([^【\n]*(?:\n[^【\n]*)*)/g;

export function parseReadingDiscussResponse(raw: string): {
    reply: string;
    actions: ReadingDiscussAction[];
} {
    const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
    if (!normalized) return { reply: "", actions: [] };

    const actions: ReadingDiscussAction[] = [];
    const spans: Array<[number, number]> = []; // 要从 reply 中删除的 [start, end)

    // 新增批注
    for (const m of normalized.matchAll(ACTION_ADD_GLOBAL_RE)) {
        const paragraphIndex = Number(m[1]) - 1;
        const content = (m[2] || "").trim();
        if (Number.isInteger(paragraphIndex) && paragraphIndex >= 0 && content) {
            actions.push({ type: "add_annotation", paragraphIndex, content });
        }
        if (m.index !== undefined) spans.push([m.index, m.index + m[0].length]);
    }
    // 删除批注
    for (const m of normalized.matchAll(ACTION_DEL_GLOBAL_RE)) {
        actions.push({ type: "delete_annotation", annotationId: m[1] });
        if (m.index !== undefined) spans.push([m.index, m.index + m[0].length]);
    }
    // 修改批注
    for (const m of normalized.matchAll(ACTION_UPD_GLOBAL_RE)) {
        const content = (m[2] || "").trim();
        if (content) {
            actions.push({ type: "update_annotation", annotationId: m[1], content });
        }
        if (m.index !== undefined) spans.push([m.index, m.index + m[0].length]);
    }

    // 从全文中删除所有动作块，剩下的就是正文 reply
    spans.sort((a, b) => a[0] - b[0]);
    let reply = "";
    let cursor = 0;
    for (const [start, end] of spans) {
        reply += normalized.slice(cursor, start);
        cursor = end;
    }
    reply += normalized.slice(cursor);
    reply = reply.replace(/\n{3,}/g, "\n\n").trim();

    return { reply, actions };
}

// ── Public API ──

/** Generate annotations for a chapter. */
export async function generateAnnotations(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<{ annotations: ReadingAnnotation[]; summary: ReadingSummary | null }> {
    return generateAnnotationBatch(
        book,
        chapter.title,
        chapter.paragraphs.map((text, paragraphIndex) => ({
            chapterIndex: chapter.index,
            paragraphIndex,
            text,
        })),
        existingAnnotations,
        characterId,
    );
}

export async function generateAnnotationBatch(
    book: Book,
    batchTitle: string,
    targets: AnnotationTarget[],
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
    readingSummary?: string,
): Promise<{ annotations: ReadingAnnotation[]; summary: ReadingSummary | null }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    if (targets.length === 0) return { annotations: [], summary: null };

    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: batchTitle,
        chapterContent: formatBatchChapterContent(targets),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
        readingSummary,
    });
    if (!resolved) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) throw new Error("API 返回空内容");

    const results: ReadingAnnotation[] = [];

    if (!responseText.includes("[无批注]")) {
        // Parse [批注:N]...[/批注]
        const pattern = /\[批注[:：](\d+)\]([\s\S]*?)\[\/批注\]/g;
        let match;
        while ((match = pattern.exec(responseText)) !== null) {
            const relativeIndex = parseInt(match[1], 10) - 1;
            const content = match[2].trim();
            const target = targets[relativeIndex];
            if (content && target) {
                results.push({
                    id: `ra_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    bookId: book.id,
                    chapterIndex: target.chapterIndex,
                    paragraphIndex: target.paragraphIndex,
                    characterId,
                    characterName: character.name,
                    content,
                    createdAt: new Date().toISOString(),
                });
            }
        }
    }

    // Parse <summary>...</summary>
    let summary: ReadingSummary | null = null;
    const summaryMatch = responseText.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch && summaryMatch[1].trim()) {
        const firstTarget = targets[0];
        const lastTarget = targets[targets.length - 1];
        summary = {
            id: `rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            bookId: book.id,
            chapterIndex: firstTarget.chapterIndex,
            startParagraph: firstTarget.paragraphIndex,
            endParagraph: lastTarget.paragraphIndex,
            content: summaryMatch[1].trim(),
            isDistilled: false,
            createdAt: new Date().toISOString(),
        };
    }

    return { annotations: results, summary };
}

export async function previewReadingAnnotationPrompt(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const targets = chapter.paragraphs.map((text, paragraphIndex) => ({
        chapterIndex: chapter.index,
        paragraphIndex,
        text,
    }));
    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: chapter.title,
        chapterContent: formatBatchChapterContent(targets),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets),
    });
    if (!resolved?.apiConfig) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `阅读:${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "默认预设",
    };
}

export async function previewReadingDiscussPrompt(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const history = loadChatMessages(session.id);
    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        history,
    });
    if (!resolved?.apiConfig) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const llmMessages = assemblePromptPayload(resolved.input);
    return {
        messages: previewMessagesForApi(resolved.apiConfig, resolved.preset, llmMessages),
        characterName: `阅读对话:${character.name}`,
        model: resolved.apiConfig.defaultModel,
        presetName: resolved.preset?.name ?? "默认预设",
    };
}

/** Generate a chat response in reading discuss mode. */
export async function generateReadingChat(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
    readingSummary?: string,
): Promise<string | null> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    const history = loadChatMessages(session.id);

    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations),
        readingSummary,
        history,
    });
    if (!resolved) return null;

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    const responseText = await callReadingLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return null;

    // Return raw text — caller is responsible for parsing and saving (like chat-room's splitAndSaveAIMessages)
    return responseText;
}

// ── Reading Summary (情节摘要) ──

/** 格式化摘要文本供注入预设模板。 */
export function formatReadingSummary(summariesToInject: ReadingSummary[]): string {
    if (summariesToInject.length === 0) return "";
    const lines = summariesToInject.map(s => {
        if (s.isDistilled) return `【前情提要（提炼）】${s.content}`;
        return `【第${s.chapterIndex + 1}章 · 段落${s.startParagraph + 1}-${s.endParagraph + 1}】${s.content}`;
    });
    return `<reading_summary>\n以下是之前阅读内容的情节摘要，帮助你回忆已读过的内容：\n${lines.join("\n")}\n</reading_summary>\n`;
}

/**
 * 按当前位置过滤应注入的摘要：
 * - 普通摘要：endParagraph 在当前位置之前（同章）或 chapterIndex 在当前章之前（跨章）
 * - 提炼摘要：distilledUpTo < 当前位置时注入（读到提炼覆盖范围之后才注入）
 *   提炼位置之前的普通摘要不注入（已被提炼覆盖），但保留在存储中不删除
 */
export function getSummariesForInjection(
    allSummaries: ReadingSummary[],
    chapterIndex: number,
    paragraphIndex: number,
): ReadingSummary[] {
    const currentPos = encodeReadingPosition(chapterIndex, paragraphIndex);
    const result: ReadingSummary[] = [];

    for (const s of allSummaries) {
        if (s.isDistilled) {
            // 提炼摘要：只在当前位置超过其覆盖范围时注入
            if (s.distilledUpTo !== undefined && currentPos > s.distilledUpTo) {
                result.push(s);
            }
        } else {
            // 普通摘要：检查是否在当前位置之前
            const summaryPos = encodeReadingPosition(s.chapterIndex, s.endParagraph);
            if (summaryPos < currentPos) {
                // 检查是否被某个提炼摘要覆盖（被覆盖的不注入）
                const coveredByDistilled = allSummaries.some(
                    d => d.isDistilled
                        && d.distilledUpTo !== undefined
                        && d.distilledUpTo >= summaryPos
                        && currentPos > d.distilledUpTo,
                );
                if (!coveredByDistilled) result.push(s);
            }
        }
    }

    return result;
}

/** 当摘要总字数超过上限时，提炼为当前的 1/3。保留旧摘要不删除。 */
export async function distillSummariesIfNeeded(
    bookId: string,
    characterId: string,
    maxChars: number,
): Promise<ReadingSummary | null> {
    const summaries = await loadSummaries(bookId);
    const totalChars = getTotalSummaryChars(summaries);
    if (totalChars <= maxChars) return null;

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "reading");
    const apiConfigId = slot.apiConfigId;
    if (!apiConfigId) return null;
    const apiConfig = loadApiConfigs().find(c => c.id === apiConfigId);
    if (!apiConfig) return null;

    const targetChars = Math.floor(totalChars / 3);
    const summaryText = summaries.map(s => {
        if (s.isDistilled) return s.content;
        return `【第${s.chapterIndex + 1}章】${s.content}`;
    }).join("\n");

    const prompt = `以下是一部长篇小说的阅读摘要记录，按时间顺序排列。请将这些摘要提炼为一份更简洁的版本，总字数约${targetChars}字，保留最重要的情节转折和人物发展，删去次要细节。只输出提炼后的摘要文本，不要输出任何其他内容：\n\n${summaryText}`;

    try {
        const result = await simpleLLMCall(apiConfig, [
            { role: "user", content: prompt },
        ], { label: "阅读摘要·提炼" });

        if (!result.content || result.content.trim().length === 0) return null;

        // 提炼摘要覆盖到最后一条摘要的位置
        const lastSummary = summaries[summaries.length - 1];
        const distilledUpTo = lastSummary
            ? encodeReadingPosition(lastSummary.chapterIndex, lastSummary.endParagraph)
            : 0;

        const distilled: ReadingSummary = {
            id: `rs_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            bookId,
            chapterIndex: -1,
            startParagraph: -1,
            endParagraph: lastSummary?.endParagraph ?? -1,
            content: result.content.trim(),
            isDistilled: true,
            distilledUpTo,
            createdAt: new Date().toISOString(),
        };

        await saveSummary(distilled);
        return distilled;
    } catch (err) {
        console.warn("[Reading] Summary distillation failed:", err);
        return null;
    }
}
