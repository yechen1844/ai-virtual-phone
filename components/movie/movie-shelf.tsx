"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
    loadMovies, addMovie, deleteMovie,
    loadProgress, saveProgress, saveCues, loadCues, loadScenes,
} from "@/lib/movie-storage";
import { parseSubtitleArrayBuffer } from "@/lib/movie-parser";
import { generateMovieSegmentation, extractSceneFrames } from "@/lib/movie-engine";
import { loadCharacters } from "@/lib/character-storage";
import type { Movie } from "@/lib/movie-types";

type Props = {
    onOpenMovie: (movie: Movie) => void;
    onClose: () => void;
};

type ImportStage = "idle" | "decoding" | "segmenting" | "extracting" | "error";
type PendingImport = { movie: Movie; videoFile: File | null };

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
    const [cuesMap, setCuesMap] = useState<Map<string, boolean>>(new Map());
    const [stage, setStage] = useState<ImportStage>("idle");
    const [stageDetail, setStageDetail] = useState("");
    const [errorMsg, setErrorMsg] = useState("");
    const [showHelp, setShowHelp] = useState(false);
    // 两步删除确认：第一次点变「确认删除？」，再点才真删（避免 window.confirm 在 APK 壳中不显示）
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
    // 选完视频后弹出的「字幕/分段」决策框（按钮触发文件选择，保证手势有效）
    const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
    // 视频文件选择的用途：导入新片 or 给已有影片补视频（重新分段）
    const videoPickTargetRef = useRef<string>("new"); // "new" | movieId
    const videoInputRef = useRef<HTMLInputElement>(null);
    const subtitleInputRef = useRef<HTMLInputElement>(null);

    const refresh = useCallback(async () => {
        const list = loadMovies();
        setMovies(list);
        const pMap = new Map<string, { positionSeconds: number; segmented: boolean }>();
        const sMap = new Map<string, number>();
        const cMap = new Map<string, boolean>();
        for (const m of list) {
            const p = await loadProgress(m.id);
            pMap.set(m.id, { positionSeconds: p?.positionSeconds ?? 0, segmented: p?.segmented ?? false });
            const scenes = await loadScenes(m.id);
            sMap.set(m.id, scenes.length);
            const cues = await loadCues(m.id);
            cMap.set(m.id, cues.length > 0);
        }
        setProgressMap(pMap);
        setSceneCountMap(sMap);
        setCuesMap(cMap);
    }, []);

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars.map(c => ({ id: c.id, name: c.name })));
        if (chars.length > 0) setCompanionId(prev => prev || chars[0].id);
        void refresh();
    }, [refresh]);

    // ── 视频选择完成 ──
    const handleVideoPicked = async (file: File | null) => {
        if (!file) return; // 用户取消，静默返回
        const target = videoPickTargetRef.current;
        setErrorMsg("");
        try {
            if (target === "new") {
                if (!companionId) {
                    setErrorMsg("请先选择一起看的人（陪伴角色）");
                    setStage("error");
                    return;
                }
                setStage("decoding");
                setStageDetail("读取视频信息...");
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
                await refresh();
                setStage("idle");
                setPendingImport({ movie, videoFile: file });
            } else {
                // 给已有影片补视频（重新分段/补帧）
                const movie = loadMovies().find(m => m.id === target);
                if (!movie) return;
                setStage("decoding");
                setStageDetail("读取视频信息...");
                await readVideoDuration(file); // 仅校验可读
                setStage("idle");
                setPendingImport({ movie, videoFile: file });
            }
        } catch (err) {
            setStage("error");
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    };

    // ── 字幕选择完成（从决策框按钮触发，带手势）──
    const handleSubtitlePicked = async (file: File | null) => {
        const ctx = pendingImport;
        if (!ctx || !file) return;
        try {
            setStage("decoding");
            setStageDetail("解析字幕...");
            const buffer = await file.arrayBuffer();
            const { cues, encoding } = parseSubtitleArrayBuffer(buffer, file.name);
            if (cues.length === 0) {
                throw new Error(`字幕解析出 0 条：请确认是 .srt/.vtt/.ass/.ssa 文件且内容完整（已尝试多编码，最后使用 ${encoding}）`);
            }
            await saveCues(ctx.movie.id, cues);
            await refresh();
            setStage("idle");
            setPendingImport({ ...ctx });
        } catch (err) {
            setStage("error");
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    };

    // ── 生成分段（决策框确认按钮触发）──
    const runSegmentation = async (ctx: PendingImport) => {
        const { movie, videoFile } = ctx;
        try {
            const cues = await loadCues(movie.id);
            if (cues.length === 0) {
                setErrorMsg("还没有字幕：char 靠字幕理解剧情，请先点「选择字幕文件」导入（没有现成字幕可看顶部的「字幕从哪来？」）");
                setStage("error");
                return;
            }
            setPendingImport(null);
            setStage("segmenting");
            setStageDetail("正在划分幕与场（调用模型，约需几十秒）...");
            const { scenes } = await generateMovieSegmentation(movie, cues, companionId, movie.durationSeconds ?? 0);
            if (videoFile) {
                setStage("extracting");
                setStageDetail("正在预抽画面关键帧...");
                await extractSceneFrames(videoFile, scenes, movie.id, (done, total) => {
                    setStageDetail(`预抽画面关键帧...（${done}/${total} 场）`);
                });
            }
            await saveProgress({
                movieId: movie.id,
                positionSeconds: (await loadProgress(movie.id))?.positionSeconds ?? 0,
                companionCharacterId: companionId,
                segmented: true,
                lastWatchAt: new Date().toISOString(),
            });
            setStage("idle");
            await refresh();
            onOpenMovie(movie);
        } catch (err) {
            setStage("error");
            setErrorMsg(err instanceof Error ? err.message : String(err));
        }
    };

    const handleDelete = async (movie: Movie) => {
        await deleteMovie(movie.id);
        setDeleteConfirmId(null);
        await refresh();
    };

    const busy = stage === "decoding" || stage === "segmenting" || stage === "extracting";
    const pendingHasCues = pendingImport ? (cuesMap.get(pendingImport.movie.id) ?? false) : false;

    return (
        <div className="absolute inset-0 flex flex-col" style={{ background: "#0d0f1a", color: "#e8e9f0" }}>
            {/* 顶栏（顶部避让状态栏安全区，照 reading-shelf-header 模式） */}
            <div style={{ flex: "0 0 auto", paddingTop: "var(--page-header-safe-top, max(48px, env(safe-area-inset-top, 48px)))", background: "#0d0f1a", borderBottom: "1px solid #232636" }}>
                <div className="flex items-center gap-3 px-4" style={{ height: 48 }}>
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
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                {/* 隐藏文件输入：视频（新片/补视频共用）与字幕均由用户手势触发 */}
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
                    accept=".srt,.vtt,.ass,.ssa,text/plain"
                    style={{ display: "none" }}
                    onChange={e => { void handleSubtitlePicked(e.target.files?.[0] ?? null); e.target.value = ""; }}
                />

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
                <button
                    className="ts-14"
                    disabled={busy}
                    onClick={() => { videoPickTargetRef.current = "new"; videoInputRef.current?.click(); }}
                    style={{
                        width: "100%", padding: "12px 0", borderRadius: 12,
                        background: busy ? "#232636" : "linear-gradient(135deg, #6c5ce7, #a29bfe)",
                        color: busy ? "#8f93a8" : "#fff", border: "none", cursor: busy ? "default" : "pointer", fontWeight: 600,
                    }}
                >＋ 导入影片（本地视频）</button>

                {/* 进度 / 错误提示 */}
                {busy && (
                    <div className="ts-14" style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#1a1d2c", color: "#a29bfe" }}>
                        {stageDetail}
                    </div>
                )}
                {stage === "error" && (
                    <div className="ts-14" style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "#2c1a1e", color: "#e08a95", lineHeight: 1.6 }}>
                        {errorMsg}
                        <button className="ts-14" onClick={() => { setStage("idle"); setErrorMsg(""); }} style={{ marginLeft: 8, background: "none", border: "none", color: "#8f93a8", cursor: "pointer" }}>关闭</button>
                    </div>
                )}

                {/* 字幕帮助 */}
                {showHelp && (
                    <div className="ts-14" style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#1a1d2c", color: "#b6b9c9", lineHeight: 1.8 }}>
                        <p style={{ fontWeight: 600, color: "#e8e9f0" }}>给视频配字幕的三种方式：</p>
                        <p>1. 下载现成字幕：SubHD、字幕库、OpenSubtitles 按资源名搜 SRT 文件；</p>
                        <p>2. 没有字幕就用电脑上的「卡卡字幕助手」（已装好，命令 videocaptioner）或手机剪映：智能字幕 → 语音转字幕 → 导出 SRT；</p>
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
                        const hasCues = cuesMap.get(movie.id) ?? false;
                        const segmented = p?.segmented ?? false;
                        const watched = (p?.positionSeconds ?? 0) > 0;
                        return (
                            <div key={movie.id} style={{ borderRadius: 12, background: "#1a1d2c", padding: "12px 14px" }}>
                                <div className="flex items-center gap-3">
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div className="ts-14" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{movie.title}</div>
                                        <div className="ts-14" style={{ color: "#8f93a8", marginTop: 2 }}>
                                            {formatDuration(movie.durationSeconds)}
                                            {segmented ? ` · ${sceneCount} 场` : " · 未分段"}
                                            {hasCues ? " · 有字幕" : " · 无字幕"}
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
                                        onClick={() => (deleteConfirmId === movie.id ? void handleDelete(movie) : setDeleteConfirmId(movie.id))}
                                        style={{
                                            padding: "6px 10px", borderRadius: 8, cursor: "pointer",
                                            background: deleteConfirmId === movie.id ? "#c0392b" : "none",
                                            border: "1px solid #2c3046",
                                            color: deleteConfirmId === movie.id ? "#fff" : "#8f93a8",
                                        }}
                                    >{deleteConfirmId === movie.id ? "确认删除" : "删除"}</button>
                                </div>
                                {/* 未就绪时的引导操作 */}
                                {(!segmented || !hasCues) && (
                                    <div className="flex items-center gap-2" style={{ marginTop: 10 }}>
                                        {!hasCues && (
                                            <button
                                                className="ts-14"
                                                disabled={busy}
                                                onClick={() => { setPendingImport({ movie, videoFile: null }); }}
                                                style={{ padding: "5px 12px", borderRadius: 8, background: "#2c3046", color: "#e8e9f0", border: "none", cursor: "pointer" }}
                                            >导入字幕</button>
                                        )}
                                        {hasCues && !segmented && (
                                            <button
                                                className="ts-14"
                                                disabled={busy}
                                                onClick={() => { videoPickTargetRef.current = movie.id; videoInputRef.current?.click(); }}
                                                style={{ padding: "5px 12px", borderRadius: 8, background: "#2c3046", color: "#e8e9f0", border: "none", cursor: "pointer" }}
                                            >生成分段（需重选视频文件）</button>
                                        )}
                                        {!hasCues && (
                                            <span className="ts-14" style={{ color: "#565b73" }}>分段需要字幕，char 靠它理解剧情</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* 隐私说明 */}
                <div className="ts-14" style={{ marginTop: 20, color: "#565b73", lineHeight: 1.7 }}>
                    视频文件保存在你的设备原处，观影不会复制或上传它；每次观看时需重新选择一次文件。库里只存分段摘要、字幕与画面帧（约几 MB）。
                </div>
            </div>

            {/* 导入决策框：选完视频后出现，字幕选择由按钮手势触发 */}
            {pendingImport && (
                <div
                    style={{
                        position: "absolute", inset: 0, zIndex: 50,
                        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
                        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
                    }}
                    onClick={() => setPendingImport(null)}
                >
                    <div
                        style={{
                            width: "min(380px, 92%)", background: "#141622", border: "1px solid #2c3046",
                            borderRadius: 16, padding: "16px 18px",
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="ts-16" style={{ fontWeight: 600, marginBottom: 6 }}>《{pendingImport.movie.title}》</div>
                        <div className="ts-14" style={{ color: "#b6b9c9", lineHeight: 1.7, marginBottom: 14 }}>
                            {pendingHasCues
                                ? "已有字幕。可以现在生成分段，也可以重新选择字幕文件覆盖。"
                                : "视频已就绪。char 靠字幕理解剧情——建议先导入字幕文件（SRT/ASS/VTT），没有的话看看顶部的「字幕从哪来？」。"}
                        </div>
                        {stage === "error" && errorMsg && (
                            <div className="ts-14" style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 8, background: "#2c1a1e", color: "#e08a95", lineHeight: 1.6 }}>
                                {errorMsg}
                            </div>
                        )}
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <button
                                className="ts-14"
                                disabled={busy}
                                onClick={() => subtitleInputRef.current?.click()}
                                style={{ padding: "10px 0", borderRadius: 10, background: "#2c3046", color: "#e8e9f0", border: "none", cursor: "pointer" }}
                            >{pendingHasCues ? "重新选择字幕文件" : "选择字幕文件（推荐）"}</button>
                            {pendingHasCues && (
                                <button
                                    className="ts-14"
                                    disabled={busy}
                                    onClick={() => void runSegmentation(pendingImport)}
                                    style={{ padding: "10px 0", borderRadius: 10, background: "linear-gradient(135deg, #6c5ce7, #a29bfe)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
                                >生成分段并抽帧</button>
                            )}
                            <button
                                className="ts-14"
                                disabled={busy}
                                onClick={() => setPendingImport(null)}
                                style={{ padding: "8px 0", borderRadius: 10, background: "none", color: "#8f93a8", border: "none", cursor: "pointer" }}
                            >稍后再说（影片已存入片架）</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
