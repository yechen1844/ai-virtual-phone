// lib/use-weixin-bridge.ts
// React hook：管理所有 WeChat Bot 的轮询生命周期 + 后台保活。

import { useEffect, useRef, useState, useCallback } from "react";
import { loadWeixinBots, loadKeepAlive, type WeixinBotConfig } from "./weixin-storage";
import { runBotLoop } from "./weixin-bridge";

export type BotRunStatus = {
    status: "running" | "stopped" | "error";
    message?: string;
};

// ⏸ 临时总开关：暂停微信 Bot 的 getupdates 长轮询，止血 Netlify compute
//（长轮询会全程占用函数时长）。仅停轮询，不影响后台保活（保活是通用功能）。
// 恢复功能：改回 false 重新部署。长期方案=用户电脑本地助手接管轮询。
const WEIXIN_BRIDGE_PAUSED: boolean = true;

// 模块级状态：让设置页面也能读到
const _statusMap = new Map<string, BotRunStatus>();

export function getWeixinBotStatus(id: string): BotRunStatus {
    return _statusMap.get(id) ?? { status: "stopped" };
}

function broadcastStatus() {
    window.dispatchEvent(new CustomEvent("weixin-status-changed"));
}

// ── 保活：Wake Lock + <audio> 静音音频 + MediaSession ─────────
// Chrome Android 的媒体通知只认 <audio>/<video> 元素（不认 AudioContext），
// 所以必须用 <audio> 播放才能让系统媒体管理显示播放条。
let _wakeLock: WakeLockSentinel | null = null;
let _keepAliveAudio: HTMLAudioElement | null = null;

let _keepAliveWanted = false;
let _suspendedForCall = false;
let _gestureHintShown = false;
let _retryTimer: number | null = null;

function ensureAudioCreated() {
    if (_keepAliveAudio) return;
    const audio = new Audio();
    // 生成 1 秒静音 WAV（有微弱能量，人耳不可闻）
    const sampleRate = 8000;
    const samples = sampleRate;
    const buf = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buf);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples * 2, true);
    for (let i = 0; i < samples; i++) {
        view.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true);
    }
    const blob = new Blob([buf], { type: "audio/wav" });
    audio.src = URL.createObjectURL(blob);
    audio.loop = true;
    audio.volume = 0.01;
    // 挂进 DOM（Chrome Android 只认页面里真实存在的媒体元素）
    try {
        audio.style.position = "fixed";
        audio.style.left = "-9999px";
        audio.style.width = "1px";
        audio.style.height = "1px";
        audio.setAttribute("aria-hidden", "true");
        audio.setAttribute("data-keepalive", "1");
        document.body.appendChild(audio);
    } catch {}
    // MediaSession：让系统媒体管理显示"float 正在播放"
    try {
        if ("mediaSession" in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: "float",
                artist: "float",
                album: "后台保活",
            });
            navigator.mediaSession.setActionHandler("play", () => { if (_keepAliveWanted && !_suspendedForCall) retryPlay(); });
            navigator.mediaSession.setActionHandler("pause", () => { try { _keepAliveAudio?.pause(); } catch {} });
            navigator.mediaSession.setActionHandler("stop", () => { try { _keepAliveAudio?.pause(); } catch {} });
        }
    } catch {}
    // 被系统打断后自动续播
    audio.addEventListener("pause", () => { if (_keepAliveWanted && !_suspendedForCall) retryPlay(); });
    audio.addEventListener("ended", () => { if (_keepAliveWanted && !_suspendedForCall) retryPlay(); });
    _keepAliveAudio = audio;
}

function clearGestureListeners() {
    document.removeEventListener("touchstart", onUserGesture, true);
    document.removeEventListener("click", onUserGesture, true);
}

function ensureGestureListeners() {
    document.addEventListener("touchstart", onUserGesture, { capture: true, once: false });
    document.addEventListener("click", onUserGesture, { capture: true, once: false });
}

function clearRetryTimer() {
    if (_retryTimer !== null) {
        window.clearTimeout(_retryTimer);
        _retryTimer = null;
    }
}

function scheduleRetry() {
    if (_retryTimer !== null) return;
    _retryTimer = window.setTimeout(() => {
        _retryTimer = null;
        retryPlay();
    }, 3000);
}

function maybeShowGestureHint() {
    if (_gestureHintShown) return;
    _gestureHintShown = true;
    window.dispatchEvent(new CustomEvent("global-notice", {
        detail: "后台保活已开启：请在页面上点一下屏幕，让静音音频完成启动",
    }));
}

function broadcastKeepAliveStatus(status: string) {
    window.dispatchEvent(new CustomEvent("weixin-keepalive-status", { detail: status }));
}

/** 尝试播放保活音频；失败则等手势 + 周期重试 */
function retryPlay() {
    if (!_keepAliveWanted || _suspendedForCall || !_keepAliveAudio) return;
    _keepAliveAudio.play()
        .then(() => {
            clearRetryTimer();
            // 显式设 playbackState=playing：确保系统媒体管理显示播放条
            try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; } catch {}
            broadcastKeepAliveStatus("运行中");
        })
        .catch(() => {
            ensureGestureListeners();
            scheduleRetry();
            maybeShowGestureHint();
            broadcastKeepAliveStatus("等待触摸启动");
        });
}

function onUserGesture() {
    if (!_keepAliveWanted || !_keepAliveAudio) return;
    retryPlay();
}

async function startKeepAlive() {
    _keepAliveWanted = true;
    broadcastKeepAliveStatus("启动中");
    ensureAudioCreated();
    ensureGestureListeners();
    retryPlay();
    try {
        if ("wakeLock" in navigator) {
            const sentinel = await navigator.wakeLock.request("screen");
            sentinel.addEventListener("release", () => { _wakeLock = null; });
            _wakeLock = sentinel;
        }
    } catch {}
}

function stopKeepAlive() {
    _keepAliveWanted = false;
    _suspendedForCall = false;
    clearRetryTimer();
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) {
        _keepAliveAudio.pause();
        _keepAliveAudio.currentTime = 0;
    }
    clearGestureListeners();
    _gestureHintShown = false;
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; } } catch {}
    broadcastKeepAliveStatus("已停止");
}

export function suspendKeepAliveForCall() {
    if (!_keepAliveWanted) return;
    _suspendedForCall = true;
    clearRetryTimer();
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) {
        try { _keepAliveAudio.pause(); } catch {}
    }
    clearGestureListeners();
}

export function resumeKeepAliveAfterCall() {
    if (!_suspendedForCall) return;
    _suspendedForCall = false;
    if (!_keepAliveWanted) return;
    void startKeepAlive();
}

export function useWeixinBridge() {
    const [bots, setBots] = useState<WeixinBotConfig[]>([]);
    const abortMap = useRef(new Map<string, AbortController>());

    // 初始加载 + 监听配置变更
    useEffect(() => {
        setBots(loadWeixinBots());
        const handler = () => setBots(loadWeixinBots());
        window.addEventListener("weixin-config-changed", handler);
        return () => window.removeEventListener("weixin-config-changed", handler);
    }, []);

    // 启动 bot（可复用：首次 + 回前台恢复）
    const startBot = useCallback((bot: WeixinBotConfig) => {
        if (WEIXIN_BRIDGE_PAUSED) {
            _statusMap.set(bot.id, { status: "stopped", message: "已暂停（为节省额度临时关闭，稍后恢复）" });
            broadcastStatus();
            return;
        }
        if (abortMap.current.has(bot.id)) return;

        const ctrl = new AbortController();
        abortMap.current.set(bot.id, ctrl);

        _statusMap.set(bot.id, { status: "running" });
        broadcastStatus();

        runBotLoop(
            bot,
            ctrl.signal,
            (status, message) => {
                _statusMap.set(bot.id, { status, message });
                broadcastStatus();
            },
        ).finally(() => {
            abortMap.current.delete(bot.id);
            if (!_statusMap.get(bot.id)?.message) {
                _statusMap.set(bot.id, { status: "stopped" });
                broadcastStatus();
            }
        });
    }, []);

    // 同步轮询 loop
    useEffect(() => {
        const activeBots = bots.filter(b => b.enabled && b.botToken.trim());

        for (const bot of activeBots) startBot(bot);

        // 停止已禁用或已删除的 bot
        for (const [id, ctrl] of abortMap.current) {
            if (!activeBots.find(b => b.id === id)) {
                ctrl.abort();
                _statusMap.set(id, { status: "stopped" });
            }
        }
        broadcastStatus();
    }, [bots, startBot]);

    // 保活管理：只要用户开启保活就启动，不依赖 Bot 是否启用。
    useEffect(() => {
        const shouldKeepAlive = loadKeepAlive();
        if (shouldKeepAlive) {
            startKeepAlive();
        } else {
            stopKeepAlive();
        }

        // 监听保活设置变更
        const onCfg = () => {
            const on = loadKeepAlive();
            if (on) startKeepAlive(); else stopKeepAlive();
        };
        window.addEventListener("weixin-config-changed", onCfg);
        return () => {
            window.removeEventListener("weixin-config-changed", onCfg);
            stopKeepAlive();
        };
    }, []);

    // 回到前台：恢复被挂起的轮询 + 重新获取 Wake Lock
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState !== "visible") return;

            // 重启所有已停止（非错误）的 bot
            const activeBots = loadWeixinBots().filter(b => b.enabled && b.botToken.trim());
            for (const bot of activeBots) {
                if (!abortMap.current.has(bot.id)) {
                    startBot(bot);
                }
            }

            // Wake Lock 在 visibilitychange 时会自动释放，需重新获取
            if (loadKeepAlive()) {
                startKeepAlive();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, [startBot]);

    // 卸载时全部停止
    useEffect(() => {
        return () => {
            for (const ctrl of abortMap.current.values()) ctrl.abort();
        };
    }, []);
}
