// lib/mixology/engine.ts
// 独家特调 · 对局运行时：开局、出杯（生成回复）、重说、继续。
//
// 特调不走聊天预设/正则管线——一杯特调自带全部提示词，正文协议由 App 自有解析器处理。
// API 走全局默认接口配置（与角色绑定无关，特调对局是独立世界）。

import { ChatEngineError, sendLLMRequest } from "../chat-engine";
import type { LLMMessage } from "../llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "../settings-storage";
import type { ApiConfig } from "../settings-types";
import { assembleMixPrompt, MIX_ENCORE_CLOSE, MIX_ENCORE_OPEN, MIX_TICKET_CLOSE, MIX_TICKET_OPEN, type MixAssembledPrompt } from "./assembler";
import { extractMixBlocks } from "./prose";
import {
    getMixMaterial,
    getMixSession,
    resolveMixRecipeMaterials,
    saveMixSession,
} from "./storage";
import {
    createMixId,
    type MixCharacterCard,
    type MixRecipe,
    type MixSession,
    type MixTurn,
} from "./types";

export const MIX_PROMPT_APP_ID = "mixology";
const MIX_PROMPT_TAGS = ["mixology"];

/** 对局用的 API 配置：全局默认接口 */
export function resolveMixApiConfig(): ApiConfig | null {
    const binding = loadBindingConfig();
    const configs = loadApiConfigs();
    const id = binding.globalDefaults.apiConfigId;
    if (id) {
        const found = configs.find((c) => c.id === id);
        if (found) return found;
    }
    return configs[0] ?? null;
}

/** 从方案快照装配提示词（材料从酒柜按 id 现取；角色卡被删则报错） */
function assembleFromSession(session: MixSession): MixAssembledPrompt {
    const { materials } = resolveMixRecipeMaterials(session.recipe);
    const character = materials.character;
    if (!character || character.kind !== "character") {
        throw new ChatEngineError("这杯特调的角色卡已不在酒柜里，无法继续对局。");
    }
    return assembleMixPrompt({
        character: character as MixCharacterCard,
        materials,
        userName: session.userName,
        openingIndex: session.openingIndex,
    });
}

/** 历史回放时给 assistant 消息补回状态栏/小剧场块，让模型看得到自己之前的输出习惯 */
function turnToHistoryContent(turn: MixTurn): string {
    if (turn.role !== "assistant") return turn.text;
    const parts = [turn.text];
    if (turn.ticketRaw) parts.push(`${MIX_TICKET_OPEN}\n${turn.ticketRaw}\n${MIX_TICKET_CLOSE}`);
    if (turn.encoreRaw) parts.push(`${MIX_ENCORE_OPEN}\n${turn.encoreRaw}\n${MIX_ENCORE_CLOSE}`);
    return parts.join("\n\n");
}

function buildMixMessages(
    session: MixSession,
    assembled: MixAssembledPrompt,
    extraUserNudge?: string,
): LLMMessage[] {
    const messages: LLMMessage[] = [
        { role: "system", content: assembled.system, _debugMeta: { marker: "mixology_system" } },
    ];
    for (const turn of session.turns) {
        messages.push({
            role: turn.role,
            content: turnToHistoryContent(turn),
            _debugMeta: { marker: "mixology_history", _fromHistory: true },
        });
    }
    if (assembled.postHistory) {
        messages.push({
            role: "system",
            content: assembled.postHistory,
            _debugMeta: { marker: "mixology_strength" },
        });
    }
    if (extraUserNudge) {
        messages.push({
            role: "user",
            content: extraUserNudge,
            _debugMeta: { marker: "mixology_nudge" },
        });
    }
    return messages;
}

/** 开局：按方案快照建对局，开场白作为首条 assistant 消息 */
export function startMixSession(
    recipe: MixRecipe,
    options?: { openingIndex?: number; userName?: string },
): MixSession {
    const characterId = recipe.slots.character;
    const card = characterId ? getMixMaterial(characterId) : null;
    if (!card || card.kind !== "character") {
        throw new ChatEngineError("特调里没有角色卡，装不满这一杯。");
    }
    const openingIndex = options?.openingIndex ?? 0;
    const session: MixSession = {
        id: createMixId("mixsess"),
        recipe: { ...recipe, slots: { ...recipe.slots } },
        charName: card.charName.trim() || card.name,
        userName: options?.userName?.trim() || undefined,
        openingIndex,
        turns: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const assembled = assembleFromSession(session);
    if (assembled.opening) {
        session.turns.push({
            id: createMixId("mixturn"),
            role: "assistant",
            text: assembled.opening,
            createdAt: Date.now(),
        });
    }
    saveMixSession(session);
    return session;
}

export type MixReplyResult = {
    session: MixSession;
    turn: MixTurn;
};

async function runMixGeneration(
    session: MixSession,
    nudge: string | undefined,
    signal?: AbortSignal,
): Promise<MixReplyResult> {
    const apiConfig = resolveMixApiConfig();
    if (!apiConfig) {
        throw new ChatEngineError("还没有配置 API 接口，请先到设置里添加。");
    }
    const assembled = assembleFromSession(session);
    const messages = buildMixMessages(session, assembled, nudge);
    const raw = await sendLLMRequest(
        apiConfig,
        null,
        messages,
        [],
        { characterName: session.charName, userName: session.userName || "你" },
        { appId: MIX_PROMPT_APP_ID, appTags: MIX_PROMPT_TAGS, skipOutputRegex: true, signal },
    );
    const { text, ticketRaw, encoreRaw } = extractMixBlocks(raw);
    if (!text && !ticketRaw) {
        throw new ChatEngineError("模型没有给出内容，请再试一次。");
    }
    const turn: MixTurn = {
        id: createMixId("mixturn"),
        role: "assistant",
        text,
        ticketRaw: assembled.hasTicket ? ticketRaw : undefined,
        encoreRaw: assembled.hasEncore ? encoreRaw : undefined,
        createdAt: Date.now(),
    };
    const updated: MixSession = { ...session, turns: [...session.turns, turn] };
    saveMixSession(updated);
    return { session: updated, turn };
}

/** 玩家发言 → 生成回复 */
export async function generateMixReply(
    sessionId: string,
    userText: string,
    signal?: AbortSignal,
): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const trimmed = userText.trim();
    if (!trimmed) throw new ChatEngineError("先说点什么吧。");
    const userTurn: MixTurn = {
        id: createMixId("mixturn"),
        role: "user",
        text: trimmed,
        createdAt: Date.now(),
    };
    const withUser: MixSession = { ...current, turns: [...current.turns, userTurn] };
    saveMixSession(withUser);
    return runMixGeneration(withUser, undefined, signal);
}

/** 重说：丢弃最后一条 assistant 回复重新生成（开场白除外） */
export async function rerollMixReply(sessionId: string, signal?: AbortSignal): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const last = current.turns[current.turns.length - 1];
    if (!last || last.role !== "assistant" || current.turns.length <= 1) {
        throw new ChatEngineError("现在没有可以重说的回复。");
    }
    const trimmedSession: MixSession = { ...current, turns: current.turns.slice(0, -1) };
    saveMixSession(trimmedSession);
    const beforeLast = trimmedSession.turns[trimmedSession.turns.length - 1];
    // 上一条也是 assistant（继续产生的），补一个不落库的推进指令避免连续 assistant 消息
    const nudge = beforeLast?.role === "assistant"
        ? "（请接着上文继续推进剧情，换一个写法，不要重复。）"
        : undefined;
    return runMixGeneration(trimmedSession, nudge, signal);
}

/** 继续：不发言，让角色接着写（推进指令不落库） */
export async function continueMix(sessionId: string, signal?: AbortSignal): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    return runMixGeneration(current, "（请接着上文继续推进剧情，直接续写，不要重复已写过的内容。）", signal);
}

/** 撤回最后一轮：删掉最后一条玩家发言及其后的全部回复 */
export function undoMixLastRound(sessionId: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    let lastUserIdx = -1;
    for (let i = current.turns.length - 1; i >= 0; i -= 1) {
        if (current.turns[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) throw new ChatEngineError("还没有可以撤回的发言。");
    const updated: MixSession = { ...current, turns: current.turns.slice(0, lastUserIdx) };
    saveMixSession(updated);
    return updated;
}
