"use client";

// 独家特调 · 材料编辑器：八类材料的自建/编辑表单（底部弹层里渲染）。
// Phase ③ 先给够用的表单闭环，创作工坊阶段再上专业编辑体验。

import { useRef, useState, type ReactNode } from "react";
import { FileText, Play, Plus, Trash2 } from "lucide-react";
import type {
    MixCharacterCard,
    MixMaterial,
    MixMaterialKind,
    MixTextMaterial,
} from "@/lib/mixology/types";
import { createMixId, MIX_KIND_LABELS, mixKindHasCover } from "@/lib/mixology/types";
import { MixPreviewSheet, MixStructureSheet, type MixPreviewTarget } from "./mixology-preview";

const OPENING_SEPARATOR = "\n---\n";

/** 每类材料点进来先说清楚：这是干什么的、写完落在提示词哪一段 */
const KIND_GUIDE: Record<MixMaterialKind, { what: string; where: string }> = {
    character: {
        what: "这里写角色资料：身份、外貌、性格、所处世界、与玩家的初始关系，以及开场白与示例对话。",
        where: "拆分为「角色资料」「世界与剧情」「示例对话」三段进入提示词。",
    },
    persona: {
        what: "这里写用户人设：{{user}} 是谁——身份、性格、外貌，以及与{{char}}关系中用户一侧的设定；可另填一个代入名替换全部 {{user}}。",
        where: "进入提示词「用户资料」段，位于「角色资料」之后；代入名会替换提示词中所有 {{user}}。",
    },
    base: {
        what: "这里写扮演总纲：如何入戏、能否代替玩家发言、是否允许冲突与负面情绪。约束态度，不涉及文笔。",
        where: "进入提示词首段「扮演总纲」。",
    },
    flavor: {
        what: "这里写文风：句式长短、叙述视角、侧重动作还是心理。仅约束写法，不承载角色设定。",
        where: "进入提示词「文风」段。",
    },
    glass: {
        what: "这里写正文输出要求：每轮的段落数量、叙述节奏与收笔方式。正文标记规则（「」对白、* * 心声、【】场景、~ ~ 强调）由系统内置在本段开头，不必重复写。",
        where: "进入提示词「正文输出要求」段，接在内置标记规则之后。",
    },
    strength: {
        what: "这里写最高优先级要求：一到两条最需要被贯彻的规则。因排在全部对话之后、生成之前，模型对其服从度最高；条目越多越互相稀释。",
        where: "进入对话历史之后的「最高优先级要求」段，九味中仅此一味在此位置。",
    },
    ticket: {
        what: "这里写状态栏：每轮附带的一张数据卡，好感度、当前心情、随身物品等由创作者自定。契约决定模型报告什么，渲染代码决定卡片如何呈现。",
        where: "契约进入提示词「状态栏」段；渲染代码不进入提示词，仅在界面中执行。",
    },
    garnish: {
        what: "这里写界面样式：正文配色、对白字体、气泡形态，以 CSS 编写。",
        where: "不进入提示词，仅改变呈现，不占用上下文。",
    },
    encore: {
        what: "这里写小剧场：正文之外的加演，例如旁观视角、朋友圈动态、一段监控录像。输出契约决定 AI 何时写什么，渲染代码决定它长什么样；契约留空则为纯静态小品（手账、排班表）。",
        where: "契约进入提示词「小剧场」段；渲染代码不进提示词，仅在界面中执行。",
    },
};

/** 文本类材料（基底/风味/杯型/苦精）的字段名与示例 */
const TEXT_FIELD_COPY: Record<"base" | "flavor" | "glass" | "strength", { label: string; placeholder: string }> = {
    base: {
        label: "扮演总纲",
        placeholder: "例：\n你将完全成为{{char}}，以第一视角活在故事里。\n- 绝不跳出角色，绝不以 AI 自称。\n- 绝不代替{{user}}说话或做决定。\n- 允许出现冲突、拒绝与负面情绪，贴合人设比讨好{{user}}更重要。",
    },
    flavor: {
        label: "文风",
        placeholder: "例：\n克制的短句，多写动作、气味和环境细节，少写心理解说。\n对话之间留白，不把话说满。",
    },
    glass: {
        label: "正文输出要求",
        placeholder: "例：\n以第三人称小说正文输出，每轮 2~4 个自然段，段落之间空一行。\n- 叙述里穿插动作与环境细节，不写成流水账。\n- 在留有余韵处收笔，给{{user}}接话的空间。",
    },
    strength: {
        label: "最高优先级要求",
        placeholder: "一到两条即可，例：\n始终保持{{char}}的克制感，不要替{{user}}总结感受。",
    },
};

/** 封面统一压到 900px 内的 JPEG dataURL，避免 kv 被大图撑爆 */
async function readCoverFile(file: File): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("图片解码失败"));
        el.src = dataUrl;
    });
    const max = 900;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    if (scale >= 1 && dataUrl.length < 400_000) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
}

type EditorProps = {
    kind: MixMaterialKind;
    initial?: MixMaterial;
    onSave: (material: MixMaterial) => void;
    onCancel: () => void;
};

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <>
            <label className="mix-form-label">
                {label}
                {hint ? <> · <b>{hint}</b></> : null}
            </label>
            {children}
        </>
    );
}

export function MixMaterialEditor({ kind, initial, onSave, onCancel }: EditorProps) {
    const isCharacter = kind === "character";
    const initialCard = isCharacter && initial?.kind === "character" ? (initial as MixCharacterCard) : null;

    const [name, setName] = useState(initial?.name ?? "");
    const [hook, setHook] = useState(initial?.hook ?? "");
    const [cover, setCover] = useState(initial?.cover ?? "");
    // 角色卡专属
    const [baseInfo, setBaseInfo] = useState(initialCard?.baseInfo ?? "");
    const [personality, setPersonality] = useState(initialCard?.personality ?? "");
    const [appearance, setAppearance] = useState(initialCard?.appearance ?? "");
    const [background, setBackground] = useState(initialCard?.background ?? "");
    const [worldview, setWorldview] = useState(initialCard?.worldview ?? "");
    const [cognition, setCognition] = useState(initialCard?.cognition ?? "");
    const [relations, setRelations] = useState(initialCard?.relations ?? "");
    const [plot, setPlot] = useState(initialCard?.plot ?? "");
    const [extra, setExtra] = useState(initialCard?.extra ?? "");
    const [openingsText, setOpeningsText] = useState(initialCard?.openings.join(OPENING_SEPARATOR) ?? "");
    const [canvas, setCanvas] = useState(initialCard?.canvas ?? "");
    const [examples, setExamples] = useState<{ role: "user" | "char"; text: string }[]>(
        initialCard?.examples ? initialCard.examples.map((e) => ({ ...e })) : [],
    );
    // 文本类 / 小票 / 装饰 / 尾调
    const [content, setContent] = useState(
        initial && "content" in initial ? (initial as MixTextMaterial).content : "",
    );
    const [personaUserName, setPersonaUserName] = useState(initial?.kind === "persona" ? initial.userName ?? "" : "");
    const [contract, setContract] = useState(initial?.kind === "ticket" ? initial.contract : "");
    const [renderHtml, setRenderHtml] = useState(initial?.kind === "ticket" ? initial.renderHtml : "");
    const [previewRaw, setPreviewRaw] = useState(initial?.kind === "ticket" ? initial.previewRaw ?? "" : "");
    const [css, setCss] = useState(initial?.kind === "garnish" ? initial.css : "");
    const [html, setHtml] = useState(initial?.kind === "encore" ? (initial.renderHtml ?? initial.html ?? "") : "");
    const [encoreContract, setEncoreContract] = useState(initial?.kind === "encore" ? initial.contract ?? "" : "");
    const [encorePreviewRaw, setEncorePreviewRaw] = useState(initial?.kind === "encore" ? initial.previewRaw ?? "" : "");
    const [error, setError] = useState("");
    const [preview, setPreview] = useState<MixPreviewTarget | null>(null);
    const [structureOpen, setStructureOpen] = useState(false);
    const fileRef = useRef<HTMLInputElement | null>(null);

    const handleCoverFile = async (file: File | undefined) => {
        if (!file) return;
        try {
            setCover(await readCoverFile(file));
        } catch {
            setError("封面图读取失败，请换一张试试。");
        }
    };

    const handleSave = () => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            setError("先给这件材料起个名字。");
            return;
        }
        const meta = {
            id: initial?.id ?? createMixId("mixmat"),
            name: trimmedName,
            hook: hook.trim() || undefined,
            author: initial?.author,
            tags: initial?.tags,
            cover: cover || undefined,
            createdAt: initial?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
        };
        if (isCharacter) {
            const openings = openingsText
                .split(/\n\s*---\s*(?:\n|$)/)
                .map((o) => o.trim())
                .filter(Boolean);
            if (!openings.length) {
                setError("至少写一段开场白，开局才有酒可端。");
                return;
            }
            const card: MixCharacterCard = {
                ...meta,
                kind: "character",
                charName: trimmedName,
                baseInfo: baseInfo.trim() || undefined,
                personality: personality.trim() || undefined,
                appearance: appearance.trim() || undefined,
                background: background.trim() || undefined,
                worldview: worldview.trim() || undefined,
                cognition: cognition.trim() || undefined,
                relations: relations.trim() || undefined,
                plot: plot.trim() || undefined,
                extra: extra.trim() || undefined,
                openings,
                examples: examples.filter((e) => e.text.trim()).map((e) => ({ role: e.role, text: e.text.trim() })),
                canvas: canvas.trim() || undefined,
                authorNote: initialCard?.authorNote,
            };
            onSave(card);
            return;
        }
        if (kind === "ticket") {
            if (!contract.trim() || !renderHtml.trim()) {
                setError("小票需要同时写「输出契约」和「渲染代码」。");
                return;
            }
            onSave({ ...meta, kind: "ticket", contract: contract.trim(), renderHtml, previewRaw: previewRaw.trim() || undefined });
            return;
        }
        if (kind === "garnish") {
            if (!css.trim()) {
                setError("装饰不能是空的，写点 CSS 吧。");
                return;
            }
            onSave({ ...meta, kind: "garnish", css });
            return;
        }
        if (kind === "encore") {
            if (!html.trim()) {
                setError("尾调的渲染代码不能为空。");
                return;
            }
            onSave({
                ...meta,
                kind: "encore",
                contract: encoreContract.trim() || undefined,
                renderHtml: html,
                previewRaw: encorePreviewRaw.trim() || undefined,
            });
            return;
        }
        if (kind === "persona") {
            if (!content.trim()) {
                setError("面具的人设内容不能为空。");
                return;
            }
            onSave({ ...meta, kind: "persona", userName: personaUserName.trim() || undefined, content: content.trim() });
            return;
        }
        if (!content.trim()) {
            setError(`${MIX_KIND_LABELS[kind]}的内容不能为空。`);
            return;
        }
        onSave({ ...meta, kind, content: content.trim() } as MixTextMaterial);
    };

    const guide = KIND_GUIDE[kind];

    return (
        <div>
            <div className="mix-guide">
                <div className="mix-guide-what">{guide.what}</div>
                <div className="mix-guide-where">{guide.where}</div>
                <button type="button" className="mix-guide-link" onClick={() => setStructureOpen(true)}>
                    <FileText size={12} style={{ verticalAlign: "-2px" }} /> 看看完整提示词结构
                </button>
            </div>
            <Field label={isCharacter ? "角色名" : "名称"} hint="必填">
                <input className="mix-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={isCharacter ? "角色叫什么，就是提示词里的 {{char}}" : `给这件${MIX_KIND_LABELS[kind]}起个名，方便自己在吧台认出来`} />
            </Field>
            <Field label="一句话介绍">
                <input className="mix-input" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="一句话说清它的特点，会显示在卡片上" />
            </Field>
            {mixKindHasCover(kind) ? (
                <Field label="封面图" hint={isCharacter ? "对局背景，强烈建议配" : undefined}>
                    <div className="mix-cover-picker">
                        {cover ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className="mix-cover-preview" src={cover} alt="封面" />
                        ) : (
                            <div className="mix-cover-preview" />
                        )}
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <button type="button" className="mix-pill-btn" onClick={() => fileRef.current?.click()}>选择图片</button>
                            {cover ? (
                                <button type="button" className="mix-pill-btn" data-tone="ghost" onClick={() => setCover("")}>移除</button>
                            ) : null}
                        </div>
                        <input
                            ref={fileRef}
                            type="file"
                            accept="image/*"
                            style={{ display: "none" }}
                            onChange={(e) => { void handleCoverFile(e.target.files?.[0]); e.target.value = ""; }}
                        />
                    </div>
                </Field>
            ) : null}
            {isCharacter ? (
                <>
                    <Field label="基础信息"><textarea className="mix-textarea" value={baseInfo} onChange={(e) => setBaseInfo(e.target.value)} placeholder="例：27 岁 / 183cm / 便利店夜班店员" /></Field>
                    <Field label="性格"><textarea className="mix-textarea" value={personality} onChange={(e) => setPersonality(e.target.value)} placeholder="例：嘴上嫌弃手上诚实，怕麻烦但从不真的拒绝人" /></Field>
                    <Field label="外貌"><textarea className="mix-textarea" value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder="例：高瘦，总把制服外套袖子卷到手肘，左耳有个旧耳洞" /></Field>
                    <Field label="背景"><textarea className="mix-textarea" value={background} onChange={(e) => setBackground(e.target.value)} placeholder="例：三年前从老家搬来，白天在读夜校，夜班是为了付学费" /></Field>
                    <Field label="世界观"><textarea className="mix-textarea" value={worldview} onChange={(e) => setWorldview(e.target.value)} placeholder="故事发生在什么世界。例：普通现代都市，没有超自然设定" /></Field>
                    <Field label="对用户的初始认知"><textarea className="mix-textarea" value={cognition} onChange={(e) => setCognition(e.target.value)} placeholder="开局时角色对你了解到什么程度。例：只知道你是每周来三次的常客，不知道名字" /></Field>
                    <Field label="关系与身份"><textarea className="mix-textarea" value={relations} onChange={(e) => setRelations(e.target.value)} placeholder="玩家可以代入哪些身份、各自什么关系。例：熟客（微妙的默契）/ 新同事（他带你）" /></Field>
                    <Field label="当前剧情"><textarea className="mix-textarea" value={plot} onChange={(e) => setPlot(e.target.value)} placeholder="故事从哪一刻开始。例：雨夜，打烊前十分钟，店里只剩你们两个" /></Field>
                    <Field label="附加设定"><textarea className="mix-textarea" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="配角、私设名词、地点等。例：店长老周只在白班出现；「三号柜」是他们之间的暗号" /></Field>
                    <Field label="开场白" hint="必填，写多个玩家开局可以挑，用单独一行 --- 分隔">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 130 }}
                            value={openingsText}
                            onChange={(e) => setOpeningsText(e.target.value)}
                            placeholder={"故事的第一幕，由角色说出口。\n\n例：\n【便利店 · 打烊前十分钟】\n他把关东煮的竹签码齐，抬眼看你。「今天也加班到这个点？」\n---\n雨夜，他撑着伞站在店门口，像是等了很久。"}
                        />
                    </Field>
                    <Field label="示例对话" hint="文风锚点，不是已发生的剧情">
                        <div className="mix-example-list">
                            {examples.map((example, i) => (
                                <div className="mix-example-row" key={i}>
                                    <button
                                        type="button"
                                        className="mix-example-role"
                                        data-role={example.role}
                                        onClick={() => setExamples((prev) => prev.map((e, idx) => (
                                            idx === i ? { ...e, role: e.role === "user" ? "char" : "user" } : e
                                        )))}
                                    >
                                        {example.role === "user" ? "玩家" : "角色"}
                                    </button>
                                    <textarea
                                        className="mix-textarea"
                                        style={{ minHeight: 56 }}
                                        value={example.text}
                                        onChange={(e) => setExamples((prev) => prev.map((item, idx) => (
                                            idx === i ? { ...item, text: e.target.value } : item
                                        )))}
                                        placeholder={example.role === "user" ? "玩家会怎么说" : "角色该怎么答"}
                                    />
                                    <button
                                        type="button"
                                        className="mix-icon-btn"
                                        onClick={() => setExamples((prev) => prev.filter((_, idx) => idx !== i))}
                                        aria-label="删除这轮"
                                    >
                                        <Trash2 size={15} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                className="mix-pill-btn"
                                onClick={() => setExamples((prev) => [
                                    ...prev,
                                    { role: prev.length && prev[prev.length - 1].role === "user" ? "char" : "user", text: "" },
                                ])}
                            >
                                <Plus size={13} style={{ verticalAlign: "-2px" }} /> 加一轮
                            </button>
                        </div>
                    </Field>
                    <Field label="开场画布" hint="选填，HTML；点进卡片时铺在封面蒙版上展示，不进提示词">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 170 }}
                            value={canvas}
                            onChange={(e) => setCanvas(e.target.value)}
                            placeholder={"这张卡的门面页：大标题、诗句、标签、给读者的说明，版面由你排。\n\n例：\n<div style=\"padding:28px 6px;color:#fff;font:14px/2 serif\">\n  <h1 style=\"font-size:34px;letter-spacing:.3em\">晏迟</h1>\n  <p style=\"opacity:.65\">便利店夜班 · 冷白皮</p>\n  <p style=\"margin-top:22px\">「今天也加班到这个点？」</p>\n</div>"}
                        />
                    </Field>
                    <button
                        type="button"
                        className="mix-pill-btn"
                        style={{ marginTop: 10 }}
                        onClick={() => setPreview({ kind: "canvas", html: canvas, cover })}
                        disabled={!canvas.trim()}
                    >
                        <Play size={13} style={{ verticalAlign: "-2px" }} /> 预览画布
                    </button>
                </>
            ) : null}
            {kind === "persona" ? (
                <>
                    <Field label="代入名" hint="选填，替换提示词里的 {{user}}；留空则用「你」">
                        <input className="mix-input" value={personaUserName} onChange={(e) => setPersonaUserName(e.target.value)} placeholder="例：阿澈" />
                    </Field>
                    <Field label="用户人设" hint="必填，可用 {{char}} / {{user}}">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 170 }}
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            placeholder={"例：\n{{user}}：22 岁，插画系学生，寄住江家的故人之女。\n- 表面顺从，实际一直在攒离开的底气。\n- 怕打雷；说谎时会攥紧左手。"}
                        />
                    </Field>
                </>
            ) : null}
            {kind === "base" || kind === "flavor" || kind === "glass" || kind === "strength" ? (
                <Field label={TEXT_FIELD_COPY[kind].label} hint="必填，可用 {{char}} / {{user}}">
                    <textarea
                        className="mix-textarea"
                        style={{ minHeight: 170 }}
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={TEXT_FIELD_COPY[kind].placeholder}
                    />
                </Field>
            ) : null}
            {kind === "ticket" ? (
                <>
                    <Field label="输出契约" hint="必填，告诉 AI 每轮报哪些数据、按什么格式报">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 130 }}
                            value={contract}
                            onChange={(e) => setContract(e.target.value)}
                            placeholder={"例：\n每轮结束后报告下面三行，每行一个字段：\n好感度: 0-100 的整数\n心情: 四个字以内\n此刻在想: 一句话"}
                        />
                    </Field>
                    <Field label="渲染代码" hint="必填，HTML+CSS+JS，把上面那段原文画成卡片">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 180 }}
                            value={renderHtml}
                            onChange={(e) => setRenderHtml(e.target.value)}
                            placeholder={"AI 报的原文用 {{RAW}} 直接插入，或在 JS 里读 window.TICKET_RAW。\n\n例：\n<div style=\"padding:12px;border-radius:10px;background:#1c1c26;color:#d9b06a\">\n  <pre>{{RAW}}</pre>\n</div>"}
                        />
                    </Field>
                    <Field label="预览示例数据" hint="随便编一份，用来试渲染效果">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            value={previewRaw}
                            onChange={(e) => setPreviewRaw(e.target.value)}
                            placeholder={"照着上面的契约编一份，例：\n好感度: 62\n心情: 嘴硬\n此刻在想: 想留你再坐一会"}
                        />
                    </Field>
                    <button
                        type="button"
                        className="mix-pill-btn"
                        style={{ marginTop: 10 }}
                        onClick={() => setPreview({ kind: "ticket", html: renderHtml, raw: previewRaw })}
                        disabled={!renderHtml.trim()}
                    >
                        <Play size={13} style={{ verticalAlign: "-2px" }} /> 预览小票
                    </button>
                </>
            ) : null}
            {kind === "garnish" ? (
                <>
                    <Field label="界面 CSS" hint="必填，点下面「试穿看看」有完整类名速查">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 190 }}
                            value={css}
                            onChange={(e) => setCss(e.target.value)}
                            placeholder={"例：\n.mix-dialogue { color: #ffd479; font-weight: 600 }\n.mix-thought  { color: #8d7bf5 }\n.mix-scene    { letter-spacing: .5em }"}
                        />
                    </Field>
                    <button
                        type="button"
                        className="mix-pill-btn"
                        style={{ marginTop: 10 }}
                        onClick={() => setPreview({ kind: "garnish", css })}
                        disabled={!css.trim()}
                    >
                        <Play size={13} style={{ verticalAlign: "-2px" }} /> 试穿看看
                    </button>
                </>
            ) : null}
            {kind === "encore" ? (
                <>
                    <Field label="输出契约" hint="选填；写了 AI 才会在对局中输出小剧场，留空则为纯静态小品">
                        <textarea
                            className="mix-textarea"
                            style={{ minHeight: 110 }}
                            value={encoreContract}
                            onChange={(e) => setEncoreContract(e.target.value)}
                            placeholder={"告诉 AI 何时输出、写什么。例：\n仅在剧情出现明显进展或情绪转折时输出：以旁观视角（助理、监控、朋友圈动态等）写一段不超过 80 字的小剧场，第一行标注视角。平淡回合整段省略。"}
                        />
                    </Field>
                    <Field label="渲染代码" hint="必填，HTML/JS；AI 输出经 {{RAW}} 或 window.ENCORE_RAW 注入，静态小品则直接展示">
                        <textarea
                            className="mix-textarea"
                            data-code="true"
                            style={{ minHeight: 180 }}
                            value={html}
                            onChange={(e) => setHtml(e.target.value)}
                            placeholder={"例：\n<div style=\"padding:14px;background:#14111c;border-radius:10px;color:#f2f0f7\">\n  <pre style=\"margin:0;white-space:pre-wrap\">{{RAW}}</pre>\n</div>"}
                        />
                    </Field>
                    <Field label="预览示例数据" hint="选填，模拟 AI 的小剧场输出来试渲染">
                        <textarea className="mix-textarea" data-code="true" value={encorePreviewRaw} onChange={(e) => setEncorePreviewRaw(e.target.value)} />
                    </Field>
                    <button
                        type="button"
                        className="mix-pill-btn"
                        style={{ marginTop: 10 }}
                        onClick={() => setPreview({ kind: "encore", html, raw: encorePreviewRaw })}
                        disabled={!html.trim()}
                    >
                        <Play size={13} style={{ verticalAlign: "-2px" }} /> 跑一下
                    </button>
                </>
            ) : null}
            {preview ? <MixPreviewSheet target={preview} onClose={() => setPreview(null)} /> : null}
            {structureOpen ? <MixStructureSheet highlight={kind} onClose={() => setStructureOpen(false)} /> : null}
            {error ? <div style={{ color: "#e2a3a3", fontSize: 12, marginTop: 12 }}>{error}</div> : null}
            <div className="mix-form-footer">
                <button type="button" className="mix-ghost-btn" onClick={onCancel}>取消</button>
                <button type="button" className="mix-brew-btn" onClick={handleSave}>保存入柜</button>
            </div>
        </div>
    );
}
