// lib/complex-memory/period-thinking.ts
// 周期思考：用户选中若干天日记，让模型结合这些天的连续内容 + char 人设/规则词/user 人设/核心记忆，
// 综合分析这段时间是否发生了「新的长期事件」（应开启的周期）。
// 背景：每日日记生成时模型只看到当天聊天记录，容易误判"没有长期事件开始"，导致周期漏建。
// 本功能用多天联动重判，结果供用户在周期页确认后手动创建周期。
// 调用复杂记忆生成 API（complexMemoryApiConfigId）。

import { simpleLLMCall } from "../api-helpers";
import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { renderMemoryPrompt } from "./prompts";
import { buildGenerationContext } from "./context-builder";
import { getCurrentCoreView, loadActivePeriods, loadDailies, loadEvents } from "./storage";
import { pushFeedAudit } from "./feed-audit";
import { getUserName, extractJsonObject } from "./utils";
import type { ComplexDaily } from "./types";

export type PeriodThinkNew = { title: string; reason: string };
export type PeriodThinkExisting = { title: string; note: string };
export type PeriodThinkResult = {
  newPeriods: PeriodThinkNew[];
  existing: PeriodThinkExisting[];
};

const THINK_TEMPLATE = `{{//周期思考 · 多日综合判定}}
你正在为角色 {{char}} 的复杂记忆系统判断「这段时间是否开启了新的长期事件（周期）」。

【角色设定与上下文（把握角色认知、避免与既有记忆冲突）】
【你是什么样的人（人设）】
{{persona}}
【性格】
{{personality}}
【规则】
{{rules}}
【你眼中的 {{user}}】
{{userPersona}}
【所在世界与其他角色】
{{worldContext}}
【你的核心记忆】
{{coreMemory}}
【当前活跃周期】
{{activePeriods}}
{{periodMainlines}}

【你选中的这几天日记】
{{dailies}}

【这几天的事件记忆（佐证连贯性）】
{{events}}

请综合上面多天的连贯内容，判断这段连续时间内是否发生了「值得作为一个长期事件/周期来记录」的事情——例如一段持续的关系进展、一个阶段性任务/冒险、一段反复出现的主题。
注意：你每次只看到单一当天的聊天记录，容易把一个持续多天的长期事件误判为"没有长期事件开始"。请放宽视野，识别跨多天的主题或阶段性事件；但也不要为凑数硬造——只有确实构成"持续一段时间的长期事件"才判定为开启。

输出 JSON：
{ "newPeriods": [ { "title": "周期标题", "reason": "为什么开启（引用多天里的具体证据）" } ], "existing": [ { "title": "已在进行的周期", "note": "这几天与它的关联" } ] }`;

function buildPrompt(
  characterName: string,
  userName: string,
  persona: string,
  personality: string,
  rules: string,
  userPersona: string,
  worldContext: string,
  coreMemory: string,
  activePeriods: string,
  periodMainlines: string,
  dailiesText: string,
  eventsText: string,
): string {
  return renderMemoryPrompt(THINK_TEMPLATE, characterName, userName, {
    persona,
    personality,
    rules,
    userPersona,
    worldContext,
    coreMemory,
    activePeriods,
    periodMainlines,
    dailies: dailiesText,
    events: eventsText,
  });
}

function parseThinkJson(text: string): PeriodThinkResult | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const arr = <T>(v: unknown, cb: (x: Record<string, unknown>) => T): T[] =>
      Array.isArray(v)
        ? (v as Array<Record<string, unknown>>).map((x) => cb(x ?? {})).filter(Boolean)
        : [];
    const newPeriods = arr<PeriodThinkNew>(obj.newPeriods, (x) => {
      const title = typeof x.title === "string" ? x.title.trim() : "";
      if (!title) return null as unknown as PeriodThinkNew;
      return { title, reason: typeof x.reason === "string" ? x.reason.trim() : "" };
    });
    const existing = arr<PeriodThinkExisting>(obj.existing, (x) => {
      const title = typeof x.title === "string" ? x.title.trim() : "";
      if (!title) return null as unknown as PeriodThinkExisting;
      return { title, note: typeof x.note === "string" ? x.note.trim() : "" };
    });
    return { newPeriods, existing };
  } catch {
    return null;
  }
}

/** 周期思考：多日联动重判是否开启长期事件。返回判定结果（不写库，由 UI 决定是否创建周期）。 */
export async function runPeriodThinking(
  characterId: string,
  characterName: string,
  dates: string[],
): Promise<{ success: boolean; result?: PeriodThinkResult; error?: string }> {
  const selected = [...new Set(dates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (selected.length === 0) return { success: false, error: "请先选择至少一天日记" };
  if (selected.length > 40) return { success: false, error: "一次最多选择 40 天，可分批判断" };

  const apiConfig = resolveAuxiliaryApiConfig("complexMemoryApiConfigId");
  if (!apiConfig) {
    return { success: false, error: "未配置复杂记忆生成 API（设置 → 绑定配置 → 辅助 API → 复杂记忆生成）" };
  }

  const [dailies, events, coreView, activePeriods] = await Promise.all([
    loadDailies(characterId),
    loadEvents(characterId),
    getCurrentCoreView(characterId),
    loadActivePeriods(characterId),
  ]);
  const selectedSet = new Set(selected);
  const selDailies: ComplexDaily[] = dailies.filter((d) => selectedSet.has(d.date));
  if (selDailies.length === 0) return { success: false, error: "所选日期没有日记" };
  const selEvents = events.filter((e) => selectedSet.has(String(e.timestamp).slice(0, 10)));

  const dailiesText = selDailies.map((d) => `[${d.date}] ${d.content}`).join("\n\n");
  const eventsText = selEvents.map((e) => `[${e.timestamp}] ${e.content}`).join("\n\n");
  const ctx = buildGenerationContext(characterId);
  const coreText = coreView.text;
  const periodsText = activePeriods.map((p) => `【${p.title}】${p.startTime} 起${p.endTime ? `至 ${p.endTime}` : "至今"}：${p.summary}`).join("\n");
  const periodMainlines = activePeriods.map((p) => `【${p.title}】${p.summary}`).join("\n");

  const prompt = buildPrompt(
    characterName,
    getUserName(characterId),
    ctx.persona,
    ctx.personality,
    ctx.rules,
    ctx.userPersona,
    ctx.worldContext,
    coreText,
    periodsText,
    periodMainlines,
    dailiesText,
    eventsText,
  );

  const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], {
    temperature: 0.3,
    label: `复杂记忆·周期思考·${characterName}`,
  });
  // 投喂审计：记录本次周期思考实际发给模型的完整 prompt
  pushFeedAudit({
    characterId,
    characterName,
    kind: "period",
    date: selected[0],
    prompt,
    response: result.content ?? (result.error ?? ""),
    model: apiConfig.defaultModel,
  });
  if (!result.content) return { success: false, error: result.error || "LLM 返回空内容" };

  const parsed = parseThinkJson(result.content);
  if (!parsed) return { success: false, error: "周期思考 JSON 解析失败，可重试" };
  return { success: true, result: parsed };
}
