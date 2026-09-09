"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createOrGetSession, loadChatMessages, pushChatMessage, isMovieDiscussMessage, type ChatMessage } from "@/lib/chat-storage";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { splitBilingualText } from "@/lib/bilingual-text";
import { loadCharacters } from "@/lib/character-storage";
import { buildMovieDiscussContext, generateMovieChat } from "@/lib/movie-engine";
import { saveDanmaku } from "@/lib/movie-storage";
import type { Movie, SubtitleCue, MovieDanmaku } from "@/lib/movie-types";

type Props = {
    movie: Movie;
    cues: SubtitleCue[];
    companionId: string;
    getPosition: () => number;
    /** 当前场起点（秒）：弹幕动作的相对秒数换算绝对时间用 */
    sceneStart: number;
    /** 当前场终点（秒）：弹幕栏过滤当前场的弹幕用 */
    sceneEnd: number;
    danmakuList: MovieDanmaku[];
    generatingScene: boolean;
    onGenerateDanmaku: () => void;
    onClose: () => void;
    /** 面板可见性（隐藏时仍挂载，生成不中断） */
    visible?: boolean;
};

function formatSeconds(total: number): string {
    const m = Math.floor(total / 60);
    const s = Math.floor(total % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MovieDiscussPanel({ movie, cues, companionId, getPosition, sceneStart, sceneEnd, danmakuList, generatingScene, onGenerateDanmaku, onClose, visible = true }: Props) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [input, setInput] = useState("");
    const [chatting, setChatting] = useState(false);
    const [errorMsg, setErrorMsg] = useState("");
    const [tab, setTab] = useState<"chat" | "danmaku">("chat");
    // 拖拽位置：null = 默认右下角；拖过后记录左上角绝对坐标（面板内坐标，随面板隐藏保持不变）
    const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
    const movedRef = useRef(false);
    const sessionIdRef = useRef("");
    // 向上加载更早消息后，保持视口停在同一条消息上（prepend 防跳）
    const scrollRestoreRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);

    const PAGE = 40;
    const companion = loadCharacters().find(c => c.id === companionId);

    const reload = useCallback(() => {
        if (!companionId) return;
        const session = createOrGetSession(companionId);
        sessionIdRef.current = session.id;
        const list = loadChatMessages(session.id, PAGE, isMovieDiscussMessage);
        setMessages(list);
        setHasMore(list.length >= PAGE);
    }, [companionId]);

    const loadMore = useCallback(() => {
        const oldest = messages[0];
        if (!oldest || loadingMore) return;
        setLoadingMore(true);
        try {
            const older = loadChatMessages(sessionIdRef.current, PAGE, isMovieDiscussMessage, oldest.createdAt);
            if (older.length > 0 && listRef.current) {
                scrollRestoreRef.current = { prevHeight: listRef.current.scrollHeight, prevTop: listRef.current.scrollTop };
            }
            setMessages(prev => [...older, ...prev]);
            setHasMore(older.length >= PAGE);
        } finally {
            setLoadingMore(false);
        }
    }, [messages, loadingMore]);

    useEffect(() => {
        reload();
    }, [reload]);

    // 弹幕生成时 char 可能附带 [开口] 主动消息；跨视图实例同步 → 事件驱动刷新
    useEffect(() => {
        reload();
    }, [danmakuList.length, reload]);

    useEffect(() => {
        const onUpdated = () => reload();
        window.addEventListener("movie-discuss-updated", onUpdated);
        return () => window.removeEventListener("movie-discuss-updated", onUpdated);
    }, [reload]);

    // prepend 后恢复滚动位置（避免「查看更早」把视口顶走）
    useEffect(() => {
        const restore = scrollRestoreRef.current;
        const el = listRef.current;
        if (restore && el) {
            scrollRestoreRef.current = null;
            el.scrollTop = el.scrollHeight - restore.prevHeight + restore.prevTop;
        }
    }, [messages.length]);

    // 聊天 tab 新消息自动滚底（只在最后一条消息变化时，向上翻历史不打扰）
    const lastMsgId = messages.length > 0 ? messages[messages.length - 1].id : "";
    useEffect(() => {
        if (tab !== "chat") return;
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lastMsgId, chatting, tab]);

    // ── 拖拽（header 指针拖动，面板可自由移动）──
    const handleDragStart = (e: React.PointerEvent) => {
        const panel = panelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const parent = panel.offsetParent as HTMLElement | null;
        const parentRect = parent?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const x = rect.left - parentRect.left;
        const y = rect.top - parentRect.top;
        setPos({ x, y });
        dragRef.current = { startX: e.clientX, startY: e.clientY, origX: x, origY: y };
        movedRef.current = false;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    };

    const handleDragMove = (e: React.PointerEvent) => {
        const drag = dragRef.current;
        const panel = panelRef.current;
        if (!drag || !panel) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) movedRef.current = true;
        const w = panel.offsetWidth;
        const h = panel.offsetHeight;
        const parent = panel.offsetParent as HTMLElement | null;
        const maxW = parent?.clientWidth ?? window.innerWidth;
        const maxH = parent?.clientHeight ?? window.innerHeight;
        setPos({
            x: Math.min(Math.max(drag.origX + dx, 0), Math.max(0, maxW - w)),
            y: Math.min(Math.max(drag.origY + dy, 0), Math.max(0, maxH - h)),
        });
    };

    const handleDragEnd = () => {
        dragRef.current = null;
    };

    // ── 发送 ──
    const handleSend = async () => {
        const text = input.trim();
        if (!text || chatting) return;
        if (!companionId) {
            setErrorMsg("未选择陪伴角色——请在片架选择陪伴后重新分段，或退出重进让进度加载完成");
            return;
        }
        setInput("");
        setErrorMsg("");

        const session = createOrGetSession(companionId);
        const positionSeconds = getPosition();
        const m = Math.floor(positionSeconds / 60);
        const s = Math.floor(positionSeconds % 60);

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
            if (!context) {
                setErrorMsg("无法构建观影上下文（分段数据缺失？）");
                return;
            }
            const result = await generateMovieChat(session, movie, context, cues, companionId);
            if (result && result.reply) {
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
                // 弹幕动作落库：相对秒数 + 当前场起点 = 绝对时间
                if (result.actions.length > 0 && companion) {
                    const items = result.actions.map((action, i) => ({
                        id: `mdk_${movie.id}_${Date.now().toString(36)}_${i}`,
                        movieId: movie.id,
                        timeSeconds: Math.max(sceneStart, sceneStart + action.timeSeconds),
                        characterId: companion.id,
                        characterName: companion.name,
                        content: action.content.slice(0, 50),
                        createdAt: new Date().toISOString(),
                    }));
                    await saveDanmaku(items);
                }
                if (typeof window !== "undefined") window.dispatchEvent(new Event("movie-discuss-updated"));
                reload();
            } else {
                setErrorMsg("她没有回复——可能是 API 未配置、请求失败或内容被拦截，详见控制台");
            }
        } catch (err) {
            console.error("[Movie] Discuss error:", err);
            setErrorMsg(`发送失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setChatting(false);
        }
    };

    // 当前场的弹幕（弹幕栏）
    const sceneDanmaku = danmakuList.filter(d => d.timeSeconds >= sceneStart && d.timeSeconds < Math.max(sceneEnd, sceneStart + 1));

    const panelStyle: React.CSSProperties = pos
        ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
        : { right: 10, bottom: "calc(10px + env(safe-area-inset-bottom, 0px))" };

    return (
        <div
            ref={panelRef}
            style={{
                position: "absolute",
                zIndex: 30,
                visibility: visible ? "visible" : "hidden",
                pointerEvents: visible ? "auto" : "none",
                ...panelStyle,
                width: "min(320px, 78%)", height: "62%",
                display: "flex", flexDirection: "column",
                background: "rgba(20,22,34,0.92)", backdropFilter: "blur(10px)",
                border: "1px solid #2c3046", borderRadius: 14,
                boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
                overflow: "hidden",
                touchAction: "none",
            }}
        >
            {/* 头部：拖拽把手 + Tab */}
            <div
                onPointerDown={handleDragStart}
                onPointerMove={handleDragMove}
                onPointerUp={handleDragEnd}
                style={{ padding: "8px 12px", borderBottom: "1px solid #232636", cursor: "grab", touchAction: "none", userSelect: "none" }}
            >
                <div className="flex items-center gap-2">
                    <span style={{ color: "#565b73", letterSpacing: 2 }}>⠿</span>
                    <span className="ts-14" style={{ fontWeight: 600 }}>{companion?.name ?? "讨论"}</span>
                    <div style={{ flex: 1 }} />
                    <button className="ts-14" onClick={onClose} style={{ background: "none", border: "none", color: "#8f93a8", cursor: "pointer", padding: "2px 6px" }}>✕</button>
                </div>
                <div className="flex gap-2" style={{ marginTop: 6 }}>
                    <button
                        className="ts-14"
                        onClick={() => setTab("chat")}
                        style={{ padding: "3px 12px", borderRadius: 999, border: "none", cursor: "pointer", background: tab === "chat" ? "#6c5ce7" : "#262a3e", color: tab === "chat" ? "#fff" : "#8f93a8" }}
                    >聊天</button>
                    <button
                        className="ts-14"
                        onClick={() => setTab("danmaku")}
                        style={{ padding: "3px 12px", borderRadius: 999, border: "none", cursor: "pointer", background: tab === "danmaku" ? "#6c5ce7" : "#262a3e", color: tab === "danmaku" ? "#fff" : "#8f93a8" }}
                    >弹幕{sceneDanmaku.length > 0 ? ` ${sceneDanmaku.length}` : ""}</button>
                </div>
            </div>

            {tab === "chat" ? (
                <>
                    {/* 消息列表 */}
                    <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                        {hasMore && (
                            <button
                                className="ts-14"
                                onClick={loadMore}
                                style={{ alignSelf: "center", padding: "4px 14px", borderRadius: 999, background: "#1a1d2c", color: "#8f93a8", border: "1px solid #2c3046", cursor: "pointer" }}
                            >{loadingMore ? "加载中…" : "查看更早的讨论"}</button>
                        )}
                        {messages.length === 0 && (
                            <div className="ts-14" style={{ color: "#565b73", textAlign: "center", padding: "20px 0" }}>
                                想到什么就说吧，她/他知道你现在看到哪
                            </div>
                        )}
                        {messages.map(msg => {
                            // 双语渲染：与主聊天一致的「原文 + 中文译文」样式
                            const bilingual = msg.role === "assistant" ? splitBilingualText(msg.content) : null;
                            return (
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
                                    >
                                        {bilingual ? (
                                            <>
                                                <div>{bilingual.original}</div>
                                                <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.12)", color: "#b6b9c9" }}>{bilingual.translated}</div>
                                            </>
                                        ) : msg.content}
                                    </div>
                                </div>
                            );
                        })}
                        {errorMsg && (
                            <div className="ts-14" style={{ color: "#e08a95", background: "rgba(224,138,149,0.1)", borderRadius: 8, padding: "6px 10px", lineHeight: 1.5 }}>
                                {errorMsg}
                            </div>
                        )}
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
                        >{chatting ? "回复中…" : "发送"}</button>
                    </div>
                </>
            ) : (
                /* 弹幕栏：本幕弹幕列表 */
                <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                        className="ts-14"
                        onClick={onGenerateDanmaku}
                        disabled={generatingScene}
                        style={{ padding: "8px 0", borderRadius: 10, background: generatingScene ? "#232636" : "#2c3046", color: generatingScene ? "#565b73" : "#e8e9f0", border: "none", cursor: generatingScene ? "default" : "pointer", marginBottom: 4 }}
                    >{generatingScene ? "弹幕生成中…" : "生成本幕弹幕"}</button>
                    {sceneDanmaku.length === 0 && (
                        <div className="ts-14" style={{ color: "#565b73", textAlign: "center", padding: "20px 0", lineHeight: 1.7 }}>
                            本幕还没有弹幕。<br />播放进入本幕时会自动生成，也可以点上面的按钮手动生成。
                        </div>
                    )}
                    {sceneDanmaku.map(d => (
                        <div key={d.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "6px 10px", borderRadius: 8, background: "#1a1d2c" }}>
                            <span className="ts-14" style={{ color: "#a29bfe", flexShrink: 0 }}>{formatSeconds(d.timeSeconds)}</span>
                            <span className="ts-14" style={{ color: "#e8e9f0", lineHeight: 1.5 }}>{d.content}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
