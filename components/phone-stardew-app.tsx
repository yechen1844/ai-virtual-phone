"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sprout, Loader2, Play, Square, RefreshCw, MessageSquare, Send } from "lucide-react";
import { PageShell } from "./ui/page-shell";
import { kvGet, kvSet } from "@/lib/kv-db";
import { BilingualTextBlock } from "./chat/message-bubble";
import { shouldSendChatInputOnEnter } from "@/lib/chat-input-keyboard";
import { useChatBottomReserve } from "./chat/use-chat-bottom-reserve";
import {
  listBindableCharacters,
  startNagiPolling,
  stopNagiPolling,
  processNagiInbox,
  getOrCreateStardewSession,
  ensureStardewToolsRegistered,
  sendGameMessageViaCloud,
} from "@/lib/nagi-bridge";
import { loadChatMessages, pushChatMessage, type ChatMessage, type ChatSession } from "@/lib/chat-storage";

type NAGI_STATUS = "idle" | "running" | "checking";
type StardewPage = "settings" | "chat";

const KV_CHAR_KEY = "nagi_bridge_character_id";
const KV_ENABLED_KEY = "nagi_bridge_enabled";
const KV_BACKEND = "https://nagi.chajianreader.cc.cd";

type CharOption = { id: string; name: string };
type LogEntry = { ts: string; text: string; ok: boolean };

export function PhoneStardewApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [page, setPage] = useState<StardewPage>("settings");
    const [chars, setChars] = useState<CharOption[]>([]);
    const [charId, setCharId] = useState<string>("");
    const [enabled, setEnabled] = useState<boolean>(false);
    const [status, setStatus] = useState<NAGI_STATUS>("idle");
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [inboxCount, setInboxCount] = useState<number>(0);
    const statusRef = useRef<NAGI_STATUS>("idle");

    useEffect(() => {
        setChars(listBindableCharacters());
        const savedChar = kvGet(KV_CHAR_KEY) || "";
        setCharId(savedChar);
        const savedEnabled = kvGet(KV_ENABLED_KEY) === "1";
        setEnabled(savedEnabled);
        // 打开星露谷 App 就自动开始轮询（如果已绑定 char），无需手动开开关
        if (savedChar) {
            setStatus("running");
            statusRef.current = "running";
            startNagiPolling(savedChar);
        }
        return () => {
            stopNagiPolling();
        };
    }, []);

    const pushLog = useCallback((text: string, ok: boolean) => {
        setLogs((prev) => {
            const next = [{ ts: new Date().toLocaleTimeString("zh-CN", { hour12: false }), text, ok }, ...prev];
            return next.slice(0, 12);
        });
    }, []);

    const handleToggle = useCallback(async () => {
        if (status === "checking") return;
        const next = !enabled;
        if (next && !charId) {
            onNotice?.("请先选择一个要绑定的角色");
            return;
        }
        setEnabled(next);
        kvSet(KV_ENABLED_KEY, next ? "1" : "0");
        if (next) {
            if (charId) kvSet(KV_CHAR_KEY, charId);
            stopNagiPolling();
            setStatus("running");
            statusRef.current = "running";
            startNagiPolling(charId);
            pushLog("已开启星露谷联动，正在实时串联…", true);
        } else {
            stopNagiPolling();
            setStatus("idle");
            statusRef.current = "idle";
            pushLog("已关闭星露谷联动", true);
        }
    }, [enabled, charId, onNotice, pushLog]);

    const handleBindChar = useCallback((id: string) => {
        setCharId(id);
        kvSet(KV_CHAR_KEY, id);
        pushLog(`已绑定角色: ${chars.find((c) => c.id === id)?.name ?? id}`, true);
    }, [chars, pushLog]);

    const handlePullNow = useCallback(async () => {
        if (status === "checking") return;
        if (!charId) {
            onNotice?.("请先选择要绑定的角色");
            return;
        }
        setStatus("checking");
        statusRef.current = "checking";
        pushLog("正在拉取游戏消息…", true);
        try {
            const n = await processNagiInbox(charId);
            setInboxCount((c) => c + n);
            pushLog(n > 0 ? `拉取并处理了 ${n} 条游戏消息` : "暂无新的游戏消息", true);
        } catch (e) {
            pushLog(`拉取出错: ${e instanceof Error ? e.message : String(e)}`, false);
        } finally {
            if (enabled) {
                setStatus("running");
                statusRef.current = "running";
            } else {
                setStatus("idle");
                statusRef.current = "idle";
            }
        }
    }, [charId, enabled, onNotice, pushLog]);

    return (
        <PageShell title={page === "chat" ? "星露谷聊天" : "星露谷联动"} onBack={page === "chat" ? () => setPage("settings") : onClose}>
            {page === "settings" ? (
                <SettingsPage
                    chars={chars}
                    charId={charId}
                    enabled={enabled}
                    status={status}
                    inboxCount={inboxCount}
                    logs={logs}
                    KV_BACKEND={KV_BACKEND}
                    onBindChar={handleBindChar}
                    onToggle={handleToggle}
                    onPullNow={handlePullNow}
                    onEnterChat={() => setPage("chat")}
                    charName={chars.find((c) => c.id === charId)?.name}
                />
            ) : (
                <StardewChatPage charId={charId} charName={chars.find((c) => c.id === charId)?.name} onNotice={onNotice} />
            )}
        </PageShell>
    );
}

function SettingsPage(props: {
    chars: CharOption[];
    charId: string;
    enabled: boolean;
    status: NAGI_STATUS;
    inboxCount: number;
    logs: LogEntry[];
    KV_BACKEND: string;
    onBindChar: (id: string) => void;
    onToggle: () => void;
    onPullNow: () => void;
    onEnterChat: () => void;
    charName?: string;
}) {
    const { chars, charId, enabled, status, inboxCount, logs, KV_BACKEND, onBindChar, onToggle, onPullNow, onEnterChat, charName } = props;
    return (
        <div className="stardew-app-root">
            <div className="stardew-hero">
                <div className="stardew-hero-icon"><Sprout size={26} /></div>
                <div className="stardew-hero-info">
                    <div className="stardew-hero-title">星露谷物语</div>
                    <div className="stardew-hero-desc">手机与电脑实时联动 · char 陪你种田聊天</div>
                </div>
            </div>

            {charId && (
                <div className="stardew-section">
                    <button className="stardew-btn stardew-btn-block" onClick={onEnterChat}>
                        <MessageSquare size={16} />
                        进入聊天（{charName || charId}）
                    </button>
                </div>
            )}

            <div className="stardew-section">
                <div className="stardew-label">绑定角色</div>
                <select className="stardew-select" value={charId} onChange={(e) => onBindChar(e.target.value)}>
                    <option value="">— 选择要绑定的 char —</option>
                    {chars.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                </select>
            </div>

            <div className="stardew-section">
                <div className="stardew-label">联动开关</div>
                <button className={`stardew-toggle ${enabled ? "on" : "off"}`} onClick={onToggle} disabled={status === "checking"}>
                    {status === "checking" ? <Loader2 size={18} className="stardew-spin" /> : enabled ? <Play size={18} /> : <Square size={18} />}
                    <span>{enabled ? "联动已开启 · 实时串联中" : "联动已关闭"}</span>
                </button>
            </div>

            <div className="stardew-section">
                <div className="stardew-label">云端状态</div>
                <div className="stardew-backend"><span className="stardew-backend-dot" />{KV_BACKEND}</div>
                <div className="stardew-row">
                    <div className="stardew-stat">已处理 <b>{inboxCount}</b> 条</div>
                    <button className="stardew-btn" onClick={onPullNow} disabled={status === "checking"}>
                        <RefreshCw size={14} className={status === "checking" ? "stardew-spin" : ""} />立即拉取
                    </button>
                </div>
            </div>

            {logs.length > 0 && (
                <div className="stardew-section">
                    <div className="stardew-label">最近动态</div>
                    <div className="stardew-logs">
                        {logs.map((l, i) => (
                            <div className={`stardew-log ${l.ok ? "ok" : "err"}`} key={i}>
                                <MessageSquare size={12} /><span>{l.text}</span><em>{l.ts}</em>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// 复刻主聊天的多气泡划分：按空行(\n\s*\n+)把 AI 回复拆成多个段落，每段一个气泡
function splitOfflineParagraphs(text: string): string[] {
    const normalized = (text || "").replace(/\r\n?/g, "\n").trim();
    if (!normalized) return [];
    return normalized
        .split(/\n\s*\n+/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function StardewChatPage({ charId, charName, onNotice }: { charId: string; charName?: string; onNotice?: (msg: string) => void }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [inputValue, setInputValue] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const [replying, setReplying] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const sessionRef = useRef<ChatSession | null>(null);

    useChatBottomReserve(wrapperRef, scrollRef, "stardew-chat");

    // 初始化会话 + 监听会话新消息（轮询在后台写入的 AI 回复要同步显示）
    useEffect(() => {
        if (!charId) return;
        let cancelled = false;
        try {
            const session = getOrCreateStardewSession(charId);
            sessionRef.current = session;
            setMessages(loadChatMessages(session.id));
            const handler = () => {
                if (cancelled) return;
                setMessages(loadChatMessages(session.id));
            };
            window.addEventListener("storage", handler);
            const timer = setInterval(handler, 2000);
            return () => {
                cancelled = true;
                window.removeEventListener("storage", handler);
                clearInterval(timer);
            };
        } catch (e) {
            console.warn("[StardewChat] 初始化会话失败:", e);
        }
    }, [charId]);

    const scrollToBottom = useCallback(() => {
        requestAnimationFrame(() => {
            if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, isThinking, scrollToBottom]);

    // 回车 / 发送按钮 = 只把消息发进游戏（game-say），不触发模型回复
    const handleSend = useCallback(async () => {
        const text = inputValue.trim();
        if (!text || isThinking || replying || !sessionRef.current) return;
        const session = sessionRef.current;
        setInputValue("");

        // 写入本地会话，作为一条"我发的话"
        const userMsg = pushChatMessage({ sessionId: session.id, role: "user", content: text, status: "sent" });
        setMessages((prev) => [...prev, userMsg]);
        scrollToBottom();

        // 发进星露谷游戏（通过云端 → 管家 → NagiBridge）
        const ok = await sendGameMessageViaCloud(text, "玩家");
        if (!ok) onNotice?.("发送到游戏失败，请检查云端/管家连接");
    }, [inputValue, isThinking, replying, onNotice, scrollToBottom]);

    // 回复按钮 = 从 Worker 拉取游戏消息，触发 char 生成回复并推回
    const handleReply = useCallback(async () => {
        if (replying || isThinking || !charId) return;
        setReplying(true);
        setIsThinking(true);
        try {
            ensureStardewToolsRegistered();
            const n = await processNagiInbox(charId);
            setMessages(loadChatMessages(sessionRef.current?.id || ""));
            if (n === 0 && charId) onNotice?.("没有新的游戏消息可回复");
        } catch (e) {
            console.warn("[StardewChat] 回复失败:", e);
            onNotice?.("回复失败，请稍后再试");
        } finally {
            setReplying(false);
            setIsThinking(false);
            scrollToBottom();
        }
    }, [charId, replying, isThinking, onNotice, scrollToBottom]);

    const onInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (shouldSendChatInputOnEnter(e, true)) {
            e.preventDefault();
            void handleSend();
        }
    }, [handleSend]);

    const autoGrow = useCallback((el: HTMLTextAreaElement) => {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }, []);

    return (
        <div className="stardew-chat-room" ref={wrapperRef}>
            <div className="stardew-chat-scroll" ref={scrollRef}>
                {messages.length === 0 && (
                    <div className="stardew-chat-empty">和 {charName || "char"} 聊聊星露谷吧～</div>
                )}
                {messages.map((msg) => {
                    const isUser = msg.role === "user";
                    const paragraphs = isUser ? [msg.content] : splitOfflineParagraphs(msg.content);
                    return (
                        <div className="chat-msg-wrapper" data-role={isUser ? "user" : "assistant"} key={msg.id}>
                            <div className={`chat-msg-content-wrap ${isUser ? "ml-auto" : ""}`} style={{ maxWidth: "72%" }}>
                                {paragraphs.map((p, i) => (
                                    <div
                                        className={`${isUser ? "chat-bubble-role-user" : "chat-bubble-role-assistant"} rounded-md stardew-msg ${i > 0 ? "stardew-msg-gap" : ""}`}
                                        key={`${msg.id}-${i}`}
                                    >
                                        <BilingualTextBlock text={p} mode="plain" defaultExpanded />
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
                {isThinking && (
                    <div className="chat-msg-wrapper" data-role="assistant">
                        <div className="chat-offline-paragraph">
                            <div className="chat-bubble-role-assistant rounded-md mascot-thinking">
                                思考中<span className="mascot-dot"></span><span className="mascot-dot"></span><span className="mascot-dot"></span>
                            </div>
                        </div>
                    </div>
                )}
                <div style={{ overflowAnchor: "auto", height: 1 }} />
            </div>

            <div className="chat-input-bar chat-room-main-pane flex flex-col" data-ui="input">
                <textarea
                    ref={textareaRef}
                    className="chat-input-textarea"
                    rows={1}
                    value={inputValue}
                    placeholder={`和 ${charName || "char"} 聊星露谷…`}
                    onChange={(e) => { setInputValue(e.target.value); autoGrow(e.target); }}
                    onKeyDown={onInputKeyDown}
                />
                <div className="chat-input-actions stardew-input-actions">
                    <button className="stardew-btn" onClick={handleReply} disabled={replying || isThinking}>
                        <Loader2 size={14} className={replying ? "stardew-spin" : ""} /> 回复
                    </button>
                    <button className="stardew-btn" onClick={handleSend} disabled={isThinking || replying || !inputValue.trim()}>
                        <Send size={16} /> 发送
                    </button>
                </div>
            </div>
        </div>
    );
}

export default PhoneStardewApp;
