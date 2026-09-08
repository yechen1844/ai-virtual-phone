// lib/movie-types.ts — Type definitions for the Movie (观影) feature.

export type Movie = {
    id: string;
    title: string;
    /** 简介（用户填写或留空） */
    intro?: string;
    /** 视频时长（秒），导入时从 <video> metadata 读取 */
    durationSeconds?: number;
    createdAt: string;
};

/** 幕：起承转合叙事骨架，由场聚合（LLM 一次产出），仅用于结构展示 */
export type MovieAct = {
    id: string;
    movieId: string;
    index: number;
    /** 如「第一幕·起」 */
    title: string;
};

/** 场：实际注入单元（3~6 分钟），物理边界候选 + LLM 语义归并的产物 */
export type MovieScene = {
    id: string;
    movieId: string;
    /** 全局顺序 0..N */
    index: number;
    /** 所属幕序号 */
    actIndex: number;
    title: string;
    startSeconds: number;
    endSeconds: number;
    /** 该场情节概括（LLM 产出） */
    summary: string;
    /** 该场完整字幕文本（分段时切好存储，观影时不再实时切） */
    subtitleText: string;
};

/** 预抽帧：分段时从视频离线抽取的缩略图（感知哈希去重后入库） */
export type MovieFrame = {
    id: string;
    movieId: string;
    sceneId: string;
    timeSeconds: number;
    /** JPEG 缩略图 ~50KB */
    thumbnail: Blob;
    /** 16x16 感知哈希（去重用，调试可读） */
    phash?: string;
};

export type WatchProgress = {
    movieId: string;
    positionSeconds: number;
    companionCharacterId?: string;
    /** 是否已完成分段 */
    segmented: boolean;
    lastWatchAt: string;
};

export type MovieDanmaku = {
    id: string;
    movieId: string;
    /** 弹幕出现时间点（秒） */
    timeSeconds: number;
    characterId: string;
    characterName: string;
    /** 弹幕短评（≤30字） */
    content: string;
    createdAt: string;
};

/** 统一字幕时间轴条目（SRT/VTT/ASS 解析产物） */
export type SubtitleCue = {
    startSeconds: number;
    endSeconds: number;
    text: string;
};

/** LLM 分段响应中的一场 */
export type MovieSceneDraft = {
    startSeconds: number;
    endSeconds: number;
    title: string;
    summary: string;
    actIndex: number;
};

/** LLM 分段响应中的一幕（由场聚合） */
export type MovieSegmentationResult = {
    acts: { index: number; title: string }[];
    scenes: MovieSceneDraft[];
};

/** 讨论上下文：防剧透门控后的注入材料 */
export type MovieDiscussContext = {
    sceneTitle: string;
    sceneSummary: string;
    /** 当前场字幕滑动窗口（向前已播~2000字符 + 向后预取~1000字符） */
    sceneSubtitleWindow: string;
    /** 前情提要（已看场次摘要，含提炼标记），已格式化 */
    movieSummary: string;
    /** 帧提示文本（当前场关键帧时间点说明，帧图另行以多模态 parts 附带） */
    frameHint: string;
    /** 当前场预抽帧（data URL，JPEG） */
    frameDataUrls: string[];
    /** 当前播放位置（秒） */
    positionSeconds: number;
};
