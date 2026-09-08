"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createOrGetSession, loadChatMessages, pushChatMessage, isMovieDiscussMessage, type ChatMessage } from "@/lib/chat-storage";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { loadCharacters } from "@/lib/character-storage";
import { buildMovieDiscussContext, generateMovieChat } from "@/lib/movie-engine";
import { saveDanmaku } from "@/lib/movie-storage";
import type { Movie, SubtitleCue } from "@/lib/movie-types";

type Props = {
    movie: Movie;
    cues: SubtitleCue[];
    companionId: string;
    getPosition: () => number;
    onClose: () => void;
};

export function MovieDiscussPanel({ movie, cues, companionId, getPosition, onClose }: Props) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [chatting, setChatting] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);

    const companion = loadCharacters().find(c => c.id === companionId);

    const reload = useCallback(() => {
        if (!companionId) return;
        const session = createOrGetSession(companionId);
        setMessages(loadChatMessages(session.id).filter(isMovieDiscussMessage));
    }, [companionId]);

    useEffect(() => {
        reload();
    }, [reload]);

    // 新消息自动滚底
    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length, chatting]);

    const handleSend = async () => {
        const text = input.trim();
        if (!text || !companionId || chatting) return;
        setInput("");

        const session = createOrGetSession(companionId);
        const positionSeconds = getPosition();
        const m = Math.floor(positionSeconds / 60);
        const s = Math.floor(positionSeconds % 60);
        const timeLabel = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

        // 用户消息：origin 标记 + 片名/播放位置锚点（短期记忆边界用）
        const userMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: text,
            origin: "movie_discuss",
            mediaData: {
                movieTitle: movie.title,
                moviePositionSeconds: Math.floor(positionSeconds),
            },
        });
        setMessages(prev => [...prev, userMsg]);

        setChatting(true);
        try {
            const context = await buildMovieDiscussContext(movie, positionSeconds, cues);
            if (!context) return;
            const result = await generateMovieChat(session, movie, context, cues, companionId);
            if (result && result.reply) {
                // 与 chat-room 同款解析：拆 parts、抽内心戏与状态值
                const { parts, statusPanel, innerMonologue, stateValues, freshStateValues } = parseAIResponse(result.reply, []);
                const saveParts = parts.length > 0 || !(statusPanel || innerMonologue) ? parts : [{ content: "" }];
                for (let i = 0; i < saveParts.length; i++) {
                    pushChatMessage({
                        sessionId: session.id,
                        role: "assistant",
                        content: saveParts[i].content,
                        mediaType: saveParts[i].mediaType,
                        origin: "movie_discuss",
                        mediaData: {
                            ...(saveParts[i].mediaData ?? {}),
                            movieTitle: movie.title,
                            moviePositionSeconds: Math.floor(positionSeconds),
                        },
                        statusPanel: i === 0 && statusPanel ? statusPanel : undefined,
                        innerMonologue: i === 0 && innerMonologue ? innerMonologue : undefined,
                        stateValues: i === 0 && stateValues.length > 0 ? stateValues : undefined,
                        freshStateValues: i === 0 ? freshStateValues : undefined,
                    });
                }
                // 弹幕动作落库（渲染层 P1）
                if (result.actions.length > 0 && companion) {
                    await saveDanmaku(result.actions.map((action, i) => ({
                        id: `mdk_${movie.id}_${Date.now().toString(36)}_${i}`,
                        movieId: movie.id,
                        timeSeconds: action.timeSeconds,
                        characterId: companion.id,
                        characterName: companion.name,
                        content: action.content,
                        createdAt: new Date().toISOString(),
                    })));
                }
                reload();
            }
        } catch (err) {
            console.error("[Movie] Discuss error:", err);
        } finally {
            setChatting(false);
        }
    };

    return (
        <div
            style={{
                position: "absolute", right: 10,
                bottom: "calc(10px + env(safe-area-inset-bottom, 0px))",
                width: "min(320px, 78%)", height: "62%",
                display: "flex", flexDirection: "column",
                background: "rgba(20,22,34,0.92)", backdropFilter: "blur(10px)",
                border: "1px solid #2c3046", borderRadius: 14,
                boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
                zIndex: 30, overflow: "hidden",
            }}
        >
            {/* 头部 */}
            <div className="flex items-center gap-2" style={{ padding: "10px 12px", borderBottom: "1px solid #232636" }}>
                <span className="ts-14" style={{ fontWeight: 600 }}>{companion?.name ?? "讨论"}</span>
                <span className="ts-14" style={{ color: "#565b73" }}>· 边看边聊</span>
                <div style={{ flex: 1 }} />
                <button className="ts-14" onClick={onClose} style={{ background: "none", border: "none", color: "#8f93a8", cursor: "pointer" }}>✕</button>
            </div>

            {/* 消息列表 */}
            <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                {messages.length === 0 && (
                    <div className="ts-14" style={{ color: "#565b73", textAlign: "center", padding: "20px 0" }}>
                        想到什么就和她/他说吧，她/他知道你现在看到哪
                    </div>
                )}
                {messages.map(msg => (
                    <div key={msg.id} style={{ display: "flex", flexDirection: msg.role === "user" ? "row-reverse" : "row" }}>
                        <div
                            className="ts-14"
                            style={{
                                maxWidth: "85%", padding: "8px 11px", borderRadius: 12,
                                whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55,
                                background: msg.role === "user" ? "#6c5ce7" : "#262a3e",
                                color: "#e8e9f0",
                                borderBottomRightRadius: msg.role === "user" ? 4 : 12,
                                borderBottomLeftRadius: msg.role === "user" ? 12 : 4,
                            }}
                        >{msg.content}</div>
                    </div>
                ))}
                {chatting && (
                    <div className="ts-14" style={{ color: "#565b73" }}>正在输入…</div>
                )}
            </div>

            {/* 输入区 */}
            <div className="flex items-center gap-2" style={{ padding: "8px 10px", borderTop: "1px solid #232636" }}>
                <textarea
                    className="ts-14 ui-textarea"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void handleSend();
                        }
                    }}
                    rows={1}
                    placeholder="说点什么…"
                    style={{ flex: 1, resize: "none", background: "#1a1d2c", color: "#e8e9f0", border: "1px solid #2c3046", borderRadius: 10, padding: "8px 10px", maxHeight: 80 }}
                />
                <button
                    className="ts-14"
                    onClick={() => void handleSend()}
                    disabled={chatting || !input.trim()}
                    style={{ padding: "8px 14px", borderRadius: 10, background: input.trim() && !chatting ? "#6c5ce7" : "#232636", color: input.trim() && !chatting ? "#fff" : "#565b73", border: "none", cursor: "pointer" }}
                >发送</button>
            </div>
        </div>
    );
}
