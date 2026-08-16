// lib/mixology/assembler.ts
// 独家特调 · 装配器：把一杯特调（角色卡 + 各槽材料）装配成提示词。
//
// 固定装配顺序（创作者不可调，保证"任意搭配都不散架"）：
//   序言 → 基底 → 角色资料 → 世界与剧情 → 风味 → 杯型 → 状态栏契约 → 示例对话
//   → [对话历史] → 苦精（离生成最近，权重最高）
// 开场白作为首条 assistant 消息单独返回，不进系统提示词。
// 所有材料文本支持 {{char}} / {{user}} 宏；空字段整段消失，不留空壳标题。

import type {
    MixCharacterCard,
    MixEncoreMaterial,
    MixMaterial,
    MixMaterialKind,
    MixPersonaMaterial,
    MixTextMaterial,
    MixTicketMaterial,
} from "./types";
import { mixEncoreRenderHtml } from "./types";

export const MIX_DEFAULT_USER_NAME = "你";

// 壳标记用「状态栏」而不是应用里的比喻词「小票」——提示词是写给模型看的，
// 模型不知道"小票"是什么，但一眼能懂"状态栏"。
export const MIX_TICKET_OPEN = "[状态栏]";
export const MIX_TICKET_CLOSE = "[/状态栏]";

/** 小剧场壳标记：尾调写了契约时，AI 的加演内容放进这对标签 */
export const MIX_ENCORE_OPEN = "[小剧场]";
export const MIX_ENCORE_CLOSE = "[/小剧场]";

export type MixAssembleInput = {
    character: MixCharacterCard;
    /** 其余槽位材料（酒柜实体，缺槽就不传） */
    materials: Partial<Record<MixMaterialKind, MixMaterial>>;
    /** 玩家代入名，空则用默认 */
    userName?: string;
    /** 选用的开场索引，越界时回退到 0 */
    openingIndex?: number;
};

export type MixAssembledPrompt = {
    /** 系统提示词（对话历史之前的全部内容） */
    system: string;
    /** 苦精：注入在对话历史之后、本轮生成之前；无苦精材料时为空串 */
    postHistory: string;
    /** 开场白（已替换宏），作为首条 assistant 消息；角色卡没写开场时为空串 */
    opening: string;
    /** 本局是否带小票（运行时据此决定是否剥取小票块） */
    hasTicket: boolean;
    /** 本局尾调是否为 AI 小剧场（有契约且有渲染代码） */
    hasEncore: boolean;
};

export function applyMixMacros(text: string, charName: string, userName: string): string {
    return text
        .replace(/\{\{\s*char\s*\}\}/gi, charName)
        .replace(/\{\{\s*user\s*\}\}/gi, userName);
}

/** 有值则输出「标题：内容」段，空值返回 null（上层过滤） */
function field(label: string, value: string | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    return `${label}：${trimmed}`;
}

function sectionBlock(title: string, lines: (string | null)[]): string | null {
    const kept = lines.filter((l): l is string => Boolean(l));
    if (!kept.length) return null;
    return `## ${title}\n${kept.join("\n\n")}`;
}

function textOf(material: MixMaterial | undefined): string {
    if (!material) return "";
    const content = (material as MixTextMaterial).content;
    return typeof content === "string" ? content.trim() : "";
}

const PREAMBLE = [
    "这是一场沉浸式角色扮演。下方依次给出扮演规则、角色资料与输出要求，请全部遵守；",
    "越靠后的要求优先级越高。",
].join("");

// 正文标记协议是 App 的渲染协议，内置且常驻——放在段首、用户杯型内容之后接，
// 不随材料缺失而消失（装饰 CSS 与正文渲染都依赖这四种标记）。
const PROSE_PROTOCOL = [
    "正文标记规则（界面按此渲染，务必遵守）：",
    "- 说出口的话用「」包裹；未说出口的心声用 * * 包裹。",
    "- 场景或时间切换时，单独一行用【】标出。",
    "- 需要重读的词可用 ~ ~ 包裹。",
    "- 除以上四种外，不要使用任何其他富文本标记（不用 Markdown 标题、粗体、列表）。",
].join("\n");

/** 状态栏契约段：把小票材料的 contract 包进固定壳指令 */
function ticketSection(ticket: MixTicketMaterial, charName: string, userName: string): string | null {
    const contract = ticket.contract.trim();
    if (!contract) return null;
    return [
        "## 状态栏",
        `输出格式：每轮回复的最末尾，另起一行输出 ${MIX_TICKET_OPEN}，随后按「输出内容」的要求逐行填写本轮的实际数据，最后以 ${MIX_TICKET_CLOSE} 单独一行收束。任何一轮都不要省略这一段。`,
        "输出内容：",
        applyMixMacros(contract, charName, userName),
    ].join("\n");
}

/** 小剧场契约段：格式说明在前，内容要求在后；契约留空则整段不存在 */
function encoreSection(encore: MixEncoreMaterial, charName: string, userName: string): string | null {
    const contract = encore.contract?.trim();
    if (!contract) return null;
    return [
        "## 小剧场",
        `输出格式：放在回复最末尾（状态栏之后），整块用 ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE} 包裹；是否输出由「输出内容」的条件决定，不输出时整段省略，不要输出空壳。`,
        "输出内容：",
        applyMixMacros(contract, charName, userName),
    ].join("\n");
}

/** 收尾核对清单：放在最后压阵，防止模型写完正文忘了必须输出的块 */
function checklistSection(withTicket: boolean, withEncore: boolean): string | null {
    if (!withTicket && !withEncore) return null;
    const items = ["- 正文符合「正文输出要求」。"];
    if (withTicket) {
        items.push(`- 回复最末尾已按「状态栏」的格式输出 ${MIX_TICKET_OPEN}...${MIX_TICKET_CLOSE} 块——任何一轮都不能缺。`);
    }
    if (withEncore) {
        items.push(`- 若本轮满足「小剧场」的输出条件，已用 ${MIX_ENCORE_OPEN}...${MIX_ENCORE_CLOSE} 块输出。`);
    }
    return ["## 输出格式检查", "每轮回复发出前逐项核对：", ...items].join("\n");
}

function exampleSection(card: MixCharacterCard, charName: string, userName: string): string | null {
    const examples = card.examples?.filter((e) => e.text.trim());
    if (!examples?.length) return null;
    const lines = examples.map((e) =>
        `${e.role === "user" ? userName : charName}：${applyMixMacros(e.text.trim(), charName, userName)}`,
    );
    return `## 示例对话\n以下仅为文风示范，不是已发生的剧情：\n${lines.join("\n")}`;
}

export function assembleMixPrompt(input: MixAssembleInput): MixAssembledPrompt {
    const card = input.character;
    const charName = card.charName.trim() || card.name.trim() || "角色";
    const m = input.materials;
    const persona = m.persona?.kind === "persona" ? (m.persona as MixPersonaMaterial) : undefined;
    // 代入名：显式传入 > 面具材料的代入名 > 默认「你」
    const userName = input.userName?.trim() || persona?.userName?.trim() || MIX_DEFAULT_USER_NAME;
    const ticket = m.ticket?.kind === "ticket" ? (m.ticket as MixTicketMaterial) : undefined;
    const encore = m.encore?.kind === "encore" ? (m.encore as MixEncoreMaterial) : undefined;

    const apply = (text: string) => applyMixMacros(text, charName, userName);

    const baseText = textOf(m.base);
    const flavorText = textOf(m.flavor);
    const glassText = textOf(m.glass);
    const strengthText = textOf(m.strength);

    const sections: (string | null)[] = [
        PREAMBLE,
        baseText ? `## 扮演总纲\n${apply(baseText)}` : null,
        sectionBlock("角色资料", [
            `角色名：${charName}`,
            field("基础信息", card.baseInfo),
            field("性格", card.personality),
            field("外貌", card.appearance),
            field("背景", card.background),
        ].map((l) => (l ? apply(l) : l))),
        // 用户资料：{{user}} 是谁。由面具材料提供，帮模型称呼与理解对面的人
        persona && persona.content.trim()
            ? `## 用户资料\n${userName}由用户扮演，${charName}对面的人。\n${apply(persona.content.trim())}`
            : null,
        sectionBlock("世界与剧情", [
            field("世界观", card.worldview),
            field(`${charName}对${userName}的初始认知`, card.cognition),
            field("关系与身份", card.relations),
            field("当前剧情", card.plot),
            field("附加设定", card.extra),
        ].map((l) => (l ? apply(l) : l))),
        flavorText ? `## 文风\n${apply(flavorText)}` : null,
        // 内置协议在前，用户的杯型内容接在后面
        `## 正文输出要求\n${PROSE_PROTOCOL}${glassText ? `\n${apply(glassText)}` : ""}`,
        ticket ? ticketSection(ticket, charName, userName) : null,
        encore ? encoreSection(encore, charName, userName) : null,
        exampleSection(card, charName, userName),
        checklistSection(
            Boolean(ticket?.contract.trim()),
            Boolean(encore?.contract?.trim()),
        ),
    ];

    const openings = card.openings.filter((o) => o.trim());
    const idx = input.openingIndex ?? 0;
    const opening = openings.length
        ? apply(openings[idx >= 0 && idx < openings.length ? idx : 0].trim())
        : "";

    return {
        system: sections.filter((s): s is string => Boolean(s)).join("\n\n"),
        postHistory: strengthText
            ? `【最高优先级要求】\n${apply(strengthText)}`
            : "",
        opening,
        hasTicket: Boolean(ticket?.contract.trim() && ticket?.renderHtml.trim()),
        hasEncore: Boolean(encore?.contract?.trim() && encore && mixEncoreRenderHtml(encore).trim()),
    };
}
