// lib/nagi-bridge.ts
// 星露谷联动信箱：把游戏里玩家说的话写成普通聊天消息，让 char 用原版人设+记忆回复，再把回复推回云端。
//
// 设计原则：
// 1. 完全复用 float 现有机制（pushChatMessage / generateChatCompletion / createOrGetSession），
//    不修改 char 的人设、预设、世界书、记忆体系。
// 2. 手机端 float 页面运行时，自动轮询云端 Worker 拉取游戏消息；拉到后写入 char 聊天记录，
//    触发 char 生成回复，回复再推回云端，由电脑端管家送进游戏聊天框。
// 3. 云端地址与密钥可配置，部署时通过环境变量 NAGI_CLOUD_URL / NAGI_CLOUD_KEY 覆盖。

import { addChatContact, createOrGetSession, loadChatMessages, pushChatMessage } from "./chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "./chat-engine";
import { loadCharacters } from "./character-storage";

const CLOUD_URL = process.env.NEXT_PUBLIC_NAGI_CLOUD_URL || "https://nagi-bridge.luyi90720.workers.dev";
const CLOUD_KEY = process.env.NEXT_PUBLIC_NAGI_CLOUD_KEY || "nagi_bridge_2026";
const POLL_MS = Number(process.env.NEXT_PUBLIC_NAGI_POLL_MS || 2000);

type NagiEntry = { sender: string; text: string; ts?: string };

let pollingStarted = false;

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
 * 处理一条来自游戏的消息：写入 char 聊天记录 → 触发 char 生成回复 → 回复推回云端。
 * @param characterId 要绑定的 char 的 characterId（在星露谷设置里选择）
 */
export async function ingestNagiGameMessage(characterId: string, msg: NagiEntry): Promise<string | null> {
  if (typeof window === "undefined") return null;
  if (!characterId) {
    console.warn("[NagiBridge] 未绑定角色，跳过游戏消息:", msg.text);
    return null;
  }

  let session;
  try {
    // 确保联系人存在，然后拿/建会话
    addChatContact(characterId);
    session = createOrGetSession(characterId);
  } catch (e) {
    console.warn("[NagiBridge] 初始化会话失败:", e);
    return null;
  }

  // 1. 把玩家在游戏里的话写入聊天记录（复用现有入库，触发记忆/会话更新）
  const userMsg = pushChatMessage({
    sessionId: session.id,
    role: "user",
    content: msg.text,
    status: "sent",
  });
  if (!userMsg) return null;

  // 2. 触发 char 生成回复
  const history = loadChatMessages(session.id);
  const replyText = await generateNagiReply(session, history);
  if (!replyText) return null;

  // 3. 把 char 的回复写回聊天记录
  pushChatMessage({
    sessionId: session.id,
    role: "assistant",
    content: replyText,
    status: "sent",
  });

  // 4. 推回云端，让管家送进游戏聊天框
  await pushReply(characterId, replyText);
  return replyText;
}

async function generateNagiReply(session: any, history: any[]): Promise<string | null> {
  try {
    const cr = await generateChatCompletion(session, history, {
      appTags: ["chat"],
    });
    return flattenCompletionResult(cr);
  } catch (e) {
    console.warn("[NagiBridge] char 生成回复失败:", e);
    return null;
  }
}

/**
 * 从云端拉取消息并逐条处理。返回处理条数。
 */
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

/**
 * 启动轮询：只要 float 页面开着，就周期性地从云端拉取游戏消息并让 char 回复。
 * @param characterId 要绑定的 char 的 characterId
 */
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

/** 停止轮询（在页面卸载或切换绑定角色时调用） */
export function stopNagiPolling(): void {
  pollingStarted = false;
}

/** 供 UI 设置页读取可绑定的角色列表 */
export function listBindableCharacters(): { id: string; name: string }[] {
  if (typeof window === "undefined") return [];
  try {
    return loadCharacters().map((c: any) => ({ id: c.id, name: c.name || c.id }));
  } catch {
    return [];
  }
}
