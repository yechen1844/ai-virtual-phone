// lib/nagi-bridge.ts
// 星露谷联动：独立会话 + 工具隔离 + 记忆共享。
//
// 设计：
// 1. 记忆按 characterId 全局共享（char 的记忆/核心记忆/复杂记忆 / 人设 / 世界书 / 预设全部复用）。
//    星露谷会话用同一个 characterId，因此 char 能延续同一套记忆——这正是用户希望的。
// 2. 工具隔离：给星露谷会话传 appId="stardew"，getEnabledInternalCapabilities("stardew") 返回 []，
//    于是主聊天那套内置能力（写记忆/音乐/日历/稍后联系…）不会加载；只暴露下面的星露谷工具。
// 3. 会话独立：用独立的 session id（同 contactId），消息流和主聊天分开；
//    但短期上下文（shortTermMemory）仍会带该 char 的近期时间线（用户明确希望共享短期记忆）。
// 4. 云端中转：从 Cloudflare Worker 拉取游戏消息 → 写入星露谷会话 → char 回复 → 推回云端。

import { loadChatSessions, saveChatSessions, pushChatMessage, loadChatMessages } from "./chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet } from "./kv-db";
import {
  createRestTool,
  saveRestTools,
  loadRestTools,
} from "./tool-storage";

const CLOUD_URL = process.env.NEXT_PUBLIC_NAGI_CLOUD_URL || "https://nagi.chajianreader.cc.cd";
const CLOUD_KEY = process.env.NEXT_PUBLIC_NAGI_CLOUD_KEY || "nagi_bridge_2026";
const POLL_MS = Number(process.env.NEXT_PUBLIC_NAGI_POLL_MS || 2000);
const BUTLER_URL = process.env.NEXT_PUBLIC_NAGI_BUTLER_URL || "http://localhost:7869";
const NAGIBRIDGE_URL = process.env.NEXT_PUBLIC_NAGIBRIDGE_URL || "http://localhost:7842";

export const STARDEW_APP_ID = "stardew";
const STARDEW_SESSION_PREFIX = "sess_stardew_";
const KV_CHAR_KEY = "nagi_bridge_character_id";
const KV_ENABLED_KEY = "nagi_bridge_enabled";

type NagiEntry = { sender: string; text: string; ts?: string };

let pollingStarted = false;

// ── 星露谷专属工具（只读 + 聊天，用于工具隔离）──

export type StardewToolDef = { name: string; description: string; parameterSchema: string };

export function getStardewTools(): StardewToolDef[] {
  return [
    { name: "stardew_get_state", description: "查看玩家当前游戏状态：位置、时间、季节、金钱、体力、背包。用于了解农场现状。", parameterSchema: "{}" },
    { name: "stardew_get_surroundings", description: "查看玩家周围环境：附近有哪些 NPC、怪物、可交互物体、作物。参数 radius 为扫描半径（默认 5）。", parameterSchema: '{"type":"object","properties":{"radius":{"type":"number","description":"扫描半径"}},"additionalProperties":false}' },
    { name: "stardew_speak_in_game", description: "让 char 在星露谷游戏聊天框里说一句话（显示给玩家看）。参数 text 为要说的话。", parameterSchema: '{"type":"object","properties":{"text":{"type":"string","description":"要说的内容"}},"required":["text"],"additionalProperties":false}' },
    { name: "stardew_get_time", description: "查看当前游戏内时间（今天几点、季节、第几天、第几年）。", parameterSchema: "{}" },
    { name: "stardew_warp", description: "传送到一个地点。常用：Farm, Town, Beach, Mountain, Forest, Mine, BusStop, Desert。参数 location 为地点名。", parameterSchema: '{"type":"object","properties":{"location":{"type":"string"},"x":{"type":"integer"},"y":{"type":"integer"}},"required":["location"],"additionalProperties":false}' },
    { name: "stardew_move_to", description: "走到一个格子坐标。参数 x 和 y 为目标格子坐标。", parameterSchema: '{"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"}},"required":["x","y"],"additionalProperties":false}' },
    { name: "stardew_use_tool", description: "挥动一个工具（斧头/镐子/锄头/水壶等），参数 name 为工具名或 'current'。", parameterSchema: '{"type":"object","properties":{"name":{"type":"string","default":"current"}},"additionalProperties":false}' },
    { name: "stardew_select_item", description: "选择背包里的一个物品（工具/种子/作物等），参数 name 为物品名。", parameterSchema: '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}' },
    { name: "stardew_interact", description: "与面前的物体/NPC 交互。", parameterSchema: "{}" },
    { name: "stardew_face", description: "设置面朝方向：0=上 1=右 2=下 3=左。", parameterSchema: '{"type":"object","properties":{"direction":{"type":"integer","enum":[0,1,2,3]}},"required":["direction"],"additionalProperties":false}' },
    { name: "stardew_use_item", description: "使用/放置当前手持物品（种子、物体等）。", parameterSchema: "{}" },
    { name: "stardew_press_key", description: "模拟按键。可用：confirm, cancel, skip, ok, F1-F12。", parameterSchema: '{"type":"object","properties":{"key":{"type":"string"},"count":{"type":"integer","default":1}},"required":["key"],"additionalProperties":false}' },
    { name: "stardew_run_script", description: "运行农场自动化脚本。可用：farm_row, water_crops, harvest, mine_run, chop_trees, clear_area, pet_animals, keg_manager, furnace_manager。参数 script 为脚本名，args 为命令行参数。", parameterSchema: '{"type":"object","properties":{"script":{"type":"string"},"args":{"type":"string"}},"required":["script"],"additionalProperties":false}' },
    { name: "stardew_sleep", description: "上床睡觉结束今天。自动找床，不需要先回家。检查结果：state=slept 表示过夜了；state=ready 表示已上床但需等所有人就绪——此时不要再移动/warp/起床，否则会卡死所有人。", parameterSchema: "{}" },
    { name: "stardew_get_machines", description: "扫描当前地点所有机器（酒桶/熔炉等）的状态。", parameterSchema: "{}" },
    { name: "stardew_get_animals", description: "查看所有农场动物：是否已摸、好感度、心情、产品就绪。", parameterSchema: "{}" },
  ];
}

// 由于 REST 工具不受 appId 过滤，星露谷工具通过 custom_app 机制按 appId 暴露。
// 这里提供一种轻量方式：把星露谷工具包装成"星露谷 App 的工具"，通过 appId 过滤。
// 具体过滤在 custom-app-sdk-registry 的 loadCustomAppToolsForContext(appId) 里发生：
// 当 appId === "stardew"（或 "custom_app:stardew"）时，只加载该 app 自己的工具。

/** 把 4 个星露谷工具注册成真实 REST 工具（endpoint 指向云端 Worker），供执行器 tryRest 命中 */
export function ensureStardewToolsRegistered(): void {
  if (typeof window === "undefined") return;
  let changed = false;
  const existing = loadRestTools();
  const defs = getStardewTools();
  for (const def of defs) {
    const found = existing.find((t) => t.name === def.name);
    if (found) continue; // 已存在
    const tool = createRestTool(def.name);
    tool.description = def.description;
    tool.parameterSchema = def.parameterSchema;
    tool.enabled = true;
    tool.packageId = undefined; // 星露谷工具独立，不入包，靠 name 前缀按 appId 过滤
    tool.directFetch = true;

    // 根据工具名映射到 NagiBridge HTTP API 端点
    const endpointMap: Record<string, { endpoint: string; method: "GET" | "POST"; bodyTemplate?: string }> = {
      stardew_get_state:        { endpoint: `${NAGIBRIDGE_URL}/state`, method: "GET" },
      stardew_get_surroundings: { endpoint: `${NAGIBRIDGE_URL}/surroundings`, method: "GET" },
      stardew_speak_in_game:    { endpoint: `${NAGIBRIDGE_URL}/chat/push`, method: "POST", bodyTemplate: `{"sender":"Nagi","message":"{{text}}"}` },
      stardew_get_time:         { endpoint: `${NAGIBRIDGE_URL}/state`, method: "GET" },
      stardew_warp:             { endpoint: `${NAGIBRIDGE_URL}/warp`, method: "POST" },
      stardew_move_to:          { endpoint: `${NAGIBRIDGE_URL}/move`, method: "POST" },
      stardew_use_tool:         { endpoint: `${NAGIBRIDGE_URL}/tool`, method: "POST" },
      stardew_select_item:      { endpoint: `${NAGIBRIDGE_URL}/select`, method: "POST" },
      stardew_interact:         { endpoint: `${NAGIBRIDGE_URL}/interact`, method: "POST" },
      stardew_face:             { endpoint: `${NAGIBRIDGE_URL}/face`, method: "POST" },
      stardew_use_item:         { endpoint: `${NAGIBRIDGE_URL}/use`, method: "POST" },
      stardew_press_key:        { endpoint: `${NAGIBRIDGE_URL}/key`, method: "POST" },
      stardew_run_script:       { endpoint: `${NAGIBRIDGE_URL}/queue`, method: "POST" },
      stardew_sleep:            { endpoint: `${NAGIBRIDGE_URL}/sleep`, method: "POST" },
      stardew_get_machines:     { endpoint: `${NAGIBRIDGE_URL}/machines`, method: "GET" },
      stardew_get_animals:      { endpoint: `${NAGIBRIDGE_URL}/animals`, method: "GET" },
    };
    const mapping = endpointMap[def.name];
    if (mapping) {
      tool.endpoint = mapping.endpoint;
      tool.method = mapping.method;
      if (mapping.bodyTemplate) tool.bodyTemplate = mapping.bodyTemplate;
    }
    existing.push(tool);
    changed = true;
  }
  if (changed) saveRestTools(existing);
}

/** 判断某个 REST 工具是否属于星露谷（按 name 前缀识别） */
export function isStardewRestTool(tool: { packageId?: string; name?: string }): boolean {
  return typeof tool?.name === "string" && tool.name.startsWith("stardew_");
}

// ── 独立会话管理 ──

function isStardewSession(s: { id?: string }): boolean {
  return typeof s?.id === "string" && s.id.startsWith(STARDEW_SESSION_PREFIX);
}

export function getOrCreateStardewSession(characterId: string) {
  const sessions = loadChatSessions();
  const existing = sessions.find((s) => s.contactId === characterId && isStardewSession(s));
  if (existing) return existing;

  const newSession: any = {
    id: `${STARDEW_SESSION_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    contactId: characterId,
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    isPinned: false,
    bilingualTranslationEnabled: true,
    collapseBilingualTranslation: true,
    visionImagePromptLimit: 1,
  };
  saveChatSessions([newSession, ...sessions]);
  return newSession;
}

// ── 云端中转 ──

async function cloudFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${CLOUD_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "X-Nagi-Key": CLOUD_KEY,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pullGameMessages(): Promise<NagiEntry[]> {
  try {
    const data = await cloudFetch("/messages");
    if (data.ok && Array.isArray(data.messages)) return data.messages;
    return [];
  } catch (e) {
    console.warn("[NagiBridge] 拉取游戏消息失败:", e);
    return [];
  }
}

async function pushReply(sender: string, text: string): Promise<void> {
  try {
    await cloudFetch("/reply", {
      method: "POST",
      body: JSON.stringify({ sender, text, ts: Date.now() }),
    });
  } catch (e) {
    console.warn("[NagiBridge] 推送回复失败:", e);
  }
}

/**
 * 把一条消息发进星露谷游戏（通过云端 Worker → 管家 → NagiBridge /chat/push）。
 * 用于星露谷聊天页的"回车发送"：只发送，不触发模型回复。
 */
export async function sendGameMessageViaCloud(text: string, sender: string = "玩家"): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  try {
    await cloudFetch("/message", {
      method: "POST",
      body: JSON.stringify({ sender, text: trimmed, ts: Date.now() }),
    });
    return true;
  } catch (e) {
    console.warn("[NagiBridge] 发消息进游戏失败:", e);
    return false;
  }
}

// ── 核心：把游戏消息写入星露谷会话，生成回复 ──

export async function ingestNagiGameMessage(characterId: string, msg: NagiEntry): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!characterId) return null;

  const session = getOrCreateStardewSession(characterId);

  pushChatMessage({
    sessionId: session.id,
    role: "user",
    content: msg.text,
    status: "sent",
  });

  const history = loadChatMessages(session.id);
  const replyText = await generateStardewReply(session, history);
  if (!replyText) return null;

  pushChatMessage({
    sessionId: session.id,
    role: "assistant",
    content: replyText,
    status: "sent",
  });

  await pushReply(characterId, replyText);
  return replyText;
}

async function generateStardewReply(session: any, history: any[]): Promise<string | null> {
  try {
    ensureStardewToolsRegistered();
    const cr = await generateChatCompletion(session, history, {
      appId: STARDEW_APP_ID,
      appTags: ["stardew"],
    });
    return flattenCompletionResult(cr);
  } catch (e) {
    console.warn("[NagiBridge] char 生成回复失败:", e);
    return null;
  }
}

// ── 轮询 ──

export async function processNagiInbox(characterId: string): Promise<number> {
  if (typeof window === "undefined") return 0;
  const msgs = await pullGameMessages();
  let count = 0;
  for (const m of msgs) {
    if (!characterId) break;
    const reply = await ingestNagiGameMessage(characterId, m);
    console.log("[NagiBridge] 处理游戏消息:", m.text, "→", reply ? "已回复" : "未回复");
    count += 1;
  }
  return count;
}

export function startNagiPolling(characterId: string): void {
  if (typeof window === "undefined") return;
  if (pollingStarted) return;
  pollingStarted = true;
  const tick = async () => {
    try {
      if (characterId) await processNagiInbox(characterId);
    } catch (e) {
      console.warn("[NagiBridge] 轮询出错:", e);
    }
    setTimeout(tick, POLL_MS);
  };
  tick();
}

export function stopNagiPolling(): void {
  pollingStarted = false;
}

// ── 供 UI 使用 ──

export function listBindableCharacters(): { id: string; name: string }[] {
  if (typeof window === "undefined") return [];
  try {
    return loadCharacters().map((c: any) => ({ id: c.id, name: c.name || c.id }));
  } catch {
    return [];
  }
}

/** 星露谷会话当前绑定的 char */
export function getStardewCharId(): string {
  return kvGet(KV_CHAR_KEY) || "";
}

export function setStardewCharId(id: string): void {
  kvSet(KV_CHAR_KEY, id);
}

export function isStardewEnabled(): boolean {
  return typeof window !== "undefined" && kvGet(KV_ENABLED_KEY) === "1";
}

export function setStardewEnabled(on: boolean): void {
  kvSet(KV_ENABLED_KEY, on ? "1" : "0");
}

// ── Think 处理器：float 浏览器作为 char 大脑，处理 char_agent 的思考请求 ──

let thinkProcessorStarted = false;

/**
 * 启动 think 处理器：轮询管家 /think-pending，
 * 拉到后调 generateChatCompletion（char 大脑）生成决策，
 * 结果（文本 + 工具调用）推回管家 /think-result。
 *
 * 需要已绑定 charId（用作 session.contactId）。
 */
export function startThinkProcessor(characterId: string): void {
  if (typeof window === "undefined") return;
  if (thinkProcessorStarted) return;
  thinkProcessorStarted = true;

  const tick = async () => {
    if (!thinkProcessorStarted) return;
    try {
      const res = await fetch(`${BUTLER_URL}/think-pending`, {
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && !data.empty && data.id) {
          await processThinkRequest(characterId, data.id, data.messages || [], data.tools || []);
        }
      }
    } catch (e) {
      // 静默：管家可能没开或没请求
    }
    if (thinkProcessorStarted) setTimeout(tick, 1500);
  };
  tick();
}

export function stopThinkProcessor(): void {
  thinkProcessorStarted = false;
}

async function processThinkRequest(
  characterId: string,
  thinkId: string,
  messages: any[],
  tools: any[],
): Promise<void> {
  try {
    ensureStardewToolsRegistered();
    const session = getOrCreateStardewSession(characterId);

    // 把 char_agent 发来的 history 转成 float 的 ChatMessage[] 格式
    // char_agent 的 messages 是 OpenAI 风格：{role, content, tool_calls?, name?}
    // float 的 generateChatCompletion 需要 ChatMessage[]（含 sessionId/role/content/status）
    const history: any[] = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        sessionId: session.id,
        role: m.role,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content || ""),
        status: "sent" as const,
      }));

    // 调 char 大脑生成决策
    const cr = await generateChatCompletion(session, history, {
      appId: STARDEW_APP_ID,
      appTags: ["stardew"],
    });

    // flattenCompletionResult 返回纯文本，但 char_agent 需要 tool_calls
    // generateChatCompletion 的返回是 { parts: [{text}] }，工具调用在内部循环里已执行
    // 这里我们需要拿到"char 想调什么工具"——但 generateChatCompletion 的设计是
    // 工具调用在内部循环执行完了，最终只返回文本。
    //
    // 所以对于 char_agent 场景，我们需要一个"只思考不执行"的模式。
    // 临时方案：把 char 的文本回复返回，工具调用由 char_agent 侧的 LLM 自行决定
    //（char_agent 仍然有它自己的 LLM 调用能力作为兜底）
    const text = flattenCompletionResult(cr);

    // 推回管家
    await fetch(`${BUTLER_URL}/think-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: thinkId,
        text,
        toolCalls: [],  // 见上注释：工具调用暂不由此路径返回
      }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[NagiBridge] think #${thinkId} 已处理 → 回复: ${text?.slice(0, 60)}`);
  } catch (e) {
    console.warn(`[NagiBridge] think #${thinkId} 处理失败:`, e);
    // 推回错误，让 char_agent 不卡死
    try {
      await fetch(`${BUTLER_URL}/think-result`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: thinkId, text: "(思考失败)", toolCalls: [] }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }
}
