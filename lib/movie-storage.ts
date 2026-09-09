// lib/movie-storage.ts — Dexie IndexedDB persistence for Movie (观影) feature.
// 结构照抄 reading-storage 模式。视频本体不入库（文件留在原地，objectURL 流式播放）。

import Dexie from "dexie";
import type { Movie, MovieAct, MovieScene, MovieFrame, WatchProgress, MovieDanmaku, SubtitleCue } from "./movie-types";

class MovieDB extends Dexie {
    movies!: Dexie.Table<Movie, string>;
    acts!: Dexie.Table<MovieAct, string>;
    scenes!: Dexie.Table<MovieScene, string>;
    frames!: Dexie.Table<MovieFrame, string>;
    progress!: Dexie.Table<WatchProgress, string>;
    danmaku!: Dexie.Table<MovieDanmaku, string>;
    cues!: Dexie.Table<{ movieId: string; cues: SubtitleCue[] }, string>;

    constructor() {
        super("movie-db");
        this.version(1).stores({
            movies: "id, createdAt",
            acts: "id, movieId, [movieId+index]",
            scenes: "id, movieId, [movieId+index]",
            frames: "id, movieId, sceneId",
            progress: "movieId",
            danmaku: "id, movieId, [movieId+timeSeconds]",
            cues: "movieId",
        });
    }
}

const db = new MovieDB();

// ── In-memory cache ──

let _moviesCache: Movie[] | null = null;
let _actsCache: Map<string, MovieAct[]> = new Map();
let _scenesCache: Map<string, MovieScene[]> = new Map();
let _framesCache: Map<string, MovieFrame[]> = new Map(); // key: movieId
let _danmakuCache: Map<string, MovieDanmaku[]> = new Map(); // key: movieId

export async function hydrateMovieStorage(): Promise<void> {
    _moviesCache = await db.movies.toArray();
    _moviesCache.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// ── Movies ──

export function loadMovies(): Movie[] {
    return _moviesCache || [];
}

export async function addMovie(movie: Movie): Promise<void> {
    await db.movies.put(movie);
    _moviesCache = await db.movies.orderBy("createdAt").reverse().toArray();
}

export async function updateMovie(movie: Movie): Promise<void> {
    await db.movies.put(movie);
    _moviesCache = await db.movies.orderBy("createdAt").reverse().toArray();
}

/** 级联删除：观影包（acts/scenes/frames/danmaku/progress）一并清除 */
export async function deleteMovie(movieId: string): Promise<void> {
    await db.movies.delete(movieId);
    await db.acts.where("movieId").equals(movieId).delete();
    await db.scenes.where("movieId").equals(movieId).delete();
    await db.frames.where("movieId").equals(movieId).delete();
    await db.danmaku.where("movieId").equals(movieId).delete();
    await db.progress.delete(movieId);
    await db.cues.delete(movieId);
    _moviesCache = await db.movies.orderBy("createdAt").reverse().toArray();
    _actsCache.delete(movieId);
    _scenesCache.delete(movieId);
    _framesCache.delete(movieId);
    _danmakuCache.delete(movieId);
}

// ── Acts / Scenes ──

export async function saveSegmentation(movieId: string, acts: MovieAct[], scenes: MovieScene[]): Promise<void> {
    // 重新分段时先清旧数据
    await db.acts.where("movieId").equals(movieId).delete();
    await db.scenes.where("movieId").equals(movieId).delete();
    await db.frames.where("movieId").equals(movieId).delete();
    if (acts.length > 0) await db.acts.bulkPut(acts);
    if (scenes.length > 0) await db.scenes.bulkPut(scenes);
    _actsCache.set(movieId, acts.slice().sort((a, b) => a.index - b.index));
    _scenesCache.set(movieId, scenes.slice().sort((a, b) => a.index - b.index));
    _framesCache.delete(movieId);
}

export async function loadActs(movieId: string): Promise<MovieAct[]> {
    if (_actsCache.has(movieId)) return _actsCache.get(movieId)!;
    const acts = await db.acts.where("movieId").equals(movieId).sortBy("index");
    _actsCache.set(movieId, acts);
    return acts;
}

export async function loadScenes(movieId: string): Promise<MovieScene[]> {
    if (_scenesCache.has(movieId)) return _scenesCache.get(movieId)!;
    const scenes = await db.scenes.where("movieId").equals(movieId).sortBy("index");
    _scenesCache.set(movieId, scenes);
    return scenes;
}

export function hasSegmentation(movieId: string): boolean {
    return _scenesCache.has(movieId) && (_scenesCache.get(movieId)!.length > 0);
}

// ── Frames ──

export async function saveFrames(frames: MovieFrame[]): Promise<void> {
    if (frames.length === 0) return;
    await db.frames.bulkPut(frames);
    const affected = new Set(frames.map(f => f.movieId));
    for (const movieId of affected) {
        _framesCache.delete(movieId);
    }
}

export async function loadFrames(movieId: string): Promise<MovieFrame[]> {
    if (_framesCache.has(movieId)) return _framesCache.get(movieId)!;
    const frames = await db.frames.where("movieId").equals(movieId).toArray();
    frames.sort((a, b) => a.timeSeconds - b.timeSeconds);
    _framesCache.set(movieId, frames);
    return frames;
}

// ── Progress ──

const _progressCache: Map<string, WatchProgress> = new Map();

export async function loadProgress(movieId: string): Promise<WatchProgress | null> {
    if (_progressCache.has(movieId)) return _progressCache.get(movieId)!;
    const p = await db.progress.get(movieId);
    if (p) _progressCache.set(movieId, p);
    return p || null;
}

export async function saveProgress(progress: WatchProgress): Promise<void> {
    // 合并式写入：新记录没带的字段（尤其 companionCharacterId）保留旧值。
    // 播放器打开瞬间视频加载就会触发一次进度保存，此时陪伴角色尚未异步加载完，
    // 覆盖式写入会把分段时选好的陪伴角色抹掉（表现为「未选择陪伴角色」）。
    const existing = _progressCache.get(progress.movieId) ?? (await db.progress.get(progress.movieId)) ?? null;
    const merged: WatchProgress = {
        ...existing,
        ...progress,
        companionCharacterId: progress.companionCharacterId ?? existing?.companionCharacterId,
        segmented: progress.segmented || existing?.segmented || false,
    };
    await db.progress.put(merged);
    _progressCache.set(merged.movieId, merged);
}

// ── Danmaku ──

export async function loadDanmaku(movieId: string): Promise<MovieDanmaku[]> {
    if (_danmakuCache.has(movieId)) return _danmakuCache.get(movieId)!;
    const danmaku = await db.danmaku.where("movieId").equals(movieId).toArray();
    danmaku.sort((a, b) => a.timeSeconds - b.timeSeconds);
    _danmakuCache.set(movieId, danmaku);
    return danmaku;
}

export async function saveDanmaku(items: MovieDanmaku[]): Promise<void> {
    if (items.length === 0) return;
    await db.danmaku.bulkPut(items);
    const affected = new Set(items.map(d => d.movieId));
    for (const movieId of affected) {
        _danmakuCache.delete(movieId);
    }
}

// ── Subtitle cues（原始时间轴，字幕滑动窗口用）──

export async function saveCues(movieId: string, cues: SubtitleCue[]): Promise<void> {
    await db.cues.put({ movieId, cues });
}

export async function loadCues(movieId: string): Promise<SubtitleCue[]> {
    const record = await db.cues.get(movieId);
    return record?.cues ?? [];
}
