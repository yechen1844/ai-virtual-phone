// lib/llm-http.ts
// LLM 请求的统一 fetch 出口。所有走 buildProviderRequest 的调用点统一经它发请求：
//  - 普通 provider：浏览器直连（现状不变）；
//  - serverProxy 标记（OpenCode 网关）：改发本站 /api/llm-proxy，由服务端转发，
//    绕过 opencode.ai 未开放浏览器 CORS 的问题。
//  - 上游 429/5xx 与网络抖动自动退避重试（可在聊天设置里关闭），避免一次瞬时打满就整条回复失败。

import type { LlmRequestPayload } from "./llm-provider-adapter";
import { getLlmRetryCount, isLlmRetryEnabled } from "./chat-storage";

export type FetchLlmPayloadOptions = {
    signal?: AbortSignal;
};

/** 上游瞬时故障：值得退避后重试的状态码 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BASE_RETRY_DELAY_MS = 1200;
/** 单次退避等待上限，避免重试次数调大后等待过久 */
const MAX_RETRY_DELAY_MS = 8000;

function isAbortLike(error: unknown): boolean {
    return error instanceof DOMException
        ? error.name === "AbortError"
        : Boolean(error && typeof error === "object" && (error as { name?: string }).name === "AbortError");
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function sendLlmPayloadOnce(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions,
): Promise<Response> {
    const bodyText = JSON.stringify(payload.body);
    if (payload.serverProxy) {
        return fetch("/api/llm-proxy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: payload.url,
                headers: payload.headers,
                body: bodyText,
            }),
            signal: options.signal,
        });
    }
    return fetch(payload.url, {
        method: "POST",
        headers: payload.headers,
        body: bodyText,
        signal: options.signal,
    });
}

export async function fetchLlmPayload(
    payload: LlmRequestPayload,
    options: FetchLlmPayloadOptions = {},
): Promise<Response> {
    // 每次请求时读取配置：总尝试次数 = 1 次首发 + 用户配置的重试次数（开关关闭则只发一次）
    const attempts = isLlmRetryEnabled() ? 1 + getLlmRetryCount() : 1;

    for (let attempt = 1; ; attempt++) {
        const isLastAttempt = attempt >= attempts;
        try {
            const response = await sendLlmPayloadOnce(payload, options);
            if (response.ok || isLastAttempt || !RETRYABLE_STATUS.has(response.status)) return response;
            // 丢掉响应体再重试，避免连接被占住
            try { await response.text(); } catch { /* 忽略读取失败 */ }
            console.warn(`[LLM] upstream ${response.status}, retry ${attempt}/${attempts - 1}`);
        } catch (error) {
            // 用户主动停止 / 超时取消：不重试
            if (isAbortLike(error) || isLastAttempt) throw error;
            console.warn(`[LLM] request failed, retry ${attempt}/${attempts - 1}`, error);
        }
        await waitForRetry(
            Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS),
            options.signal,
        );
    }
}
