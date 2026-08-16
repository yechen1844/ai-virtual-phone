// lib/mixology/types.ts
// 独家特调 · 领域类型：材料（七类）、特调方案、对局。
//
// 心智模型：角色卡也是一种材料；玩家把材料收进酒柜，在吧台给每个槽位
// 各挑一件调成「特调」，特调可命名保存/分享。对局 = 角色卡 + 特调的一次运行。
// 本文件只定义数据形状，装配见 assembler.ts，存取见 storage.ts。

/** 材料七类（槽位一一对应） */
export type MixMaterialKind =
    | "character" // 角色卡
    | "base"      // 基底：扮演总纲
    | "flavor"    // 风味：文风
    | "glass"     // 杯型：输出格式
    | "strength"  // 苦精：尾部强化（离生成最近、权重最高）
    | "ticket"    // 小票：状态数据卡（输出契约 + 渲染代码）
    | "garnish"   // 装饰：界面美化 CSS
    | "encore";   // 尾调：随卡互动 HTML 小品

export const MIX_KIND_LABELS: Record<MixMaterialKind, string> = {
    character: "角色卡",
    base: "基底",
    flavor: "风味",
    glass: "杯型",
    strength: "苦精",
    ticket: "小票",
    garnish: "装饰",
    encore: "尾调",
};

/** 吧台槽位顺序（角色卡永远第一槽） */
export const MIX_SLOT_ORDER: MixMaterialKind[] = [
    "character", "base", "flavor", "glass", "strength", "ticket", "garnish", "encore",
];

/** 必选槽：没配齐不能开局；其余槽可留空 */
export const MIX_REQUIRED_KINDS: MixMaterialKind[] = ["character"];

/** 所有材料共有的元信息 */
export type MixMaterialMeta = {
    id: string;
    kind: MixMaterialKind;
    name: string;
    /** 一句话介绍（列表页钩子文案） */
    hook?: string;
    /** 创作者署名（本地自建可空） */
    author?: string;
    tags?: string[];
    /** 封面图 dataURL 或远端地址（角色卡强烈建议有） */
    cover?: string;
    /** 已发布到酒单时的线上 id：有它才谈得上"更新已发布版本" */
    publishedId?: string;
    /**
     * 来自酒单/大厅的别人的作品。与应用市场、游戏大厅同规矩：
     * 能拿来开局，但站内不展示正文、不能编辑、不能导出、不能二次发布。
     */
    imported?: boolean;
    createdAt: number;
    updatedAt: number;
};

/** 角色卡：AI 读的字段全部可选（空字段装配时整段消失），只有名字必填 */
export type MixCharacterCard = MixMaterialMeta & {
    kind: "character";
    /** 角色名（对局中的 {{char}}） */
    charName: string;
    /** 基础信息：年龄/身高/职业等，自由文本或键值行 */
    baseInfo?: string;
    personality?: string;
    appearance?: string;
    background?: string;
    /** 世界观：所处世界的公共设定 */
    worldview?: string;
    /** 对 user 的初始认知：开局时角色"知道"user 什么 */
    cognition?: string;
    /** 关系与身份推荐：user 可代入哪些身份、各身份下关系如何 */
    relations?: string;
    /** 当前剧情：开局时间点的情境 */
    plot?: string;
    /** 开场白（可多个，玩家开局挑一个；纯文本，进对局与提示词） */
    openings: string[];
    /** 开场画布：点进卡详情时铺在封面蒙版上的门面页（HTML，沙盒渲染，不进提示词） */
    canvas?: string;
    /** 示例对话：文风锚点（user/char 轮次） */
    examples?: { role: "user" | "char"; text: string }[];
    /** 附加设定：NPC、私设名词表等自由区 */
    extra?: string;
    /** @deprecated 已被开场画布取代，仅为兼容旧数据保留 */
    authorNote?: string;
};

/** 纯文本类材料：基底 / 风味 / 杯型 / 苦精 */
export type MixTextMaterial = MixMaterialMeta & {
    kind: "base" | "flavor" | "glass" | "strength";
    content: string;
};

/** 小票：输出契约进提示词，渲染代码在沙盒 iframe 接管展示 */
export type MixTicketMaterial = MixMaterialMeta & {
    kind: "ticket";
    /** 告诉 AI 每轮在 [小票] 壳内输出什么 */
    contract: string;
    /** 完整 HTML（可含 JS），数据经 window.TICKET_RAW / {{RAW}} 注入 */
    renderHtml: string;
    /** 编辑器预览用示例数据 */
    previewRaw?: string;
};

/** 装饰：对局界面美化（官方语义类 + 界面定位符的 CSS） */
export type MixGarnishMaterial = MixMaterialMeta & {
    kind: "garnish";
    css: string;
};

/** 尾调（小剧场）：AI 按契约输出加演内容，渲染代码负责画出来；契约留空则为纯静态小品 */
export type MixEncoreMaterial = MixMaterialMeta & {
    kind: "encore";
    /** 告诉 AI 小剧场何时出现、写什么；留空则不进提示词，渲染代码作为静态小品直接展示 */
    contract?: string;
    /** 完整 HTML（可含 JS），AI 输出经 window.ENCORE_RAW / {{RAW}} 注入 */
    renderHtml?: string;
    /** @deprecated 旧字段（纯静态 HTML），读取时等价于 renderHtml */
    html?: string;
    /** 编辑器预览用示例数据 */
    previewRaw?: string;
};

/** 尾调渲染代码：新旧字段统一出口 */
export function mixEncoreRenderHtml(material: MixEncoreMaterial): string {
    return material.renderHtml ?? material.html ?? "";
}

export type MixMaterial =
    | MixCharacterCard
    | MixTextMaterial
    | MixTicketMaterial
    | MixGarnishMaterial
    | MixEncoreMaterial;

/** 特调方案：每个槽位记录所用材料 id（材料本体在酒柜里） */
export type MixRecipe = {
    id: string;
    name: string;
    /** kind → 材料 id；角色卡必有，其余可缺 */
    slots: Partial<Record<MixMaterialKind, string>>;
    /** 已发布到大厅时的线上 id */
    publishedId?: string;
    /** 从大厅导入的别人的配方：不能二次发布 */
    imported?: boolean;
    createdAt: number;
    updatedAt: number;
};

/** 对局消息 */
export type MixTurn = {
    id: string;
    role: "user" | "assistant";
    /** 正文（assistant 侧已剥离小票块） */
    text: string;
    /** 该轮小票壳内原文（有小票材料且 AI 按契约输出时才有） */
    ticketRaw?: string;
    /** 该轮小剧场壳内原文（尾调写了契约且 AI 输出时才有） */
    encoreRaw?: string;
    createdAt: number;
};

/** 对局：一次「角色卡 + 特调」的运行 */
export type MixSession = {
    id: string;
    /** 开局时的方案快照（防止事后改方案影响旧局回放语义） */
    recipe: MixRecipe;
    /** 角色名快照（列表展示用，酒柜里的卡被删也不受影响） */
    charName: string;
    /** 玩家代入名（{{user}}），空则用默认 */
    userName?: string;
    /** 选用的开场索引 */
    openingIndex: number;
    turns: MixTurn[];
    createdAt: number;
    updatedAt: number;
};

/** 生成短 id（本地实体通用） */
export function createMixId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
