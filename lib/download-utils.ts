export type DownloadFileOptions = {
    disableNativeShare?: boolean;
    nativeShareOnly?: boolean;
};

export function isAndroidBrowser(): boolean {
    return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/** 是否运行在 float 安卓壳（WebView）里。壳内 WebView 不会把 blob:/data: 交回浏览器下载，
 *  必须走原生 AndroidShell.downloadBlob 才真正落盘。 */
export function isFloatShell(): boolean {
    if (typeof window === "undefined") return false;
    try { return !!(window as unknown as Record<string, unknown>)?.AndroidShell; } catch { return false; }
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result === "string") {
                // FileReader 读出来的是 dataURL：去掉前缀拿纯 base64
                const idx = result.indexOf(",");
                resolve(idx >= 0 ? result.slice(idx + 1) : result);
            } else {
                reject(new Error("读取文件失败"));
            }
        };
        reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
        reader.readAsDataURL(blob);
    });
}

export function isIOSBrowser(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export async function downloadFile(blob: Blob, filename: string, options: DownloadFileOptions = {}): Promise<void> {
    // float 安卓壳：WebView 不处理 blob:/data:，必须交给原生写进「下载」目录。
    if (isFloatShell()) {
        const shell = (window as unknown as { AndroidShell?: { downloadBlob?: (b64: string, name: string, mime: string) => void } }).AndroidShell;
        if (shell?.downloadBlob) {
            const b64 = await blobToBase64(blob);
            shell.downloadBlob(b64, filename || "download", blob.type || "application/octet-stream");
            return;
        }
        // 万一壳版本老、没有 downloadBlob，则回退到页面 a[download]，尽力而为。
    }

    const url = URL.createObjectURL(blob);
    const anchorDownload = () => {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    };

    const shouldUseNativeShare = options.nativeShareOnly || (!options.disableNativeShare && isIOSBrowser());
    if (shouldUseNativeShare) {
        const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
        const canNativeShare = typeof navigator !== "undefined"
            && typeof navigator.share === "function"
            && typeof navigator.canShare === "function"
            && navigator.canShare({ files: [file] });
        if (canNativeShare) {
            try {
                await navigator.share({ files: [file] });
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return;
            } catch (err) {
                // User explicitly dismissed the share sheet → respect it, don't force a download.
                if (err instanceof DOMException && err.name === "AbortError") {
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    return;
                }
                // Any other failure (webview without real file-share support, lost user
                // activation, etc.) is surfaced to the caller on iOS instead of opening
                // the blob URL, which can navigate away from the app.
            }
        }
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        throw new Error("当前浏览器没有成功打开系统分享，请在 Safari 中重试，或导出轻量备份后再试。");
    }

    anchorDownload();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadUrl(url: string, filename: string): Promise<void> {
    let blob: Blob | null = null;

    try {
        const res = await fetch(url);
        if (res.ok) blob = await res.blob();
    } catch { /* CORS or network error — try proxy */ }

    if (!blob && /^https?:\/\//.test(url)) {
        try {
            const res = await fetch("/api/tool-proxy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url, method: "GET" }),
            });
            if (res.ok) blob = await res.blob();
        } catch { /* proxy also failed */ }
    }

    if (blob) {
        await downloadFile(blob, filename);
    } else {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
}
