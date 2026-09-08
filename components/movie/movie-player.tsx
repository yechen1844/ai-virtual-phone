"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { loadProgress, saveProgress, loadScenes, loadCues } from "@/lib/movie-storage";
import { findCurrentScene } from "@/lib/movie-engine";
import type { Movie, MovieScene, SubtitleCue } from "@/lib/movie-types";
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
    const videoRef = useRef<HTMLVideoElement>(null);
    const objectUrlRef = useRef<string | null>(null);
    const lastSavedRef = useRef(0);
    const positionRef = useRef(0);

    // 加载进度 / 场次 / 字幕
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
        })();
        return () => {
            cancelled = true;
        };
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

    const handleFilePicked = (file: File | null) => {
        if (!file) return;
        setFileError("");
        const url = URL.createObjectURL(file);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        setVideoUrl(url);
        setNeedFile(false);
    };

    const handleTimeUpdate = useCallback(() => {
        const video = videoRef.current;
        if (!video) return;
        positionRef.current = video.currentTime;
        setPosition(video.currentTime);
        // 节流保存：每 5 秒
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
    }, [movie.id, companionId]);

    const handleSeekToSaved = () => {
        const video = videoRef.current;
        if (video && positionRef.current > 1) {
            video.currentTime = positionRef.current;
        }
    };

    const currentScene = findCurrentScene(scenes, position);

    return (
        <div className="absolute inset-0 flex flex-col" style={{ background: "#000", color: "#e8e9f0" }}>
            {/* 顶栏 */}
            <div className="flex items-center gap-3 px-4" style={{ height: 48, background: "#0d0f1a", borderBottom: "1px solid #232636" }}>
                <button className="ts-14" onClick={onBack} style={{ background: "none", border: "none", color: "#8f93a8", padding: "4px 8px", cursor: "pointer" }}>‹ 片架</button>
                <span className="ts-14" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{movie.title}</span>
                <div style={{ flex: 1 }} />
                {scenes.length > 0 && (
                    <button className="ts-14" onClick={() => setShowSegments(true)} style={{ background: "none", border: "1px solid #2c3046", color: "#8f93a8", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}>分段</button>
                )}
                <button
                    className="ts-14"
                    onClick={() => setShowDiscuss(v => !v)}
                    style={{ background: showDiscuss ? "#6c5ce7" : "none", border: "1px solid #2c3046", color: showDiscuss ? "#fff" : "#8f93a8", borderRadius: 8, padding: "4px 10px", cursor: "pointer" }}
                >讨论</button>
            </div>

            {/* 视频区 */}
            <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", justifyContent: "center", background: "#000", overflow: "hidden" }}>
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
                        onLoadedMetadata={handleSeekToSaved}
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                    />
                )}

                {/* 当前场指示 */}
                {!needFile && currentScene && (
                    <div
                        className="ts-14"
                        style={{
                            position: "absolute", top: 10, left: 10, right: 10,
                            padding: "6px 10px", borderRadius: 8,
                            background: "rgba(13,15,26,0.72)", color: "#c9cce0",
                            pointerEvents: "none", backdropFilter: "blur(6px)",
                        }}
                    >
                        第{currentScene.index + 1}场 {currentScene.title} · {formatSeconds(position)}
                    </div>
                )}
            </div>

            {/* 讨论悬浮窗 */}
            {showDiscuss && (
                <MovieDiscussPanel
                    movie={movie}
                    cues={cues}
                    companionId={companionId}
                    getPosition={() => positionRef.current}
                    onClose={() => setShowDiscuss(false)}
                />
            )}

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
