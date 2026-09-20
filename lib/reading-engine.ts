// lib/reading-engine.ts — LLM integration for Reading feature.
// All prompts go through the preset system via assemblePromptPayload. No extra message push.

import type { Book, BookChapter, ReadingAnnotation, ReadingSummary, ReadingEssay, ReadingNote } from "./reading-types";
import type { ChatSession, ChatMessage } from "./chat-storage";
import { loadChatMessages, pushChatMessage, isReadingNoteMessage } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadReadingInteractionConfig, loadSummaries, saveSummary, getTotalSummaryChars, encodeReadingPosition, loadEssays, saveEssay, loadNotes, saveNote } from "./reading-storage";
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
import { trimBilingualForFeed, type TranslationFeedMode } from "./bilingual-text";
import { recordCharacterActivity } from "./complex-memory/guard";

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
    /** 焦点章节（当前阅读中心所在章），供摘要注入与正文上下文保持同一位置来源 */
    focusChapterIndex: number;
    /** 焦点窗口首段（当前阅读中心段落） */
    focusStartParagraph: number;
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
        readingEssay?: string;
        readingNote?: string;
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
        readingEssay: options.readingEssay,
        readingNote: options.readingNote,
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

/**
 * 读取阅读链路用的聊天历史：剔除「读书笔记」消息。
 * 笔记已由 getLatestNoteForInjection 显式注入最新一篇；若历史里再带一份，
 * 既会重复出现，也会把过往多篇笔记一起塞进上下文导致膨胀。
 * （记忆管线不受影响：时间线投影直接读存储，笔记仍会进入短期/长期记忆。）
 */
export function loadReadingHistory(sessionId: string): ChatMessage[] {
    return loadChatMessages(sessionId).filter(msg => !isReadingNoteMessage(msg));
}

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

function formatBatchAnnotationHistory(
    annotations: ReadingAnnotation[],
    targets: AnnotationTarget[],
    translationFeedMode?: TranslationFeedMode,
): string {
    if (annotations.length === 0) return "（暂无批注）";

    const targetIndexMap = new Map<string, number>();
    targets.forEach((target, index) => {
        targetIndexMap.set(`${target.chapterIndex}:${target.paragraphIndex}`, index + 1);
    });

    const lines = annotations.flatMap((annotation) => {
        const relativeIndex = targetIndexMap.get(`${annotation.chapterIndex}:${annotation.paragraphIndex}`);
        if (!relativeIndex) return [];
        // 只裁内容字段：整段裁会把「[批注:N][角色:x]」这类框架也交给双语解析，破坏行结构
        const content = trimBilingualForFeed(annotation.content, translationFeedMode);
        return [`[批注:${relativeIndex}][角色:${annotation.characterName}] ${content}`];
    });

    return lines.length > 0 ? lines.join("\n") : "（暂无批注）";
}

function formatAnnotationActionContext(
    annotations: ReadingAnnotation[],
    translationFeedMode?: TranslationFeedMode,
): string {
    if (annotations.length === 0) return "（当前范围暂无批注）";
    return annotations
        .map((annotation) => {
            // 只裁「内容」字段：这一行的 | 是字段分隔符，整行交给双语解析会把结构搅乱
            const content = trimBilingualForFeed(annotation.content, translationFeedMode);
            return `- ID=${annotation.id} | 段落=${annotation.paragraphIndex + 1} | 角色=${annotation.characterName} | 内容=${content}`;
        })
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
): Promise<{ annotations: ReadingAnnotation[]; summary: ReadingSummary | null; essay: ReadingEssay | null }> {
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
    /** 该角色的主聊天历史（含共读讨论消息），让批注理解用户近况；由调用方按开关决定是否传入 */
    history?: ChatMessage[],
    /** 已注入格式的随笔文本（含标签），由调用方按当前位置过滤后传入 */
    readingEssay?: string,
    /** 已注入格式的最新读书笔记文本（含标签） */
    readingNote?: string,
    /** 会话的双语投喂模式：批注历史按此只留原文/译文（未传或 both 时原样） */
    translationFeedMode?: TranslationFeedMode,
): Promise<{ annotations: ReadingAnnotation[]; summary: ReadingSummary | null; essay: ReadingEssay | null }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");
    if (targets.length === 0) return { annotations: [], summary: null, essay: null };

    const resolved = await resolveReadingInput(characterId, ["reading", "annotate"], {
        bookTitle: book.title,
        chapterTitle: batchTitle,
        chapterContent: formatBatchChapterContent(targets),
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets, translationFeedMode),
        readingSummary,
        history,
        readingEssay,
        readingNote,
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

    // Parse <essay>...</essay>（读书随笔：两句话、第一人称、承载当时情绪）
    let essay: ReadingEssay | null = null;
    const essayMatch = responseText.match(/<essay>([\s\S]*?)<\/essay>/i);
    if (essayMatch && essayMatch[1].trim()) {
        const firstTarget = targets[0];
        const lastTarget = targets[targets.length - 1];
        essay = {
            id: `re_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            bookId: book.id,
            characterId,
            characterName: character.name,
            chapterIndex: firstTarget.chapterIndex,
            startParagraph: firstTarget.paragraphIndex,
            endParagraph: lastTarget.paragraphIndex,
            // 前缀角色名：便于 char 之后以第一人称认出"这是我自己写的随笔"
            content: `${character.name}的随笔：${essayMatch[1].trim()}`,
            isDistilled: false,
            createdAt: new Date().toISOString(),
        };
    }

    return { annotations: results, summary, essay };
}

export async function previewReadingAnnotationPrompt(
    book: Book,
    chapter: BookChapter,
    existingAnnotations: ReadingAnnotation[],
    characterId: string,
    translationFeedMode?: TranslationFeedMode,
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
        annotationHistory: formatBatchAnnotationHistory(existingAnnotations, targets, translationFeedMode),
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

    const history = loadReadingHistory(session.id);
    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations, session.translationFeedMode),
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
    readingEssay?: string,
    readingNote?: string,
): Promise<string | null> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    const history = loadReadingHistory(session.id);

    const resolved = await resolveReadingInput(characterId, ["reading", "discuss"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations, session.translationFeedMode),
        readingSummary,
        readingEssay,
        readingNote,
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

    // 阅读共读也接入复杂记忆活动计数（与聊天/朋友圈等一致，避免漏计导致事件生成不触发）
    recordCharacterActivity(characterId, character.name, 1);

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
 * 按当前位置动态过滤应注入的摘要（全部以当前阅读位置判定）：
 * - 提炼摘要：多条时只注入「当前位置已读过的提炼摘要中覆盖最远的一条」——即一条从开头到最新提炼点的
 *   总前情提要（每次提炼都以更早的提炼为源，内容已包含它们，不重复注入）；
 *   最新提炼点尚未读到时不注入（其内容含未读情节，防剧透），改由已读部分的细粒度旧摘要回退补位
 * - 普通摘要：endParagraph 不晚于当前位置即注入（摘要描述的是已读情节，跳读/回读时提供细粒度前情）；
 *   已被上面注入的提炼摘要覆盖（位置 ≤ 其 distilledUpTo）的不再重复注入
 * - 提炼时 distilledUpTo 会截断到当时阅读位置（见 distillSummariesIfNeeded），避免 prefetch 预生成的
 *   超前摘要把覆盖范围推到未读区域、导致提炼摘要长期无法接管
 */
export function getSummariesForInjection(
    allSummaries: ReadingSummary[],
    chapterIndex: number,
    paragraphIndex: number,
    options?: { alwaysLatestDistilled?: boolean },
): ReadingSummary[] {
    const currentPos = encodeReadingPosition(chapterIndex, paragraphIndex);
    const result: ReadingSummary[] = [];

    // 确定当前生效的那一条提炼摘要（永远最多一条，呈现为「一条从开头到提炼点的总前情提要」）：
    // - alwaysLatestDistilled 开启：无视阅读位置，始终取覆盖最远（最新最全面）的一条——回读时 char 仍记得全部已看情节
    // - 默认（关闭）：只从「提炼点已被读过」的提炼摘要中取覆盖最远的一条；最新提炼点尚未读到时不注入（防剧透），
    //   由已读部分的细粒度旧摘要回退补位
    const distilledCandidates = allSummaries.filter(s => s.isDistilled && typeof s.distilledUpTo === "number");
    let activeDistilled: ReadingSummary | null = null;
    if (distilledCandidates.length > 0) {
        const sorted = [...distilledCandidates].sort((a, b) => (b.distilledUpTo ?? 0) - (a.distilledUpTo ?? 0));
        activeDistilled = options?.alwaysLatestDistilled === true
            ? sorted[0]
            : sorted.find(s => currentPos > (s.distilledUpTo ?? 0)) ?? null;
    }

    for (const s of allSummaries) {
        if (s.isDistilled) {
            if (activeDistilled && s.id === activeDistilled.id) {
                result.push(s);
            }
        } else {
            // 普通摘要：检查是否不晚于当前位置（摘要末段=当前段也算已读，摘要描述的是已读内容）
            const summaryPos = encodeReadingPosition(s.chapterIndex, s.endParagraph);
            if (summaryPos > currentPos) continue;
            // 已被当前注入的提炼摘要覆盖时不再注入，避免同一情节双份出现
            const coveredByDistilled = activeDistilled !== null
                && (activeDistilled.distilledUpTo ?? 0) >= summaryPos;
            if (!coveredByDistilled) result.push(s);
        }
    }

    return result;
}

/**
 * 计算"最远提炼覆盖位置"：所有提炼摘要把位置 ≤ distilledUpTo 的普通摘要覆盖了，
 * 覆盖范围内的普通摘要在注入时不显示、也不计入下一轮提炼源（但保留在存储中不删）。
 */
function getFarthestDistilledCoverage(allSummaries: ReadingSummary[]): number {
    let max = 0;
    for (const s of allSummaries) {
        if (s.isDistilled && typeof s.distilledUpTo === "number" && s.distilledUpTo > max) {
            max = s.distilledUpTo;
        }
    }
    return max;
}

/**
 * 返回"应参与下一轮提炼"的摘要：= 最新一条提炼摘要 + 所有未被既有提炼覆盖的普通摘要。
 * 这样提炼后的旧普通摘要不会反复计入字数、也不会被重复提炼（避免越堆越多），
 * 但它们始终保留在存储中，供"全部摘要"标签与云备份查看。
 */
export function getDistillableSummaries(allSummaries: ReadingSummary[]): ReadingSummary[] {
    const coverage = getFarthestDistilledCoverage(allSummaries);
    const distilled = allSummaries.filter(s => s.isDistilled);
    // 提炼摘要若有多条，只取最新一条（前面更早的提炼已被后续提炼覆盖）
    const latestDistilled = distilled.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const uncoveredNormal = allSummaries.filter(s =>
        !s.isDistilled
        && encodeReadingPosition(s.chapterIndex, s.endParagraph) > coverage,
    );
    const out: ReadingSummary[] = [];
    if (latestDistilled) out.push(latestDistilled);
    out.push(...uncoveredNormal);
    return out;
}

/** 待提炼摘要的总字数（仅统计可提炼部分，不含已被覆盖的旧普通摘要）。 */
export function getDistillableSummaryChars(allSummaries: ReadingSummary[]): number {
    return getDistillableSummaries(allSummaries).reduce((sum, s) => sum + s.content.length, 0);
}

/**
 * 当摘要总字数超过上限时，提炼为当前的 1/3。保留旧摘要不删除。
 * - 提炼失败（空返回/异常）会按 attempt 重试；重试仍失败只记 warn、返回 null，绝不删除任何已生成摘要。
 * - 传 { force: true } 可忽略字数上限强制提炼（供「立即提炼」使用）。
 */
export async function distillSummariesIfNeeded(
    bookId: string,
    characterId: string,
    maxChars: number,
    options?: { force?: boolean; currentReadingPos?: number },
): Promise<ReadingSummary | null> {
    const force = options?.force === true;
    const summaries = await loadSummaries(bookId);
    // 只对"可提炼摘要"（最新提炼 + 未被覆盖的普通摘要）做源与阈值判断，
    // 避免提炼后被覆盖的旧摘要反复计入、导致每加一点就重复提炼。
    const distillable = getDistillableSummaries(summaries);
    const totalChars = getDistillableSummaryChars(summaries);
    if (!force && totalChars <= maxChars) return null;
    if (distillable.length === 0) return null;

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "reading");
    const apiConfigId = slot.apiConfigId;
    if (!apiConfigId) return null;
    const apiConfig = loadApiConfigs().find(c => c.id === apiConfigId);
    if (!apiConfig) return null;

    const targetChars = Math.max(1, Math.floor((force ? Math.max(totalChars, 1) : totalChars) / 3));
    const summaryText = distillable.map(s => {
        if (s.isDistilled) return s.content;
        return `【第${s.chapterIndex + 1}章】${s.content}`;
    }).join("\n");

    const prompt = `以下是一部长篇小说的阅读摘要记录，按时间顺序排列。请将这些摘要提炼为一份更简洁的版本，总字数约${targetChars}字，保留最重要的情节转折和人物发展，删去次要细节。只输出提炼后的摘要文本，不要输出任何其他内容：\n\n${summaryText}`;

    // 提炼失败重试：最多 MAX_ATTEMPTS 次。失败不丢旧摘要，但会返回 null 让调用方决定是否提示重试。
    const MAX_ATTEMPTS = 2;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
            const result = await simpleLLMCall(apiConfig, [
                { role: "user", content: prompt },
            ], { label: "阅读摘要·提炼" });

            if (!result.content || result.content.trim().length === 0) {
                lastError = new Error("提炼返回空内容");
                if (attempt < MAX_ATTEMPTS - 1) continue;
                break;
            }

            // 提炼摘要覆盖到最后一条可提炼摘要的位置；但 prefetch 预生成的超前摘要位置会跑到阅读位置
            // 之前（未来段），若不截断，覆盖范围会常态性大于阅读位置，导致提炼摘要长期无法接管注入。
            // 因此把覆盖范围截断到当前阅读位置：覆盖范围内全是已读情节，注入不剧透。
            const lastSummary = distillable[distillable.length - 1];
            const lastSummaryPos = lastSummary
                ? encodeReadingPosition(lastSummary.chapterIndex, lastSummary.endParagraph)
                : 0;
            const distilledUpTo = typeof options?.currentReadingPos === "number"
                ? Math.min(lastSummaryPos, options.currentReadingPos)
                : lastSummaryPos;

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
            lastError = err;
            if (attempt < MAX_ATTEMPTS - 1) continue;
            break;
        }
    }
    // 重试完仍失败：只 warn 上报，绝不删除已生成摘要。
    console.warn("[Reading] Summary distillation failed after retries:", lastError);
    return null;
}

// ── Reading Essay（读书随笔：与摘要同批生成，按角色绑定，承载当时情绪） ──

/** 格式化随笔文本供注入预设模板。 */
export function formatReadingEssay(essays: ReadingEssay[], translationFeedMode?: TranslationFeedMode): string {
    if (essays.length === 0) return "";
    const lines = essays.map(e => {
        // 只裁正文：前缀是结构标记，不能被当成双语内容
        const content = trimBilingualForFeed(e.content, translationFeedMode);
        if (e.isDistilled) return `【随笔·提炼】${content}`;
        return `【第${e.chapterIndex + 1}章 · 段落${e.startParagraph + 1}-${e.endParagraph + 1}】${content}`;
    });
    return `<reading_essay>\n以下是{{char}}之前读这本书时留下的随笔，保留着当时的情绪（供你保持情感连续）：\n${lines.join("\n")}\n</reading_essay>\n`;
}

/**
 * 按当前位置动态过滤应注入的随笔（与摘要同构）：
 * - 提炼随笔：多条时只注入「当前位置已读过的提炼随笔中覆盖最远的一条」，其余不注入
 * - 普通随笔：endParagraph 不晚于当前位置即注入；已被当前生效的提炼随笔覆盖的不重复注入
 * - options.alwaysLatestDistilled：开启「回读时仍注入最新前情提要」时，提炼随笔无视位置始终取覆盖最远一条
 */
export function getEssaysForInjection(
    allEssays: ReadingEssay[],
    chapterIndex: number,
    paragraphIndex: number,
    options?: { alwaysLatestDistilled?: boolean },
): ReadingEssay[] {
    const currentPos = encodeReadingPosition(chapterIndex, paragraphIndex);
    const result: ReadingEssay[] = [];

    const distilledCandidates = allEssays.filter(e => e.isDistilled && typeof e.distilledUpTo === "number");
    let activeDistilled: ReadingEssay | null = null;
    if (distilledCandidates.length > 0) {
        const sorted = [...distilledCandidates].sort((a, b) => (b.distilledUpTo ?? 0) - (a.distilledUpTo ?? 0));
        activeDistilled = options?.alwaysLatestDistilled === true
            ? sorted[0]
            : sorted.find(e => currentPos > (e.distilledUpTo ?? 0)) ?? null;
    }

    for (const e of allEssays) {
        if (e.isDistilled) {
            if (activeDistilled && e.id === activeDistilled.id) result.push(e);
        } else {
            const essayPos = encodeReadingPosition(e.chapterIndex, e.endParagraph);
            if (essayPos > currentPos) continue;
            const covered = activeDistilled !== null && (activeDistilled.distilledUpTo ?? 0) >= essayPos;
            if (!covered) result.push(e);
        }
    }

    return result;
}

function getFarthestEssayDistilledCoverage(allEssays: ReadingEssay[]): number {
    let max = 0;
    for (const e of allEssays) {
        if (e.isDistilled && typeof e.distilledUpTo === "number" && e.distilledUpTo > max) max = e.distilledUpTo;
    }
    return max;
}

/** 应参与下一轮提炼的随笔：最新一条提炼随笔 + 所有未被既有提炼覆盖的普通随笔。 */
export function getDistillableEssays(allEssays: ReadingEssay[]): ReadingEssay[] {
    const coverage = getFarthestEssayDistilledCoverage(allEssays);
    const distilled = allEssays.filter(e => e.isDistilled);
    const latestDistilled = distilled.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const uncoveredNormal = allEssays.filter(e =>
        !e.isDistilled
        && encodeReadingPosition(e.chapterIndex, e.endParagraph) > coverage,
    );
    const out: ReadingEssay[] = [];
    if (latestDistilled) out.push(latestDistilled);
    out.push(...uncoveredNormal);
    return out;
}

/** 待提炼随笔的总字数（仅统计可提炼部分）。 */
export function getDistillableEssayChars(allEssays: ReadingEssay[]): number {
    return getDistillableEssays(allEssays).reduce((sum, e) => sum + e.content.length, 0);
}

/**
 * 随笔超过上限时提炼为当前的 1/3，保留旧随笔不删除。
 * 覆盖范围同样截断到当前阅读位置（与摘要一致，避免预生成超前导致提炼长期无法接管）。
 *
 * 与摘要提炼的关键差异：随笔是 char 自己写下的心情记录，提炼时必须带着它的人设、记忆与
 * 阅读语境一起交给模型，否则压缩出来的文本会丢掉"我当时是谁、和谁一起读、心情怎样"。
 * 所以这里走与批注/讨论同一条预设管线（人设与记忆由 marker 条目自动注入），而不是裸调用；
 * 摘要只记录客观情节，仍用裸调用。
 */
export async function distillEssaysIfNeeded(
    bookId: string,
    characterId: string,
    maxChars: number,
    options?: {
        force?: boolean;
        currentReadingPos?: number;
        /** 当前书籍标题，供提炼时还原阅读语境 */
        bookTitle?: string;
        /** 该角色的聊天历史（含共读讨论），让提炼理解"当时和谁在一起读" */
        history?: ChatMessage[];
    },
): Promise<ReadingEssay | null> {
    const force = options?.force === true;
    const essays = await loadEssays(bookId, characterId);
    const distillable = getDistillableEssays(essays);
    const totalChars = getDistillableEssayChars(essays);
    if (!force && totalChars <= maxChars) return null;
    if (distillable.length === 0) return null;

    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    // appTags 里带上 essay_distill：它匹配不到任何既有条目，从而避免把批注/讨论/笔记三个
    // 条目的指令一起注入；人设与记忆来自 marker 条目（不受 tags 筛选），会照常带上。
    const resolved = await resolveReadingInput(characterId, ["reading", "essay_distill"], {
        bookTitle: options?.bookTitle ?? "",
        chapterTitle: "",
        chapterContent: "",
        annotationHistory: "",
        history: options?.history,
    });
    if (!resolved) return null;
    const { input, apiConfig, preset } = resolved;

    const targetChars = Math.max(1, Math.floor((force ? Math.max(totalChars, 1) : totalChars) / 3));
    const essayText = distillable.map(e => {
        if (e.isDistilled) return e.content;
        return `【第${e.chapterIndex + 1}章】${e.content}`;
    }).join("\n");

    // 提炼要求放在预设条目 reading_essay_distill 里（用户可在预设管理里改），
    // 但绑定复制出来的旧预设时该条目不存在，模型会收不到任何要求，
    // 所以这里检测一次：条目缺失就用 user 消息兜底。
    const presetHasDistillEntry = (preset?.prompts ?? []).some(
        p => p.identifier === "reading_essay_distill" && p.enabled !== false,
    );
    const instruction = [
        ...(presetHasDistillEntry
            ? [`请把下面这些读书随笔提炼为更简短的版本，总字数控制在约${targetChars}字。`]
            : [
                "以下是你在阅读过程中陆续写下的读书随笔，按时间顺序排列，都是你的第一人称心情记录。",
                `请把它们提炼为一份更简短的版本，总字数约${targetChars}字。`,
                "要求：",
                "- 用你原本的口吻来写，保留情绪与感受的连贯性和重要变化，删去重复",
                "- 不要写成第三人称的情节梗概，也不要丢掉当时的情绪",
                "- 保留一起读书的感受，不要写成独自一人的记录",
                "- 只输出提炼后的文本，不要任何解释、标题或前后缀",
            ]),
        "",
        essayText,
    ].join("\n");

    const llmMessages = [...assemblePromptPayload(input), { role: "user" as const, content: instruction }];

    const MAX_ATTEMPTS = 2;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
            const responseText = await callReadingLLM(
                apiConfig!,
                preset,
                llmMessages,
                character.name,
                input.regexes,
                input.appTags,
                input.userIdentity?.name,
            );

            if (!responseText || !responseText.trim()) {
                lastError = new Error("提炼返回空内容");
                if (attempt < MAX_ATTEMPTS - 1) continue;
                break;
            }

            const lastEssay = distillable[distillable.length - 1];
            const lastEssayPos = lastEssay
                ? encodeReadingPosition(lastEssay.chapterIndex, lastEssay.endParagraph)
                : 0;
            const distilledUpTo = typeof options?.currentReadingPos === "number"
                ? Math.min(lastEssayPos, options.currentReadingPos)
                : lastEssayPos;

            const distilled: ReadingEssay = {
                id: `re_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                bookId,
                characterId,
                characterName: character.name,
                chapterIndex: -1,
                startParagraph: -1,
                endParagraph: lastEssay?.endParagraph ?? -1,
                content: responseText.trim(),
                isDistilled: true,
                distilledUpTo,
                createdAt: new Date().toISOString(),
            };

            await saveEssay(distilled);
            return distilled;
        } catch (err) {
            lastError = err;
            if (attempt < MAX_ATTEMPTS - 1) continue;
            break;
        }
    }
    console.warn("[Reading] Essay distillation failed after retries:", lastError);
    return null;
}

// ── Reading Note（读书笔记：每次阅读会话一篇，只注入最新一篇） ──

/** 格式化读书笔记供注入预设模板（只注入传入的那一篇）。 */
export function formatReadingNote(note: ReadingNote | null, translationFeedMode?: TranslationFeedMode): string {
    if (!note) return "";
    return `<reading_note>\n${trimBilingualForFeed(note.content, translationFeedMode)}\n</reading_note>\n`;
}

/**
 * 选出应注入的那一篇笔记：只取最新一篇。
 * - 默认：该笔记的覆盖起点必须已被读过（当前位置不早于其起点），否则视为"还没读到"不注入
 * - options.alwaysLatestDistilled（回读开关）：无视位置，始终注入最新一篇，让 char 记得上次读到哪
 */
export function getLatestNoteForInjection(
    allNotes: ReadingNote[],
    chapterIndex: number,
    paragraphIndex: number,
    options?: { alwaysLatestDistilled?: boolean },
): ReadingNote | null {
    if (allNotes.length === 0) return null;
    const sorted = [...allNotes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const latest = sorted[0];
    if (options?.alwaysLatestDistilled === true) return latest;
    const currentPos = encodeReadingPosition(chapterIndex, paragraphIndex);
    const startPos = encodeReadingPosition(latest.startChapterIndex, latest.startParagraph);
    return currentPos >= startPos ? latest : null;
}

/**
 * 生成一篇读书笔记（供共读窗按钮手动触发）。
 * 返回笔记正文（第一人称，开头带「角色名的读书笔记：」）；失败返回 null。
 */
export async function generateReadingNote(
    session: ChatSession,
    book: Book,
    context: ReadingDiscussContext,
    characterId: string,
    readingSummary?: string,
    readingEssay?: string,
    readingNote?: string,
): Promise<string | null> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    const history = loadReadingHistory(session.id);

    const resolved = await resolveReadingInput(characterId, ["reading", "note"], {
        bookTitle: book.title,
        chapterTitle: context.chapterTitle,
        chapterContent: context.chapterContent,
        annotationHistory: formatAnnotationActionContext(context.annotations, session.translationFeedMode),
        readingSummary,
        readingEssay,
        readingNote,
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

    // 统一加前缀：让 char 之后以第一人称读到能认出「这是我自己写的」
    const body = responseText.trim().replace(/^#*\s*/, "");
    return `${character.name}的读书笔记：${body}`;
}
