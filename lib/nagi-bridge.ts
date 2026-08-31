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

import { loadChatSessions, saveChatSessions, pushChatMessage, loadChatMessages, createOrGetSession, reassignChatSessionMessages, deleteChatSession, DEFAULT_VISION_IMAGE_PROMPT_LIMIT, type ChatSession, type ChatMessage, type StateValue } from "./chat-storage";
import { recordStardewMessage } from "./stardew-memory";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import { parseAIResponse } from "./rich-message-parser";
import { loadCharacters } from "./character-storage";
import { kvGet, kvSet } from "./kv-db";
import {
  createRestTool,
  saveRestTools,
  loadRestTools,
} from "./tool-storage";

const POLL_MS = Number(process.env.NEXT_PUBLIC_NAGI_POLL_MS || 2000);
const BUTLER_URL = process.env.NEXT_PUBLIC_NAGI_BUTLER_URL || "http://localhost:7869";

export const STARDEW_APP_ID = "stardew";
const STARDEW_SESSION_PREFIX = "sess_stardew_";
// 星露谷回复只取最近 N 条，绝不全量历史（历史可能上万条，全量会撑爆上下文/崩溃）
const STARDEW_HISTORY_LIMIT = 150;
// 自主行动（自由活动）时追加给模型的内容：说明玩家没有说话，让 char 按性格决定说话或干活。
const STARDEW_AUTONOMY_PROMPT = "【自主时间】现在玩家没有说话。你可以按自己的性格决定：要么主动跟玩家说句话，要么去做一件合适的农活（可调用工具）。不想做就安静待着也可以。";
const KV_CHAR_KEY = "nagi_bridge_character_id";
const KV_ENABLED_KEY = "nagi_bridge_enabled";

type NagiEntry = { sender: string; text: string; ts?: string };

let pollingStarted = false;
// 星露谷 char 是否正在生成回复（供星露谷聊天页显示"思考中"）
let stardewGenerating = false;
export function isStardewGenerating(): boolean {
  return stardewGenerating;
}

// ── 星露谷自主性：char 完成动作后随机 1~4 分钟无玩家互动 → 自主说话/干活 ──
let stardewActivityTs = Date.now();
let stardewAutonomyTimer: ReturnType<typeof setTimeout> | null = null;

// ── 星露谷思维链：生成期间实时累积，供聊天页展示 ──
let stardewReasoning = "";
export function getStardewReasoning(): string {
  return stardewReasoning;
}

function cancelStardewAutonomy(): void {
  if (stardewAutonomyTimer) {
    clearTimeout(stardewAutonomyTimer);
    stardewAutonomyTimer = null;
  }
}

/** 玩家有互动时调用：刷新活动时间，并取消待触发的自主行动。 */
function markStardewActivity(): void {
  stardewActivityTs = Date.now();
  cancelStardewAutonomy();
}

/** char 生成完成后，排一个随机 1~4 分钟的自主计时：到点若玩家这段时间没说话则自主行动。 */
function armStardewAutonomy(characterId: string, session: any): void {
  cancelStardewAutonomy();
  const delay = 60000 + Math.floor(Math.random() * 180000); // 1~4 分钟随机
  stardewAutonomyTimer = setTimeout(async () => {
    stardewAutonomyTimer = null;
    if (stardewGenerating) return;
    // 玩家在这段时间若说过话，markStardewActivity 会 cancel 本 timer；
    // 能走到这里说明期间无互动，可自主。
    await fireStardewAutonomy(characterId, session);
  }, delay);
}

/** 自主时间：char 按自己性格决定说话或调工具干活。 */
async function fireStardewAutonomy(characterId: string, session: any): Promise<void> {
  stardewGenerating = true;
  try {
    ensureStardewToolsRegistered();
    const history = loadChatMessages(session.id);
    const autonomyHistory = [
      ...history,
      {
        sessionId: session.id,
        role: "system",
        content: STARDEW_AUTONOMY_PROMPT,
        status: "sent" as const,
      },
    ];
    const enriched = await injectStardewState(session, autonomyHistory);
    const cr = await generateChatCompletion(session, enriched, {
      appId: STARDEW_APP_ID,
      appTags: ["stardew"],
      forceEnableTools: true,
    }, {
      onToolNotice: (notice: string) => {
        if (session?.id) {
          pushChatMessage({ sessionId: session.id, role: "system", content: notice, mediaType: "tool_notice", status: "sent" });
        }
      },
    });
    if ((cr as any)?.reasoning) stardewReasoning = (cr as any).reasoning;
    const text = flattenCompletionResult(cr);
    if (text) {
      const parsedReply = parseStardewReplyForStorage(text);
      pushChatMessage({ sessionId: session.id, role: "assistant", content: parsedReply.content, statusPanel: parsedReply.statusPanel, innerMonologue: parsedReply.innerMonologue, stateValues: parsedReply.stateValues, freshStateValues: parsedReply.freshStateValues, status: "sent" });
      // 自主行动也要投影进主聊天短期记忆，否则主聊天看不到星露谷自主活动
      recordStardewMessage(characterId, { role: "assistant", content: parsedReply.content });
      await pushReply(characterId, parsedReply.content);
    }
  } catch (e) {
    console.warn("[NagiBridge] 自主行动失败:", e);
  } finally {
    stardewGenerating = false;
    armStardewAutonomy(characterId, session);
    // 思维链只供聊天页折叠展示，不写入会话、不参与上下文组装
  }
}

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
    { name: "stardew_run_script", description: "【优先·一键脚本】一键执行农场/战斗自动化脚本，一次完成整类任务，比一步步手动工具高效，能做就用它。可用脚本：farm_row(种田)、water_crops(浇水)、chop_trees(砍树)、harvest(收获)、mine_run(挖矿)、clear_area(开垦)、pet_animals(撸动物)、keg_manager(酿酒)、furnace_manager(熔炉)、fish_run(钓鱼)、shop_buy(购物)、combat_run(打怪，args 传 --mode guard|offense 选择守卫跟随用户打怪或主动攻击)。参数 script 为脚本名，args 为可选命令行参数。", parameterSchema: '{"type":"object","properties":{"script":{"type":"string"},"args":{"type":"string"}},"required":["script"],"additionalProperties":false}' },
    { name: "stardew_sleep", description: "上床睡觉结束今天。自动找床，不需要先回家。检查结果：state=slept 表示过夜了；state=ready 表示已上床但需等所有人就绪——此时不要再移动/warp/起床，否则会卡死所有人。", parameterSchema: "{}" },
    { name: "stardew_get_machines", description: "扫描当前地点所有机器（酒桶/熔炉等）的状态。", parameterSchema: "{}" },
    { name: "stardew_get_animals", description: "查看所有农场动物：是否已摸、好感度、心情、产品就绪。", parameterSchema: "{}" },
    { name: "stardew_heal", description: "作弊：完全恢复体力和生命值。", parameterSchema: "{}" },
    { name: "stardew_eat", description: "吃下手持的食物，恢复体力。若当前没选中食物，先用 stardew_select_item 选择食物再调用本工具。", parameterSchema: "{}" },
    { name: "stardew_gift_npc", description: "送给面前的NPC村民一件礼物，提升好感度。参数 item 为礼物物品名。若NPC不在面前，先用 warp/move_to 靠近再调用。", parameterSchema: '{"type":"object","properties":{"item":{"type":"string"}},"required":["item"],"additionalProperties":false}' },
    { name: "stardew_gift_player", description: "送给玩家（host）一件礼物。参数 item 为礼物物品名。若玩家不在附近，先走近（move_to）再递送。", parameterSchema: '{"type":"object","properties":{"item":{"type":"string"}},"required":["item"],"additionalProperties":false}' },
    { name: "stardew_buy", description: "购买物品。参数 id 为物品ID，count 为数量。", parameterSchema: '{"type":"object","properties":{"id":{"type":"string"},"count":{"type":"integer","default":1}},"required":["id"],"additionalProperties":false}' },
    { name: "stardew_sell", description: "把物品出售到出货箱（需在农场）。参数 name 指定要卖的东西；不填则卖出全部。", parameterSchema: '{"type":"object","properties":{"name":{"type":"string"}},"additionalProperties":false}' },
    { name: "stardew_store", description: "把背包物品存到箱子。参数 x、y 为箱子坐标，name 为要存的物品名（可选）。", parameterSchema: '{"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"},"name":{"type":"string"}},"required":["x","y"],"additionalProperties":false}' },
    { name: "stardew_emote", description: "让角色做一个表情动作。参数 emotion 可选。", parameterSchema: '{"type":"object","properties":{"emotion":{"type":"string"}},"additionalProperties":false}' },
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
  // 星露谷工具统一走管家转发到本地 NagiBridge HTTP API。
  // 浏览器直连 NagiBridge 的 POST 会因 CORS 预检(OPTIONS)失败而"服务器连接失败"，
  // 管家已处理 CORS/OPTIONS，由其转发即可绕开。
  const endpointMap: Record<string, { endpoint: string; method: "GET" | "POST"; bodyTemplate?: string }> = {
    stardew_get_state:        { endpoint: `${BUTLER_URL}/nb/state`, method: "GET" },
    stardew_get_surroundings: { endpoint: `${BUTLER_URL}/nb/surroundings`, method: "GET" },
    stardew_speak_in_game:    { endpoint: `${BUTLER_URL}/nb/chat/push`, method: "POST", bodyTemplate: `{"sender":"Nagi","message":"{{text}}"}` },
    stardew_get_time:         { endpoint: `${BUTLER_URL}/nb/state`, method: "GET" },
    stardew_warp:             { endpoint: `${BUTLER_URL}/nb/warp`, method: "POST" },
    stardew_move_to:          { endpoint: `${BUTLER_URL}/nb/move`, method: "POST" },
    stardew_use_tool:         { endpoint: `${BUTLER_URL}/nb/tool`, method: "POST" },
    stardew_select_item:      { endpoint: `${BUTLER_URL}/nb/select`, method: "POST" },
    stardew_interact:         { endpoint: `${BUTLER_URL}/nb/interact`, method: "POST" },
    stardew_face:             { endpoint: `${BUTLER_URL}/nb/face`, method: "POST" },
    stardew_use_item:         { endpoint: `${BUTLER_URL}/nb/use`, method: "POST" },
    stardew_press_key:        { endpoint: `${BUTLER_URL}/nb/key`, method: "POST" },
    stardew_run_script:       { endpoint: `${BUTLER_URL}/script`, method: "POST" },
    stardew_sleep:            { endpoint: `${BUTLER_URL}/nb/sleep`, method: "POST" },
    stardew_get_machines:     { endpoint: `${BUTLER_URL}/nb/machines`, method: "GET" },
    stardew_get_animals:      { endpoint: `${BUTLER_URL}/nb/animals`, method: "GET" },
    stardew_heal:             { endpoint: `${BUTLER_URL}/nb/heal`, method: "POST" },
    stardew_eat:              { endpoint: `${BUTLER_URL}/nb/use`, method: "POST" },
    stardew_gift_npc:         { endpoint: `${BUTLER_URL}/nb/gift`, method: "POST" },
    stardew_gift_player:      { endpoint: `${BUTLER_URL}/nb/gift`, method: "POST" },
    stardew_buy:              { endpoint: `${BUTLER_URL}/nb/buy`, method: "POST" },
    stardew_sell:             { endpoint: `${BUTLER_URL}/nb/sell`, method: "POST" },
    stardew_store:            { endpoint: `${BUTLER_URL}/nb/store`, method: "POST" },
    stardew_emote:            { endpoint: `${BUTLER_URL}/nb/emote`, method: "POST" },
  };

  const defs = getStardewTools();
  for (const def of defs) {
    const found = existing.find((t) => t.name === def.name);
    const mapping = endpointMap[def.name];
    if (found) {
      // 旧版本可能仍指向云端 Worker 或带旧鉴权头 → 强制同步为本地 NagiBridge 地址，避免 401
      if (mapping) {
        if (found.endpoint !== mapping.endpoint) found.endpoint = mapping.endpoint;
        if (found.method !== mapping.method) found.method = mapping.method;
        if (mapping.bodyTemplate && found.bodyTemplate !== mapping.bodyTemplate) found.bodyTemplate = mapping.bodyTemplate;
        if (found.headers) {
          found.headers = undefined;
          changed = true;
        }
        changed = true;
      }
      continue;
    }
    const tool = createRestTool(def.name);
    tool.description = def.description;
    tool.parameterSchema = def.parameterSchema;
    tool.enabled = true;
    tool.packageId = undefined; // 星露谷工具独立，不入包，靠 name 前缀按 appId 过滤
    tool.directFetch = true;
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
  // 星露谷使用独立 app 会话（sess_stardew_* + contactId = stardew:角色id），
  // 与主聊天隔离（像小红书/朋友圈那样是独立记录），同时其记录经 stardew 投影写入主聊天短期记忆。
  if (!characterId) return null as any;
  const contactId = `stardew:${characterId}`;
  const sessions = loadChatSessions();
  const existing = sessions.find((s) => isStardewSession(s) && s.contactId === contactId);
  if (existing) return existing;
  const newSession: ChatSession = {
    id: `sess_stardew_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    contactId,
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    isPinned: false,
    bilingualTranslationEnabled: true,
    collapseBilingualTranslation: true,
    visionImagePromptLimit: DEFAULT_VISION_IMAGE_PROMPT_LIMIT,
  };
  saveChatSessions([newSession, ...sessions]);
  return newSession;
}

// ── 云端中转 ──

async function cloudFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BUTLER_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pullGameMessages(): Promise<NagiEntry[]> {
  try {
    // 从本机管家拉取游戏里玩家说的话（管家在 channelServer 收到了存进 inbox）
    const data = await cloudFetch("/inbox");
    if (data.ok && Array.isArray(data.messages)) return data.messages;
    return [];
  } catch (e) {
    console.warn("[NagiBridge] 拉取游戏消息失败:", e);
    return [];
  }
}

async function pushReply(characterId: string, text: string): Promise<void> {
  try {
    // char 的回复经本机管家送进游戏聊天框。sender 用角色的显示名，而不是 id——
    // 否则游戏弹窗会把发送者显示成角色 id 而非名字。
    const name = loadCharacters().find(c => c.id === characterId)?.name || characterId;
    await cloudFetch("/message", {
      method: "POST",
      body: JSON.stringify({ sender: name, text, ts: Date.now() }),
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
  markStardewActivity(); // 玩家有互动，取消自主

  pushChatMessage({
    sessionId: session.id,
    role: "user",
    content: msg.text,
    status: "sent",
  });
  recordStardewMessage(characterId, { role: "user", content: msg.text });

  const history = loadChatMessages(session.id, STARDEW_HISTORY_LIMIT);
  const replyText = await generateStardewReply(session, history);
  if (!replyText) return null;

  const parsedReply = parseStardewReplyForStorage(replyText);
  pushChatMessage({
    sessionId: session.id,
    role: "assistant",
    content: parsedReply.content,
    statusPanel: parsedReply.statusPanel,
    innerMonologue: parsedReply.innerMonologue,
    stateValues: parsedReply.stateValues,
    freshStateValues: parsedReply.freshStateValues,
    status: "sent",
  });
  recordStardewMessage(characterId, { role: "assistant", content: parsedReply.content });

  await pushReply(characterId, parsedReply.content);
  armStardewAutonomy(characterId, session); // 完成后排 1 分钟自主
  return parsedReply.content;
}

/** 读取农工当前状态（位置/时间/金钱/体力/背包/周围），拼成一段文本。 */
async function readStardewStateText(): Promise<string> {
  const lines: string[] = ["【你（农工）当前的状态】"];
  try {
    const state: any = await cloudFetch("/nb/state");
    const info = state?.info ?? state?.player ?? state ?? {};
    if (info.location || info.currentLocation) {
      const loc = info.location ?? info.currentLocation;
      lines.push(`位置：${typeof loc === "string" ? loc : (loc.name ?? JSON.stringify(loc))}`);
    }
    if (info.season) {
      lines.push(`时间：${info.season} 第${info.dayOfMonth ?? info.day ?? "?"}天 ${info.time ?? "?"}`);
    }
    if (typeof info.money === "number") lines.push(`金钱：${info.money}`);
    if (info.stamina != null) lines.push(`体力：${info.stamina}`);
    const inv = Array.isArray(info.inventory) ? info.inventory.map((i: any) => (typeof i === "string" ? i : (i?.name ?? JSON.stringify(i)))).join("、").slice(0, 200) : (Array.isArray(state?.inventory) ? state?.inventory.length : "");
    if (inv) lines.push(`背包：${inv}`);
  } catch { /* 读取失败不阻断注入 */ }
  try {
    const sur: any = await cloudFetch("/nb/surroundings?radius=5");
    const tiles = sur?.tiles ?? sur?.surroundings;
    if (tiles) lines.push(`周围：${JSON.stringify(tiles).slice(0, 220)}`);
  } catch { /* 忽略 */ }
  return lines.length > 1 ? lines.join("\n") : "";
}

// 星露谷操作偏好：整类农活优先一键脚本，尽量别一步步手动操作（更快更少出错）。
const STARDEW_RULE =
  "【游戏操作偏好】凡能用 stardew_run_script(一键脚本) 一次性完成的整类任务，必须优先用它，" +
  "例如 种田farm_row、浇水water_crops、砍树chop_trees、收获harvest、挖矿mine_run、开垦clear_area、" +
  "撸动物pet_animals、酿酒keg_manager、熔炉furnace_manager、钓鱼fish_run、购物shop_buy。" +
  "只有脚本无法完成（如打怪、送礼物、特定剧情交互）时才回退到一步步的 stardew_warp/move_to/use_tool/select_item/press_key 等手工操作。";

/** 把农工当前状态注入到 history 末尾（作为 system 消息），让 char 不必先调 get_state。
 *  注意：星露谷的续写判定已在 chat-engine 按 appId=stardew 关闭，因此 state 可安全追加在末尾。 */
async function injectStardewState(session: any, history: any[]): Promise<any[]> {
  const injected: any[] = [];
  try {
    const stateText = await readStardewStateText();
    if (stateText && session?.id) {
      injected.push({ sessionId: session.id, role: "system", content: stateText, status: "sent" as const });
    }
  } catch (e) {
    console.warn("[NagiBridge] 状态注入失败:", e);
  }
  if (session?.id) {
    injected.push({ sessionId: session.id, role: "system", content: STARDEW_RULE, status: "sent" as const });
  }
  return injected.length ? [...history, ...injected] : history;
}

async function generateStardewReply(session: any, history: any[]): Promise<string | null> {
  stardewGenerating = true;
  try {
    ensureStardewToolsRegistered();
    // 只取最近 STARDEW_HISTORY_LIMIT 条，绝不全量历史（历史可能上万条，全量会崩溃）
    const bounded = history.slice(-STARDEW_HISTORY_LIMIT);
    // 注入农工当前状态作为系统消息，char 开口就知道自己处境，不用先调 get_state
    const enrichedHistory = await injectStardewState(session, bounded);
    const cr = await generateChatCompletion(session, enrichedHistory, {
      appId: STARDEW_APP_ID,
      appTags: ["stardew"],
      // 星露谷不是内置 chat 应用，{{tools}} 宏默认不匹配 tag 会被跳过，
      // 这里强制启用工具，让模型能读到星露谷工具并调用。
      forceEnableTools: true,
    }, {
      // 把 char 的工具调用（正在执行的动作）写成可见系统消息，
      // 星露谷聊天页就能看到"char 正在干什么"。
      onToolNotice: (notice: string) => {
        if (session?.id) {
          pushChatMessage({
            sessionId: session.id,
            role: "system",
            content: notice,
            mediaType: "tool_notice",
            status: "sent",
          });
        }
      },
    });
    if ((cr as any)?.reasoning) stardewReasoning = (cr as any).reasoning;
    const reply = flattenCompletionResult(cr);
    if (!reply && session?.id) {
      pushChatMessage({ sessionId: session.id, role: "system", content: "⚠️ char 返回了空回复", mediaType: "tool_notice", status: "sent" });
    }
    return reply;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[NagiBridge] char 生成回复失败:", e);
    // 把真实报错写到星露谷聊天页，便于定位为什么触发不了回复
    if (session?.id) {
      try {
        pushChatMessage({ sessionId: session.id, role: "system", content: `⚠️ char 回复失败：${msg}`, mediaType: "tool_notice", status: "sent" });
      } catch { /* ignore */ }
    }
    return null;
  } finally {
    stardewGenerating = false;
    // 思维链只供聊天页折叠展示，不写入会话、不参与上下文组装
  }
}

// 剔除星露谷回复里的格式标签：只去掉标签外壳，绝不改动标签内的内容。
// 关键：标签内可能带空格（实测模型输出 [私聊 ]/[/私聊 ]、[状态数值 ]/[/状态数值 ]），
// 所以用 \s* 兼容；并支持成对(...[/xx])与裸([xx]/[/xx])两种形态。
function stripStardewPrivateMarker(text: string): string {
    if (!text) return text;
    return text
        .replace(/\[私聊\s*\]([\s\S]*?)\[\/私聊\s*\]/g, "$1")
        .replace(/\[状态数值\s*\]([\s\S]*?)\[\/状态数值\s*\]/g, "$1")
        .replace(/\[私聊\s*\]/g, "")
        .replace(/\[\/私聊\s*\]/g, "")
        .replace(/\[状态数值\s*\]/g, "")
        .replace(/\[\/状态数值\s*\]/g, "");
}

// 把 char 回复文本解析成「纯可见正文 + 状态栏 + 内心独白 + 状态数值」，与主聊天一致：
// 剥离 [状态栏]...[/状态栏]、[内心]...[/内心]、[私聊] 与 [状态数值] 外壳标签（否则星露谷看到原始标签、渲染出错），
// 同时把 [好感度:X] 等状态值提取出来供状态面板渲染。
// 正文按空行保留多气泡结构，供星露谷聊天页渲染成多个气泡 + 心声卡片。
function parseStardewReplyForStorage(reply: string): {
    content: string; statusPanel?: string; innerMonologue?: string;
    stateValues?: StateValue[]; freshStateValues?: StateValue[];
} {
    const cleaned = stripStardewPrivateMarker(reply);
    const parsed = parseAIResponse(cleaned, []);
    const content = parsed.parts.map(p => p.content).filter(Boolean).join("\n\n");
    return {
        content: content || cleaned,
        statusPanel: parsed.statusPanel || undefined,
        innerMonologue: parsed.innerMonologue || undefined,
        stateValues: parsed.stateValues.length > 0 ? parsed.stateValues : undefined,
        freshStateValues: parsed.freshStateValues.length > 0 ? parsed.freshStateValues : undefined,
    };
}

// 构建「自由活动（自主行动）」预览用的历史：在会话历史末尾追加【自主时间】系统消息与游戏操作偏好(RULE)。
// 供提示词查看器查看星露谷自主活动的真实提示词。不采集实时农工状态（避免预览时请求游戏后端）。
export function buildStardewAutonomyPromptHistory(history: ChatMessage[]): ChatMessage[] {
    const now = new Date().toISOString();
    const seed = `stardew-auto-${Date.now()}`;
    return [
        ...history,
        { id: `${seed}-1`, sessionId: "", role: "system", content: STARDEW_AUTONOMY_PROMPT, status: "sent" as const, createdAt: now },
        { id: `${seed}-2`, sessionId: "", role: "system", content: STARDEW_RULE, status: "sent" as const, createdAt: now },
    ];
}

/** float 星露谷 app 里用户直接对 char 说话：写入会话 → char 生成回复 → 推回游戏。 */
export async function stardewFrontendSay(characterId: string, text: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!characterId || !text) return null;
  const session = getOrCreateStardewSession(characterId);
  markStardewActivity(); // 玩家有互动，取消自主
  pushChatMessage({ sessionId: session.id, role: "user", content: text, status: "sent" });
  recordStardewMessage(characterId, { role: "user", content: text });
  const history = loadChatMessages(session.id, STARDEW_HISTORY_LIMIT);
  const replyText = await generateStardewReply(session, history);
  if (!replyText) return null;
  const parsedReply = parseStardewReplyForStorage(replyText);
  pushChatMessage({ sessionId: session.id, role: "assistant", content: parsedReply.content, statusPanel: parsedReply.statusPanel, innerMonologue: parsedReply.innerMonologue, stateValues: parsedReply.stateValues, freshStateValues: parsedReply.freshStateValues, status: "sent" });
  recordStardewMessage(characterId, { role: "assistant", content: parsedReply.content });
  await pushReply(characterId, parsedReply.content);
  armStardewAutonomy(characterId, session); // 完成后排 1 分钟自主
  return parsedReply.content;
}

/** 手动触发：队列无新消息时，若会话最后一条是 user 消息且还没有 assistant 回复，则强制 char 补一条回复。 */
export async function stardewReplyLatestPending(characterId: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!characterId) return null;
  const session = getOrCreateStardewSession(characterId);
  const history = loadChatMessages(session.id, STARDEW_HISTORY_LIMIT);
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (last.role === "assistant") return null; // 已有回复，无需重复
  const replyText = await generateStardewReply(session, history);
  if (!replyText) return null;
  const parsedReply = parseStardewReplyForStorage(replyText);
  pushChatMessage({ sessionId: session.id, role: "assistant", content: parsedReply.content, statusPanel: parsedReply.statusPanel, innerMonologue: parsedReply.innerMonologue, stateValues: parsedReply.stateValues, freshStateValues: parsedReply.freshStateValues, status: "sent" });
  recordStardewMessage(characterId, { role: "assistant", content: parsedReply.content });
  await pushReply(characterId, parsedReply.content);
  armStardewAutonomy(characterId, session);
  return parsedReply.content;
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
      forceEnableTools: true,
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
