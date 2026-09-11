// lib/xhs-share.ts
// 小红书帖子抓取（移植自 roche-xhs-reader 的核心抓取逻辑，仅保留所需部分）。
// 原理：不依赖 cookie，由 CF Worker 以 iPhone UA 请求小红书移动版页面并返回解析后的 JSON。
// 代理链：自定义 CF Worker（可选）→ 内置主代理（456）→ Vercel 回退。

const BUILTIN_CF_PROXY = "https://456.chajianreader.cc.cd";
const BUILTIN_VERCEL_PROXY = "https://vercel.chajianreader.cc.cd";

const CUSTOM_PROXY_KEY = "xhs_custom_cf_proxy";
const MAX_IMAGES = 9;

export type XhsNoteComment = {
    nickname: string;
    content: string;
    likedCount?: number | string;
};

export type XhsNote = {
    noteId: string;
    title: string;
    desc: string;
    type: "post" | "video";
    authorName: string;
    images: string[];
    tags: string[];
    likedCount?: number | string;
    collectedCount?: number | string;
    commentCount?: number | string;
    shareCount?: number | string;
    comments: XhsNoteComment[];
};

// ── 自定义 CF Worker 地址（可选，localStorage 持久化） ──

export function loadXhsCustomProxy(): string {
    if (typeof window === "undefined") return "";
    try {
        return window.localStorage.getItem(CUSTOM_PROXY_KEY)?.trim() || "";
    } catch {
        return "";
    }
}

export function saveXhsCustomProxy(url: string): void {
    try {
        const trimmed = url.trim();
        if (trimmed) window.localStorage.setItem(CUSTOM_PROXY_KEY, trimmed);
        else window.localStorage.removeItem(CUSTOM_PROXY_KEY);
    } catch { /* ignore */ }
}

// ── 链接提取（覆盖分享口令里的短链/长链） ──

export function extractXhsUrl(text: string): string | null {
    if (!text) return null;
    // 短链 xhslink.com / 新版 xhslink.cn（含多段路径），长链 www.xiaohongshu.com
    const m = text.match(
        /https?:\/\/(?:xhslink\.(?:com|cn)\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+|(?:www\.)?xiaohongshu\.com\/[^\s`'"（()）,。！？；、）)\]》\u4e00-\u9fa5]+)/,
    );
    return m ? m[0] : null;
}

// ── 抓取 ──

function buildProxyList(): { name: string; url: (target: string) => string }[] {
    const list: { name: string; url: (target: string) => string }[] = [];
    const custom = loadXhsCustomProxy();
    if (custom) {
        list.push({ name: "自定义CF", url: (u) => custom.replace(/\/$/, "") + "?url=" + encodeURIComponent(u) });
    }
    list.push({ name: "内置主代理", url: (u) => BUILTIN_CF_PROXY.replace(/\/$/, "") + "?url=" + encodeURIComponent(u) });
    list.push({ name: "Vercel回退", url: (u) => BUILTIN_VERCEL_PROXY.replace(/\/$/, "") + "?url=" + encodeURIComponent(u) });
    return list;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        window.clearTimeout(timer);
    }
}

function normalizeImgUrl(url: string): string {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    if (!url.startsWith("http")) return "";
    return url;
}

function isNoteJson(parsed: unknown): boolean {
    const obj = parsed as Record<string, unknown> | null;
    return !!obj && typeof obj === "object"
        && Boolean(obj.noteId || obj.title || obj.desc || obj.images);
}

/** 把主代理返回的解析 JSON 归一化为 XhsNote */
function convertJsonToNote(d: Record<string, unknown>): XhsNote {
    const author = d.author as { nickname?: string } | undefined;
    const rawImages = Array.isArray(d.images) ? d.images : [];
    const images = rawImages
        .map((img) => normalizeImgUrl(typeof img === "string" ? img : ((img as { url?: string; urlDefault?: string })?.url || (img as { urlDefault?: string })?.urlDefault || "")))
        .filter(Boolean)
        .slice(0, MAX_IMAGES);
    const rawTags = Array.isArray(d.tags) ? d.tags : [];
    const tags = rawTags
        .map((t) => (typeof t === "string" ? t : ((t as { name?: string })?.name || "")))
        .filter(Boolean);
    const rawComments = Array.isArray(d.comments) ? d.comments : [];
    const comments: XhsNoteComment[] = rawComments
        .map((c) => {
            const item = c as { content?: string; nickname?: string; author?: string; likedCount?: number | string; time?: number | string };
            return {
                content: String(item.content || "").trim(),
                nickname: String(item.nickname || item.author || "").trim(),
                likedCount: item.likedCount,
            };
        })
        .filter((c) => c.content)
        .slice(0, 5);
    return {
        noteId: String(d.noteId || ""),
        title: String(d.title || "").trim(),
        desc: String(d.desc || "").trim(),
        type: d.type === "video" ? "video" : "post",
        authorName: String(author?.nickname || "").trim(),
        images,
        tags,
        likedCount: d.likedCount as number | string | undefined,
        collectedCount: d.collectedCount as number | string | undefined,
        commentCount: d.commentCount as number | string | undefined,
        shareCount: d.shareCount as number | string | undefined,
        comments,
    };
}

/** 抓取小红书笔记（依次尝试代理链，任一成功即返回） */
export async function fetchXhsNote(xhsUrl: string): Promise<XhsNote> {
    if (!xhsUrl) throw new Error("链接为空");
    const proxies = buildProxyList();
    if (proxies.length === 0) throw new Error("没有可用的抓取代理");

    const errors: string[] = [];
    for (const proxy of proxies) {
        try {
            const resp = await fetchWithTimeout(proxy.url(xhsUrl), 20000);
            if (!resp.ok) {
                errors.push(`${proxy.name}: HTTP ${resp.status}`);
                continue;
            }
            const text = await resp.text();
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                errors.push(`${proxy.name}: 返回非 JSON`);
                continue;
            }
            const obj = parsed as Record<string, unknown> | null;
            if (!isNoteJson(parsed)) {
                const msg = obj && typeof obj === "object" && typeof obj.error === "string" ? obj.error : "无笔记数据";
                errors.push(`${proxy.name}: ${msg}`);
                continue;
            }
            return convertJsonToNote(obj as Record<string, unknown>);
        } catch (e) {
            const msg = e instanceof Error ? (e.name === "AbortError" ? "请求超时" : e.message) : "请求失败";
            errors.push(`${proxy.name}: ${msg}`);
        }
    }
    throw new Error(`所有代理均失败：${errors.join(" | ")}`);
}

/** 通过同一代理链下载笔记配图（绕过防盗链） */
export async function fetchXhsImageBlob(imageUrl: string): Promise<Blob> {
    if (!imageUrl) throw new Error("图片地址为空");
    const proxies = buildProxyList();
    const errors: string[] = [];
    for (const proxy of proxies) {
        try {
            const resp = await fetchWithTimeout(proxy.url(imageUrl), 25000);
            if (!resp.ok) {
                errors.push(`${proxy.name}: HTTP ${resp.status}`);
                continue;
            }
            const blob = await resp.blob();
            if (blob.size === 0) {
                errors.push(`${proxy.name}: 空图片`);
                continue;
            }
            return blob;
        } catch (e) {
            errors.push(`${proxy.name}: ${e instanceof Error ? e.message : "请求失败"}`);
        }
    }
    throw new Error(`图片下载失败：${errors.join(" | ")}`);
}

/** 压缩图片（封面用：最长边压到 maxDim，转 JPEG），失败时返回原图 */
export async function compressXhsImageBlob(blob: Blob, maxDim = 640, quality = 0.82): Promise<Blob> {
    try {
        const bitmap = await createImageBitmap(blob);
        const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return blob;
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
        const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        return out && out.size > 0 ? out : blob;
    } catch {
        return blob;
    }
}
