// lib/complex-memory/prompts.ts
// 复杂记忆系统 · 五套默认模板（可被用户配置覆盖）与模板渲染引擎。
// 双层变量：① 模板专属变量原始替换（与 float 总结模板同模式）；
//          ② 全局宏复用中央 MacroEngine（char/user/time/weekday/timestamp/random/var…）。

import { MacroEngine, STATIC_MACRO_NAMES } from "../macro-engine";
import type { MemoryPromptKey, MemoryPrompts } from "./types";

// ── 默认模板 ──
export const DEFAULT_PROMPTS: MemoryPrompts & { coreSplit: string } = {
  event: `{{//事件记忆压缩模板 · 全局宏与专属变量可混用}}
你将阅读 {{char}} 最近的一段生活时间线（现实时间 {{earliest}} 至 {{latest}}，共 {{eventCount}} 条）。
请以 {{char}} 第一人称写一段约 {{length}} 字的记忆叙事：
- 只写 {{char}} 亲历、亲闻的事，不写全知视角
- 开头注明现实时间（如 2026-08-15 14:30）
- 点出本段最强烈的 1-2 种情绪

时间线素材：
{{events}}

输出 JSON：{ content, emotion: { valence, arousal }, importanceScore }`,

  daily: `{{//每日日记模板 · {{date}} 为日记日期，{{time}}/{{weekday}} 为生成时刻}}
今天是 {{date}}（{{weekday}}）。请以 {{char}} 第一人称写一篇约 {{length}} 字的日记，依次包含：
【日期与天气】【今日关键事件】【心情起伏】【对{{user}}的承诺与约定】【原话摘录（最难忘的 1-3 句）】

素材：
<今日时间线>
{{todayTimeline}}
</今日时间线>
<今日事件记忆>
{{todayEvents}}
</今日事件记忆>
<当前核心记忆>
{{coreMemory}}
</当前核心记忆>
<活跃周期>
{{activePeriods}}
</活跃周期>

同时判定：是否有新的长期事件开始？已有长期事件是否结束？
对每个活跃周期，用一句话记录「该周期今日进展」（每条不超过 {{rollingAppendMax}} 字，无进展写空串）。
输出 JSON：{ diary, emotion: { valence, arousal }, periodCheck: { newPeriods, closedPeriods, activePeriodIds }, periodProgress: [{ periodId, progress }] }`,

  period: `以下是周期「{{periodTitle}}」（{{startTime}} 至 {{endTime}}，共 {{durationDays}} 天）的滚动累积进展。
请做轻收尾（合并去重 + 收束语），生成周期总结，覆盖四部分：事件脉络 / 情绪曲线 / 角色成长 / 未解决事项；
并产出逐日索引 timeline_index（日期 → "Day N: 一句话要点"）。

<滚动累积进展>
{{rollingSummary}}
</滚动累积进展>
<关联日记与事件（滚动累积为空时使用）>
{{periodDairies}}
</关联日记与事件>

输出 JSON：{ summary, timelineIndex }`,

  core: `请基于以下材料，为 {{char}} 产出一组「核心记忆条目」。
逐条拆解成一句话事实（建议每条 30–80 字），并给每条打上分类 category，取值只能是：
  identity（身份认知，原 P0）— 我是谁、我如何感知世界
  bond（关系纽带，原 P1）— 我与重要他人的关系
  principle（原则承诺，原 P2）— 我答应过、我绝不会违背的原则
  milestone（里程碑事件，原 P3）— 影响深远的标志性事件
必须覆盖：身份认知 / 关系纽带 / 原则承诺 / 里程碑事件 四类；条目要具体、可长期复用，避免空泛总结。
改进意见：{{feedback}}
禁用词（爹味/超雄消毒）：{{banList}}；含禁用词的条目直接不输出，改用陪伴、记得、在意等表达。

材料：
<人设>
{{persona}}
</人设>
<既有核心记忆>
{{existingCore}}
</既有核心记忆>
<新材料>
{{newMaterials}}
</新材料>

输出条目数组 JSON：[{ "text": "...", "category": "identity|bond|principle|milestone" }, ...]`,

  coreSplit: `请把以下「旧整块核心记忆」拆解为一组核心记忆条目。
每条一句话事实（建议 30–80 字），打上分类 category，取值：identity / bond / principle / milestone。
分类定义：{{categoryDefs}}。原 P0–P3 框架内容丢失前尽量保留，遗漏信息不要创造。
禁用词：{{banList}}；含禁用词的条目不输出。
旧整块内容：
{{legacyContent}}

输出条目数组 JSON：[{ "text": "...", "category": "identity|bond|principle|milestone" }, ...]`,

  rerank: `以下是候选记忆、当前对话上下文与核心记忆。
请对每条候选按四个维度打分（0-10）：主题相关性 / 情感共鸣度 / 时间近因性 / 未解决状态。
综合分 = 四维加权。与固定注入区重复的条目给 0 分。最多保留 {{keepMax}} 条。

<候选记忆>
{{candidates}}
</候选记忆>
<当前上下文>
{{context}}
</当前上下文>
<核心记忆>
{{coreMemory}}
</核心记忆>
输出 JSON：{ scores: [{ id, topic, emotion, recency, open, total, keep }] }`,
};

// ── 模板渲染（双层变量） ──
export function renderMemoryPrompt(
  template: string,                 // 用户自定义模板（空串回落默认）
  characterName: string,
  userName: string,
  values: Record<string, string>,    // 模板专属变量键值对
): string {
  let text = template;
  // ① 模板专属变量：原始替换（与 float 总结模板同模式，容忍变量名两侧空格）
  for (const [k, v] of Object.entries(values)) {
    text = text.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"), v ?? "");
  }
  // ② 全局宏：复用中央引擎（char/user/time/weekday/timestamp/random/var…）
  const engine = new MacroEngine(characterName, userName);
  return engine.expand(text);       // 未识别宏原样保留，自定义写错不崩
}

// ── 模板变量速查（供编辑器侧栏展示与一键插入） ──
export type PromptVariableInfo = {
  name: string;
  templates: MemoryPromptKey[];
  description: string;
};

export const PROMPT_VARIABLES: PromptVariableInfo[] = [
  { name: "events", templates: ["event"], description: "待压缩的时间线素材全文（float 同名同义）" },
  { name: "earliest", templates: ["event"], description: "素材起始现实时间（float 同名同义）" },
  { name: "latest", templates: ["event"], description: "素材结束现实时间（float 同名同义）" },
  { name: "eventCount", templates: ["event"], description: "素材事件条数" },
  { name: "length", templates: ["event", "daily"], description: "篇幅目标字数（读配置项）" },
  { name: "rollingAppendMax", templates: ["daily"], description: "周期每日进展追加上限字数（读配置项）" },
  { name: "date", templates: ["daily"], description: "日记日期 YYYY-MM-DD" },
  { name: "todayTimeline", templates: ["daily"], description: "今日全部短期上下文素材" },
  { name: "todayEvents", templates: ["daily"], description: "今日已生成的事件记忆" },
  { name: "coreMemory", templates: ["daily", "rerank"], description: "当前核心记忆全文" },
  { name: "activePeriods", templates: ["daily"], description: "活跃周期摘要列表（含标题与起止）" },
  { name: "periodTitle", templates: ["period"], description: "周期标题" },
  { name: "startTime", templates: ["period"], description: "周期起始日期" },
  { name: "endTime", templates: ["period"], description: "周期结束日期" },
  { name: "durationDays", templates: ["period"], description: "周期持续天数" },
  { name: "rollingSummary", templates: ["period"], description: "周期滚动累积进展（带日期戳，轻收尾主素材）" },
  { name: "periodDairies", templates: ["period"], description: "该周期关联的全部日记全文合集（滚动累积为空时回退）" },
  { name: "persona", templates: ["core"], description: "角色人设全文" },
  { name: "existingCore", templates: ["core"], description: "既有核心记忆（微调时的当前版本；bootstrap 时为空）" },
  { name: "newMaterials", templates: ["core"], description: "触发本次更新的新材料（新增日记 / 周期总结）" },
  { name: "minLength", templates: ["core"], description: "核心记忆篇幅下限（读配置项）" },
  { name: "maxLength", templates: ["core"], description: "核心记忆篇幅上限（读配置项）" },
  { name: "banList", templates: ["core"], description: "消毒禁词表（读 sanitizerBanList）" },
  { name: "candidates", templates: ["rerank"], description: "向量召回候选（编号 + 时间 + 摘要）" },
  { name: "context", templates: ["rerank"], description: "当前对话上下文摘要" },
  { name: "keepMax", templates: ["rerank"], description: "保留上限条数（读配置项）" },
];

// 全局宏速查（由 MacroEngine 解析）
export const GLOBAL_MACRO_VARIABLES: PromptVariableInfo[] = [
  { name: "char", templates: ["event", "daily", "period", "core", "rerank"], description: "角色名，与聊天 prompt 同源" },
  { name: "user", templates: ["event", "daily", "period", "core", "rerank"], description: "用户名（未设置时为“用户”）" },
  { name: "time", templates: ["event", "daily", "period", "core", "rerank"], description: "当前现实时间，如 2026年8月20日15:40" },
  { name: "weekday", templates: ["event", "daily", "period", "core", "rerank"], description: "星期几" },
  { name: "timestamp:YYYY-MM-DD HH:mm", templates: ["event", "daily", "period", "core", "rerank"], description: "自定义格式时间戳" },
  { name: "random:a,b,c", templates: ["event", "daily", "period", "core", "rerank"], description: "随机选一项" },
  { name: "setvar::名::值", templates: ["event", "daily", "period", "core", "rerank"], description: "模板内局部变量传递" },
  { name: "getvar::名", templates: ["event", "daily", "period", "core", "rerank"], description: "读取模板内局部变量" },
  { name: "//注释内容", templates: ["event", "daily", "period", "core", "rerank"], description: "注释占位，渲染时删除" },
];

// ── 模板未识别变量校验（编辑器保存时提示，不阻止保存） ──
const DYNAMIC_MACRO_RE = /^(?:random|setvar|getvar|setglobalvar|getglobalvar|timestamp)(?::|$)/;

export function findUnknownTemplateVariables(template: string): string[] {
  const known = new Set([...PROMPT_VARIABLES.map((v) => v.name), ...STATIC_MACRO_NAMES]);
  const found = new Set<string>();
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(template)) !== null) {
    const body = match[1].trim();
    if (body.startsWith("//")) continue;
    if (DYNAMIC_MACRO_RE.test(body)) continue;
    if (known.has(body)) continue;
    found.add(body);
  }
  return Array.from(found);
}
