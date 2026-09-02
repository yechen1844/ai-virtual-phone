"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sprout, Loader2, Play, Square, RefreshCw, MessageSquare, Send } from "lucide-react";
import { PageShell } from "./ui/page-shell";
import { kvGet, kvSet } from "@/lib/kv-db";
import { BilingualTextBlock } from "./chat/message-bubble";
import { StateValuesPanel } from "./chat/state-values-panel";
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
  startThinkProcessor,
  stopThinkProcessor,
  isStardewGenerating,
  getStardewReasoning,
  stardewReplyLatestPending,
} from "@/lib/nagi-bridge";
import { loadChatMessages, pushChatMessage, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { recordStardewMessage } from "@/lib/stardew-memory";
import { useStardewSync, type SyncUiState } from "@/lib/sync-runtime/use-stardew-sync";
import type { StardewSyncConfig, SyncRole } from "@/lib/sync-runtime/config";

type NAGI_STATUS = "idle" | "running" | "checking";
type StardewPage = "settings" | "chat";

const KV_CHAR_KEY = "nagi_bridge_character_id";
const KV_ENABLED_KEY = "nagi_bridge_enabled";
const KV_BACKEND = "http://localhost:7869";

type CharOption = { id: string; name: string };
type LogEntry = { ts: string; text: string; ok: boolean };

// 判断消息列表是否真正变化（长度 + 末尾消息），避免每 2s 轮询都全量重载/重渲
function chatMessagesEqual(a: ChatMessage[], b: ChatMessage[]): boolean {
    if (a.length !== b.length) return false;
    if (a.length === 0) return true;
    const la = a[a.length - 1];
    const lb = b[b.length - 1];
    return la.id === lb.id && la.content === lb.content && la.createdAt === lb.createdAt;
}

export function PhoneStardewApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [page, setPage] = useState<StardewPage>("settings");
    const [chars, setChars] = useState<CharOption[]>([]);
    const [charId, setCharId] = useState<string>("");
    const [enabled, setEnabled] = useState<boolean>(false);
    const [status, setStatus] = useState<NAGI_STATUS>("idle");
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [inboxCount, setInboxCount] = useState<number>(0);
    const statusRef = useRef<NAGI_STATUS>("idle");

    // PC↔手机实时同步（游玩端/遥控端）。两端都是同一 float 程序，由 user 手动指定 syncRole。
    const sync = useStardewSync();

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
            startThinkProcessor(savedChar);
        }
        return () => {
            stopNagiPolling();
            stopThinkProcessor();
        };
    }, []);

    // 同步开关状态联动：任一时刻改变配置的 enabled/role → 启动/停止引擎
    useEffect(() => {
        sync.start(sync.cfg);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sync.cfg.enabled, sync.cfg.role]);

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
                    syncCfg={sync.cfg}
                    syncUi={sync.ui}
                    onSyncApply={sync.apply}
                />
            ) : (
                <StardewChatPage
                    charId={charId}
                    charName={chars.find((c) => c.id === charId)?.name}
                    onNotice={onNotice}
                    syncCfg={sync.cfg}
                    onRemoteSendUser={sync.remoteSendUser}
                    onRemoteRequestReply={sync.remoteRequestReply}
                />
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
    syncCfg: StardewSyncConfig;
    syncUi: SyncUiState;
    onSyncApply: (patch: Partial<StardewSyncConfig>) => StardewSyncConfig;
}) {
    const { chars, charId, enabled, status, inboxCount, logs, KV_BACKEND, onBindChar, onToggle, onPullNow, onEnterChat, charName, syncCfg, syncUi, onSyncApply } = props;
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

            {/* PC↔手机实时同步：两端相同 float 程序，user 手动选游玩端；两端都开才工作 */}
            <div className="stardew-section">
                <div className="stardew-label">实时同步（电脑↔手机）</div>
                <div className="stardew-sync-box">
                    <div className="stardew-row" style={{ justifyContent: "space-between" }}>
                        <span className="stardew-backend">本机角色</span>
                        <select
                            className="stardew-select stardew-sync-role"
                            value={syncCfg.role}
                            onChange={(e) => onSyncApply({ role: e.target.value as SyncRole })}
                        >
                            <option value="play">游玩端（生成/调工具）</option>
                            <option value="remote">遥控端（只读/转发）</option>
                        </select>
                    </div>
                    <div className="stardew-row" style={{ justifyContent: "space-between" }}>
                        <span className="stardew-backend">同步开关（两端都要开）</span>
                        <button
                            type="button"
                            className={`stardew-toggle stardew-sync-toggle ${syncCfg.enabled ? "on" : "off"}`}
                            onClick={() => onSyncApply({ enabled: !syncCfg.enabled })}
                        >
                            <span>{syncCfg.enabled ? "同步已开启" : "同步已关闭"}</span>
                        </button>
                    </div>
                    <input
                        className="stardew-input"
                        placeholder="Supabase 项目地址 (https://xxxx.supabase.co)"
                        value={syncCfg.url}
                        onChange={(e) => onSyncApply({ url: e.target.value })}
                    />
                    <input
                        className="stardew-input"
                        placeholder="anon/public key"
                        value={syncCfg.anonKey}
                        onChange={(e) => onSyncApply({ anonKey: e.target.value })}
                    />
                    <div className={`stardew-sync-status ${syncUi.state}`}>
                        {syncUi.configured ? (syncCfg.enabled ? `同步中…（${syncUi.role === "play" ? "游玩端" : "遥控端"}）` : "已配置，等待开启") : "未配置（填地址+密钥）"}
                        {syncUi.state === "error" && syncUi.errorMsg ? ` · ${syncUi.errorMsg}` : ""}
                    </div>
                </div>
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

// 剔除星露谷回复里的格式标签：只去掉标签外壳，不动标签内内容。
// 标签内可能带空格(如 [私聊 ]/[/私聊 ]、[状态数值 ]/[/状态数值 ])，用 \s* 兼容；
// 支持成对(...[/xx])与裸([xx]/[/xx])两种形态（防御性处理旧消息里残留的原始标签）。
function stripStardewPrivateMarker(text: string): string {
    if (!text) return text;
    return text
        .replace(/\[私聊\s*\]([\s\S]*?)\[\/私聊\s*\]/g, "$1")
        .replace(/\[状态数值\s*\]([\s\S]*?)\[\/状态数值\s*\]/g, "$1")
        .replace(/\[私聊\s*\]/g, "")
        .replace(/\[\/私聊\s*\]/g, "")
        .replace(/\[状态数值\s*\]/g, "")
        .replace(/\[\/状态数值\s*\]/g, "");
}

// 复刻主聊天的多气泡划分：按空行(\n\s*\n+)把 AI 回复拆成多个段落，每段一个气泡
function splitOfflineParagraphs(text: string): string[] {
    const normalized = stripStardewPrivateMarker((text || "").replace(/\r\n?/g, "\n")).trim();
    if (!normalized) return [];
    return normalized
        .split(/\n\s*\n+/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function StardewChatPage({ charId, charName, onNotice, syncCfg, onRemoteSendUser, onRemoteRequestReply }: {
    charId: string; charName?: string; onNotice?: (msg: string) => void;
    syncCfg: StardewSyncConfig;
    onRemoteSendUser: (cfg: StardewSyncConfig, sessionId: string, characterId: string, content: string) => Promise<void>;
    onRemoteRequestReply: (cfg: StardewSyncConfig, sessionId: string, characterId: string) => Promise<void>;
}) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [inputValue, setInputValue] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const [reasoning, setReasoning] = useState("");
    const [replying, setReplying] = useState(false);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const messagesRef = useRef<ChatMessage[]>([]);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const sessionRef = useRef<ChatSession | null>(null);
    // 懒加载：只显示最近 PAGE 条，往上翻再加载更早；缓存全量用于比对，避免每 2s 全量重渲
    const PAGE = 60;
    const visibleCountRef = useRef(PAGE);
    const allMsgsRef = useRef<ChatMessage[]>([]);
    const lastMsgIdRef = useRef<string | null>(null);

    useChatBottomReserve(wrapperRef, scrollRef, "stardew-chat");

    // 初始化会话 + 监听会话新消息（轮询在后台写入的 AI 回复要同步显示）
    useEffect(() => {
        if (!charId) return;
        let cancelled = false;
        try {
            const session = getOrCreateStardewSession(charId);
            sessionRef.current = session;
            const initMsgs = loadChatMessages(session.id);
            allMsgsRef.current = initMsgs;
            messagesRef.current = initMsgs;
            setMessages(initMsgs.slice(-visibleCountRef.current));
            const handler = () => {
            if (cancelled) return;
            // 懒加载缓存比对：只在消息真正变化时才重渲，避免每 2s 全量重载/重渲整表
            const next = loadChatMessages(session.id);
            if (!chatMessagesEqual(allMsgsRef.current, next)) {
                allMsgsRef.current = next;
                messagesRef.current = next;
                setMessages(next.slice(-visibleCountRef.current));
            }
            setIsThinking(isStardewGenerating());
            setReasoning(getStardewReasoning());
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
        // 只在底部消息变化(新消息/开始思考)时才滚到底；「加载更早」(往前prepend)不触发跳底
        const lastId = messages.length ? messages[messages.length - 1].id : null;
        if (lastMsgIdRef.current !== lastId) {
            lastMsgIdRef.current = lastId;
            scrollToBottom();
        }
    }, [messages, isThinking, scrollToBottom]);

    // 从存储刷新：更新全量缓存，但只渲染最近窗口（避免"点回复/发送后全量渲染整个会话"导致卡顿）
    const refreshFromStorage = useCallback(() => {
        const all = loadChatMessages(sessionRef.current?.id || "");
        allMsgsRef.current = all;
        messagesRef.current = all;
        setMessages(all.slice(-visibleCountRef.current));
    }, []);

    // 发送 = 只是发消息（发进游戏 + 写入会话），不触发 char 回复；回复必须手动点「回复」按钮
    const handleSend = useCallback(async () => {
        const text = inputValue.trim();
        if (!text || isThinking || replying || !charId) return;
        setInputValue("");
        try {
            const session = getOrCreateStardewSession(charId);
            sessionRef.current = session;
            if (syncCfg.enabled && syncCfg.role === "remote") {
                // 遥控端：把 user 消息同步给游玩端（不本地生成、不直接进游戏）。
                // 同时本地也写入一条，否则遥控端自己看不到自己发的消息。
                pushChatMessage({ sessionId: session.id, role: "user", content: text, status: "sent" });
                recordStardewMessage(charId, { role: "user", content: text });
                await onRemoteSendUser(syncCfg, session.id, charId, text);
                onNotice?.("已发送，等待游玩端回复");
            } else {
                // 游玩端（或未开同步）：发进游戏 + 写本地会话
                await sendGameMessageViaCloud(text, "玩家");
                pushChatMessage({ sessionId: session.id, role: "user", content: text, status: "sent" });
                recordStardewMessage(charId, { role: "user", content: text });
            }
        } catch (e) {
            console.warn("[StardewChat] 发送失败:", e);
            onNotice?.("发送失败，请重试");
        } finally {
            refreshFromStorage();
            scrollToBottom();
        }
    }, [inputValue, isThinking, replying, charId, syncCfg, onRemoteSendUser, onNotice, scrollToBottom, refreshFromStorage]);

    // 回复按钮：遥控端 → 请求游玩端生成并拉回；游玩端 → 本地触发生成并推回
    const handleReply = useCallback(async () => {
        if (replying || isThinking || !charId) return;
        setReplying(true);
        setIsThinking(true);
        try {
            const session = getOrCreateStardewSession(charId);
            sessionRef.current = session;
            if (syncCfg.enabled && syncCfg.role === "remote") {
                // 遥控端：请求游玩端对已同步的 user 消息生成回复，回复经 fanout 拉回
                await onRemoteRequestReply(syncCfg, session.id, charId);
            } else {
                // 游玩端（或未开同步）：本机生成（含工具）
                ensureStardewToolsRegistered();
                const n = await processNagiInbox(charId);
                if (n === 0 && charId) {
                    const forced = await stardewReplyLatestPending(charId);
                    if (!forced) onNotice?.("没有新的游戏消息，且没有待回复的对话");
                }
            }
        } catch (e) {
            console.warn("[StardewChat] 回复失败:", e);
            onNotice?.("回复失败，请稍后再试");
        } finally {
            setReplying(false);
            setIsThinking(isStardewGenerating());
            refreshFromStorage();
            scrollToBottom();
        }
    }, [charId, replying, isThinking, syncCfg, onRemoteRequestReply, onNotice, scrollToBottom, refreshFromStorage]);

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

    const loadOlder = useCallback(() => {
        visibleCountRef.current += PAGE;
        setMessages(allMsgsRef.current.slice(-visibleCountRef.current));
    }, []);

    return (
        <div className="stardew-chat-room" ref={wrapperRef}>
            <div className="stardew-chat-scroll" ref={scrollRef}>
                {allMsgsRef.current.length > visibleCountRef.current && (
                    <button
                        type="button"
                        className="stardew-btn"
                        onClick={loadOlder}
                        style={{ alignSelf: "center", margin: "8px 0" }}
                    >
                        加载更早的消息（{allMsgsRef.current.length - visibleCountRef.current} 条）
                    </button>
                )}
                {messages.length === 0 && (
                    <div className="stardew-chat-empty">和 {charName || "char"} 聊聊星露谷吧～</div>
                )}
                {messages.map((msg) => {
                    // 工具调用提示（如"char 正在执行动作…"）以居中系统消息显示
                    if (msg.role === "system" || msg.mediaType === "tool_notice") {
                        return (
                            <div className="chat-msg-wrapper" data-role="system" key={msg.id}>
                                <div className="stardew-sys-msg">{msg.content}</div>
                            </div>
                        );
                    }
                    const isUser = msg.role === "user";
                    const paragraphs = isUser ? [msg.content] : splitOfflineParagraphs(msg.content);
                    const cardStateValues = msg.freshStateValues ?? msg.stateValues;
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
                                {!isUser && (msg.statusPanel || (!msg.innerMonologue && cardStateValues && cardStateValues.length > 0)) && (
                                    <div className="chat-status-bare" style={{ alignSelf: "flex-start" }}>
                                        {!msg.innerMonologue && cardStateValues && cardStateValues.length > 0 && (
                                            <StateValuesPanel stateValues={cardStateValues} />
                                        )}
                                        {msg.statusPanel && (
                                            <BilingualTextBlock text={msg.statusPanel} mode="markdown" defaultExpanded />
                                        )}
                                    </div>
                                )}
                                {!isUser && msg.innerMonologue && (
                                    <div className="chat-thought-card">
                                        <div className="chat-thought-tape-left" />
                                        <div className="chat-thought-tape-right" />
                                        <div className="chat-thought-title">💭 内心独白</div>
                                        {cardStateValues && cardStateValues.length > 0 && (
                                            <StateValuesPanel stateValues={cardStateValues} />
                                        )}
                                        <div className="chat-thought-body">
                                            <BilingualTextBlock text={msg.innerMonologue} mode="markdown" defaultExpanded />
                                        </div>
                                        <div className="chat-thought-sig">— {charName || "TA"}</div>
                                    </div>
                                )}
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
                {reasoning && !isThinking && (
                    <div className="chat-msg-wrapper" data-role="system">
                        <details className="stardew-reasoning">
                            <summary className="stardew-reasoning-summary">💭 思考过程</summary>
                            <div className="stardew-reasoning-body">{reasoning}</div>
                        </details>
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
