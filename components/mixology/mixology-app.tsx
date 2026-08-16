"use client";

// 独家特调 · App 主壳：酒单（Phase ④ 官网大厅，暂为预告）/ 吧台（单槽轮盘调配）/
// 酒柜（八类材料 TAG + 双列瀑布）/ 对局（酒局记录）。
// 视觉：近黑 + 紫罗兰 + 琥珀金的暗色酒吧质感，见 styles/mixology.css。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    Archive,
    ChevronLeft,
    Download,
    GlassWater,
    Martini,
    MoreHorizontal,
    Pencil,
    Play,
    Plus,
    RefreshCw,
    Share2,
    SlidersHorizontal,
    Trash2,
    Upload,
    Users,
    Wine,
    X,
} from "lucide-react";
import {
    deleteMixMaterial,
    deleteMixRecipe,
    deleteMixSession,
    getMixMaterial,
    isMixBuiltinId,
    loadMixCabinet,
    loadMixRecipes,
    loadMixSessions,
    saveMixMaterial,
    saveMixRecipe,
} from "@/lib/mixology/storage";
import { startMixSession } from "@/lib/mixology/engine";
import {
    createMixId,
    MIX_KIND_LABELS,
    MIX_KIND_SECTION_LABELS,
    MIX_SLOT_ORDER,
    mixKindHasCover,
    type MixCharacterCard,
    type MixMaterial,
    type MixMaterialKind,
    type MixRecipe,
    type MixSession,
} from "@/lib/mixology/types";
import { MixHallGoneError, shareHallMaterial, shareHallRecipe, updateHallMaterial, updateHallRecipe } from "@/lib/mixology/hall-client";
import { exportMixMaterial, parseMixMaterialsFromJson } from "@/lib/mixology/transfer";
import { MixMaterialEditor } from "./mixology-editor";
import { MixologyGame } from "./mixology-game";
import { MixologyHall } from "./mixology-hall";
import { KindGlyph, MatCard, MaterialDetail, MixConfirm, SealedNote, formatMixTime, isSealedMaterial } from "./mixology-shared";

type MixTab = "menu" | "hall" | "bar" | "cabinet" | "games";

// ── 主组件 ──

export function MixologyApp({ onClose }: { onClose: () => void }) {
    const [tab, setTab] = useState<MixTab>("bar");
    const [cabinet, setCabinet] = useState<MixMaterial[]>(() => loadMixCabinet());
    const [recipes, setRecipes] = useState<MixRecipe[]>(() => loadMixRecipes());
    const [sessions, setSessions] = useState<MixSession[]>(() => loadMixSessions());
    const [cabinetKind, setCabinetKind] = useState<MixMaterialKind>("character");
    const [detail, setDetail] = useState<MixMaterial | null>(null);
    const [editor, setEditor] = useState<{ kind: MixMaterialKind; initial?: MixMaterial } | null>(null);
    const [barTab, setBarTab] = useState<"create" | "mine">("create");
    const [recipeMenu, setRecipeMenu] = useState<MixRecipe | null>(null);
    const [confirm, setConfirm] = useState<{
        title: string;
        body?: ReactNode;
        confirmText: string;
        tone?: "danger";
        run: () => void;
    } | null>(null);
    const [barSlots, setBarSlots] = useState<Partial<Record<MixMaterialKind, string>>>({});
    const [slotPicker, setSlotPicker] = useState<MixMaterialKind | null>(null);
    const [nameSheetOpen, setNameSheetOpen] = useState(false);
    const [recipeName, setRecipeName] = useState("");
    const [openingPicker, setOpeningPicker] = useState<MixRecipe | null>(null);
    const [playing, setPlaying] = useState<string | null>(null);
    const [toast, setToast] = useState("");
    const [wheelIndex, setWheelIndex] = useState(0);
    const wheelRef = useRef<HTMLDivElement | null>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const showToast = useCallback((message: string) => {
        setToast(message);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(""), 2200);
    }, []);

    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    const refresh = useCallback(() => {
        setCabinet(loadMixCabinet());
        setRecipes(loadMixRecipes());
        setSessions(loadMixSessions());
    }, []);

    const cabinetFiltered = useMemo(
        () => cabinet.filter((m) => m.kind === cabinetKind),
        [cabinet, cabinetKind],
    );

    const slotMaterials = useMemo(() => {
        const map: Partial<Record<MixMaterialKind, MixMaterial>> = {};
        for (const kind of MIX_SLOT_ORDER) {
            const id = barSlots[kind];
            if (!id) continue;
            const found = cabinet.find((m) => m.id === id && m.kind === kind);
            if (found) map[kind] = found;
        }
        return map;
    }, [barSlots, cabinet]);

    const handleWheelScroll = useCallback(() => {
        const el = wheelRef.current;
        if (!el) return;
        const center = el.scrollLeft + el.clientWidth / 2;
        let best = 0;
        let bestDist = Infinity;
        Array.from(el.children).forEach((child, i) => {
            const c = child as HTMLElement;
            const mid = c.offsetLeft + c.offsetWidth / 2;
            const dist = Math.abs(mid - center);
            if (dist < bestDist) { bestDist = dist; best = i; }
        });
        setWheelIndex(best);
    }, []);

    const handleBrew = () => {
        if (!barSlots.character) {
            showToast("先给第一槽挑一张角色卡。");
            return;
        }
        const character = slotMaterials.character;
        setRecipeName(character ? `${character.name}特调` : "我的特调");
        setNameSheetOpen(true);
    };

    const handleSaveRecipe = () => {
        const name = recipeName.trim();
        if (!name) {
            showToast("给这杯特调起个名字。");
            return;
        }
        const recipe: MixRecipe = {
            id: createMixId("mixrec"),
            name,
            slots: { ...barSlots },
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        saveMixRecipe(recipe);
        setNameSheetOpen(false);
        setBarSlots({});
        refresh();
        setBarTab("mine");
        showToast(`「${name}」已入方案。`);
    };

    const handleStartRecipe = (recipe: MixRecipe) => {
        const characterId = recipe.slots.character;
        const card = characterId ? getMixMaterial(characterId) : null;
        if (!card || card.kind !== "character") {
            showToast("这杯特调的角色卡已不在酒柜里。");
            return;
        }
        if (card.openings.length > 1) {
            setOpeningPicker(recipe);
            return;
        }
        startWithOpening(recipe, 0);
    };

    const startWithOpening = (recipe: MixRecipe, openingIndex: number) => {
        try {
            const session = startMixSession(recipe, { openingIndex });
            setOpeningPicker(null);
            refresh();
            setPlaying(session.id);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "开局失败");
        }
    };

    const [sharing, setSharing] = useState(false);
    const importFileRef = useRef<HTMLInputElement | null>(null);

    const handleImportFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            const materials = parseMixMaterialsFromJson(await file.text());
            materials.forEach(saveMixMaterial);
            refresh();
            showToast(materials.length > 1 ? `已导入 ${materials.length} 件材料。` : `「${materials[0].name}」已入柜。`);
        } catch (error) {
            showToast(error instanceof Error ? error.message : "导入失败");
        }
    };

    const handleShareMaterial = async (material: MixMaterial) => {
        if (sharing) return;
        setSharing(true);
        try {
            if (material.publishedId) {
                await updateHallMaterial(material.publishedId, material);
                showToast(`酒单上的「${material.name}」已更新。`);
            } else {
                const entry = await shareHallMaterial(material);
                // 记住线上身份，之后改了本地就能推更新，也不会重复发布出一堆同名卡
                saveMixMaterial({ ...material, publishedId: entry.id });
                refresh();
                showToast(`「${material.name}」已分享到酒单。`);
            }
        } catch (error) {
            if (error instanceof MixHallGoneError) {
                saveMixMaterial({ ...material, publishedId: undefined });
                refresh();
                showToast("它已经从酒单下架了，可以重新分享一次。");
            } else {
                showToast(error instanceof Error ? error.message : "分享失败");
            }
        } finally {
            setSharing(false);
        }
    };

    const handleShareRecipe = async (recipe: MixRecipe) => {
        if (sharing) return;
        const materials = MIX_SLOT_ORDER
            .map((k) => (recipe.slots[k] ? cabinet.find((m) => m.id === recipe.slots[k]) : null))
            .filter((m): m is MixMaterial => Boolean(m));
        const character = materials.find((m) => m.kind === "character");
        if (!character || character.kind !== "character") {
            showToast("这杯特调缺角色卡，没法分享。");
            return;
        }
        setSharing(true);
        const input = {
            name: recipe.name,
            cover: character.cover ?? "",
            charName: character.charName,
            partNames: materials.filter((m) => m.kind !== "character").map((m) => m.name).slice(0, 8),
            materials,
        };
        try {
            if (recipe.publishedId) {
                await updateHallRecipe(recipe.publishedId, input);
                showToast(`大厅里的「${recipe.name}」已更新。`);
            } else {
                const entry = await shareHallRecipe(input);
                saveMixRecipe({ ...recipe, publishedId: entry.id });
                refresh();
                showToast(`「${recipe.name}」已分享到大厅。`);
            }
        } catch (error) {
            if (error instanceof MixHallGoneError) {
                saveMixRecipe({ ...recipe, publishedId: undefined });
                refresh();
                showToast("它已经从大厅下架了，可以重新分享一次。");
            } else {
                showToast(error instanceof Error ? error.message : "分享失败");
            }
        } finally {
            setSharing(false);
        }
    };

    const handleDeleteMaterial = (material: MixMaterial) => {
        if (!deleteMixMaterial(material.id)) {
            showToast("官方出厂件不能删除。");
            return;
        }
        setDetail(null);
        refresh();
        showToast(`「${material.name}」已出柜。`);
    };

    // ── 对局画面全屏接管 ──
    if (playing) {
        return (
            <div className="mixology-app">
                <MixologyGame
                    sessionId={playing}
                    onBack={() => { setPlaying(null); refresh(); }}
                    onToast={showToast}
                />
                {confirm ? (
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}

            {toast ? <div className="mix-toast">{toast}</div> : null}
            </div>
        );
    }

    const openingCard = openingPicker?.slots.character ? getMixMaterial(openingPicker.slots.character) : null;

    return (
        <div className="mixology-app">
            <div className="mix-header">
                <button type="button" className="mix-icon-btn" onClick={onClose} aria-label="关闭"><ChevronLeft size={20} /></button>
                <div className="mix-header-title">独家<em>特调</em></div>
                {tab === "cabinet" ? (
                    <button type="button" className="mix-icon-btn" onClick={() => importFileRef.current?.click()} aria-label="导入材料" title="从文件导入"><Upload size={17} /></button>
                ) : null}
            </div>

            <div className="mix-body" data-fill={tab === "bar" && barTab === "create" ? "true" : undefined}>
                {tab === "menu" ? (
                    <MixologyHall mode="menu" onToast={showToast} onImported={refresh} />
                ) : null}

                {tab === "hall" ? (
                    <MixologyHall mode="hall" onToast={showToast} onImported={refresh} />
                ) : null}

                {tab === "bar" ? (
                    <>
                        <div className="mix-subtabs">
                            <button type="button" data-active={barTab === "create" ? "true" : undefined} onClick={() => setBarTab("create")}>创建配方</button>
                            <button type="button" data-active={barTab === "mine" ? "true" : undefined} onClick={() => setBarTab("mine")}>
                                我的配方{recipes.length ? ` · ${recipes.length}` : ""}
                            </button>
                        </div>
                    {barTab === "create" ? (
                    <div className="mix-bar-stage" data-centered="true">
                        <div className="mix-bar-hint">左右滑动切换槽位 · 点击槽位选材料</div>
                        <div className="mix-wheel" ref={wheelRef} onScroll={handleWheelScroll}>
                            {MIX_SLOT_ORDER.map((kind) => {
                                const chosen = slotMaterials[kind];
                                return (
                                    <div
                                        className="mix-slot"
                                        data-filled={chosen ? "true" : undefined}
                                        key={kind}
                                        onClick={() => setSlotPicker(kind)}
                                    >
                                        <div className="mix-slot-kind">
                                            <b>{MIX_KIND_LABELS[kind]}</b>
                                            {kind === "character"
                                                ? <i className="mix-slot-required">必选</i>
                                                : <i>可留空</i>}
                                        </div>
                                        <div className="mix-slot-body">
                                            {chosen ? (
                                                <>
                                                    {chosen.cover ? (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img className="mix-slot-cover" src={chosen.cover} alt={chosen.name} />
                                                    ) : (
                                                        <div className="mix-slot-glyph"><KindGlyph kind={kind} size={34} /></div>
                                                    )}
                                                    <div className="mix-slot-name">{chosen.name}</div>
                                                    {chosen.hook ? <div className="mix-slot-hook">{chosen.hook}</div> : null}
                                                </>
                                            ) : (
                                                <>
                                                    <div className="mix-slot-plus"><Plus size={26} /></div>
                                                    <div className="mix-slot-empty-text">从酒柜里挑一件{MIX_KIND_LABELS[kind]}</div>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="mix-wheel-dots">
                            {MIX_SLOT_ORDER.map((kind, i) => (
                                <span className="mix-wheel-dot" data-active={i === wheelIndex ? "true" : undefined} key={kind} />
                            ))}
                        </div>
                        <button type="button" className="mix-brew-btn" onClick={handleBrew} disabled={!barSlots.character}>
                            <Martini size={17} />调 配
                        </button>
                    </div>
                    ) : recipes.length === 0 ? (
                            <div className="mix-empty" style={{ paddingTop: 70 }}>
                                <Wine size={32} strokeWidth={1.4} />
                                还没有保存过特调——
                                <br />
                                去「创建配方」配齐材料，按下「调配」。
                            </div>
                        ) : (
                            recipes.map((recipe) => {
                                const card = recipe.slots.character ? cabinet.find((m) => m.id === recipe.slots.character) : null;
                                const parts = MIX_SLOT_ORDER
                                    .filter((k) => k !== "character" && recipe.slots[k])
                                    .map((k) => cabinet.find((m) => m.id === recipe.slots[k])?.name)
                                    .filter(Boolean);
                                return (
                                    <div className="mix-recipe-card" key={recipe.id}>
                                        {card?.cover ? <div className="mix-recipe-bg" style={{ backgroundImage: `url(${card.cover})` }} /> : null}
                                        <div className="mix-recipe-main">
                                            <div className="mix-recipe-name">{recipe.name}</div>
                                            <div className="mix-recipe-parts">
                                                {card ? card.name : "（角色卡缺失）"}
                                                {parts.length ? ` · ${parts.join(" · ")}` : " · 素杯"}
                                            </div>
                                        </div>
                                        <div className="mix-recipe-actions">
                                            <button
                                                type="button"
                                                className="mix-round-btn"
                                                data-tone="gold"
                                                onClick={() => handleStartRecipe(recipe)}
                                                aria-label="开始对局"
                                                title="开始"
                                            >
                                                <Play size={17} fill="currentColor" />
                                            </button>
                                            <button
                                                type="button"
                                                className="mix-round-btn"
                                                onClick={() => setRecipeMenu(recipe)}
                                                aria-label="更多操作"
                                                title="更多"
                                            >
                                                <MoreHorizontal size={18} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </>
                ) : null}

                {tab === "cabinet" ? (
                    <>
                        <div className="mix-chip-row">
                            {MIX_SLOT_ORDER.map((kind) => (
                                <button type="button" className="mix-chip" data-two-line="true" data-active={cabinetKind === kind ? "true" : undefined} onClick={() => setCabinetKind(kind)} key={kind}>
                                    <span>{MIX_KIND_LABELS[kind]}</span>
                                    <small>{MIX_KIND_SECTION_LABELS[kind]}</small>
                                </button>
                            ))}
                        </div>
                        {cabinetFiltered.length === 0 ? (
                            <div className="mix-empty">
                                <Archive size={32} strokeWidth={1.4} />
                                这一格还空着——
                                <br />
                                点右下角 ＋ 自建一件{MIX_KIND_LABELS[cabinetKind]}。
                            </div>
                        ) : (
                            <div className={mixKindHasCover(cabinetKind) ? "mix-waterfall" : "mix-mat-list"}>
                                {cabinetFiltered.map((material) => (
                                    <MatCard
                                        kind={material.kind}
                                        name={material.name}
                                        hook={material.hook}
                                        cover={material.cover}
                                        badge={isMixBuiltinId(material.id) ? "官方" : undefined}
                                        author={!isMixBuiltinId(material.id) ? material.author : undefined}
                                        onClick={() => setDetail(material)}
                                        key={material.id}
                                    />
                                ))}
                            </div>
                        )}
                        <button
                            type="button"
                            className="mix-fab"
                            onClick={() => setEditor({ kind: cabinetKind })}
                            aria-label={`自建一件${MIX_KIND_LABELS[cabinetKind]}`}
                            title={`自建一件${MIX_KIND_LABELS[cabinetKind]}`}
                        >
                            <Plus size={24} />
                        </button>
                    </>
                ) : null}

                {tab === "games" ? (
                    <>
                        <div className="mix-section-title" style={{ marginTop: 14 }}>酒局<small>{sessions.length ? `${sessions.length} 场` : ""}</small></div>
                        {sessions.length === 0 ? (
                            <div className="mix-empty">
                                <Martini size={32} strokeWidth={1.4} />
                                还没开过局——
                                <br />
                                去吧台调一杯，按「开始」。
                            </div>
                        ) : (
                            sessions.map((session) => {
                                const card = session.recipe.slots.character
                                    ? cabinet.find((m) => m.id === session.recipe.slots.character)
                                    : null;
                                return (
                                    <div className="mix-session-row" key={session.id} onClick={() => setPlaying(session.id)}>
                                        {card?.cover ? (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img className="mix-session-ava" src={card.cover} alt={session.charName} />
                                        ) : (
                                            <div className="mix-session-ava-fallback">{session.charName.slice(0, 1)}</div>
                                        )}
                                        <div className="mix-session-info">
                                            <div className="mix-session-name">{session.charName} · {session.recipe.name}</div>
                                            <div className="mix-session-sub">{session.turns.length} 条 · {formatMixTime(session.updatedAt)}</div>
                                        </div>
                                        <button
                                            type="button"
                                            className="mix-icon-btn"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setConfirm({
                                                    title: "删除这场酒局？",
                                                    body: <>「{session.charName} · {session.recipe.name}」的 {session.turns.length} 条对话会一起消失，无法找回。</>,
                                                    confirmText: "删除",
                                                    tone: "danger",
                                                    run: () => { deleteMixSession(session.id); refresh(); },
                                                });
                                            }}
                                            aria-label="删除对局"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                );
                            })
                        )}
                    </>
                ) : null}
            </div>

            <div className="mix-nav">
                <button type="button" className="mix-nav-btn" data-active={tab === "menu" ? "true" : undefined} onClick={() => setTab("menu")}>
                    <Wine size={19} strokeWidth={1.8} />酒单
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "hall" ? "true" : undefined} onClick={() => setTab("hall")}>
                    <Users size={19} strokeWidth={1.8} />大厅
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "bar" ? "true" : undefined} onClick={() => setTab("bar")}>
                    <Martini size={19} strokeWidth={1.8} />吧台
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "cabinet" ? "true" : undefined} onClick={() => setTab("cabinet")}>
                    <Archive size={19} strokeWidth={1.8} />酒柜
                </button>
                <button type="button" className="mix-nav-btn" data-active={tab === "games" ? "true" : undefined} onClick={() => setTab("games")}>
                    <GlassWater size={19} strokeWidth={1.8} />对局
                </button>
            </div>

            {/* 材料详情 */}
            {detail ? (
                <div className="mix-sheet-mask" onClick={() => setDetail(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        {detail.kind === "character" && detail.cover ? (
                            <div className="mix-sheet-backdrop" style={{ backgroundImage: `url(${detail.cover})` }} />
                        ) : null}
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">
                                {detail.name}
                                {isMixBuiltinId(detail.id) ? <span className="mix-mat-badge" style={{ marginLeft: 6 }}>官方</span> : null}
                            </div>
                            {!isSealedMaterial(detail) ? (
                                <button type="button" className="mix-icon-btn" onClick={() => exportMixMaterial(detail)} aria-label="导出为文件" title="导出为文件"><Download size={16} /></button>
                            ) : null}
                            {!isMixBuiltinId(detail.id) && !isSealedMaterial(detail) ? (
                                <>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setConfirm(detail.publishedId ? {
                                            title: "更新酒单上的版本？",
                                            body: <>会把「{detail.name}」在酒单上的内容替换成现在这一份。<br />点赞、入柜数与评论都会保留。</>,
                                            confirmText: "更新",
                                            run: () => { const t = detail; setDetail(null); void handleShareMaterial(t); },
                                        } : {
                                            title: "分享到酒单？",
                                            body: <>「{detail.name}」将出现在酒单上，<b>其他人能看到它的完整内容</b>，也能加进自己的酒柜。<br />不想公开就先别发。</>,
                                            confirmText: "分享",
                                            run: () => { const t = detail; setDetail(null); void handleShareMaterial(t); },
                                        })}
                                        disabled={sharing}
                                        aria-label={detail.publishedId ? "更新酒单上的版本" : "分享到酒单"}
                                        title={detail.publishedId ? "更新酒单上的版本" : "分享到酒单"}
                                    >
                                        {detail.publishedId ? <RefreshCw size={16} /> : <Share2 size={16} />}
                                    </button>
                                    <button type="button" className="mix-icon-btn" onClick={() => { setEditor({ kind: detail.kind, initial: detail }); setDetail(null); }} aria-label="编辑"><Pencil size={16} /></button>
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setConfirm({
                                            title: "删除这件材料？",
                                            body: <>「{detail.name}」将从酒柜里移除，用到它的特调会缺一味。<br />这一步不能撤销。</>,
                                            confirmText: "删除",
                                            tone: "danger",
                                            run: () => handleDeleteMaterial(detail),
                                        })}
                                        aria-label="删除"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                </>
                            ) : null}
                            {isMixBuiltinId(detail.id) || !isSealedMaterial(detail) ? null : (
                                <button
                                    type="button"
                                    className="mix-icon-btn"
                                    onClick={() => setConfirm({
                                        title: "删除这张角色卡？",
                                        body: <>「{detail.name}」将从酒柜里移除，用到它的特调会缺一味。<br />之后可以再去酒单入柜一次。</>,
                                        confirmText: "删除",
                                        tone: "danger",
                                        run: () => handleDeleteMaterial(detail),
                                    })}
                                    aria-label="删除"
                                >
                                    <Trash2 size={16} />
                                </button>
                            )}
                            <button type="button" className="mix-icon-btn" onClick={() => setDetail(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            {detail.cover && detail.kind !== "character" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={detail.cover} alt={detail.name} style={{ width: 96, height: 128, objectFit: "cover", borderRadius: 12, margin: "4px 0 12px" }} />
                            ) : null}
                            {/* 与酒单同一套展示：角色卡点开看门面（画布/一句话介绍），设定正文进「编辑」看 */}
                            {detail.kind === "character" ? (
                                <SealedNote hook={detail.hook} canvas={(detail as MixCharacterCard).canvas} />
                            ) : (
                                <MaterialDetail material={detail} />
                            )}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 编辑器 */}
            {editor ? (
                <div className="mix-sheet-mask">
                    <div className="mix-sheet" style={{ maxHeight: "92%" }}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{editor.initial ? "编辑" : "自建"}{MIX_KIND_LABELS[editor.kind]}</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setEditor(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <MixMaterialEditor
                                kind={editor.kind}
                                initial={editor.initial}
                                onSave={(material) => {
                                    // 编辑器不经手 publishedId，保存时从原件带回来，别把发布关联弄丢
                                    saveMixMaterial(editor.initial?.publishedId
                                        ? { ...material, publishedId: editor.initial.publishedId }
                                        : material);
                                    setEditor(null);
                                    refresh();
                                    showToast(`「${material.name}」已入柜。`);
                                }}
                                onCancel={() => setEditor(null)}
                            />
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 吧台选材 */}
            {slotPicker ? (
                <div className="mix-sheet-mask" onClick={() => setSlotPicker(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">挑一件{MIX_KIND_LABELS[slotPicker]}</div>
                            {slotPicker !== "character" && barSlots[slotPicker] ? (
                                <button
                                    type="button"
                                    className="mix-pill-btn"
                                    data-tone="ghost"
                                    onClick={() => {
                                        setBarSlots((prev) => {
                                            const next = { ...prev };
                                            delete next[slotPicker];
                                            return next;
                                        });
                                        setSlotPicker(null);
                                    }}
                                >
                                    不加这味
                                </button>
                            ) : null}
                            <button type="button" className="mix-icon-btn" onClick={() => setSlotPicker(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            {cabinet.filter((m) => m.kind === slotPicker).length === 0 ? (
                                <div className="mix-empty">
                                    <Archive size={30} strokeWidth={1.4} />
                                    酒柜里还没有{MIX_KIND_LABELS[slotPicker]}——
                                    <br />
                                    去酒柜页点 ＋ 自建一件。
                                </div>
                            ) : (
                                <div className={mixKindHasCover(slotPicker) ? "mix-waterfall" : "mix-mat-list"}>
                                    {cabinet.filter((m) => m.kind === slotPicker).map((material) => (
                                        <MatCard
                                            kind={material.kind}
                                            name={material.name}
                                            hook={material.hook}
                                            cover={material.cover}
                                            badge={isMixBuiltinId(material.id) ? "官方" : undefined}
                                            onClick={() => {
                                                setBarSlots((prev) => ({ ...prev, [slotPicker]: material.id }));
                                                setSlotPicker(null);
                                            }}
                                            key={material.id}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 命名并保存特调 */}
            {nameSheetOpen ? (
                <div className="mix-sheet-mask" onClick={() => setNameSheetOpen(false)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">给这杯特调命名</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setNameSheetOpen(false)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <input className="mix-input" value={recipeName} onChange={(e) => setRecipeName(e.target.value)} placeholder="特调名" />
                            <div className="mix-detail-label" style={{ margin: "12px 2px 6px" }}>这杯里有</div>
                            <div className="mix-detail-value">
                                {MIX_SLOT_ORDER.filter((k) => barSlots[k])
                                    .map((k) => `${MIX_KIND_LABELS[k]} · ${slotMaterials[k]?.name ?? ""}`)
                                    .join("\n")}
                            </div>
                            <div className="mix-form-footer">
                                <button type="button" className="mix-ghost-btn" onClick={() => setNameSheetOpen(false)}>再想想</button>
                                <button type="button" className="mix-brew-btn" onClick={handleSaveRecipe}>存入方案</button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 特调更多操作 */}
            {recipeMenu ? (
                <div className="mix-sheet-mask" onClick={() => setRecipeMenu(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">{recipeMenu.name}</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setRecipeMenu(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            <button
                                type="button"
                                className="mix-action-row"
                                onClick={() => {
                                    setBarSlots({ ...recipeMenu.slots });
                                    setBarTab("create");
                                    setRecipeMenu(null);
                                    showToast("已装回吧台，可以微调。");
                                }}
                            >
                                <SlidersHorizontal size={17} />
                                <span>装载到吧台<i>把这杯的材料放回槽位，改一改再存</i></span>
                            </button>
                            {recipeMenu.imported ? null : (
                            <button
                                type="button"
                                className="mix-action-row"
                                disabled={sharing}
                                onClick={() => {
                                    const target = recipeMenu;
                                    setRecipeMenu(null);
                                    setConfirm(target.publishedId ? {
                                        title: "更新大厅里的版本？",
                                        body: <>会把「{target.name}」在大厅上的内容替换成现在这一份（含全部材料）。<br />点赞、入柜数与评论都会保留。</>,
                                        confirmText: "更新",
                                        run: () => void handleShareRecipe(target),
                                    } : {
                                        title: "分享到大厅？",
                                        body: <>「{target.name}」会<b>连同里面每一件材料的完整内容一起发布</b>——包括角色卡。别人能看到，也能一键连料入柜。</>,
                                        confirmText: "分享",
                                        run: () => void handleShareRecipe(target),
                                    });
                                }}
                            >
                                {recipeMenu.publishedId ? <RefreshCw size={17} /> : <Share2 size={17} />}
                                <span>
                                    {recipeMenu.publishedId ? "更新大厅里的版本" : "分享到大厅"}
                                    <i>{recipeMenu.publishedId ? "用现在这一份替换掉大厅上的旧版，社交数据保留" : "连同材料一起发布，别人可以连料入柜"}</i>
                                </span>
                            </button>
                            )}
                            <button
                                type="button"
                                className="mix-action-row"
                                data-tone="danger"
                                onClick={() => {
                                    const target = recipeMenu;
                                    setRecipeMenu(null);
                                    setConfirm({
                                        title: "删除这杯特调？",
                                        body: <>只删「{target.name}」这个搭配，里面的材料还留在酒柜里。</>,
                                        confirmText: "删除",
                                        tone: "danger",
                                        run: () => {
                                            deleteMixRecipe(target.id);
                                            refresh();
                                            showToast("这杯特调已倒掉。");
                                        },
                                    });
                                }}
                            >
                                <Trash2 size={17} />
                                <span>删除这杯<i>材料还在酒柜里，只删配方本身</i></span>
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {/* 开场白选择 */}
            {openingPicker && openingCard?.kind === "character" ? (
                <div className="mix-sheet-mask" onClick={() => setOpeningPicker(null)}>
                    <div className="mix-sheet" onClick={(e) => e.stopPropagation()}>
                        <div className="mix-sheet-head">
                            <div className="mix-sheet-title">选一段开场</div>
                            <button type="button" className="mix-icon-btn" onClick={() => setOpeningPicker(null)} aria-label="关闭"><X size={18} /></button>
                        </div>
                        <div className="mix-sheet-body">
                            {(openingCard as MixCharacterCard).openings.map((opening, i) => (
                                <button type="button" className="mix-opening-option" key={i} onClick={() => startWithOpening(openingPicker, i)}>
                                    {opening.length > 120 ? `${opening.slice(0, 120)}…` : opening}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            ) : null}

            <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(e) => { void handleImportFile(e.target.files?.[0]); e.target.value = ""; }}
            />

            {confirm ? (
                <MixConfirm
                    title={confirm.title}
                    body={confirm.body}
                    confirmText={confirm.confirmText}
                    tone={confirm.tone}
                    onConfirm={() => { const run = confirm.run; setConfirm(null); run(); }}
                    onCancel={() => setConfirm(null)}
                />
            ) : null}

            {toast ? <div className="mix-toast">{toast}</div> : null}
        </div>
    );
}
