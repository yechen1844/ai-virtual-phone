"use client";

import { useEffect, useState } from "react";
import { loadActs, loadScenes } from "@/lib/movie-storage";
import type { Movie, MovieAct, MovieScene } from "@/lib/movie-types";

type Props = {
    movie: Movie;
    scenes: MovieScene[];
    onClose: () => void;
};

function formatSeconds(total: number): string {
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MovieSegmentDialog({ movie, scenes, onClose }: Props) {
    const [acts, setActs] = useState<MovieAct[]>([]);

    useEffect(() => {
        void loadActs(movie.id).then(setActs);
    }, [movie.id]);

    return (
        <div
            style={{
                position: "absolute", inset: 0, zIndex: 40,
                background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
                display: "flex", alignItems: "center", justifyContent: "center",
            }}
            onClick={onClose}
        >
            <div
                style={{
                    width: "min(400px, 92%)", maxHeight: "80%",
                    background: "#141622", border: "1px solid #2c3046", borderRadius: 16,
                    display: "flex", flexDirection: "column", overflow: "hidden",
                }}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center gap-2" style={{ padding: "12px 14px", borderBottom: "1px solid #232636" }}>
                    <span className="ts-14" style={{ fontWeight: 600 }}>分段结构 · {movie.title}</span>
                    <div style={{ flex: 1 }} />
                    <button className="ts-14" onClick={onClose} style={{ background: "none", border: "none", color: "#8f93a8", cursor: "pointer" }}>✕</button>
                </div>
                <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
                    {scenes.length === 0 && (
                        <div className="ts-14" style={{ color: "#565b73", textAlign: "center", padding: 20 }}>尚未分段</div>
                    )}
                    {acts.map(act => {
                        const actScenes = scenes.filter(s => s.actIndex === act.index);
                        return (
                            <div key={act.id} style={{ marginBottom: 16 }}>
                                <div className="ts-14" style={{ fontWeight: 600, color: "#a29bfe", marginBottom: 8 }}>{act.title}</div>
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    {actScenes.map(scene => (
                                        <div key={scene.id} style={{ padding: "10px 12px", borderRadius: 10, background: "#1a1d2c" }}>
                                            <div className="ts-14" style={{ fontWeight: 600 }}>
                                                第{scene.index + 1}场 {scene.title}
                                                <span style={{ color: "#565b73", fontWeight: 400, marginLeft: 8 }}>
                                                    {formatSeconds(scene.startSeconds)}-{formatSeconds(scene.endSeconds)}
                                                </span>
                                            </div>
                                            <div className="ts-14" style={{ color: "#b6b9c9", marginTop: 4, lineHeight: 1.6 }}>{scene.summary}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                    {/* 未归幕的场（模型漏标幕时兜底显示） */}
                    {acts.length > 0 && scenes.some(s => !acts.some(a => a.index === s.actIndex)) && (
                        <div>
                            <div className="ts-14" style={{ fontWeight: 600, color: "#a29bfe", marginBottom: 8 }}>其他</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {scenes.filter(s => !acts.some(a => a.index === s.actIndex)).map(scene => (
                                    <div key={scene.id} style={{ padding: "10px 12px", borderRadius: 10, background: "#1a1d2c" }}>
                                        <div className="ts-14" style={{ fontWeight: 600 }}>
                                            第{scene.index + 1}场 {scene.title}
                                            <span style={{ color: "#565b73", fontWeight: 400, marginLeft: 8 }}>
                                                {formatSeconds(scene.startSeconds)}-{formatSeconds(scene.endSeconds)}
                                            </span>
                                        </div>
                                        <div className="ts-14" style={{ color: "#b6b9c9", marginTop: 4, lineHeight: 1.6 }}>{scene.summary}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
