"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { loadProgress, saveProgress, loadScenes, loadCues, loadDanmaku } from "@/lib/movie-storage";
import { findCurrentScene, generateMovieDanmaku } from "@/lib/movie-engine";
import type { Movie, MovieScene, SubtitleCue, MovieDanmaku } from "@/lib/movie-types";
import { MovieDiscussPanel } from "./movie-discuss-panel";
import { MovieSegmentDialog } from "./movie-segment-dialog";

type Props = {
    movie: Movie;
    onBack: () => void;
};

function formatSeconds(total: number): string {
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const DANMAKU_LANES = 5;
const DANMAKU_DURATION_MS = 9000;

export function MoviePlayer({ movie, onBack }: Props) {
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    const [needFile, setNeedFile] = useState(true);
    const [fileError, setFileError] = useState("");
    const [position, setPosition] = useState(0);
    const [scenes, setScenes] = useState<MovieScene[]>([]);
    const [cues, setCues] = useState<SubtitleCue[]>([]);
    const [companionId, setCompanionId] = useState("");
    const [showDiscuss, setShowDiscuss] = useState(false);
    const [showSegments, setShowSegments] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [danmakuList, setDanmakuList] = useState<MovieDanmaku[]>([]);
    const [generatingSceneIdx, setGeneratingSceneIdx] = useState<number | null>(null);
    const [danmakuNotice, setDanmakuNotice] = useState("");
    const videoRef = useRef<HTMLVideoElement>(null);
    const videoAreaRef = useRef<HTMLDivElement>(null);
    const danmakuLayerRef = useRef<HTMLDivElement>(null);
    const objectUrlRef = useRef<string | null>(null);
    const lastSavedRef = useRef(0);
    const positionRef = useRef(0);
    const spawnedRef = useRef<Set<string>>(new Set());
    const laneRef = useRef(0);
    const scenesRef = useRef<MovieScene[]>([]);
    const danmakuRef = useRef<MovieDanmaku[]>([]);
    const generatingSceneRef = useRef<number | null>(null);
    const companionIdRef = useRef("");
    const cuesRef = useRef<SubtitleCue[]>([]);
    const showDiscussRef = useRef(false);

    scenesRef.current = scenes;
    danmakuRef.current = danmakuList;
    cuesRef.current = cues;
    companionIdRef.current = companionId;
    showDiscussRef.current = showDiscuss;

    // 加载进度 / 场次 / 字幕 / 弹幕
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const progress = await loadProgress(movie.id);
            if (cancelled) return;
            setCompanionId(progress?.companionCharacterId ?? "");
            setPosition(progress?.positionSeconds ?? 0);
            positionRef.current = progress?.positionSeconds ?? 0;
            setScenes(await loadScenes(movie.id));
            setCues(await loadCues(movie.id));
            setDanmakuList(await loadDanmaku(movie.id));
        })();
        return () => { cancelled = true; };
    }, [movie.id]);

    // 卸载时释放 objectURL 并保存进度
    useEffect(() => {
        return () => {
            if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
            if (positionRef.current > 0) {
                void saveProgress({
                    movieId: movie.id,
                    positionSeconds: positionRef.current,
                    companionCharacterId: companionId || undefined,
                    segmented: true,
                    lastWatchAt: new Date().toISOString(),
                });
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [movie.id]);

    // 全屏状态监听
    useEffect(() => {
        const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener("fullscreenchange", onFsChange);
        return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    const handleFilePicked = (file: File | null) => {
        if (!file) return;
        setFileError("");
        const url = URL.createObjectURL(file);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setVideoUrl(url);
        setNeedFile(false);
    };

    const toggleFullscreen = useCallback(() => {
        const el = videoAreaRef.current;
        if (!el) return;
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => {});
        } else {
            void el.requestFullscreen?.().catch(() => {
                // WebView 兜底：尝试 video 元素自身的原生全屏
                const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
                v?.webkitEnterFullscreen?.();
            });
        }
    }, []);

    // ── 弹幕：spawn 一条到 overlay（命令式 DOM + WAAPI，重渲染零开销）──
    const spawnDanmaku = useCallback((d: MovieDanmaku) => {
        const layer = danmakuLayerRef.current;
        if (!layer) return;
        const lane = laneRef.current % DANMAKU_LANES;
        laneRef.current += 1;
        const el = document.createElement("div");
        el.textContent = `${d.characterName}：${d.content}`;
        el.style.cssText = [
            "position:absolute",
            `top:${8 + lane * 26}px`,
            "left:100%",
            "white-space:nowrap",
            "font-size:13px",
            "font-weight:600",
            "color:#fff",
            "text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 4px rgba(0,0,0,.7)",
            "padding:2px 8px",
            "border-radius:10px",
            "background:rgba(13,15,26,.45)",
            "will-change:transform",
            "pointer-events:none",
        ].join(";");
        layer.appendChild(el);
        const travel = layer.clientWidth + el.offsetWidth + 24;
        const anim = el.animate(
            [{ transform: "translateX(0)" }, { transform: `translateX(-${travel}px)` }],
            { duration: DANMAKU_DURATION_MS, easing: "linear" },
        );
        anim.onfinish = () => el.remove();
        anim.oncancel = () => el.remove();
    }, []);

    // ── 进新场自动生成弹幕（该场一条都没有时才触发，控成本）──
    const maybeAutoGenerate = useCallback((scene: MovieScene) => {
        if (generatingSceneRef.current !== null) return;
        if (!companionIdRef.current) return;
        if (danmakuRef.current.some(d => d.timeSeconds >= scene.startSeconds && d.timeSeconds < scene.endSeconds)) return;
        generatingSceneRef.current = scene.index;
        setGeneratingSceneIdx(scene.index);
        void generateMovieDanmaku(movie, scene, companionIdRef.current)
            .then(items => {
                if (items.length > 0) {
                    setDanmakuList(prev => [...prev, ...items].sort((a, b) => a.timeSeconds - b.timeSeconds));
                    spawnedRef.current = new Set([...spawnedRef.current].filter(id => !items.some(it => it.id === id)));
                } else {
                    setDanmakuNotice("本场没有生成弹幕（可稍后手动重试）");
                    window.setTimeout(() => setDanmakuNotice(""), 4000);
                }
            })
            .catch(() => {
                setDanmakuNotice("弹幕生成失败，可稍后手动重试");
                window.setTimeout(() => setDanmakuNotice(""), 4000);
            })
            .finally(() => {
                generatingSceneRef.current = null;
                setGeneratingSceneIdx(null);
            });
    }, [movie]);

    const handleTimeUpdate = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        positionRef.current = video.currentTime;
        setPosition(video.currentTime);

        // 节流保存进度：每 5 秒
        if (video.currentTime - lastSavedRef.current >= 5) {
            lastSavedRef.current = video.currentTime;
            void saveProgress({
                movieId: movie.id,
                positionSeconds: video.currentTime,
                companionCharacterId: companionId || undefined,
                segmented: true,
                lastWatchAt: new Date().toISOString(),
            });
        }

        // 弹幕 spawn（含轻微时间窗，seek 后批量跳过的旧弹幕不补刷）
        for (const d of danmakuRef.current) {
            if (spawnedRef.current.has(d.id)) continue;
            if (d.timeSeconds <= video.currentTime && video.currentTime - d.timeSeconds < 6) {
                spawnedRef.current.add(d.id);
                spawnDanmaku(d);
            }
        }

        // 进新场 → 自动生成弹幕
        const scene = findCurrentScene(scenesRef.current, video.currentTime);
        if (scene && scene.index !== generatingSceneRef.current) {
            maybeAutoGenerate(scene);
        }
    }, [movie.id, companionId, spawnDanmaku, maybeAutoGenerate]);

    const handleSeeking = useCallback(() => {
        // seek 后重置：未来的弹幕重新可触发，屏幕上的立刻清空
        spawnedRef.current = spawnedRef.current && new Set(
            [...spawnedRef.current].filter(id => {
                const d = danmakuRef.current.find(x => x.id === id);
                return d && d.timeSeconds <= (videoRef.current?.currentTime ?? 0);
            }),
        );
        if (danmakuLayerRef.current) danmakuLayerRef.current.innerHTML = "";
    }, []);

    const handleSeekToSaved = () => {
        const video = videoRef.current;
        if (video && positionRef.current > 1) {
            video.currentTime = positionRef.current;
        }
    };

    const currentScene = findCurrentScene(scenes, position);

    // ── 手动生成当前场弹幕（弹幕栏按钮）──
    const handleGenerateDanmaku = useCallback(() => {
        const scene = findCurrentScene(scenesRef.current, positionRef.current);
        if (!scene || generatingSceneRef.current !== null) return;
        generatingSceneRef.current = scene.index;
        setGeneratingSceneIdx(scene.index);
        void generateMovieDanmaku(movie, scene, companionIdRef.current)
            .then(items => {
                if (items.length > 0) {
                    setDanmakuList(prev => [...prev, ...items].sort((a, b) => a.timeSeconds - b.timeSeconds));
                } else {
                    setDanmakuNotice("没有解析出弹幕，可稍后重试");
                    window.setTimeout(() => setDanmakuNotice(""), 4000);
                }
            })
            .catch(() => {
                setDanmakuNotice("弹幕生成失败，可稍后重试");
                window.setTimeout(() => setDanmakuNotice(""), 4000);
            })
            .finally(() => {
                generatingSceneRef.current = null;
                setGeneratingSceneIdx(null);
            });
    }, [movie]);

    // ── 讨论开关：打开暂停、关闭继续；面板常驻挂载（关掉也继续生成）──
    const handleToggleDiscuss = useCallback(() => {
        setShowDiscuss(prev => {
            const next = !prev;
            const video = videoRef.current;
            if (video) {
                if (next) video.pause();
                else void video.play().catch(() => {});
            }
            return next;
        });
    }, []);

    return (
        <div className="absolute inset-0 flex flex-col" style={{ background: "#000", color: "#e8e9f0" }}>
            {/* 顶栏（顶部避让状态栏安全区） */}
            <div style={{ flex: "0 0 auto", paddingTop: "var(--page-header-safe-top, max(48px, env(safe-area-inset-top, 48px)))", background: "#0d0f1a", borderBottom: "1px solid #232636" }}>
                <div className="flex items-center gap-3 px-4" style={{ height: 48 }}>
                    <button className="ts-14" onClick={onBack} style={{ background: "none", border: "none", color: "#8f93a8", padding: "4px 8px", cursor: "pointer" }}>‹ 片架</button>
                    <span className="ts-14" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{movie.title}</span>
                    <div style={{ flex: 1 }} />
                    {scenes.length > 0 && (
                        <button className="ts-14" onClick={() => setShowSegments(true)} style={{ background: "none", border: "1px solid #2c3046", color: "#8f93a8", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>分段</button>
                    )}
                    <button className="ts-14" onClick={toggleFullscreen} style={{ background: "none", border: "1px solid #2c3046", color: "#8f93a8", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>{isFullscreen ? "退出全屏" : "全屏"}</button>
                    <button
                        className="ts-14"
                        onClick={handleToggleDiscuss}
                        style={{ background: showDiscuss ? "#6c5ce7" : "none", border: "1px solid #2c3046", color: showDiscuss ? "#fff" : "#8f93a8", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}
                    >讨论</button>
                </div>
            </div>

            {/* 视频区（全屏目标容器） */}
            <div ref={videoAreaRef} style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", overflow: "hidden" }}>
                {needFile ? (
                    <div style={{ textAlign: "center", padding: 20 }}>
                        <p className="ts-14" style={{ color: "#8f93a8", marginBottom: 12 }}>选择这部电影的视频文件开始观看（文件仍在你的设备原处）</p>
                        <input
                            type="file"
                            accept="video/*,.mp4,.webm,.mov,.m4v"
                            id={`movie-file-${movie.id}`}
                            style={{ display: "none" }}
                            onChange={e => { handleFilePicked(e.target.files?.[0] ?? null); e.target.value = ""; }}
                        />
                        <button
                            className="ts-14"
                            onClick={() => document.getElementById(`movie-file-${movie.id}`)?.click()}
                            style={{ padding: "10px 24px", borderRadius: 10, background: "linear-gradient(135deg, #6c5ce7, #a29bfe)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
                        >选择视频文件</button>
                        {fileError && <p className="ts-14" style={{ color: "#e08a95", marginTop: 10 }}>{fileError}</p>}
                    </div>
                ) : (
                    <video
                        ref={videoRef}
                        src={videoUrl ?? undefined}
                        controls
                        playsInline
                        onTimeUpdate={handleTimeUpdate}
                        onSeeking={handleSeeking}
                        onLoadedMetadata={handleSeekToSaved}
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                    />
                )}

                {/* 弹幕层 */}
                <div
                    ref={danmakuLayerRef}
                    style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
                />

                {/* 当前场指示 */}
                {!needFile && currentScene && (
                    <div
                        className="ts-14"
                        style={{
                            position: "absolute", top: 8, left: 10,
                            padding: "6px 10px", borderRadius: 8,
                            background: "rgba(13,15,26,0.72)", color: "#c9cce0",
                            pointerEvents: "none", backdropFilter: "blur(6px)",
                        }}
                    >
                        第{currentScene.index + 1}场 {currentScene.title} · {formatSeconds(position)}
                        {generatingSceneIdx === currentScene.index && <span style={{ color: "#a29bfe" }}> · 弹幕生成中…</span>}
                    </div>
                )}

                {/* 弹幕提示 */}
                {danmakuNotice && (
                    <div className="ts-14" style={{ position: "absolute", bottom: 12, left: 12, padding: "6px 10px", borderRadius: 8, background: "rgba(13,15,26,0.8)", color: "#a29bfe", pointerEvents: "none" }}>
                        {danmakuNotice}
                    </div>
                )}
            </div>

            {/* 讨论面板：常驻挂载（隐藏时也继续生成），拖拽 + 弹幕栏 */}
            <div
                style={{
                    position: "absolute", inset: 0, zIndex: 30,
                    visibility: showDiscuss ? "visible" : "hidden",
                    pointerEvents: showDiscuss ? "auto" : "none",
                }}
            >
                <MovieDiscussPanel
                    movie={movie}
                    cues={cues}
                    companionId={companionId}
                    getPosition={() => positionRef.current}
                    sceneStart={currentScene?.startSeconds ?? 0}
                    sceneEnd={currentScene?.endSeconds ?? 0}
                    danmakuList={danmakuList}
                    generatingScene={generatingSceneIdx !== null}
                    onGenerateDanmaku={handleGenerateDanmaku}
                    onClose={handleToggleDiscuss}
                />
            </div>

            {/* 分段结构弹窗 */}
            {showSegments && (
                <MovieSegmentDialog
                    movie={movie}
                    scenes={scenes}
                    onClose={() => setShowSegments(false)}
                />
            )}
        </div>
    );
}
