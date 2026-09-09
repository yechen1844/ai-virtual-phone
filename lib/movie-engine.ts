// lib/movie-engine.ts — LLM integration for Movie (观影) feature.
// 架构严格照抄 reading-engine：预设条目走 assemblePromptPayload、记忆走统一水位线。
// 讨论消息存 char 主会话（origin: "movie_discuss"），隔离靠三层过滤，不搞独立 contactId。

import type { Movie, MovieAct, MovieScene, MovieFrame, SubtitleCue, MovieSegmentationResult, MovieDiscussContext, MovieDanmaku } from "./movie-types";
import type { ChatSession } from "./chat-storage";
import { loadChatMessages, pushChatMessage, createOrGetSession } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { saveSegmentation, saveFrames, saveDanmaku, loadScenes, loadFrames } from "./movie-storage";
import { buildSubtitleWindow, sliceSubtitleText } from "./movie-parser";
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
import { sendLLMRequest } from "./chat-engine";
import { recordCharacterActivity } from "./complex-memory/guard";
import { DEFAULT_MOVIE_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";

// ── Resolve assembler input for movie context（照抄 resolveReadingInput）──

async function resolveMovieInput(
    characterId: string,
    appTags: string[],
    options: {
        movieTitle: string;
        sceneTitle?: string;
        sceneSummary?: string;
        movieSummary?: string;
        sceneSubtitleWindow?: string;
        frameHint?: string;
        sceneBoundaries?: string;
        moviePosition?: string;
        bilingualInstruction?: string;
        history?: ReturnType<typeof loadChatMessages>;
    },
): Promise<{ input: AssemblerInput; apiConfig: ApiConfig | null; preset: PresetConfig | null } | null> {
    const chars = loadCharacters();
    const character = chars.find(c => c.id === characterId);
    if (!character) return null;

    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "movie");

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

    // Memory：核心记忆 + 长期记忆相关性召回（阅读用书名作 query，观影用片名+当前场摘要，更精准）
    const memConfig = loadMemoryConfig();
    const coreMemories = await retrieveCoreMemoriesForPrompt(characterId, memConfig);
    const recallQuery = [options.movieTitle, options.sceneSummary].filter(Boolean).join(" ");
    const longTermMemories = await retrieveMemoriesForPrompt(characterId, recallQuery, memConfig);

    // Short-term context（含观影边界条目，短期记忆与主聊天互通）
    const { recentBlocks, truncatedHistory, unifiedRecentItems } = prepareShortTermContext(characterId, "chat", {
        history: options.history,
        userName: userIdentity?.name ?? "用户",
    });

    const input: AssemblerInput = {
        character,
        history: truncatedHistory,
        preset,
        worldBooks,
        regexes,
        userIdentity,
        appId: "movie",
        appTags,
        coreMemories: formatCoreMemories(coreMemories),
        longTermMemories: formatLongTermMemories(longTermMemories),
        recentBlocks,
        unifiedRecentItems,
        movieTitle: options.movieTitle,
        sceneTitle: options.sceneTitle,
        sceneSummary: options.sceneSummary,
        movieSummary: options.movieSummary,
        sceneSubtitleWindow: options.sceneSubtitleWindow,
        frameHint: options.frameHint,
        sceneBoundaries: options.sceneBoundaries,
        moviePosition: options.moviePosition,
        chatBilingualInstruction: options.bilingualInstruction ?? "",
    };

    return { input, apiConfig, preset };
}

async function callMovieLLM(
    config: ApiConfig,
    preset: PresetConfig | null,
    messages: LLMMessage[],
    characterName: string,
    regexes?: RegexConfig[],
    appTags?: string[],
    userName?: string,
): Promise<string> {
    // 看门狗：请求挂起时不能永久卡死 generatingSceneRef / chatting 状态
    const MOVIE_LLM_TIMEOUT_MS = 180_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            sendLLMRequest(
                config,
                preset,
                messages,
                regexes ?? [],
                { characterName, userName },
                { appId: "movie", appTags },
            ),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("请求超时（3 分钟无响应）")), MOVIE_LLM_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ── Format helpers ──

function formatSeconds(total: number): string {
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** 前情提要格式（对齐阅读 formatReadingSummary；防剧透：只含已看场次） */
export function formatMovieSummary(scenes: MovieScene[], positionSeconds: number): string {
    const watched = scenes.filter(s => s.endSeconds <= positionSeconds + 0.5);
    if (watched.length === 0) return "";
    const lines = watched.map(s => `【第${s.index + 1}场 · ${formatSeconds(s.startSeconds)}-${formatSeconds(s.endSeconds)}】${s.summary}`);
    return `<movie_summary>\n以下是已观看内容的情节摘要，帮助你回忆看过的部分（之后的剧情你一无所知，也绝不剧透）：\n${lines.join("\n")}\n</movie_summary>\n`;
}

/** 组装帧提示文本（帧图以多模态 parts 附在 payload 末尾） */
function buildFrameHint(frames: MovieFrame[], scene: MovieScene): string {
    if (frames.length === 0) {
        return `<movie_frames>\n本场无预抽画面帧（分段时未提取），请仅凭字幕与摘要理解画面。\n</movie_frames>\n`;
    }
    const times = frames.map(f => formatSeconds(f.timeSeconds)).join("、");
    return `<movie_frames>\n以下附带本场（${formatSeconds(scene.startSeconds)}-${formatSeconds(scene.endSeconds)}）的 ${frames.length} 张预抽画面关键帧，时间点：${times}。请结合画面理解剧情，注意帧之间可能有省略。\n</movie_frames>\n`;
}

// ── 兜底注入：预设条目缺失时的保底指令 ──
// 用户的生效预设可能是自定义副本、没有 movie_* 条目（或未启用）。
// assemblePromptPayload 后检测标记是否存在，缺失则用实际数据现拼指令插入，
// 保证「分段/讨论」无论如何都有完整指令。预设里配了条目时仍以预设为准（可自定义）。

function ensureMovieInstruction(llmMessages: LLMMessage[], marker: string, fallback: string): void {
    const present = llmMessages.some(m => typeof m.content === "string" && m.content.includes(marker));
    if (present) return;
    console.warn(`[Movie] 预设未注入 ${marker}，使用引擎兜底指令`);
    // 插到最后一条连续 system 消息之后（保持 system 区块相邻），否则置于最前
    let insertAt = 0;
    for (let i = 0; i < llmMessages.length; i++) {
        if (llmMessages[i].role === "system") insertAt = i + 1;
        else break;
    }
    llmMessages.splice(insertAt, 0, { role: "system", content: fallback });
}

function buildSegmentFallback(movieTitle: string, sceneBoundaries: string): string {
    return [
        "<movie_segment_instruction>",
        `你是一位专业的影视结构分析师。用户准备和伴侣一起观看电影「${movieTitle}」，需要你把电影划分为便于边看边聊的段落。`,
        "",
        "以下是这部电影按时间排序的完整字幕文本，其中已用 [候选切点 秒=N] 标出了天然的场面转换边界（沉默间隙/画面突变）：",
        sceneBoundaries,
        "",
        "请完成两级划分：",
        "1. 把电影划分为 4~8 个「幕」（对应起承转合的叙事骨架）；",
        "2. 在幕内把电影划分为 20~40 个「场」（每场约 3~6 分钟），场必须以候选切点为边界，不得自行发明边界时间。",
        "",
        "输出格式（严格遵循，每场一条）：",
        "[幕 序号=N]幕标题[/幕]",
        "[场 开始=秒 结束=秒 幕=N]场标题|情节概括[/场]",
        "",
        "要求：",
        "- 场标题简短（10字内），情节概括 60~120 字，写清该场的关键事件、人物动态与情绪走向",
        "- 严格按时间顺序，各场时间范围首尾相接、覆盖全片，不重叠不遗漏",
        "- 只输出标记，不要输出任何其他内容",
        "</movie_segment_instruction>",
    ].join("\n");
}

function buildDiscussFallback(params: {
    movieTitle: string;
    sceneTitle: string;
    sceneSummary: string;
    movieSummary: string;
    sceneSubtitleWindow: string;
    frameHint: string;
    moviePosition: string;
    characterName: string;
    userName: string;
}): string {
    const p = params;
    return [
        "<movie_context>",
        `你正在和${p.userName}一起观看电影「${p.movieTitle}」。`,
        `当前正在看：${p.sceneTitle}（播放到 ${p.moviePosition}）`,
        "",
        p.sceneSummary,
        "",
        p.movieSummary,
        "",
        `当前场次附近的字幕（按时间顺序，你只「看过」已播放的部分）：`,
        p.sceneSubtitleWindow,
        "",
        p.frameHint,
        "</movie_context>",
        "",
        "<movie_instruction>",
        `${p.userName}想和你边看边聊。请围绕当前正在发生的剧情自然回复，可以评价画面节奏、猜测走向、分享感受、联想你们共同的经历。`,
        "- 回复简短自然，像朋友间坐在沙发上小声聊天，不要写长文影评",
        "- 你只知道已经播放过的内容，绝对不要剧透后面的剧情",
        "- 你的记忆和性格与平时聊天完全一致",
        "- 如果你想发一条弹幕，先正常回复，再在末尾追加动作尾注：【发弹幕 秒=N】内容（N 为当前场内秒数，内容 ≤30 字）",
        "- 禁止用星号（*）或括号包裹动作描写、神态描写或旁白",
        "</movie_instruction>",
    ].join("\n");
}

// ── 物理边界候选 + LLM 分段 ──

/**
 * 物理边界候选：字幕沉默间隙（>10s 无台词）+ 长段均匀兜底点（每 120s）。
 * 帧差采样在 P1 增强；P0 靠字幕静默间隙已能覆盖绝大多数场面转换。
 */
export function buildBoundaryCandidates(cues: SubtitleCue[], durationSeconds: number): number[] {
    const points = new Set<number>();
    for (let i = 1; i < cues.length; i++) {
        const gap = cues[i].startSeconds - cues[i - 1].endSeconds;
        if (gap > 10) {
            const mid = (cues[i - 1].endSeconds + cues[i].startSeconds) / 2;
            points.add(Math.round(mid));
        }
    }
    for (let t = 120; t < durationSeconds - 60; t += 120) {
        points.add(t);
    }
    points.delete(0);
    return [...points].sort((a, b) => a - b);
}

/** 全字幕文本 + 候选切点标记；超 token 预算时截尾并提示 */
function buildSegmentSourceText(cues: SubtitleCue[], boundaries: number[], maxChars = 48000): { text: string; truncated: boolean } {
    const lines: string[] = [];
    let boundaryIndex = 0;
    let total = 0;
    let truncated = false;
    for (const cue of cues) {
        while (boundaryIndex < boundaries.length && boundaries[boundaryIndex] <= cue.startSeconds) {
            const marker = `[候选切点 秒=${boundaries[boundaryIndex]}]`;
            lines.push(marker);
            total += marker.length + 1;
            boundaryIndex++;
        }
        lines.push(cue.text);
        total += cue.text.length + 1;
        if (total > maxChars) {
            truncated = true;
            break;
        }
    }
    return { text: lines.join("\n"), truncated };
}

/** 解析 [幕 序号=N]..[/幕] 与 [场 开始=秒 结束=秒 幕=N]标题|概括[/场] */
export function parseSegmentationResponse(raw: string): MovieSegmentationResult {
    const normalized = raw.replace(/\r\n/g, "\n");
    const acts: { index: number; title: string }[] = [];
    for (const m of normalized.matchAll(/\[幕\s*序号\s*[=＝]\s*(\d+)\s*\]([^[]*?)\[\/幕\]/g)) {
        const index = Number(m[1]) - 1;
        const title = (m[2] || "").trim();
        if (Number.isInteger(index) && index >= 0 && title) acts.push({ index, title });
    }
    const scenes: MovieSegmentationResult["scenes"] = [];
    for (const m of normalized.matchAll(/\[场\s*开始\s*[=＝]\s*(\d+)\s*结束\s*[=＝]\s*(\d+)\s*幕\s*[=＝]\s*(\d+)\s*\]([^[]*?)\[\/场\]/g)) {
        const start = Number(m[1]);
        const end = Number(m[2]);
        const actIndex = Number(m[3]) - 1;
        const rest = (m[4] || "").trim();
        const sep = rest.indexOf("|");
        const title = sep >= 0 ? rest.slice(0, sep).trim() : rest.slice(0, 20).trim();
        const summary = sep >= 0 ? rest.slice(sep + 1).trim() : rest.trim();
        if (end > start && title && summary) {
            scenes.push({ startSeconds: start, endSeconds: end, title, summary, actIndex });
        }
    }
    return { acts, scenes };
}

/** 校正 LLM 分段结果：排序、钳位到片长、消除重叠、补全覆盖 */
function normalizeScenes(drafts: MovieSegmentationResult["scenes"], durationSeconds: number): MovieSegmentationResult["scenes"] {
    const sorted = drafts.slice().sort((a, b) => a.startSeconds - b.startSeconds);
    const result: MovieSegmentationResult["scenes"] = [];
    let cursor = 0;
    for (const d of sorted) {
        const start = Math.max(cursor, Math.min(d.startSeconds, durationSeconds));
        let end = Math.min(d.endSeconds, durationSeconds);
        if (end <= start) continue;
        result.push({ ...d, startSeconds: start, endSeconds: end });
        cursor = end;
    }
    // 补尾：最后一场未覆盖到片尾时并入
    if (result.length > 0 && cursor < durationSeconds - 1) {
        result[result.length - 1].endSeconds = durationSeconds;
    }
    return result;
}

async function callWithRetry(fn: () => Promise<string>, retries = 2): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const text = await fn();
            if (text) return text;
            lastErr = new Error("API 返回空内容");
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error("分段调用失败");
}

/**
 * 生成分段：物理边界候选 + 全字幕 → LLM 两级划分 → 校正入库。
 * 调用方需先确保 movie 已入库；成功后 acts/scenes 落库（saveSegmentation）。
 */
export async function generateMovieSegmentation(
    movie: Movie,
    cues: SubtitleCue[],
    characterId: string,
    durationSeconds: number,
): Promise<{ acts: MovieAct[]; scenes: MovieScene[] }> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) throw new Error("角色不存在");

    const boundaries = buildBoundaryCandidates(cues, durationSeconds);
    const { text: sourceText, truncated } = buildSegmentSourceText(cues, boundaries);
    const truncatedNote = truncated
        ? "\n\n注意：字幕过长已截断，请仅针对给出的内容划分。"
        : "";

    const resolved = await resolveMovieInput(characterId, ["movie", "segment"], {
        movieTitle: movie.title,
        sceneBoundaries: sourceText + truncatedNote,
    });
    if (!resolved?.apiConfig) throw new Error("未找到 API 配置，请在设置中绑定 API");

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    ensureMovieInstruction(llmMessages, "<movie_segment_instruction>", buildSegmentFallback(movie.title, sourceText));
    const responseText = await callWithRetry(() => callMovieLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    ));

    const parsed = parseSegmentationResponse(responseText);
    if (parsed.scenes.length === 0) throw new Error("分段解析失败：模型未返回有效的场划分");

    const normalized = normalizeScenes(parsed.scenes, durationSeconds);
    const validActIndexes = new Set(parsed.acts.map(a => a.index));
    // 幕兜底：模型漏幕时按序补默认幕
    const acts: MovieAct[] = parsed.acts.length > 0
        ? parsed.acts.map(a => ({
            id: `mact_${movie.id}_${a.index}_${Date.now().toString(36)}`,
            movieId: movie.id,
            index: a.index,
            title: a.title,
        }))
        : [{ id: `mact_${movie.id}_0_${Date.now().toString(36)}`, movieId: movie.id, index: 0, title: "全片" }];
    const scenes: MovieScene[] = normalized.map((s, index) => ({
        id: `msc_${movie.id}_${index}_${Date.now().toString(36)}`,
        movieId: movie.id,
        index,
        actIndex: validActIndexes.has(s.actIndex ?? -1) ? (s.actIndex ?? 0) : 0,
        title: s.title,
        startSeconds: s.startSeconds,
        endSeconds: s.endSeconds,
        summary: s.summary,
        subtitleText: sliceSubtitleText(cues, s.startSeconds, s.endSeconds),
    }));

    await saveSegmentation(movie.id, acts, scenes);
    return { acts, scenes };
}

// ── 预抽帧（离线、去重，学 couchmate 画面diff守门 + OWC 观影包）──

/** 16x16 灰度感知哈希（8x8 均值阈值 → 64bit hex） */
function computePhash(canvas: HTMLCanvasElement): string {
    const size = 16;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "";
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // 缩到 16x16 灰度
    const stepX = canvas.width / size;
    const stepY = canvas.height / size;
    const grays: number[] = [];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const px = Math.floor(x * stepX);
            const py = Math.floor(y * stepY);
            const idx = (py * canvas.width + px) * 4;
            const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            grays.push(gray);
        }
    }
    const avg = grays.reduce((a, b) => a + b, 0) / grays.length;
    let hashLow = 0, hashHigh = 0;
    for (let i = 0; i < 32; i++) if (grays[i] > avg) hashLow |= (1 << i);
    for (let i = 32; i < 64; i++) if (grays[i] > avg) hashHigh |= (1 << (i - 32));
    return `${hashHigh.toString(16).padStart(8, "0")}${hashLow.toString(16).padStart(8, "0")}`;
}

function hammingHex(a: string, b: string): number {
    if (!a || !b || a.length !== b.length) return 64;
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) { dist += x & 1; x >>= 1; }
    }
    return dist;
}

/** 从视频文件为每场预抽 ~10 张帧（ evenly 分布），感知哈希去重相邻重复帧 */
export async function extractSceneFrames(
    file: File,
    scenes: MovieScene[],
    movieId: string,
    onProgress?: (done: number, total: number) => void,
): Promise<MovieFrame[]> {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.preload = "auto";
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("视频加载失败，无法提取画面帧"));
        });
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 360;
        const scale = Math.min(1, 320 / Math.max(vw, vh));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(vw * scale));
        canvas.height = Math.max(1, Math.round(vh * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 不可用");

        const frames: MovieFrame[] = [];
        let lastHash = "";
        const total = scenes.length;
        let done = 0;

        for (const scene of scenes) {
            const FRAMES_PER_SCENE = 10;
            let kept = 0;
            for (let i = 0; i < FRAMES_PER_SCENE && kept < FRAMES_PER_SCENE; i++) {
                const t = scene.startSeconds + ((i + 0.5) / FRAMES_PER_SCENE) * (scene.endSeconds - scene.startSeconds);
                const seekOk = await new Promise<boolean>((resolve) => {
                    const onSeeked = () => { cleanup(); resolve(true); };
                    const onError = () => { cleanup(); resolve(false); };
                    const cleanup = () => {
                        video.removeEventListener("seeked", onSeeked);
                        video.removeEventListener("error", onError);
                    };
                    video.addEventListener("seeked", onSeeked, { once: true });
                    video.addEventListener("error", onError, { once: true });
                    video.currentTime = Math.min(t, Math.max(0, (video.duration || scene.endSeconds) - 0.1));
                    // 部分浏览器 seek 到相同位置不触发 seeked
                    window.setTimeout(() => { cleanup(); resolve(true); }, 3000);
                });
                if (!seekOk) continue;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                const hash = computePhash(canvas);
                if (lastHash && hammingHex(hash, lastHash) <= 4) continue; // 画面没变，跳过（省存储与token）
                lastHash = hash;
                const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.7));
                if (!blob) continue;
                frames.push({
                    id: `mfr_${movieId}_${scene.index}_${kept}_${Date.now().toString(36)}`,
                    movieId,
                    sceneId: scene.id,
                    timeSeconds: t,
                    thumbnail: blob,
                    phash: hash,
                });
                kept++;
            }
            done++;
            onProgress?.(done, total);
        }
        await saveFrames(frames);
        return frames;
    } finally {
        URL.revokeObjectURL(url);
        video.removeAttribute("src");
    }
}

// ── 防剧透上下文组装 ──

/** 按播放位置定位当前场（线性；场数 ≤40 无需二分） */
export function findCurrentScene(scenes: MovieScene[], positionSeconds: number): MovieScene | null {
    for (const s of scenes) {
        if (positionSeconds >= s.startSeconds && positionSeconds < s.endSeconds) return s;
    }
    // 播放到片尾之后：返回最后一场
    return scenes.length > 0 ? scenes[scenes.length - 1] : null;
}

/**
 * 防剧透门控讨论上下文：摘要/字幕/帧全部只含已播放位置的材料。
 * 字幕窗口向后预取仅限当前场范围内（当前场本身属于「正在看」，允许）。
 */
export async function buildMovieDiscussContext(
    movie: Movie,
    positionSeconds: number,
    cues: SubtitleCue[],
): Promise<MovieDiscussContext | null> {
    const scenes = await loadScenes(movie.id);
    if (scenes.length === 0) return null;
    const current = findCurrentScene(scenes, positionSeconds);
    if (!current) return null;

    const allFrames = await loadFrames(movie.id);
    const sceneFrames = allFrames.filter(f => f.sceneId === current.id);
    const frameDataUrls: string[] = [];
    for (const f of sceneFrames) {
        frameDataUrls.push(await blobToDataUrl(f.thumbnail));
    }

    return {
        sceneTitle: `第${current.index + 1}场 ${current.title}（${formatSeconds(current.startSeconds)}-${formatSeconds(current.endSeconds)}）`,
        sceneSummary: current.summary,
        sceneSubtitleWindow: buildSubtitleWindow(cues, positionSeconds),
        movieSummary: formatMovieSummary(scenes, positionSeconds),
        frameHint: buildFrameHint(sceneFrames, current),
        frameDataUrls,
        positionSeconds,
    };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

// ── 讨论回复 ──

export type MovieDiscussAction = { type: "send_danmaku"; timeSeconds: number; content: string };

/** 解析【发弹幕 秒=N】动作尾注（兼容全角＝、= 两侧空格；动作块可在回复任意位置） */
const ACTION_DANMAKU_GLOBAL_RE = /【\s*发弹幕\s*秒\s*[=＝]\s*(\d+)\s*】([^【\n]*)/g;

export function parseMovieDiscussResponse(raw: string): { reply: string; actions: MovieDiscussAction[] } {
    const normalized = raw.replace(/\r\n/g, "\n").trimEnd();
    if (!normalized) return { reply: "", actions: [] };
    const actions: MovieDiscussAction[] = [];
    const spans: Array<[number, number]> = [];
    for (const m of normalized.matchAll(ACTION_DANMAKU_GLOBAL_RE)) {
        const timeSeconds = Number(m[1]);
        const content = (m[2] || "").trim();
        if (Number.isFinite(timeSeconds) && content) {
            actions.push({ type: "send_danmaku", timeSeconds, content });
        }
        if (m.index !== undefined) spans.push([m.index, m.index + m[0].length]);
    }
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

/** 观影讨论：组装上下文 → LLM → 剥动作尾注 → 活动计数进水位线 */
export async function generateMovieChat(
    session: ChatSession,
    movie: Movie,
    context: MovieDiscussContext,
    cues: SubtitleCue[],
    characterId: string,
): Promise<{ reply: string; actions: MovieDiscussAction[] } | null> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return null;

    const history = loadChatMessages(session.id);
    const m = Math.floor(context.positionSeconds / 60);
    const s = Math.floor(context.positionSeconds % 60);

    const resolved = await resolveMovieInput(characterId, ["movie", "discuss"], {
        movieTitle: movie.title,
        sceneTitle: context.sceneTitle,
        sceneSummary: context.sceneSummary,
        movieSummary: context.movieSummary,
        sceneSubtitleWindow: context.sceneSubtitleWindow,
        frameHint: context.frameHint,
        moviePosition: `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`,
        bilingualInstruction: resolveBilingualPrompt(session.bilingualTranslationEnabled !== false, undefined, DEFAULT_MOVIE_BILINGUAL_PROMPT),
        history,
    });
    if (!resolved) return null;

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    ensureMovieInstruction(llmMessages, "<movie_instruction>", buildDiscussFallback({
        movieTitle: movie.title,
        sceneTitle: context.sceneTitle,
        sceneSummary: context.sceneSummary,
        movieSummary: context.movieSummary,
        sceneSubtitleWindow: context.sceneSubtitleWindow,
        frameHint: context.frameHint,
        moviePosition: `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`,
        characterName: character.name,
        userName: input.userIdentity?.name ?? "用户",
    }));
    // 帧图以多模态 parts 附在 payload 末尾（detail low 省 token）
    if (context.frameDataUrls.length > 0) {
        llmMessages.push({
            role: "user",
            content: [
                { type: "text", text: `[系统附注：以下是你当前正在观看的画面关键帧（按时间顺序），仅供理解剧情，不要逐帧描述。]` },
                ...context.frameDataUrls.map(url => ({ type: "image_url" as const, image_url: { url, detail: "low" as const } })),
            ],
        });
    }
    const responseText = await callMovieLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return null;

    // 阅读共读同款：活动计数进复杂记忆统一水位线（副 app，不带 trigger）
    recordCharacterActivity(characterId, character.name, 1);

    return parseMovieDiscussResponse(responseText);
}

// ── 弹幕批量生成（进新场自动 / 手动补充）──

/** 解析 [弹幕 秒=N]内容[/弹幕]（容忍缺失闭合标签），N 为场内相对秒数 */
const DANMAKU_GLOBAL_RE = /\[弹幕\s*秒\s*[=＝]\s*(\d+)\s*\]([^[\n]*(?:\n[^[\n]*)*)/g;

export function parseDanmakuResponse(raw: string): { timeSeconds: number; content: string }[] {
    const items: { timeSeconds: number; content: string }[] = [];
    for (const m of raw.matchAll(DANMAKU_GLOBAL_RE)) {
        const rel = Number(m[1]);
        const content = (m[2] || "").trim();
        if (Number.isFinite(rel) && content) items.push({ timeSeconds: rel, content });
    }
    return items;
}

function buildDanmakuFallback(params: {
    movieTitle: string;
    sceneTitle: string;
    sceneSummary: string;
    sceneSubtitleWindow: string;
    frameHint: string;
    characterName: string;
    userName: string;
}): string {
    const p = params;
    return [
        "<movie_danmaku_instruction>",
        `你正在和${p.userName}一起观看电影「${p.movieTitle}」。${p.characterName}是你的身份，弹幕是你的实时吐槽，像朋友窝在沙发上一起看片时随口说的话。`,
        "",
        `当前场：${p.sceneTitle}`,
        p.sceneSummary,
        "",
        "该场的字幕（按时间顺序）：",
        p.sceneSubtitleWindow,
        "",
        p.frameHint,
        "",
        "请以该角色的口吻为本场生成 5~10 条弹幕，散布在本场时间轴的不同时间点上。",
        "格式：[弹幕 秒=N]内容[/弹幕]，N 为本场范围内的秒数。",
        "要求：",
        "- 每条 ≤30 字，口语化、自然、符合角色的性格",
        "- 可以吐槽、感叹、联想、共情、玩梗，但不要复述字幕原文",
        "- 禁止剧透本场之后的内容",
        "- 禁止用星号（*）或括号包裹动作描写",
        "- 如果本场有特别想说的话（一句弹幕装不下的感想、联想到了你们的共同经历），在所有弹幕之后另起一行输出：[开口]想说的话[/开口]。没有就输出 [无开口]，不要勉强",
        "</movie_danmaku_instruction>",
    ].join("\n");
}

/** 为指定场批量生成弹幕并入库，返回新产生的弹幕 */
export async function generateMovieDanmaku(
    movie: Movie,
    scene: MovieScene,
    characterId: string,
): Promise<MovieDanmaku[]> {
    const character = loadCharacters().find(c => c.id === characterId);
    if (!character) return [];

    const sceneFrames = (await loadFrames(movie.id)).filter(f => f.sceneId === scene.id);
    const resolved = await resolveMovieInput(characterId, ["movie", "danmaku"], {
        movieTitle: movie.title,
        sceneTitle: `第${scene.index + 1}场 ${scene.title}（${formatSeconds(scene.startSeconds)}-${formatSeconds(scene.endSeconds)}）`,
        sceneSummary: scene.summary,
        sceneSubtitleWindow: scene.subtitleText,
        frameHint: buildFrameHint(sceneFrames, scene),
    });
    if (!resolved?.apiConfig) throw new Error("观影 app 未绑定 API（设置 → 配置绑定 → 观影）");

    const { input, apiConfig, preset } = resolved;
    const llmMessages = assemblePromptPayload(input);
    ensureMovieInstruction(llmMessages, "<movie_danmaku_instruction>", buildDanmakuFallback({
        movieTitle: movie.title,
        sceneTitle: `第${scene.index + 1}场 ${scene.title}（${formatSeconds(scene.startSeconds)}-${formatSeconds(scene.endSeconds)}）`,
        sceneSummary: scene.summary,
        sceneSubtitleWindow: scene.subtitleText,
        frameHint: buildFrameHint(sceneFrames, scene),
        characterName: character.name,
        userName: input.userIdentity?.name ?? "用户",
    }));

    const responseText = await callMovieLLM(
        apiConfig!,
        preset,
        llmMessages,
        character.name,
        input.regexes,
        input.appTags,
        input.userIdentity?.name,
    );
    if (!responseText) return [];

    // 副 app 活动计数进统一水位线
    recordCharacterActivity(characterId, character.name, 1);

    // [开口]：char 主动以聊天消息发一条感想（走 movie_discuss 会话，主聊天不可见但短期记忆互通）
    const openingMatch = responseText.match(/\[开口\]([\s\S]*?)\[\/开口\]/);
    if (openingMatch && openingMatch[1].trim()) {
        const session = createOrGetSession(characterId);
        pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: openingMatch[1].trim(),
            origin: "movie_discuss",
            mediaData: {
                movieTitle: movie.title,
                moviePositionSeconds: Math.floor(scene.startSeconds),
            },
        });
        // 通知讨论面板刷新（面板可能在普通视图或影院层挂载）
        if (typeof window !== "undefined") window.dispatchEvent(new Event("movie-discuss-updated"));
    }

    const items: MovieDanmaku[] = [];
    for (const d of parseDanmakuResponse(responseText)) {
        const abs = Math.min(Math.max(scene.startSeconds + d.timeSeconds, scene.startSeconds), Math.max(scene.endSeconds - 1, scene.startSeconds));
        items.push({
            id: `mdk_${movie.id}_${scene.index}_${Date.now().toString(36)}_${items.length}`,
            movieId: movie.id,
            timeSeconds: abs,
            characterId: character.id,
            characterName: character.name,
            content: d.content.slice(0, 50),
            createdAt: new Date().toISOString(),
        });
    }
    await saveDanmaku(items);
    return items;
}
