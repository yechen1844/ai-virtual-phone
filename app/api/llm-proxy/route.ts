import { NextRequest, NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const maxDuration = 120;

function isPrivateIpv4(host: string): boolean {
    const parts = host.split(".").map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    return a === 0
        || a === 10
        || a === 127
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127);
}

function blockedProxyUrlReason(rawUrl: string): string | null {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return "URL 格式不合法";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        return "只允许 http/https URL";
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isIpv6Literal = host.includes(":");
    const blocked = host === "localhost"
        || host.endsWith(".localhost")
        || host.endsWith(".local")
        || host.endsWith(".internal")
        || host === "::1"
        || host === "0:0:0:0:0:0:0:1"
        || (isIpv6Literal && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:")))
        || isPrivateIpv4(host);
    return blocked ? "不允许转发到本机或内网地址" : null;
}

/**
 * 域名白名单：默认只允许转发到 opencode 网关，避免公开部署后变成「开放代理」
 * 被任意站点借用转发流量。可用环境变量 LLM_PROXY_ALLOWED_HOSTS 扩展
 * （逗号分隔的域名清单，置空表示不限制）。
 */
function hostAllowed(host: string): boolean {
    const raw = process.env.LLM_PROXY_ALLOWED_HOSTS || "opencode.ai,api.opencode.ai";
    const list = raw.split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
    if (list.length === 0) return true;
    const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
    return list.some(item => normalized === item || normalized.endsWith(`.${item}`));
}

/**
 * 服务端 LLM 请求代理：浏览器 → /api/llm-proxy → 上游（如 OpenCode 网关）。
 * 解决 opencode.ai 等供应商未开放浏览器 CORS 的问题；同时支持流式 SSE 原样回传。
 *
 * POST /api/llm-proxy
 * Body: { url, headers, body, method? }
 */
export async function POST(req: NextRequest) {
    let parsed: { url?: unknown; headers?: unknown; body?: unknown; method?: unknown };
    try {
        parsed = await req.json();
    } catch {
        return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
    }

    const url = typeof parsed.url === "string" ? parsed.url : "";
    if (!url) {
        return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }
    const blockedReason = blockedProxyUrlReason(url);
    if (blockedReason) {
        return NextResponse.json({ error: blockedReason }, { status: 400 });
    }
    let urlObj: URL;
    try {
        urlObj = new URL(url);
    } catch {
        return NextResponse.json({ error: "URL 格式不合法" }, { status: 400 });
    }
    if (!hostAllowed(urlObj.hostname)) {
        return NextResponse.json({ error: "不允许转发到白名单之外的域名" }, { status: 403 });
    }

    const method = typeof parsed.method === "string" && parsed.method ? parsed.method : "POST";

    const headers: Record<string, string> = {};
    if (parsed.headers && typeof parsed.headers === "object") {
        for (const [key, value] of Object.entries(parsed.headers as Record<string, unknown>)) {
            if (typeof value === "string") headers[key] = value;
        }
    }
    if (!headers["Content-Type"] && bodyHoldsPayload(parsed.body)) {
        headers["Content-Type"] = "application/json";
    }

    const rawBody = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? {});

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
        const upstream = await proxyFetch(url, {
            method,
            headers,
            body: method === "GET" ? undefined : rawBody,
            signal: controller.signal,
        });
        const contentType = upstream.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
            // 流式：把上游 SSE 流直接 pipe 回浏览器，聊天/工具流解析器（readSseStream 等）照常工作
            return new Response(upstream.body, {
                status: upstream.status,
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
            });
        }
        const text = await upstream.text();
        return new Response(text, {
            status: upstream.status,
            headers: { "Content-Type": contentType || "application/json" },
        });
    } catch (err) {
        const safeUrl = url.length > 90 ? `${url.slice(0, 90)}...` : url;
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout");
        return NextResponse.json(
            { error: isTimeout ? `LLM 代理请求超时（${safeUrl}）` : `LLM 代理请求失败（${safeUrl}）：${message}` },
            { status: isTimeout ? 504 : 502 },
        );
    } finally {
        clearTimeout(timeout);
    }
}

function bodyHoldsPayload(body: unknown): boolean {
    return body !== undefined && body !== null && body !== "";
}