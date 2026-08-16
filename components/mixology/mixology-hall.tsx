"use client";

// 独家特调 · 酒单（在线材料）与大厅（在线配方）：
// 双列瀑布 / 宽卡列表 + 详情弹层（入柜·点赞·评论楼中楼）。官网专用，
// 未配后端（自部署）或表未建时按「还没开张」处理，不打扰本地玩法。

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Heart, Inbox, Trash2, Wine, X } from "lucide-react";
import { fetchCurrentAccount } from "@/lib/account-client";
import {
    deleteHallComment,
    fetchHallComments,
    fetchHallMaterial,
    fetchHallMaterials,
    fetchHallRecipe,
    fetchHallRecipes,
    markHallSaved,
    postHallComment,
    removeHallEntry,
    toggleHallLike,
    type MixHallComment,
    type MixHallMaterial,
    type MixHallRecipe,
    type MixHallType,
} from "@/lib/mixology/hall-client";
import { saveMixMaterial, saveMixRecipe } from "@/lib/mixology/storage";
import {
    MIX_KIND_LABELS,
    MIX_KIND_SECTION_LABELS,
    MIX_SLOT_ORDER,
    mixKindHasCover,
    type MixCharacterCard,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
} from "@/lib/mixology/types";
import { MatCard, MaterialDetail, MixConfirm, SealedNote } from "./mixology-shared";

type HallMode = "menu" | "hall";

function statsLine(entry: { likeCount: number; saveCount: number; commentCount: number }): string {
    return `♥ ${entry.likeCount} · 入柜 ${entry.saveCount} · 评论 ${entry.commentCount}`;
}

// ── 评论区（楼中楼） ──

function CommentThread({
    type,
    targetId,
    myId,
    onToast,
    onCountChange,
    requestConfirm,
}: {
    type: MixHallType;
    targetId: string;
    myId: string;
    onToast: (message: string) => void;
    onCountChange: (delta: number) => void;
    requestConfirm: (payload: { title: string; body?: ReactNode; confirmText: string; tone?: "danger"; run: () => void }) => void;
}) {
    const [comments, setComments] = useState<MixHallComment[]>([]);
    const [loading, setLoading] = useState(true);
    const [input, setInput] = useState("");
    const [replyTo, setReplyTo] = useState<MixHallComment | null>(null);
    const [busy, setBusy] = useState(false);
    const [deletingIds, setDeletingIds] = useState<string[]>([]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetchHallComments(type, targetId)
            .then((list) => { if (!cancelled) setComments(list); })
            .catch(() => { /* 评论加载失败不打断详情 */ })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [type, targetId]);

    const handlePost = async () => {
        const content = input.trim();
        if (!content || busy) return;
        setBusy(true);
        try {
            const comment = await postHallComment(type, targetId, content, replyTo?.id);
            setComments((prev) => [...prev, comment]);
            setInput("");
            setReplyTo(null);
            onCountChange(1);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "评论失败");
        } finally {
            setBusy(false);
        }
    };

    const handleDelete = async (comment: MixHallComment) => {
        setDeletingIds((prev) => [...prev, comment.id]);
        try {
            const deletedIds = await deleteHallComment(comment.id);
            setComments((prev) => prev.filter((c) => !deletedIds.includes(c.id)));
            onCountChange(-deletedIds.length);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "删除失败");
        } finally {
            setDeletingIds((prev) => prev.filter((id) => id !== comment.id));
        }
    };

    const onConfirmDelete = (comment: MixHallComment) => {
        const hasReplies = comments.some((c) => c.parentId === comment.id);
        requestConfirm({
            title: "删除这条评论？",
            body: hasReplies ? <>它下面的回复会一起删掉。</> : undefined,
            confirmText: "删除",
            tone: "danger",
            run: () => void handleDelete(comment),
        });
    };

    const topLevel = comments.filter((c) => !c.parentId);
    const childrenOf = (id: string) => comments.filter((c) => c.parentId === id);
    const nameOf = (id?: string) => comments.find((c) => c.id === id)?.authorName;

    const renderComment = (comment: MixHallComment, depth: number) => {
        const deleting = deletingIds.includes(comment.id);
        return (
            <div className="mix-comment" data-depth={depth > 0 ? "1" : undefined} data-deleting={deleting ? "true" : undefined} key={comment.id}>
                <div className="mix-comment-head">
                    <span className="mix-comment-author">{comment.authorName}</span>
                    {depth > 0 && comment.parentId && nameOf(comment.parentId) ? (
                        <span className="mix-comment-replyto">回复 {nameOf(comment.parentId)}</span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <button type="button" className="mix-comment-op" onClick={() => setReplyTo(comment)} disabled={deleting}>回复</button>
                    {comment.authorId === myId ? (
                        <button type="button" className="mix-comment-op" onClick={() => onConfirmDelete(comment)} disabled={deleting}>
                            {deleting ? "删除中…" : "删除"}
                        </button>
                    ) : null}
                </div>
                <div className="mix-comment-content">{comment.content}</div>
                {childrenOf(comment.id).map((child) => renderComment(child, depth + 1))}
            </div>
        );
    };

    return (
        <div className="mix-comments">
            <div className="mix-detail-label" style={{ marginTop: 16 }}>评论{comments.length ? ` · ${comments.length}` : ""}</div>
            {loading ? (
                <div className="mix-comment-empty">加载中…</div>
            ) : topLevel.length === 0 ? (
                <div className="mix-comment-empty">还没有人评论，坐下聊两句？</div>
            ) : (
                topLevel.map((comment) => renderComment(comment, 0))
            )}
            {replyTo ? (
                <div className="mix-comment-replying">
                    正在回复 {replyTo.authorName}
                    <button type="button" className="mix-comment-op" onClick={() => setReplyTo(null)}>取消</button>
                </div>
            ) : null}
            <div className="mix-comment-inputrow">
                <input
                    className="mix-input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handlePost(); }}
                    placeholder={replyTo ? `回复 ${replyTo.authorName}…` : "说点什么…"}
                    disabled={busy}
                />
                <button type="button" className="mix-pill-btn" onClick={() => void handlePost()} disabled={busy || !input.trim()}>{busy ? "发送中…" : "发送"}</button>
            </div>
        </div>
    );
}

// ── 主组件 ──

export function MixologyHall({
    mode,
    onToast,
    onImported,
    reloadToken = 0,
    onLoadingChange,
}: {
    mode: HallMode;
    onToast: (message: string) => void;
    onImported: () => void;
    /** 父层的手动刷新令牌：数值变化即重新拉取 */
    reloadToken?: number;
    /** 拉取状态回报给父层（驱动头部刷新图标旋转） */
    onLoadingChange?: (loading: boolean) => void;
}) {
    const [materials, setMaterials] = useState<MixHallMaterial[]>([]);
    const [recipes, setRecipes] = useState<MixHallRecipe[]>([]);
    const [kind, setKind] = useState<MixMaterialKind>("character");
    const [loading, setLoading] = useState(true);
    const [notReady, setNotReady] = useState<string | null>(null);
    const [detailMaterial, setDetailMaterial] = useState<MixHallMaterial | null>(null);
    const [detailRecipe, setDetailRecipe] = useState<MixHallRecipe | null>(null);
    const [busy, setBusy] = useState(false);
    const [likePending, setLikePending] = useState<string[]>([]);
    const [myId, setMyId] = useState("");
    // 弹层宿主：.mix-body 是滚动容器（position:relative），弹层若留在其内部，
    // inset:0 锚的是滚动坐标系——列表滚动后弹窗会"不贴底"。portal 到应用根层。
    const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
    useEffect(() => { setOverlayHost(document.querySelector<HTMLElement>(".mixology-app")); }, []);
    const inOverlay = (node: ReactNode) => (overlayHost ? createPortal(node, overlayHost) : null);
    const [confirm, setConfirm] = useState<{
        title: string;
        body?: ReactNode;
        confirmText: string;
        tone?: "danger";
        run: () => void;
    } | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        void fetchCurrentAccount()
            .then((res) => { if (mountedRef.current && res.account) setMyId(res.account.id); })
            .catch(() => { /* 未登录/自部署：匿名浏览态 */ });
        return () => { mountedRef.current = false; };
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setNotReady(null);
        try {
            if (mode === "menu") {
                const { entries, setupRequired } = await fetchHallMaterials(kind);
                if (!mountedRef.current) return;
                setMaterials(entries);
                if (setupRequired) setNotReady("酒单的后厨还没开张（共享表未创建）。");
            } else {
                const { entries, setupRequired } = await fetchHallRecipes();
                if (!mountedRef.current) return;
                setRecipes(entries);
                if (setupRequired) setNotReady("大厅还没开张（共享表未创建）。");
            }
        } catch (error) {
            if (!mountedRef.current) return;
            const message = error instanceof Error ? error.message : "暂时连不上大厅。";
            setNotReady(/missing_supabase_env/.test(message)
                ? "酒单和大厅只在官网营业——本地部署没有联网后端。"
                : message);
        } finally {
            if (mountedRef.current) setLoading(false);
        }
    // reloadToken 只作触发器，值本身不参与请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, kind, reloadToken]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => { onLoadingChange?.(loading); }, [loading, onLoadingChange]);

    const patchEntry = (type: MixHallType, id: string, patch: Record<string, unknown>) => {
        if (type === "material") {
            setMaterials((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
            setDetailMaterial((prev) => (prev?.id === id ? { ...prev, ...patch } as MixHallMaterial : prev));
        } else {
            setRecipes((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
            setDetailRecipe((prev) => (prev?.id === id ? { ...prev, ...patch } as MixHallRecipe : prev));
        }
    };

    const handleLike = async (type: MixHallType, id: string) => {
        const key = `${type}:${id}`;
        if (likePending.includes(key)) return;
        setLikePending((prev) => [...prev, key]);
        try {
            const { liked, likeCount } = await toggleHallLike(type, id);
            patchEntry(type, id, { likedByMe: liked, likeCount });
        } catch (error) {
            onToast(error instanceof Error ? error.message : "点赞失败");
        } finally {
            setLikePending((prev) => prev.filter((k) => k !== key));
        }
    };

    const openMaterial = async (entry: MixHallMaterial) => {
        setDetailMaterial({ ...entry, payload: undefined });
        try {
            const full = await fetchHallMaterial(entry.id);
            setDetailMaterial((prev) => (prev?.id === entry.id ? full : prev));
        } catch (error) {
            setDetailMaterial(null);
            onToast(error instanceof Error ? error.message : "详情加载失败");
        }
    };

    const openRecipe = async (entry: MixHallRecipe) => {
        setDetailRecipe({ ...entry, materials: undefined });
        try {
            const full = await fetchHallRecipe(entry.id);
            setDetailRecipe((prev) => (prev?.id === entry.id ? full : prev));
        } catch (error) {
            setDetailRecipe(null);
            onToast(error instanceof Error ? error.message : "详情加载失败");
        }
    };

    const importMaterial = async (entry: MixHallMaterial) => {
        if (!entry.payload || busy) return;
        setBusy(true);
        try {
            const { saveCount } = await markHallSaved("material", entry.id);
            const { publishedId: _p, ...rest } = entry.payload as MixMaterial;
            const material = { ...rest, id: entry.id, author: entry.authorName, imported: true } as MixMaterial;
            saveMixMaterial(material);
            patchEntry("material", entry.id, { savedByMe: true, saveCount });
            onImported();
            onToast(`「${entry.name}」已入柜。`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "入柜失败");
        } finally {
            setBusy(false);
        }
    };

    const importRecipe = async (entry: MixHallRecipe) => {
        if (!entry.materials?.length || busy) return;
        setBusy(true);
        try {
            const { saveCount } = await markHallSaved("recipe", entry.id);
            const slots: Partial<Record<MixMaterialKind, string>> = {};
            for (const material of entry.materials) {
                if (!material || typeof material !== "object" || !material.id || !material.kind) continue;
                const { publishedId: _mp, ...clean } = material;
                saveMixMaterial({ ...clean, author: entry.authorName, imported: true } as MixMaterial);
                slots[material.kind] = material.id;
            }
            const recipe: MixRecipe = {
                id: entry.id,
                name: entry.name,
                slots,
                imported: true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            saveMixRecipe(recipe);
            patchEntry("recipe", entry.id, { savedByMe: true, saveCount });
            onImported();
            onToast(`「${entry.name}」已连料入柜，去吧台看看。`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "导入失败");
        } finally {
            setBusy(false);
        }
    };

    const handleRemove = async (type: MixHallType, id: string, name: string) => {
        if (busy) return;
        setBusy(true);
        onToast("正在下架…");
        try {
            await removeHallEntry(type, id);
            if (type === "material") {
                setMaterials((prev) => prev.filter((e) => e.id !== id));
                setDetailMaterial(null);
            } else {
                setRecipes((prev) => prev.filter((e) => e.id !== id));
                setDetailRecipe(null);
            }
            onToast(`「${name}」已下架。`);
        } catch (error) {
            onToast(error instanceof Error ? error.message : "下架失败");
        } finally {
            setBusy(false);
        }
    };

    const likeButton = (type: MixHallType, entry: { id: string; likedByMe?: boolean; likeCount: number }) => (
        <button
            type="button"
            className="mix-like-btn"
            data-on={entry.likedByMe ? "true" : undefined}
            data-pending={likePending.includes(`${type}:${entry.id}`) ? "true" : undefined}
            onClick={() => void handleLike(type, entry.id)}
            disabled={likePending.includes(`${type}:${entry.id}`)}
            aria-label="点赞"
        >
            <Heart size={15} fill={entry.likedByMe ? "currentColor" : "none"} />
            {entry.likeCount}
        </button>
    );

    // ── 渲染 ──

    // TAG 行是导航骨架，不跟着加载/未开张一起消失——否则每点一个 TAG 整行都会闪一下
    const chipRow = mode === "menu" ? (
        <div className="mix-chip-row">
            {MIX_SLOT_ORDER.map((k) => (
                <button type="button" className="mix-chip" data-two-line="true" data-active={kind === k ? "true" : undefined} onClick={() => setKind(k)} key={k}>
                    <span>{MIX_KIND_LABELS[k]}</span>
                    <small>{MIX_KIND_SECTION_LABELS[k]}</small>
                </button>
            ))}
        </div>
    ) : null;

    function renderBody() {
        if (loading) {
            return <div className="mix-empty" style={{ paddingTop: 60 }}>调酒师正在开灯…</div>;
        }
        if (notReady) {
            return (
                <div className="mix-empty" style={{ paddingTop: 60 }}>
                    <Wine size={36} strokeWidth={1.4} />
                    {notReady}
                    <br />
                    本地的吧台和酒柜不受影响，先自己调一杯。
                </div>
            );
        }
        if (mode === "menu") {
            if (materials.length === 0) {
                return (
                    <div className="mix-empty">
                        <Inbox size={32} strokeWidth={1.4} />
                        {`还没有人分享${MIX_KIND_LABELS[kind]}——`}
                        <br />
                        在酒柜里打开自己的材料，点「分享到酒单」。
                    </div>
                );
            }
            return (
                <div className={mixKindHasCover(kind) ? "mix-waterfall" : "mix-mat-list"}>
                    {materials.map((entry) => (
                        <MatCard
                            kind={entry.kind}
                            name={entry.name}
                            hook={entry.hook}
                            cover={entry.cover}
                            author={entry.authorName}
                            stats={statsLine(entry)}
                            onClick={() => void openMaterial(entry)}
                            key={entry.id}
                        />
                    ))}
                </div>
            );
        }
        if (recipes.length === 0) {
            return (
                <div className="mix-empty" style={{ paddingTop: 60 }}>
                    <Wine size={32} strokeWidth={1.4} />
                    大厅里还没有配方——
                    <br />
                    在吧台给自己的特调点「分享」。
                </div>
            );
        }
        return (
            <div style={{ paddingTop: 14 }}>
                {recipes.map((entry) => (
                    <div className="mix-recipe-card" key={entry.id} onClick={() => void openRecipe(entry)}>
                        {entry.cover ? <div className="mix-recipe-bg" style={{ backgroundImage: `url(${entry.cover})` }} /> : null}
                        <div className="mix-recipe-main">
                            <div className="mix-recipe-name">{entry.name}</div>
                            <div className="mix-recipe-parts">
                                {entry.charName || "特调"}
                                {entry.partNames.length ? ` · ${entry.partNames.join(" · ")}` : ""}
                            </div>
                            <div className="mix-mat-stats">
                                @{entry.authorName} · {statsLine(entry)} · 浏览 {entry.viewCount}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <>
            {chipRow}
            {renderBody()}

            {/* 材料详情 */}
            {detailMaterial ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setDetailMaterial(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        {detailMaterial.kind === "character" && detailMaterial.cover ? (
                            <div className="mix-sheet-backdrop" style={{ backgroundImage: `url(${detailMaterial.cover})` }} />
                        ) : null}
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{detailMaterial.name}</div>
                            {likeButton("material", detailMaterial)}
                            {detailMaterial.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "从酒单下架？",
                                        body: <>「{detailMaterial.name}」将从酒单上撤下，别人看不到也拿不到了。<br />已经入柜的人手里那份不受影响。</>,
                                        confirmText: "下架",
                                        tone: "danger",
                                        run: () => void handleRemove("material", detailMaterial.id, detailMaterial.name),
                                    })}
                                    aria-label="下架"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetailMaterial(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-mat-stats" style={{ marginTop: 2 }}>
                                {MIX_KIND_LABELS[detailMaterial.kind]} · @{detailMaterial.authorName} · 浏览 {detailMaterial.viewCount} · 评论 {detailMaterial.commentCount}
                            </div>
                            {detailMaterial.cover && detailMaterial.kind !== "character" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={detailMaterial.cover} alt={detailMaterial.name} style={{ width: 96, height: 128, objectFit: "cover", borderRadius: 12, margin: "10px 0 4px" }} />
                            ) : null}
                            {detailMaterial.payload ? (
                                <>
                                    <div style={{ marginTop: 8 }}>
                                        {detailMaterial.kind === "character"
                                            ? <SealedNote
                                                hook={detailMaterial.hook}
                                                canvas={(detailMaterial.payload as MixCharacterCard).canvas}
                                            />
                                            : <MaterialDetail material={detailMaterial.payload} />}
                                    </div>
                                    <button type="button" className="mix-brew-btn" onClick={() => void importMaterial(detailMaterial)} disabled={busy}>
                                        <CornerDownRight size={16} />{busy ? "处理中…" : detailMaterial.savedByMe ? "再次入柜" : "加入酒柜"}
                                    </button>
                                </>
                            ) : (
                                <div className="mix-comment-empty">细节加载中…</div>
                            )}
                            <CommentThread
                                type="material"
                                targetId={detailMaterial.id}
                                myId={myId}
                                onToast={onToast}
                                onCountChange={(delta) => patchEntry("material", detailMaterial.id, { commentCount: Math.max(0, detailMaterial.commentCount + delta) })}
                                requestConfirm={setConfirm}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 配方详情 */}
            {detailRecipe ? inOverlay(
                <div className="mix-sheet-mask" onClick={() => setDetailRecipe(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{detailRecipe.name}</div>
                            {likeButton("recipe", detailRecipe)}
                            {detailRecipe.authorId === myId ? (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "从大厅下架？",
                                        body: <>「{detailRecipe.name}」将从大厅撤下，别人看不到也导不了了。<br />已经导入的人手里那份不受影响。</>,
                                        confirmText: "下架",
                                        tone: "danger",
                                        run: () => void handleRemove("recipe", detailRecipe.id, detailRecipe.name),
                                    })}
                                    aria-label="下架"
                                >
                                    <Trash2 size={16} />
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetailRecipe(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <div className="mix-mat-stats" style={{ marginTop: 2 }}>
                                @{detailRecipe.authorName} · 浏览 {detailRecipe.viewCount} · 评论 {detailRecipe.commentCount}
                            </div>
                            {detailRecipe.intro ? <div className="mix-detail-value" style={{ marginTop: 10 }}>{detailRecipe.intro}</div> : null}
                            {detailRecipe.materials ? (
                                <>
                                    <div className="mix-detail-label" style={{ marginTop: 12 }}>这杯里有</div>
                                    <div className="mix-detail-value">
                                        {detailRecipe.materials
                                            .filter((m) => m && m.kind && MIX_KIND_LABELS[m.kind])
                                            .map((m) => `${MIX_KIND_LABELS[m.kind]} · ${m.name}`)
                                            .join("\n")}
                                    </div>
                                    <button
                                        type="button"
                                        className="mix-brew-btn"
                                        onClick={() => setConfirm({
                                            title: "连料入柜？",
                                            body: <>会把「{detailRecipe.name}」以及里面的 <b>{detailRecipe.materials?.length ?? 0} 件材料</b>一并放进你的酒柜，之后在吧台就能开局。</>,
                                            confirmText: "入柜",
                                            run: () => void importRecipe(detailRecipe),
                                        })}
                                        disabled={busy}
                                    >
                                        <CornerDownRight size={16} />{busy ? "处理中…" : detailRecipe.savedByMe ? "再次导入" : "连料入柜"}
                                    </button>
                                </>
                            ) : (
                                <div className="mix-comment-empty">细节加载中…</div>
                            )}
                            <CommentThread
                                type="recipe"
                                targetId={detailRecipe.id}
                                myId={myId}
                                onToast={onToast}
                                onCountChange={(delta) => patchEntry("recipe", detailRecipe.id, { commentCount: Math.max(0, detailRecipe.commentCount + delta) })}
                                requestConfirm={setConfirm}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {confirm ? inOverlay(
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}
        </>
    );
}
