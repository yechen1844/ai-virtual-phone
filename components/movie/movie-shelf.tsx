"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
    loadMovies, addMovie, deleteMovie, updateMovie,
    loadProgress, saveProgress, saveCues, loadScenes,
} from "@/lib/movie-storage";
import { parseSubtitleArrayBuffer } from "@/lib/movie-parser";
import { generateMovieSegmentation, extractSceneFrames } from "@/lib/movie-engine";
import { loadCharacters } from "@/lib/character-storage";
import type { Movie } from "@/lib/movie-types";

type Props = {
    onOpenMovie: (movie: Movie) => void;
    onClose: () => void;
};

type ImportStage = "idle" | "decoding" | "segmenting" | "extracting" | "done" | "error";

function formatDuration(total?: number): string {
    if (!total || !Number.isFinite(total)) return "--:--";
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(total % 60)).padStart(2, "0")}` : `${m}:${String(Math.floor(total % 60)).padStart(2, "0")}`;
}

function readVideoDuration(file: File): Promise<number> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const video = document.createElement("video");
        video.preload = "metadata";
        video.onloadedmetadata = () => {
            const d = video.duration;
            URL.revokeObjectURL(url);
            resolve(Number.isFinite(d) ? d : 0);
        };
        video.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("浏览器无法读取此视频（mkv 等容器可能不支持，建议先用剪映转成 MP4）"));
        };
        video.src = url;
    });
}

export function MovieShelf({ onOpenMovie, onClose }: Props) {
    const [movies, setMovies] = useState<Movie[]>([]);
    const [characters, setCharacters] = useState<{ id: string; name: string }[]>([]);
    const [companionId, setCompanionId] = useState<string>("");
    const [progressMap, setProgressMap] = useState<Map<string, { positionSeconds: number; segmented: boolean }>>(new Map());
    const [sceneCountMap, setSceneCountMap] = useState<Map<string, number>>(new Map());
    const [stage, setStage] = useState<ImportStage>("idle");
    const [stageDetail, setStageDetail] = useState("");
    const [errorMsg, setErrorMsg] = useState("");
    const [showHelp, setShowHelp] = useState(false);
    const videoInputRef = useRef<HTMLInputElement>(null);
    const subtitleInputRef = useRef<HTMLInputElement>(null);
    const pendingVideoRef = useRef<File | null>(null);
    const [subtitlePickerMovie, setSubtitlePickerMovie] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        const list = loadMovies();
        setMovies(list);
        const pMap = new Map<string, { positionSeconds: number; segmented: boolean }>();
        const sMap = new Map<string, number>();
        for (const m of list) {
            const p = await loadProgress(m.id);
            pMap.set(m.id, { positionSeconds: p?.positionSeconds ?? 0, segmented: p?.segmented ?? false });
            const scenes = await loadScenes(m.id);
            sMap.set(m.id, scenes.length);
        }
        setProgressMap(pMap);
        setSceneCountMap(sMap);
    }, []);

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars.map(c => ({ id: c.id, name: c.name })));
        if (chars.length > 0) setCompanionId(prev => prev || chars[0].id);
        void refresh();
    }, [refresh]);

    const handleVideoPicked = async (file: File | null) => {
        if (!file) return;
        if (!companionId) {
            setErrorMsg("请先选择陪伴角色");
            return;
        }
        pendingVideoRef.current = file;
        setErrorMsg("");
        setStage("decoding");
        setStageDetail("读取视频信息...");
        try {
            const duration = await readVideoDuration(file);
            if (!duration) throw new Error("无法读取视频时长");
            const title = file.name.replace(/\.[^.]+$/, "");
            const movie: Movie = {
                id: `mv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                title,
                durationSeconds: Math.round(duration),
                createdAt: new Date().toISOString(),
            };
            await addMovie(movie);
            // 若随选了字幕文件则自动接续；否则进入字幕选择提示
            if (subtitleInputRef.current) {
                subtitleInputRef.current.value = "";
                subtitleInputRef.current.click();
                setSubtitlePickerMovie(movie.id);
                setStage("idle");
                setStageDetail("");
            } else {
                await runSegmentation(movie, file, null);
            }
        } catch (err) {
            setStage("error");
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    };

    const handleSubtitlePicked = async (file: File | null) => {
        const movieId = subtitlePickerMovie;
        setSubtitlePickerMovie(null);
        if (!movieId) return;
        const movie = loadMovies().find(m => m.id === movieId);
        const videoFile = pendingVideoRef.current;
        if (!movie || !videoFile) return;
        try {
            if (file) {
                setStage("decoding");
                setStageDetail("解析字幕...");
                const buffer = await file.arrayBuffer();
                const { cues, encoding } = parseSubtitleArrayBuffer(buffer, file.name);
                if (cues.length === 0) {
                    throw new Error(`字幕解析出 0 条：请确认是 .srt/.vtt/.ass/.ssa 文件且内容完整（已尝试多编码，最后使用 ${encoding}）`);
                }
                await saveCues(movie.id, cues);
            }
            await runSegmentation(movie, videoFile, null);
        } catch (err) {
            setStage("error");
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    };

    const runSegmentation = async (movie: Movie, videoFile: File, _subtitleFile: File | null) => {
        const { loadCues } = await import("@/lib/movie-storage");
        try {
            setStage("segmenting");
            setStageDetail("正在划分幕与场（调用模型，约需几十秒）...");
            const cues = await loadCues(movie.id);
            const { scenes } = await generateMovieSegmentation(movie, cues, companionId, movie.durationSeconds ?? 0);
            setStage("extracting");
            setStageDetail("正在预抽画面关键帧...");
            await extractSceneFrames(videoFile, scenes, movie.id, (done, total) => {
                setStageDetail(`预抽画面关键帧...（${done}/${total} 场）`);
            });
            await saveProgress({
                movieId: movie.id,
                positionSeconds: 0,
                companionCharacterId: companionId,
                segmented: true,
                lastWatchAt: new Date().toISOString(),
            });
            pendingVideoRef.current = null;
            setStage("done");
            setStageDetail(`完成！共 ${scenes.length} 场`);
            await refresh();
            // 分段完成直接进入播放
            onOpenMovie({ ...movie });
        } catch (err) {
            setStage("error");
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    };

    const handleDelete = async (movie: Movie) => {
        if (!window.confirm(`删除《${movie.title}》？观影包（分段/摘要/画面帧/弹幕）将一并删除。`)) return;
        await deleteMovie(movie.id);
        await refresh();
    };

    const busy = stage === "decoding" || stage === "segmenting" || stage === "extracting";

    return (
        <div className="absolute inset-0 flex flex-col" style={{ background: "#0d0f1a", color: "#e8e9f0" }}>
            {/* 顶栏 */}
            <div className="flex items-center gap-3 px-4" style={{ height: 52, borderBottom: "1px solid #232636" }}>
                <button
                    className="ts-14"
                    onClick={onClose}
                    style={{ background: "none", border: "none", color: "#8f93a8", padding: "4px 8px", cursor: "pointer" }}
                >‹ 返回</button>
                <span className="ts-16" style={{ fontWeight: 600 }}>观影</span>
                <div style={{ flex: 1 }} />
                <button
                    className="ts-14"
                    onClick={() => setShowHelp(v => !v)}
                    style={{ background: "none", border: "none", color: "#8f93a8", padding: "4px 8px", cursor: "pointer" }}
                >字幕从哪来？</button>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                {/* 角色选择 */}
                <div className="flex items-center gap-2" style={{ marginBottom: 14 }}>
                    <span className="ts-14" style={{ color: "#8f93a8" }}>一起看的人：</span>
                    <select
                        className="ts-14"
                        value={companionId}
                        onChange={e => setCompanionId(e.target.value)}
                        style={{ background: "#1a1d2c", color: "#e8e9f0", border: "1px solid #2c3046", borderRadius: 8, padding: "6px 10px", maxWidth: "60%" }}
                    >
                        {characters.length === 0 && <option value="">（暂无角色）</option>}
                        {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                </div>

                {/* 导入按钮 */}
                <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*,.mp4,.webm,.mov,.m4v"
                    style={{ display: "none" }}
                    onChange={e => { void handleVideoPicked(e.target.files?.[0] ?? null); e.target.value = ""; }}
                />
                <input
                    ref={subtitleInputRef}
                    type="file"
                    accept=".srt,.vtt,.ass,.ssa"
                    style={{ display: "none" }}
                    onChange={e => { void handleSubtitlePicked(e.target.files?.[0] ?? null); }}
                />
                <button
                    className="ts-14"
                    disabled={busy || !companionId}
                    onClick={() => videoInputRef.current?.click()}
                    style={{
                        width: "100%", padding: "12px 0", borderRadius: 12,
                        background: busy ? "#232636" : "linear-gradient(135deg, #6c5ce7, #a29bfe)",
                        color: busy ? "#8f93a8" : "#fff", border: "none", cursor: busy ? "default" : "pointer", fontWeight: 600,
                    }}
                >＋ 导入影片（本地视频，可带字幕）</button>

                {/* 进度 / 错误提示 */}
                {busy && (
                    <div className="ts-14" style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#1a1d2c", color: "#a29bfe" }}>
                        {stageDetail}
                    </div>
                )}
                {stage === "done" && (
                    <div className="ts-14" style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#16241c", color: "#7ec99a" }}>
                        {stageDetail}
                    </div>
                )}
                {stage === "error" && (
                    <div className="ts-14" style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#2c1a1e", color: "#e08a95" }}>
                        {errorMsg}
                        <button className="ts-14" onClick={() => setStage("idle")} style={{ marginLeft: 8, background: "none", border: "none", color: "#8f93a8", cursor: "pointer" }}>关闭</button>
                    </div>
                )}

                {/* 字幕帮助 */}
                {showHelp && (
                    <div className="ts-14" style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#1a1d2c", color: "#b6b9c9", lineHeight: 1.8 }}>
                        <p style={{ fontWeight: 600, color: "#e8e9f0" }}>给视频配字幕的三种方式：</p>
                        <p>1. 下载现成字幕：SubHD、字幕库、OpenSubtitles 按资源名搜 SRT 文件；</p>
                        <p>2. 没有字幕就用剪映（手机/电脑）：导入视频 → 文本 → 智能字幕 → 语音转字幕 → 导出 SRT，免费；</p>
                        <p>3. mkv 内封字幕：电脑上用 PotPlayer「字幕另存为」或 MKVToolNix 提取；mkv 本体若播放失败，先用剪映转一次 MP4。</p>
                    </div>
                )}

                {/* 片架 */}
                <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
                    {movies.length === 0 && (
                        <div className="ts-14" style={{ textAlign: "center", color: "#565b73", padding: "40px 0" }}>
                            片架还是空的，导入一部电影开始吧
                        </div>
                    )}
                    {movies.map(movie => {
                        const p = progressMap.get(movie.id);
                        const sceneCount = sceneCountMap.get(movie.id) ?? 0;
                        const watched = (p?.positionSeconds ?? 0) > 0;
                        return (
                            <div key={movie.id} style={{ borderRadius: 12, background: "#1a1d2c", padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div className="ts-14" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{movie.title}</div>
                                    <div className="ts-14" style={{ color: "#8f93a8", marginTop: 2 }}>
                                        {formatDuration(movie.durationSeconds)}
                                        {sceneCount > 0 ? ` · ${sceneCount} 场` : " · 未分段"}
                                        {watched ? ` · 看到 ${formatDuration(p?.positionSeconds)}` : ""}
                                    </div>
                                </div>
                                <button
                                    className="ts-14"
                                    onClick={() => onOpenMovie(movie)}
                                    style={{ padding: "6px 14px", borderRadius: 8, background: "#6c5ce7", color: "#fff", border: "none", cursor: "pointer" }}
                                >{watched ? "继续" : "观看"}</button>
                                <button
                                    className="ts-14"
                                    onClick={() => void handleDelete(movie)}
                                    style={{ padding: "6px 10px", borderRadius: 8, background: "none", border: "1px solid #2c3046", color: "#8f93a8", cursor: "pointer" }}
                                >删除</button>
                            </div>
                        );
                    })}
                </div>

                {/* 隐私说明 */}
                <div className="ts-14" style={{ marginTop: 20, color: "#565b73", lineHeight: 1.7 }}>
                    视频文件保存在你的设备原处，观影不会复制或上传它；每次观看时需重新选择一次文件。库里只存分段摘要、字幕与画面帧（约几 MB）。
                </div>
            </div>
        </div>
    );
}
