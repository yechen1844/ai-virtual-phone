"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { loadProgress, saveProgress, loadScenes, loadCues, loadDanmaku } from "@/lib/movie-storage";
import { findCurrentScene, generateMovieDanmaku } from "@/lib/movie-engine";
import { loadCharacters } from "@/lib/character-storage";
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
    // 影院模式：portal 到 body 的铺满视口层（脱离 float 虚拟手机边框），横竖屏自适应；暂停时显示顶栏
    const [cinema, setCinema] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [danmakuList, setDanmakuList] = useState<MovieDanmaku[]>([]);
    const [generatingSceneIdx, setGeneratingSceneIdx] = useState<number | null>(null);
    const [danmakuNotice, setDanmakuNotice] = useState("");
    // 长按三倍速
    const [speedActive, setSpeedActive] = useState(false);

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
    const pressTimerRef = useRef<number | null>(null);
    const rateRef = useRef(1);
    // 影院模式切换时移交播放状态：新 video 元素加载后跳回原位置并恢复播放
    const pendingSeekRef = useRef<number | null>(null);
    const pendingPlayRef = useRef(false);

    scenesRef.current = scenes;
    danmakuRef.current = danmakuList;
    companionIdRef.current = companionId;

    const companionName = loadCharacters().find(c => c.id === companionId)?.name ?? "讨论";
    const currentScene = findCurrentScene(scenes, position);

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

    const showNotice = useCallback((text: string) => {
        setDanmakuNotice(text);
        window.setTimeout(() => setDanmakuNotice(""), 4000);
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

    const finishDanmakuGeneration = useCallback((items: MovieDanmaku[]) => {
        if (items.length > 0) {
            setDanmakuList(prev => [...prev, ...items].sort((a, b) => a.timeSeconds - b.timeSeconds));
            showNotice(`已生成 ${items.length} 条弹幕`);
        } else {
            showNotice("本场没有生成弹幕，可稍后手动重试");
        }
    }, [showNotice]);

    // ── 进新场自动生成弹幕（该场一条都没有时才触发，控成本）──
    const maybeAutoGenerate = useCallback((scene: MovieScene) => {
        if (generatingSceneRef.current !== null) return;
        if (!companionIdRef.current) return;
        if (danmakuRef.current.some(d => d.timeSeconds >= scene.startSeconds && d.timeSeconds < scene.endSeconds)) return;
        generatingSceneRef.current = scene.index;
        setGeneratingSceneIdx(scene.index);
        void generateMovieDanmaku(movie, scene, companionIdRef.current)
            .then(finishDanmakuGeneration)
            .catch((err: unknown) => {
                showNotice(`弹幕生成失败：${err instanceof Error ? err.message : String(err)}`);
            })
            .finally(() => {
                generatingSceneRef.current = null;
                setGeneratingSceneIdx(null);
            });
    }, [movie, showNotice, finishDanmakuGeneration]);

    // 换幕即触发（React effect 监听，比挂在 timeupdate 上可靠；companionId 异步加载完成后也要补跑一次）
    const currentSceneIdx = currentScene?.index ?? -1;
    useEffect(() => {
        if (needFile) return;
        if (currentSceneIdx < 0) return;
        if (!companionId) return;
        const scene = scenes.find(s => s.index === currentSceneIdx);
        if (scene) maybeAutoGenerate(scene);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentSceneIdx, needFile, companionId]);

    // ── 手动生成当前场弹幕 ──
    const handleGenerateDanmaku = useCallback(() => {
        if (!companionIdRef.current) {
            showNotice("先在片架选择陪伴角色，才能生成她的弹幕");
            return;
        }
        const scene = findCurrentScene(scenesRef.current, positionRef.current);
        if (!scene || generatingSceneRef.current !== null) return;
        generatingSceneRef.current = scene.index;
        setGeneratingSceneIdx(scene.index);
        void generateMovieDanmaku(movie, scene, companionIdRef.current)
            .then(finishDanmakuGeneration)
            .catch((err: unknown) => {
                showNotice(`弹幕生成失败：${err instanceof Error ? err.message : String(err)}`);
            })
            .finally(() => {
                generatingSceneRef.current = null;
                setGeneratingSceneIdx(null);
            });
    }, [movie, showNotice, finishDanmakuGeneration]);

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
    }, [movie.id, companionId, spawnDanmaku]);

    const handleSeeking = useCallback(() => {
        spawnedRef.current = new Set(
            [...spawnedRef.current].filter(id => {
                const d = danmakuRef.current.find(x => x.id === id);
                return d && d.timeSeconds <= (videoRef.current?.currentTime ?? 0);
            }),
        );
        if (danmakuLayerRef.current) danmakuLayerRef.current.innerHTML = "";
    }, []);

    // 视频加载完成后：跳到移交位置（影院模式切换）或上次观看到的位置
    const handleLoadedMetadata = () => {
        const video = videoRef.current;
        if (!video) return;
        const seek = pendingSeekRef.current ?? (positionRef.current > 1 ? positionRef.current : 0);
        pendingSeekRef.current = null;
        if (seek > 0) video.currentTime = seek;
        if (pendingPlayRef.current) {
            pendingPlayRef.current = false;
            void video.play().catch(() => {});
        }
    };

    const handleFilePicked = (file: File | null) => {
        if (!file) return;
        setFileError("");
        const url = URL.createObjectURL(file);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setVideoUrl(url);
        setNeedFile(false);
    };

    // ── 影院模式切换：移交播放位置与播放状态，portal 到 body 铺满真实视口 ──
    const toggleCinema = useCallback(async () => {
        const video = videoRef.current;
        if (video) {
            pendingSeekRef.current = video.currentTime;
            pendingPlayRef.current = !video.paused;
        }
        const next = !cinema;
        setCinema(next);
        if (next && typeof document !== "undefined" && !document.fullscreenElement) {
            // 尝试系统级全屏（隐藏浏览器 UI / 壳层状态栏）；失败则纯应用内铺满
            window.setTimeout(() => {
                void videoAreaRef.current?.requestFullscreen?.().catch(() => {});
            }, 50);
        }
    }, [cinema]);

    // 系统手势退出全屏时保持影院模式不丢状态（portal 层仍铺满视口）
    useEffect(() => {
        const onFsChange = () => { /* no-op：影院层不依赖 fullscreen 状态 */ };
        document.addEventListener("fullscreenchange", onFsChange);
        return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    // 长按三倍速
    const clearPressTimer = useCallback(() => {
        if (pressTimerRef.current !== null) {
            window.clearTimeout(pressTimerRef.current);
            pressTimerRef.current = null;
        }
        const video = videoRef.current;
        if (speedActive && video) {
            video.playbackRate = rateRef.current;
            setSpeedActive(false);
        }
    }, [speedActive]);

    const handleAreaPointerDown = useCallback((e: React.PointerEvent) => {
        if (needFile) return;
        const rect = videoAreaRef.current?.getBoundingClientRect();
        const video = videoRef.current;
        if (!video || video.paused) return;
        if (rect && e.clientY > rect.bottom - 64) return;
        clearPressTimer();
        pressTimerRef.current = window.setTimeout(() => {
            const v = videoRef.current;
            if (v && !v.paused) {
                rateRef.current = v.playbackRate || 1;
                v.playbackRate = 3;
                setSpeedActive(true);
            }
        }, 450);
    }, [needFile, clearPressTimer]);

    const handleAreaPointerUp = useCallback(() => {
        clearPressTimer();
    }, [clearPressTimer]);

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

    // ── 陪伴角色选择（可随时查看/更换，不需重新分段）──
    const [showCompanionPick, setShowCompanionPick] = useState(false);
    const characters = loadCharacters();
    const handlePickCompanion = (id: string) => {
        setCompanionId(id);
        setShowCompanionPick(false);
        void saveProgress({
            movieId: movie.id,
            positionSeconds: positionRef.current,
            companionCharacterId: id,
            segmented: true,
            lastWatchAt: new Date().toISOString(),
        });
    };

    // 陪伴选择弹层（放进 overlayJsx，普通视图与影院层都可用）
    const companionPickerJsx = showCompanionPick && (
        <div
            onClick={() => setShowCompanionPick(false)}
            style={{ position: "absolute", inset: 0, zIndex: 45, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
            <div
                onClick={e => e.stopPropagation()}
                style={{ width: "min(300px, 84%)", maxHeight: "70%", overflowY: "auto", background: "#161927", border: "1px solid #2c3046", borderRadius: 14, padding: 14 }}
            >
                <p className="ts-14" style={{ fontWeight: 600, marginBottom: 10 }}>选择陪你观影的角色</p>
                {characters.map(c => (
                    <button
                        key={c.id}
                        onClick={() => handlePickCompanion(c.id)}
                        style={{
                            display: "block", width: "100%", textAlign: "left", marginBottom: 6,
                            padding: "9px 12px", borderRadius: 10,
                            background: c.id === companionId ? "#6c5ce7" : "#1f2334",
                            color: c.id === companionId ? "#fff" : "#c9cce0",
                            border: "none", cursor: "pointer",
                        }}
                    >
                        <span className="ts-14">{c.name}{c.id === companionId ? " · 当前" : ""}</span>
                    </button>
                ))}
                <button
                    className="ts-14"
                    onClick={() => setShowCompanionPick(false)}
                    style={{ width: "100%", marginTop: 4, padding: "8px 0", borderRadius: 10, background: "none", border: "1px solid #2c3046", color: "#8f93a8", cursor: "pointer" }}
                >取消</button>
            </div>
        </div>
    );

    // 共用的视频元素（同一时刻只挂载一份：普通视图或影院层）
    const videoJsx = needFile ? null : (
        <video
            ref={videoRef}
            src={videoUrl ?? undefined}
            controls
            playsInline
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={handleTimeUpdate}
            onSeeking={handleSeeking}
            onLoadedMetadata={handleLoadedMetadata}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
    );

    // 共用的视频区子层：弹幕层 / 场景指示 / 倍速指示 / 提示
    const overlayJsx = (
        <>
            <div ref={danmakuLayerRef} style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }} />
            {!needFile && currentScene && (
                <div
                    className="ts-14"
                    style={{
                        position: "absolute", top: 8, left: 10,
                        padding: "6px 10px", borderRadius: 8,
                        background: "rgba(13,15,26,0.72)", color: "#c9cce0",
                        pointerEvents: "none",
                    }}
                >
                    第{currentScene.index + 1}场 {currentScene.title} · {formatSeconds(position)}
                    {generatingSceneIdx === currentScene.index && <span style={{ color: "#a29bfe" }}> · 弹幕生成中…</span>}
                </div>
            )}
            {speedActive && (
                <div
                    className="ts-14"
                    style={{
                        position: "absolute", top: "42%", left: "50%", transform: "translate(-50%, -50%)",
                        padding: "10px 18px", borderRadius: 999,
                        background: "rgba(13,15,26,0.8)", color: "#a29bfe",
                        fontWeight: 700, pointerEvents: "none",
                    }}
                >3× 倍速中</div>
            )}
            {danmakuNotice && (
                <div className="ts-14" style={{ position: "absolute", bottom: 12, left: 12, padding: "6px 10px", borderRadius: 8, background: "rgba(13,15,26,0.8)", color: "#a29bfe", pointerEvents: "none" }}>
                    {danmakuNotice}
                </div>
            )}
            {companionPickerJsx}
        </>
    );

    const videoAreaHandlers = {
        onPointerDown: handleAreaPointerDown,
        onPointerUp: handleAreaPointerUp,
        onPointerCancel: handleAreaPointerUp,
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    };

    // 顶栏按钮
    const barButtons = (
        <>
            <button className="ts-14" onClick={onBack} style={{ background: "none", border: "none", color: "#8f93a8", padding: "4px 8px", cursor: "pointer" }}>‹ 片架</button>
            <span className="ts-14" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{movie.title}</span>
            <div style={{ flex: 1 }} />
            <button className="ts-14" onClick={() => setShowCompanionPick(true)} style={{ background: "none", border: "1px solid #2c3046", color: companionId ? "#a29bfe" : "#e08a95", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>陪伴{companionName ? `·${companionName.slice(0, 4)}` : "未选"}</button>
            {scenes.length > 0 && (
                <button className="ts-14" onClick={() => setShowSegments(true)} style={{ background: "none", border: "1px solid #2c3046", color: "#8f93a8", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>分段</button>
            )}
            <button className="ts-14" onClick={() => void toggleCinema()} style={{ background: "none", border: "1px solid #2c3046", color: "#8f93a8", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>{cinema ? "退出全屏" : "全屏"}</button>
        </>
    );

    // 讨论 UI（悬浮球 + 点外关闭 + 面板）：普通视图与影院层共用同一实例
    const discussionJsx = (
        <>
            {!showDiscuss && !needFile && (
                <button
                    onClick={handleToggleDiscuss}
                    style={{
                        position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                        width: 52, height: 52, borderRadius: "50%", zIndex: 25,
                        background: "linear-gradient(135deg, #6c5ce7, #a29bfe)",
                        color: "#fff", border: "2px solid rgba(255,255,255,0.25)",
                        cursor: "pointer", fontWeight: 600, fontSize: 12,
                        boxShadow: "0 4px 14px rgba(0,0,0,0.45)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        lineHeight: 1.2, padding: 4, wordBreak: "break-all",
                    }}
                >{companionName.slice(0, 4)}</button>
            )}
            {showDiscuss && (
                <div
                    onClick={handleToggleDiscuss}
                    style={{ position: "absolute", inset: 0, zIndex: 29, background: "rgba(0,0,0,0.15)" }}
                />
            )}
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
                visible={showDiscuss}
            />
        </>
    );

    // 影院层（portal 到 body）：铺满真实视口，横竖屏自适应，暂停时显示顶栏
    const cinemaLayer = cinema && typeof document !== "undefined" ? createPortal(
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "#000", display: "flex", flexDirection: "column" }}>
            <div
                ref={videoAreaRef}
                {...videoAreaHandlers}
                style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", overflow: "hidden", userSelect: "none", WebkitUserSelect: "none" }}
            >
                {videoJsx}
                {overlayJsx}
            </div>
            {/* 顶栏浮层：暂停时显示，播放时隐藏 */}
            {!playing && (
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 40, paddingTop: "max(18px, env(safe-area-inset-top, 18px))", background: "rgba(13,15,26,0.92)", borderBottom: "1px solid #232636" }}>
                    <div className="flex items-center gap-3 px-4" style={{ height: 48 }}>{barButtons}</div>
                </div>
            )}
            {discussionJsx}
        </div>,
        document.body,
    ) : null;

    return (
        <div className="absolute inset-0 flex flex-col" style={{ background: "#000", color: "#e8e9f0" }}>
            {/* 顶栏 */}
            <div style={{ flex: "0 0 auto", paddingTop: "var(--page-header-safe-top, max(48px, env(safe-area-inset-top, 48px)))", background: "#0d0f1a", borderBottom: "1px solid #232636" }}>
                <div className="flex items-center gap-3 px-4" style={{ height: 48 }}>{barButtons}</div>
            </div>

            {/* 视频区 / 影院模式占位 */}
            {cinema ? (
                <div
                    onClick={() => void toggleCinema()}
                    style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#565b73" }}
                >
                    <span className="ts-14">正在以影院模式播放，点这里返回</span>
                </div>
            ) : (
                <div
                    ref={videoAreaRef}
                    {...videoAreaHandlers}
                    style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", overflow: "hidden", userSelect: "none", WebkitUserSelect: "none" }}
                >
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
                    ) : videoJsx}
                    {overlayJsx}
                </div>
            )}

            {cinemaLayer}

            {/* 讨论 UI：普通视图（非影院模式时挂载） */}
            {!cinema && discussionJsx}

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
