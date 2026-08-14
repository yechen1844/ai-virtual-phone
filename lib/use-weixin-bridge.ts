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

// ── 保活：Wake Lock + 静音音频 ───────────────────────────────
let _wakeLock: WakeLockSentinel | null = null;
let _keepAliveAudio: HTMLAudioElement | null = null;

let _keepAliveWanted = false; // 标记：想要保活但还没获得用户手势
let _suspendedForCall = false; // 标记：因语音/视频通话临时暂停了保活
let _gestureHintShown = false; // 提示"点一下屏幕"只弹一次
let _retryTimer: number | null = null; // 音频播放失败后的周期重试

function ensureAudioCreated() {
    if (_keepAliveAudio) return;
    const audio = new Audio();
    // 生成 1 秒静音 WAV
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
    // ±32 LSB 微噪声（约 -54dB，人耳不可闻）：纯零波形会被 Chrome 判为"无声页面"，
    // 安卓后台 5 分钟后定时器被强节流（轮询延迟拉到分钟级）；有能量的音频
    // 可获得 "playing audio" 豁免。振幅太低（如 ±1）个别安卓 ROM 会当静音丢弃。
    for (let i = 0; i < samples; i++) {
        view.setInt16(44 + i * 2, i % 2 === 0 ? 32 : -32, true);
    }
    const blob = new Blob([buf], { type: "audio/wav" });
    audio.src = URL.createObjectURL(blob);
    audio.loop = true;
    // 0.05（约 -26dB）仍几乎无声，但比 0.01 更容易让系统认可"正在播放音频"，
    // 从而拿到后台豁免；太低的音量会被部分安卓 ROM 当作静音而节流。
    audio.volume = 0.05;
    // 挂进 DOM：个别安卓 ROM/浏览器只认"页面里真实存在"的媒体元素，
    // 游离的 new Audio() 对象可能不被计入媒体会话。绝对定位移出可视区，不占布局。
    try {
        audio.style.position = "fixed";
        audio.style.left = "-9999px";
        audio.style.width = "1px";
        audio.style.height = "1px";
        audio.setAttribute("aria-hidden", "true");
        audio.setAttribute("data-keepalive", "1");
        document.body.appendChild(audio);
    } catch {}
    // 被系统打断/抢占后（来电、其他 App 出声、焦点被抢）自动续播
    audio.addEventListener("pause", () => { if (_keepAliveWanted && !_suspendedForCall) retryPlay(); });
    audio.addEventListener("ended", () => { if (_keepAliveWanted && !_suspendedForCall) retryPlay(); });
    _keepAliveAudio = audio;
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

/** 尝试播放保活音频；失败则等手势 + 周期重试 */
function retryPlay() {
    if (!_keepAliveWanted || _suspendedForCall || !_keepAliveAudio) return;
    const audio = _keepAliveAudio;
    // play() 在部分环境（blob 音频未就绪、系统音频焦点被占等）可能永远不 settle，
    // 导致"无提示、无重试"的假死。加 2s 超时兜底：超时按失败处理，走等手势+重试。
    let settled = false;
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const timeout = window.setTimeout(() => {
        settle(() => {
            ensureGestureListeners();
            scheduleRetry();
            maybeShowGestureHint();
            broadcastKeepAliveStatus("等待触摸启动");
        });
    }, 2000);
    audio.play()
        .then(() => settle(() => {
            window.clearTimeout(timeout);
            clearRetryTimer();
            broadcastKeepAliveStatus("运行中");
        }))
        .catch(() => settle(() => {
            window.clearTimeout(timeout);
            // 不在这里移除触摸监听（旧逻辑在成功后 clear，导致音频被系统打断后
            // 触摸监听已消失，之后再怎么点都无法恢复播放）。
            ensureGestureListeners();
            scheduleRetry();
            maybeShowGestureHint();
            broadcastKeepAliveStatus("等待触摸启动");
        }));
}

/** 用户触摸时尝试播放（浏览器要求音频必须在用户手势中启动） */
function onUserGesture() {
    if (!_keepAliveWanted || !_keepAliveAudio) return;
    retryPlay();
}

async function startKeepAlive() {
    _keepAliveWanted = true;
    broadcastKeepAliveStatus("启动中");

    // 音频优先：play 需要用户手势上下文，绝不能排在 wakeLock 的异步等待之后，
    // 否则 await 期间手势窗口已经过去，首次播放必然失败。
    ensureAudioCreated();
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
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) {
        _keepAliveAudio.pause();
        _keepAliveAudio.currentTime = 0;
    }
    clearGestureListeners();
    _gestureHintShown = false;
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
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    if (_keepAliveAudio) {
        try { _keepAliveAudio.pause(); } catch {}
    }
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
