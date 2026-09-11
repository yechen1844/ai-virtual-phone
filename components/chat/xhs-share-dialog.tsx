"use client";

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import {
    extractXhsUrl,
    fetchXhsImageBlob,
    fetchXhsNote,
    compressXhsImageBlob,
    loadXhsCustomProxy,
    saveXhsCustomProxy,
    type XhsNote,
} from "@/lib/xhs-share";
import { saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { formatXiaohongshuShareForPrompt } from "@/lib/chat-share";

type XhsShareDialogProps = {
    onClose: () => void;
    onSend: (payload: { mediaData: Record<string, unknown>; content: string }) => void;
};

/** 小红书链接分享：粘贴链接 → 抓取帖子 → 预览 → 以分享卡片发给角色 */
export function XhsShareDialog({ onClose, onSend }: XhsShareDialogProps) {
    const [urlText, setUrlText] = useState("");
    const [customProxy, setCustomProxy] = useState("");
    const [showProxyInput, setShowProxyInput] = useState(false);
    const [fetching, setFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<XhsNote | null>(null);
    const [imageUrls, setImageUrls] = useState<string[]>([]);
    const [coverAssetId, setCoverAssetId] = useState<string>("");
    const [imageProgress, setImageProgress] = useState(0);

    useEffect(() => {
        setCustomProxy(loadXhsCustomProxy());
    }, []);

    async function handleFetch() {
        if (fetching) return;
        setError(null);
        setNote(null);
        setImageUrls([]);
        setCoverAssetId("");
        setImageProgress(0);
        const url = extractXhsUrl(urlText);
        if (!url) {
            setError("未识别到小红书链接，请粘贴分享口令或完整链接");
            return;
        }
        saveXhsCustomProxy(customProxy);
        setFetching(true);
        try {
            const fetched = await fetchXhsNote(url);
            setNote(fetched);
            // 抓取全部配图：压缩后作为 data URL 列表（发送后第一轮注入视觉），
            // 首图同时落库（分享卡片封面渲染用）。单张失败跳过，不阻塞整体。
            const urls: string[] = [];
            for (let i = 0; i < fetched.images.length; i++) {
                setImageProgress(i + 1);
                try {
                    const blob = await fetchXhsImageBlob(fetched.images[i]);
                    const compressed = await compressXhsImageBlob(blob, 512, 0.75);
                    const dataUrl = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.onerror = () => reject(new Error("图片编码失败"));
                        reader.readAsDataURL(compressed);
                    });
                    if (dataUrl.startsWith("data:image/")) {
                        urls.push(dataUrl);
                        if (i === 0) setCoverAssetId(await saveChatImageToIndexedDB(compressed));
                    }
                } catch { /* 跳过失败的图 */ }
            }
            setImageUrls(urls);
            setImageProgress(0);
        } catch (e) {
            setError(e instanceof Error ? e.message : "抓取失败");
        } finally {
            setFetching(false);
        }
    }

    function handleSend() {
        if (!note) return;
        const stats = [
            note.likedCount ? `赞${note.likedCount}` : "",
            note.collectedCount ? `收藏${note.collectedCount}` : "",
            note.commentCount ? `评论${note.commentCount}` : "",
        ].filter(Boolean).join("·");
        const content = formatXiaohongshuShareForPrompt({
            author: note.authorName,
            title: note.title,
            body: note.desc,
            noteType: note.type,
            tags: note.tags,
            hotComments: note.comments,
            stats: stats || undefined,
        });
        onSend({
            mediaData: {
                xiaohongshuAuthor: note.authorName,
                xiaohongshuTitle: note.title,
                xiaohongshuBody: note.desc,
                xiaohongshuNoteType: note.type,
                xiaohongshuTags: note.tags,
                xiaohongshuImageAssetId: coverAssetId || undefined,
                xiaohongshuImages: imageUrls.length ? imageUrls : undefined,
                xiaohongshuHotComments: note.comments.length ? note.comments : undefined,
                xiaohongshuStats: stats || undefined,
            },
            content,
        });
    }

    return (
        <div className="modal-overlay" data-ui="modal" role="dialog" aria-modal="true" aria-label="分享小红书帖子" onClick={onClose}>
            <div className="modal-dialog chat-xhs-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between w-full">
                    <h3 className="modal-title">分享小红书帖子</h3>
                    <button type="button" className="ui-bare-btn text-[var(--c-icon)]" onClick={onClose} aria-label="关闭">
                        <X size={18} strokeWidth={2} />
                    </button>
                </div>

                <textarea
                    className="chat-xhs-dialog-input"
                    placeholder="粘贴小红书分享口令或链接，如：https://xhslink.com/xxxx"
                    value={urlText}
                    onChange={(e) => setUrlText(e.target.value)}
                    rows={3}
                />

                {showProxyInput && (
                    <input
                        className="chat-xhs-dialog-input"
                        placeholder="自定义 CF Worker 地址（可选，如 https://xxx.workers.dev）"
                        value={customProxy}
                        onChange={(e) => setCustomProxy(e.target.value)}
                    />
                )}

                <div className="flex items-center justify-between w-full">
                    <button type="button" className="ui-bare-btn ts-12 text-[var(--c-icon)]" onClick={() => setShowProxyInput(v => !v)}>
                        {showProxyInput ? "收起代理设置" : "代理设置"}
                    </button>
                    <button
                        type="button"
                        className="ui-btn ui-btn-outline"
                        onClick={handleFetch}
                        disabled={fetching || !urlText.trim()}
                    >
                        {fetching ? <Loader2 size={14} className="animate-spin" /> : null}
                        {fetching ? (imageProgress > 0 ? `下载配图 ${imageProgress}/${note?.images.length ?? "?"}` : "抓取中…") : "获取帖子"}
                    </button>
                </div>

                {error && <div className="chat-xhs-dialog-error">{error}</div>}

                {note && (
                    <div className="chat-xhs-dialog-preview">
                        <div className="chat-xhs-dialog-preview-card">
                            <div className="chat-xhs-share-cover chat-xhs-share-cover--blush">
                                {imageUrls[0] ? <img src={imageUrls[0]} alt="" /> : <span>{note.type === "video" ? "▶" : "小"}</span>}
                            </div>
                            <div className="chat-xhs-share-info">
                                <div className="chat-xhs-share-title">{note.title || "（无标题）"}</div>
                                <div className="chat-xhs-share-author">{note.authorName || "小红书用户"}</div>
                                <div className="chat-xhs-share-desc">{note.desc || "（无正文）"}</div>
                            </div>
                        </div>
                        {imageUrls.length > 1 && (
                            <div className="chat-xhs-dialog-imagecount">已获取 {imageUrls.length} 张配图（仅 TA 回复的这一轮可见）</div>
                        )}
                        {note.tags.length > 0 && (
                            <div className="chat-xhs-share-tags">
                                {note.tags.slice(0, 5).map(tag => <span key={tag}>#{tag}</span>)}
                            </div>
                        )}
                        {note.comments.length > 0 && (
                            <div className="chat-xhs-dialog-comments">
                                <div className="chat-xhs-dialog-comments-title">热评 {note.comments.length} 条</div>
                                {note.comments.slice(0, 3).map((c, i) => (
                                    <div key={i} className="chat-xhs-dialog-comment">
                                        <b>{c.nickname || "匿名用户"}</b>
                                        <span>{c.content}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        <button
                            type="button"
                            className="ui-btn ui-btn-primary w-full"
                            onClick={handleSend}
                        >
                            发送给 TA
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
