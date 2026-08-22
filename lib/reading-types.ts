// lib/reading-types.ts — Type definitions for the Reading (阅读) feature.

export type Book = {
    id: string;
    title: string;
    author?: string;
    format: "txt" | "epub" | "pdf";
    totalChapters: number;
    createdAt: string;
};

export type BookChapter = {
    id: string;
    bookId: string;
    index: number;
    title: string;
    paragraphs: string[];
    /** PDF only: synthetic page chunk start (1-based) */
    pageStart?: number;
    /** PDF only: synthetic page chunk end (1-based) */
    pageEnd?: number;
    /** PDF only: page number (1-based) for each paragraph */
    paragraphPages?: number[];
    /** PDF only: vertical position (0-1 ratio) within page for each paragraph */
    paragraphYPositions?: number[];
};

export type ReadingProgress = {
    bookId: string;
    chapterIndex: number;
    scrollPosition: number;
    companionCharacterId?: string;
    progressFraction?: number;
    progressCurrent?: number;
    progressTotal?: number;
    progressScope?: "book" | "chapter";
    /** 保存进度时的阅读模式；滚动模式下 scrollPosition 存的是章节内滚动比例(0-1) */
    readingMode?: "page" | "scroll";
    lastReadAt: string;
};

export type ReadingAnnotation = {
    id: string;
    bookId: string;
    chapterIndex: number;
    paragraphIndex: number;
    characterId: string;
    characterName: string;
    content: string;
    createdAt: string;
};

/** 阅读摘要：批注时一并生成的情节概要，注入后续批注/讨论上下文以防失忆。 */
export type ReadingSummary = {
    id: string;
    bookId: string;
    /** 章节序号；提炼摘要覆盖多章时为 -1 */
    chapterIndex: number;
    /** 本批起始段落序号 */
    startParagraph: number;
    /** 本批结束段落序号 */
    endParagraph: number;
    /** ~150 字情节摘要 */
    content: string;
    /** 是否为提炼后的摘要 */
    isDistilled: boolean;
    /** 提炼摘要覆盖到的最后位置（chapterIndex * 100000 + endParagraph）；仅 isDistilled 时有值。
     *  注入条件：当前位置 > distilledUpTo 时才注入提炼摘要。
     *  提炼位置之前的普通摘要不注入（被提炼覆盖），但保留在存储中。 */
    distilledUpTo?: number;
    createdAt: string;
};
