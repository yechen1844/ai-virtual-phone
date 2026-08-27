"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sprout, Loader2, Play, Square, RefreshCw, MessageSquare } from "lucide-react";
import { PageShell } from "./ui/page-shell";
import { kvGet, kvSet } from "@/lib/kv-db";
import {
    listBindableCharacters,
    startNagiPolling,
    stopNagiPolling,
    processNagiInbox,
} from "@/lib/nagi-bridge";

type NAGI_STATUS = "idle" | "running" | "checking";

const KV_CHAR_KEY = "nagi_bridge_character_id";
const KV_ENABLED_KEY = "nagi_bridge_enabled";
const KV_BACKEND = "https://nagi.chajianreader.cc.cd";

type CharOption = { id: string; name: string };
type LogEntry = { ts: string; text: string; ok: boolean };

export function PhoneStardewApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [chars, setChars] = useState<CharOption[]>([]);
    const [charId, setCharId] = useState<string>("");
    const [enabled, setEnabled] = useState<boolean>(false);
    const [status, setStatus] = useState<NAGI_STATUS>("idle");
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [inboxCount, setInboxCount] = useState<number>(0);
    const statusRef = useRef<NAGI_STATUS>("idle");

    // 读取当前 char 列表 + 已保存的绑定/开关
    useEffect(() => {
        setChars(listBindableCharacters());
        const savedChar = kvGet(KV_CHAR_KEY) || "";
        setCharId(savedChar);
        const savedEnabled = kvGet(KV_ENABLED_KEY) === "1";
        setEnabled(savedEnabled);
        if (savedEnabled && savedChar) {
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
        <PageShell title="星露谷联动" onBack={onClose} >
            <div className="stardew-app-root">
                <div className="stardew-hero">
                    <div className="stardew-hero-icon"><Sprout size={26} /></div>
                    <div className="stardew-hero-info">
                        <div className="stardew-hero-title">星露谷物语</div>
                        <div className="stardew-hero-desc">手机与电脑实时联动 · char 陪你种田聊天</div>
                    </div>
                </div>

                <div className="stardew-section">
                    <div className="stardew-label">绑定角色</div>
                    <select
                        className="stardew-select"
                        value={charId}
                        onChange={(e) => handleBindChar(e.target.value)}
                    >
                        <option value="">— 选择要绑定的 char —</option>
                        {chars.map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                    </select>
                </div>

                <div className="stardew-section">
                    <div className="stardew-label">联动开关</div>
                    <button
                        className={`stardew-toggle ${enabled ? "on" : "off"}`}
                        onClick={handleToggle}
                        disabled={status === "checking"}
                    >
                        {status === "checking" ? <Loader2 size={18} className="stardew-spin" /> : enabled ? <Play size={18} /> : <Square size={18} />}
                        <span>{enabled ? "联动已开启 · 实时串联中" : "联动已关闭"}</span>
                    </button>
                </div>

                <div className="stardew-section">
                    <div className="stardew-label">云端状态</div>
                    <div className="stardew-backend">
                        <span className="stardew-backend-dot" />
                        {KV_BACKEND}
                    </div>
                    <div className="stardew-row">
                        <div className="stardew-stat">已处理 <b>{inboxCount}</b> 条</div>
                        <button className="stardew-btn" onClick={handlePullNow} disabled={status === "checking"}>
                            <RefreshCw size={14} className={status === "checking" ? "stardew-spin" : ""} />
                            立即拉取
                        </button>
                    </div>
                </div>

                {logs.length > 0 && (
                    <div className="stardew-section">
                        <div className="stardew-label">最近动态</div>
                        <div className="stardew-logs">
                            {logs.map((l, i) => (
                                <div className={`stardew-log ${l.ok ? "ok" : "err"}`} key={i}>
                                    <MessageSquare size={12} />
                                    <span>{l.text}</span>
                                    <em>{l.ts}</em>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </PageShell>
    );
}

export default PhoneStardewApp;
