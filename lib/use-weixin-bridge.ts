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

// ── 保活：Wake Lock + WebAudio 微弱噪声 ───────────────────────
// 用 AudioContext 持续循环播放微弱噪声（loop），获得系统"正在播放音频"状态：
// - AudioContext 一旦 resume 成功（running），切后台不会被系统暂停，比 HTMLAudioElement 稳定
// - 配合 MediaSession 声明，系统媒体管理/通知栏会显示"float 后台保活"播放条
let _wakeLock: WakeLockSentinel | null = null;
let _keepAliveCtx: AudioContext | null = null;
let _keepAliveSource: AudioBufferSourceNode | null = null;
let _keepAliveGain: GainNode | null = null;
let _keepAliveSourceStarted = false;

let _keepAliveWanted = false; // 标记：想要保活但还没获得用户手势
let _suspendedForCall = false; // 标记：因语音/视频通话临时暂停了保活
let _gestureHintShown = false; // 提示"点一下屏幕"只弹一次
let _retryTimer: number | null = null; // 音频播放失败后的周期重试

function createKeepAliveAudio(): boolean {
    if (_keepAliveCtx) return true;
    try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return false;
        const ctx = new Ctor();
        const gain = ctx.createGain();
        gain.gain.value = 0.01; // 极轻（人耳不可闻），有微弱能量避免被系统判为纯静音
        gain.connect(ctx.destination);
        _keepAliveCtx = ctx;
        _keepAliveGain = gain;
        // 声明媒体会话：让系统媒体管理/通知栏能显示"float 正在播放"。
        // 不设 MediaSession metadata 时，即使媒体在播，系统也可能不显示播放条。
        try {
            if ("mediaSession" in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: "float",
                    artist: "float",
                    album: "后台保活",
                });
                navigator.mediaSession.setActionHandler("play", () => { if (_keepAliveWanted && !_suspendedForCall) retryPlay(); });
                navigator.mediaSession.setActionHandler("pause", () => { suspendKeepAliveSource(); });
                navigator.mediaSession.setActionHandler("stop", () => { suspendKeepAliveSource(); });
            }
        } catch {}
        return true;
    } catch {
        return false;
    }
}

/** 生成并启动循环播放的无声音频（极弱噪声，人耳不可闻但有微弱能量） */
function startKeepAliveSource() {
    if (!_keepAliveCtx || !_keepAliveGain || _keepAliveSource) return;
    try {
        const ctx = _keepAliveCtx;
        const len = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.001; // 极弱噪声（人耳不可闻）
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.connect(_keepAliveGain);
        src.start(0);
        _keepAliveSource = src;
        _keepAliveSourceStarted = true;
        // 关键修复：AudioContext 不像 <audio> 元素会自动设 MediaSession.playbackState，
        // 必须手动设为 "playing"，系统媒体管理才会显示播放条
        try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; } catch {}
    } catch {
        _keepAliveSource = null;
        _keepAliveSourceStarted = false;
    }
}

function suspendKeepAliveSource() {
    try {
        _keepAliveSource?.stop();
    } catch {}
    _keepAliveSource = null;
    _keepAliveSourceStarted = false;
    try {
        if (_keepAliveCtx && _keepAliveCtx.state === "running") void _keepAliveCtx.suspend();
    } catch {}
    try { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; } catch {}
}

function clearGestureListeners() {
    document.removeEventListener("touchstart", onUserGesture, true);
    document.removeEventListener("click", onUserGesture, true);
}

/** 幂等挂上触摸监听：同函数同参数重复 addEventListener 不会叠加，可安全反复调用 */
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

/** 保活状态广播：设置页可实时显示（运行中 / 等待触摸启动 / 启动中 / 已停止） */
function broadcastKeepAliveStatus(status: string) {
    window.dispatchEvent(new CustomEvent("weixin-keepalive-status", { detail: status }));
}

/** 尝试启动/恢复保活音频（AudioContext.resume 需要用户手势）；成功返回 true */
async function playKeepAliveAudio(): Promise<boolean> {
    if (!_keepAliveCtx) return false;
    try {
        if (_keepAliveCtx.state === "suspended" || _keepAliveCtx.state === "interrupted") {
            await _keepAliveCtx.resume();
        }
        if (!_keepAliveSourceStarted) startKeepAliveSource();
        return _keepAliveCtx.state === "running";
    } catch {
        return false;
    }
}

/** 尝试播放保活音频；失败则等手势 + 周期重试 */
function retryPlay() {
    if (!_keepAliveWanted || _suspendedForCall || !_keepAliveCtx) return;
    playKeepAliveAudio()
        .then((ok) => {
            if (ok) {
                clearRetryTimer();
                broadcastKeepAliveStatus("运行中");
            } else {
                // 不在这里移除触摸监听（旧逻辑在成功后 clear，导致音频被系统打断后
                // 触摸监听已消失，之后再怎么点都无法恢复播放）。
                ensureGestureListeners();
                scheduleRetry();
                maybeShowGestureHint();
                broadcastKeepAliveStatus("等待触摸启动");
            }
        })
        .catch(() => {
            ensureGestureListeners();
            scheduleRetry();
            maybeShowGestureHint();
            broadcastKeepAliveStatus("等待触摸启动");
        });
}

/** 用户触摸时尝试播放（浏览器要求音频必须在用户手势中启动） */
function onUserGesture() {
    if (!_keepAliveWanted || !_keepAliveCtx) return;
    retryPlay();
}

async function startKeepAlive() {
    _keepAliveWanted = true;
    broadcastKeepAliveStatus("启动中");

    // 音频优先：resume 需要用户手势上下文，绝不能排在 wakeLock 的异步等待之后，
    // 否则 await 期间手势窗口已经过去，首次启动必然失败。
    createKeepAliveAudio();
    ensureGestureListeners();
    retryPlay();

    // Wake Lock（切后台会被浏览器自动释放，回前台再取）
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
    suspendKeepAliveSource();
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    clearGestureListeners();
    _gestureHintShown = false;
    // 释放媒体会话声明，让系统媒体管理不再显示 float
    try { if ("mediaSession" in navigator) { navigator.mediaSession.playbackState = "none"; navigator.mediaSession.metadata = null; } } catch {}
    broadcastKeepAliveStatus("已停止");
}

/**
 * Pause keep-alive for the duration of a voice/video call. Starting STT grabs
 * the mic and the OS audio focus, which would otherwise interrupt the looping
 * silent audio and leave it dead after the call. The call holds the mic + audio
 * session itself, so keep-alive is redundant meanwhile. No-op if keep-alive is off.
 */
export function suspendKeepAliveForCall() {
    if (!_keepAliveWanted) return;
    _suspendedForCall = true;
    clearRetryTimer();
    suspendKeepAliveSource();
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    clearGestureListeners();
}

/** Re-arm keep-alive after a call ends, unless the user turned it off meanwhile. */
export function resumeKeepAliveAfterCall() {
    if (!_suspendedForCall) return;
    _suspendedForCall = false;
    if (!_keepAliveWanted) return; // keep-alive was switched off during the call
    void startKeepAlive(); // re-acquires Wake Lock + replays the silent audio
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
