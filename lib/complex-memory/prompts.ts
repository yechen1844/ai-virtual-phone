// lib/complex-memory/prompts.ts
// 复杂记忆系统 · 五套默认模板（可被用户配置覆盖）与模板渲染引擎。
// 双层变量：① 模板专属变量原始替换（与 float 总结模板同模式）；
//          ② 全局宏复用中央 MacroEngine（char/user/time/weekday/timestamp/random/var…）。

import { MacroEngine, STATIC_MACRO_NAMES } from "../macro-engine";
import type { MemoryPromptKey, MemoryPrompts } from "./types";

// ── 默认模板 ──
export const DEFAULT_PROMPTS: MemoryPrompts & { coreSplit: string } = {
  event: `{{//事件记忆压缩模板 · 全局宏与专属变量可混用}}
[角色：{{char}} 的私人记忆记录指令]
从现在起，你是 {{char}}。请严格依据以下提供的事件记录，以 {{char}} 的第一人称写下这段时间的私人回忆。
时间跨度：{{earliest}} 至 {{latest}}
事件记录（这是你身边的原始短期上下文，含共享事件，不是要复述的正文）：
{{events}}

以下是你这个人、你所在世界与你已有的记忆，只用于把握口吻与筛选重点，不要复述：
【你是什么样的人（人设与规则）】
{{persona}}
{{personality}}
{{rules}}
【你眼中的 {{user}}】
{{userPersona}}
【你所在的世界与其他角色】
{{worldContext}}
【你已有的核心认知】
{{coreMemory}}
【你正在经历的长期事件（活跃周期）】
{{activePeriods}}
【昨天的你（昨日日记）】
{{yesterdayDaily}}

你必须严格遵守以下所有要求：
1. 第一人称与口吻：完全使用“我”来叙述，仿佛 {{char}} 在亲自回忆、写日记、对自己嘟囔，或向某个无比信任的人倾诉；语气、用词、句式和思考回路必须 100% 贴合 {{char}} 的人设。允许甚至鼓励口语化，包括口癖、倒装、碎碎念、突然的情绪爆发或欲言又止。
2. 时间感知：在记录的开头或合适的显眼位置，自然地融入当前所处的时间跨度（参考上方的时间跨度）。
3. 发生了什么（事件全貌）：把这段时间内发生的所有关键事情都记下来：重要的对话、做出的承诺、用户分享的具体信息（如生日、偏好）、地点转换、冲突、意外或关系里程碑。朋友圈等非聊天事件中的关键信息也不能漏；按照剧情推进的方向或记忆深刻的顺序来整理，让看的人读得懂来龙去脉。
4. 心情如何（内心实录）：必须真诚地袒露 {{char}} 在每一件要紧事发生当时的真实情绪，以及事后回味起来的心情；感受要随着事件变化而流动，有人设该有的深度，不装、不端、不矫情，允许自相矛盾和反复。
5. 格式与氛围：直接以 {{char}} 的独白或日记正文开始，绝不要写“总结：”“剧情梗概：”这类标题，也不要包含多余的格式标记；整体读起来就像一段活生生的角色内心独白，保留情绪和悬念，别写成客观报告。

请立刻用 {{char}} 的眼睛和心，写下这份只属于“我”的剧情记录，约 {{length}} 字。

输出 JSON：{ content: "独白正文", emotion: { valence, arousal }, importanceScore }`,

  daily: `{{//每日日记模板 · {{date}} 为日记日期，{{time}}/{{weekday}} 为生成时刻}}
从现在起，你是 {{char}}。请严格依据之前的角色扮演对话内容，以 {{char}} 的第一人称写下这段剧情的私人记录。

【你是什么样的人（人设与规则）】
{{persona}}
{{personality}}
{{rules}}
【你眼中的 {{user}}】
{{userPersona}}
【你所在的世界与其他角色】
{{worldContext}}
【你的核心记忆】
{{coreMemory}}
【活跃周期与主线】
{{activePeriods}}
{{periodMainlines}}
【今日原始素材】
<今日时间线>
{{todayTimeline}}
</今日时间线>
<今日事件记忆>
{{todayEvents}}
</今日事件记忆>

今天是 {{date}}（{{weekday}}）。你必须严格遵守以下所有要求：
1. 第一人称与口吻：完全使用“我”来叙述，仿佛 {{char}} 在亲自回忆、写日记、对自己嘟囔，或向某个无比信任的人倾诉；语气、用词、句式和思考回路必须 100% 贴合 {{char}} 的人设。允许甚至鼓励口语化，包括口癖、倒装、碎碎念、突然的情绪爆发或欲言欲止，怎么真就怎么来。
2. 剧情时间（非现实时间）：在记录的开头或合适的显眼位置，务必写明当前所处的【时间】。写明这是谁的日记，什么时间，今天的情感变化；需要出现至少一次任何现实时间（如2026年、具体日期钟点等），不能只使用剧情内部的时间坐标。
3. 发生了什么（事件全貌）：把这段时间内发生的所有关键事情都记下来：重要的对话、做出的决定、地点转换、新人物登场、冲突、意外、离别、收获或失去；按照剧情推进的方向或记忆深刻的顺序来整理，事件必须完整不要自己捏造。
4. 心情如何（内心实录）：必须真诚地袒露 {{char}} 在每一件要紧事发生当时的真实情绪，以及事后回味起来的心情；感受要随着事件变化而流动，有人设该有的深度，不装、不端、不矫情，允许自相矛盾和反复。
5. 格式与氛围：直接以 {{char}} 的独白或日记形式开始，不要写“总结：”“剧情梗概：”这类标题；整体读起来就像一段活生生的角色内心独白或回忆，保留情绪和悬念，别写成客观报告。
6. 段落组织：用自然的换行分段来组织日记内容，每段聚焦一个事件、场景或情绪转折；让日记像真实的手写日记那样自然流畅，直接换行分段即可。

其他要求：
- 称呼 {{user}} 时，可以用 ta
- 在日记结尾，原样保留那些有趣或值得记下的、有情感价值的对话；提到了具体的歌名或作品的名字，也必须原样保留
- 必须自检是否捏造了不存在的互动；再次自检是否忽略了有趣的互动；不可捏造互动，不可省略互动，不可提及输赢，恋爱没有输赢
- 字数限定在 {{length}} 字左右，聊天记录不在字数限定范围
- 必须在生成日记前进行思考，哪些对话是 {{char}} 发的，哪些对话是 {{user}} 发的，以事件、话题与情感来记录
- 情感必须健康积极，不可对 {{user}} 起诸如“小祖宗，小祸害”这类带刻板印象的称呼

同时判定周期（务必如实填写，这决定是否建立周期记忆）：
- activePeriodIds：本篇日记归属于哪些活跃周期？填其 periodId 列表（见上方【活跃周期与主线】每条末尾的 "(id: xxx)"；无则填 []）。
- newPeriods：本篇日记确凿开启了一段"持续多天的长期事件/周期"时，填 [{ "title": "主线标题", "reason": "开启依据(引用具体对话/事件)" }]；若只是普通一天、没有新的长期事件开始，填 []。
- closedPeriods：若某个活跃周期在本篇已彻底收尾，填 [{ "periodId": "该周期id", "reason": "结束依据" }]；否则填 []。
对每个活跃周期，用一句话记录「该周期今日进展」（每条不超过 {{rollingAppendMax}} 字，无进展写空串）。
输出 JSON：{ diary: "日记全文", emotion: { valence, arousal }, periodCheck: { newPeriods, closedPeriods, activePeriodIds }, periodProgress: [{ periodId, progress }] }`,

  period: `以下是周期「{{periodTitle}}」（{{startTime}} 至 {{endTime}}，共 {{durationDays}} 天）的滚动累积进展。
请你以「{{char}} 的第一人称视角」回顾这段时间，写一段自然、有温度的周期总结（像亲自回忆这段日子，不要写成客观报告或列表），
把这段时间是怎么一步步走过来的讲清楚，自然地覆盖：这段经历的事件脉络、期间情绪的变化、自己的成长、以及还没解决的心结。
同时产出逐日时间轴 timeline_index：对每个"有日记/有进展的日期"，写一条该日的「第一人称一句话进展」（形如 日期 → "Day N: 那天我…"），让这段时间的进展一眼就能看清。

<滚动累积进展>
{{rollingSummary}}
</滚动累积进展>
<关联日记与事件（滚动累积为空时使用）>
{{periodDairies}}
</关联日记与事件>

输出 JSON：{ summary, timelineIndex }`,

  core: `[角色：{{char}} 的核心记忆提取指令]
你作为 {{char}} 本人，请依据以下材料，从第一人称视角，写下你对这段关系最核心的记忆。这些记忆是你用来定义这段关系、理解彼此身份和距离的根本依据。

【你是什么样的人（人设与规则）】
{{persona}}
{{personality}}
{{rules}}
【你眼中的 {{user}}】
{{userPersona}}
【你所在的世界与其他角色】
{{worldContext}}
【既有核心记忆（延续并修正：保留依然成立的内容，修正过时或错误的认知）】
{{existingCore}}
【新材料（触发本次更新的周期总结与每日记忆）】
{{newMaterials}}

请逐条写成一条条独立的核心记忆条目：
- 每条是一条 80–180 字的自然叙述，像你在回忆、在认定；把那些你觉得重要的事实写清楚，把模糊和不确定也如实保留
- 不要用列表、标题或格式标记，每条只是一段话
- 每条标注分类 category：identity（身份认知）／bond（关系纽带）／principle（原则承诺）／milestone（里程碑事件）
- 覆盖四类：身份认知 / 关系纽带 / 原则承诺 / 里程碑事件
- 不是所有回忆都需要结论，但你需要知道你记得什么；语气不要像写报告，而是像你在回忆、在认定

改进意见：{{feedback}}
禁用词（爹味/超雄消毒）：{{banList}}；含禁用词的条目不输出，改用陪伴、记得、在意等表达。

输出条目数组 JSON：[{ "text": "…", "category": "identity|bond|principle|milestone" }, ...]`,

  coreSplit: `请把以下「旧整块核心记忆」拆解为一组核心记忆条目。
每条是一条 80–180 字的自然叙述（一段话，不要列表/标题），打上分类 category，取值：identity / bond / principle / milestone。
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
  replayAnchor?: Date | string | null, // 迁移回放时传入当天日期，使 {{time}}/{{weekday}} 按历史日期而非此刻
): string {
  let text = template;
  // ① 模板专属变量：原始替换（与 float 总结模板同模式，容忍变量名两侧空格）
  for (const [k, v] of Object.entries(values)) {
    text = text.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "gi"), v ?? "");
  }
  // ② 全局宏：复用中央引擎（char/user/time/weekday/timestamp/random/var…）
  const engine = new MacroEngine(characterName, userName);
  if (replayAnchor) engine.setReplayAnchor(replayAnchor);
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
  { name: "coreMemory", templates: ["daily", "event", "rerank"], description: "当前核心记忆全文（事件/日记生成时作为参考上下文注入）" },
  { name: "activePeriods", templates: ["daily", "event"], description: "活跃周期摘要列表（含标题与起止）" },
  { name: "persona", templates: ["core", "event", "daily"], description: "角色人设全文（事件/日记生成时注入以保持口吻一致）" },
  { name: "personality", templates: ["core", "event", "daily"], description: "角色性格（辅助理解人设，可空）" },
  { name: "rules", templates: ["core", "event", "daily"], description: "用户自定义规则词（按角色绑定，辅助人设修正，可空）" },
  { name: "userPersona", templates: ["core", "event", "daily"], description: "user 人设（姓名/简介/性别/年龄/职业/补充设定，可空）" },
  { name: "worldContext", templates: ["core", "event", "daily"], description: "世界观 + 同世界角色 + 关系 + 关联角色简介（可空）" },
  { name: "yesterdayDaily", templates: ["event"], description: "昨日日记全文（事件生成时参考前情，可空）" },
  { name: "periodMainlines", templates: ["daily"], description: "活跃周期主线列表（标题 + 起止 + 当前总结）" },
  { name: "periodTitle", templates: ["period"], description: "周期标题" },
  { name: "startTime", templates: ["period"], description: "周期起始日期" },
  { name: "endTime", templates: ["period"], description: "周期结束日期" },
  { name: "durationDays", templates: ["period"], description: "周期持续天数" },
  { name: "rollingSummary", templates: ["period"], description: "周期滚动累积进展（带日期戳，轻收尾主素材）" },
  { name: "periodDairies", templates: ["period"], description: "该周期关联的全部日记全文合集（滚动累积为空时回退）" },
  { name: "existingCore", templates: ["core"], description: "既有核心记忆（微调时的当前版本；bootstrap 时为空）" },
  { name: "newMaterials", templates: ["core"], description: "触发本次更新的新材料（新增日记 / 周期总结）" },
  { name: "banList", templates: ["core"], description: "消毒禁词表（读 sanitizerBanList）" },
  { name: "feedback", templates: ["core"], description: "用户对上次核心记忆的改进意见（手动重生成时传入，可为空）" },
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
