// lib/sync-runtime/engine.ts
// 星露谷 + 主聊天 PC↔手机「实时同步」引擎。
//
// 角色（由 user 在星露谷 app 里手动选择）：
//   play   = 游玩端（生成中枢）：轮到回复请求 -> 用 char 大脑生成回复(含工具)，写下游 fanout。
//   remote = 遥控端（只读+转发）：把 user 消息 与「回复」按钮请求写上游；拉取游玩端 fanout 显示。
//
// 云布局（都在 ai-phone-backup 桶的 sync/ 前缀下，已用 RL 策略放行 anon 读写）：
//   sync/upsert/user/<sessionId>/<nonce>.json        遥控端发来的 user 消息
//   sync/upsert/reply-request/<sessionId>/<nonce>.json 遥控端按「回复」按钮发的生成请求
//   sync/fanout/<sessionId>/<msgId>.json             游玩端所有下游消息（char回复/notice/自由活动/主聊天）

import { loadSyncConfig, saveSyncConfig, type StardewSyncConfig } from "./config";
import { writeSyncObject, listSyncObjects, readSyncObject } from "./cloud";
import { pushChatMessage, loadChatMessages, deleteChatMessage, CHAT_MESSAGE_PUSHED_EVENT, CHAT_MESSAGES_DELETED_EVENT, type ChatMessage } from "../chat-storage";
import { stardewReplyLatestPending } from "../nagi-bridge";

export type SyncedUserMessage = {
  sessionId: string;
  characterId: string; // 用于游玩端定位星露谷会话/角色
  role: "user";
  content: string;
  createdAt: string;
  source: "remote";
};

export type SyncedReplyRequest = {
  sessionId: string;
  characterId: string;
  createdAt: string;
  source: "remote";
};

export type SyncedFanoutMessage = {
  sessionId: string;
  messageId: string;   // 本地 ChatMessage.id，用于幂等 upsert
  role: "user" | "assistant" | "system";
  content: string;
  mediaType?: string;
  mediaData?: unknown;
  statusPanel?: string;
  innerMonologue?: string;
  createdAt: string;
  source: "play";
};

export type SyncedDelete = {
  sessionId: string;
  messageIds: string[]; // 被删除的 ChatMessage.id 列表
  createdAt: string;
  source: "play" | "remote";
};

const USER_PREFIX = "upsert/user";
const REQ_PREFIX = "upsert/reply-request";
const FANOUT_SESSION_PREFIX = "fanout/session"; // 实际按会话分目录
const DELETES_PREFIX = "deletes/session";

/**
 * 拉取落库期间抑制 fanout 发布器的开关：
 * 当一端从云端把"另一端发来的消息"落库时，这些 pushChatMessage 会触发本端发布器，
 * 若不抑制会把"别人发来的消息"再写回 fanout，另一端又拉回来 → 无限循环 / 重复复制。
 * 只有"本机真实产生的消息"才允许发布到 fanout。
 */
let suppressFanoutPublish = false;

async function withSuppressedFanout<T>(run: () => Promise<T>): Promise<T> {
  const prev = suppressFanoutPublish;
  suppressFanoutPublish = true;
  try {
    return await run();
  } finally {
    suppressFanoutPublish = prev;
  }
}

function localNonce(): string {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 遥控端：把 user 消息写入云端（仅同步，不触发生成）。 */
export async function remoteSendUser(cfg: StardewSyncConfig, sessionId: string, characterId: string, content: string): Promise<void> {
  const data: SyncedUserMessage = {
    sessionId, characterId, role: "user", content, createdAt: new Date().toISOString(), source: "remote",
  };
  await writeSyncObject(cfg, `${USER_PREFIX}/${sessionId}`, localNonce(), data);
}

/** 遥控端：按「回复」按钮时，请求游玩端对已同步的 user 消息生成回复。 */
export async function remoteRequestReply(cfg: StardewSyncConfig, sessionId: string, characterId: string): Promise<void> {
  const data: SyncedReplyRequest = {
    sessionId, characterId, createdAt: new Date().toISOString(), source: "remote",
  };
  await writeSyncObject(cfg, `${REQ_PREFIX}/${sessionId}`, localNonce(), data);
}

async function listFresh(cfg: StardewSyncConfig, prefix: string, after: string): Promise<{ name: string; ts: string; path: string }[]> {
  const objs = await listSyncObjects(cfg, prefix);
  // 只取时间戳严格晚于水位的新对象（避免重复/重扫）
  return objs
    .filter(o => !after || o.ts > after)
    .map(o => ({ name: o.name, ts: o.ts, path: o.path }))
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** 把「某类按会话分桶的前缀」解析成实际要扫的 prefix 列表。sessionId 为空 = 扫描该目录下所有会话子目录。 */
async function resolveSessionPrefixes(cfg: StardewSyncConfig, basePrefix: string, sessionId?: string): Promise<string[]> {
  if (sessionId) return [`${basePrefix}/${sessionId}`];
  // 全量：列 basePrefix/ 下的子目录（每个就是一个会话前缀）
  const dirs = await listSyncObjects(cfg, `${basePrefix}/`);
  const seen = new Set<string>();
  const prefixes: string[] = [];
  for (const d of dirs) {
    // listSyncObjects 返回的对象名可能含子路径；取第一段作为会话前缀
    const seg = d.name.split("/")[0];
    if (!seg || seen.has(seg)) continue;
    seen.add(seg);
    prefixes.push(`${basePrefix}/${seg}`);
  }
  return prefixes;
}

/** 遥控端：拉取游玩端的下游消息并幂等显示。返回本次新增条数。sessionId 为空 = 全量扫描。 */
export async function remotePullFanout(cfg: StardewSyncConfig, sessionId?: string): Promise<number> {
  const read = await readSyncObject<{ lastSyncedAt: string }>(cfg, "sync/state/remote.lock");
  let water = read?.lastSyncedAt ?? cfg.lastSyncedAt;
  let inserted = 0;

  const prefixes = await resolveSessionPrefixes(cfg, FANOUT_SESSION_PREFIX, sessionId);
  for (const prefix of prefixes) {
    const fresh = await listFresh(cfg, prefix, water);
    for (const obj of fresh) {
      const msg = await readSyncObject<SyncedFanoutMessage>(cfg, obj.path);
      if (!msg || !msg.messageId) continue;
      const local = loadChatMessages(msg.sessionId).find(m => m.id === msg.messageId);
      if (local) continue;
      // 拉取落库期间抑制发布器：这些是"别人发来的消息"，不能回写 fanout。
      await withSuppressedFanout(async () => {
        pushChatMessage({
          sessionId: msg.sessionId, role: msg.role as any, content: msg.content,
          mediaType: msg.mediaType as any, mediaData: msg.mediaData as any,
          statusPanel: msg.statusPanel, innerMonologue: msg.innerMonologue,
          status: "sent", createdAt: msg.createdAt,
        });
      });
      inserted += 1;
      if (obj.ts > water) water = obj.ts;
    }
  }
  if (inserted > 0) {
    saveSyncConfig({ ...cfg, lastSyncedAt: water });
    await writeSyncObject(cfg, "state/remote", "lock", { lastSyncedAt: water });
  }
  return inserted;
}

/** 游玩端：拉取购买端 user 消息（落库，不生成）。sessionId 为空 = 全量扫描。 */
export async function playPullUsers(cfg: StardewSyncConfig, sessionId?: string): Promise<number> {
  let inserted = 0;
  const seen = new Set<string>();
  const prefixes = await resolveSessionPrefixes(cfg, USER_PREFIX, sessionId);
  for (const prefix of prefixes) {
    const fresh = await listFresh(cfg, prefix, cfg.lastSyncedAt);
    for (const obj of fresh) {
      const u = await readSyncObject<SyncedUserMessage>(cfg, obj.path);
      if (!u || !u.content) continue;
      const nonce = `${u.createdAt}-${u.content}`;
      if (seen.has(nonce)) continue;
      seen.add(nonce);
      // 拉取落库期间抑制发布器：遥控端发来的 user 不能回写 fanout（否则遥控端再拉回 → 循环）。
      await withSuppressedFanout(async () => {
        pushChatMessage({ sessionId: u.sessionId, role: "user", content: u.content, status: "sent", createdAt: u.createdAt });
      });
      inserted += 1;
    }
  }
  return inserted;
}

/** 游玩端：拉取 reply-request，若 role=play 则调用星露谷回复生成(含工具)。返回本次触发生成数。 */
export async function playHandleReplyRequests(cfg: StardewSyncConfig): Promise<number> {
  if (cfg.role !== "play") return 0;
  // 列出所有 reply-request
  const reqDirs = await listSyncObjects(cfg, REQ_PREFIX);
  let handled = 0;
  // 用「已处理请求」水位：仅处理 name 里带 nonce 且之前未处理过的
  const doneKey = `sync/state/play.done`;
  const done = await readSyncObject<string[]>(cfg, doneKey).catch(() => null) ?? [];
  const doneSet = new Set(done);
  for (const dir of reqDirs) {
    const reqs = await listSyncObjects(cfg, `${REQ_PREFIX}/${dir.name}`);
    for (const r of reqs) {
      if (doneSet.has(r.name)) continue;
      const req = await readSyncObject<SyncedReplyRequest>(cfg, r.path);
      if (!req || !req.characterId) continue;
      if (doneSet.has(req.characterId)) continue;
      doneSet.add(req.characterId);
      handled += 1;
      // 游玩端只对「最后一条是 user 且尚未回复」的消息生成回复（含工具）。
      // 遥控端发消息只同步、不生成；必须遥控端按「回复」才走到这里触发游玩端生成。
      await stardewReplyLatestPending(req.characterId);
      // 已处理标记持久化
      await writeSyncObject(cfg, "state/play", "done", Array.from(doneSet));
    }
  }
  return handled;
}

/**
 * 游玩端 fanout 发布器：订阅本机新消息事件，把「星露谷/主聊天会话」的新消息写成云端下游 fanout，
 * 供遥控端短轮询拉取显示。返回一个可调用的停止函数。
 * 只在 role=play 且同步开启时挂载；其余情形返回空停止函数（不做事）。
 */
export function attachPlayFanoutPublisher(cfg: StardewSyncConfig): () => void {
  if (cfg.role !== "play" || !cfg.enabled || typeof window === "undefined") return () => undefined;

  const onMessage = (e: Event) => {
    const msg = (e as CustomEvent).detail?.message as ChatMessage | undefined;
    if (!msg || !msg.sessionId) return;
    // 拉取落库期间不发布：把"从云端拉来的消息"再写回 fanout 会造成循环/重复。
    if (suppressFanoutPublish) return;
    // 只转发星露谷会话 + 非群主聊天会话；其它（群聊/朋友圈等）不同步
    const isStardew = msg.sessionId.startsWith("sess_stardew_");
    const isMainChat = !msg.sessionId.startsWith("sess_stardew_") && !msg.sessionId.startsWith("sess_group_");
    if (!isStardew && !isMainChat) return;
    // user / assistant / system 都发布：三路来源（遥控端发、游玩端发、游戏里发）都要同步到对面。
    // 但"从云端拉取落库"的不会走到这里（上方已 suppress），因此不会有 user 回写循环。

    const data: SyncedFanoutMessage = {
      sessionId: msg.sessionId,
      messageId: msg.id,
      role: msg.role as any,
      content: msg.content,
      mediaType: msg.mediaType as any,
      mediaData: msg.mediaData as any,
      statusPanel: msg.statusPanel,
      innerMonologue: msg.innerMonologue,
      createdAt: msg.createdAt,
      source: "play",
    };
    writeSyncObject(cfg, `fanout/session/${msg.sessionId}`, msg.id, data)
      .catch((err) => console.warn("[SyncPlay] fanout 写失败:", err));
  };

  window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, onMessage);
  return () => window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, onMessage);
}

async function uploadDelete(cfg: StardewSyncConfig, sessionId: string, messageIds: string[], source: "play" | "remote"): Promise<void> {
  if (messageIds.length === 0) return;
  const data: SyncedDelete = {
    sessionId, messageIds, createdAt: new Date().toISOString(), source,
  };
  await writeSyncObject(cfg, `${DELETES_PREFIX}/${sessionId}`, localNonce(), data);
}

/**
 * 游玩端/遥控端 删除发布器：订阅本机「消息被删除」事件，把星露谷/主聊天会话里的删除写成云端，
 * 供另一端拉取并同步删除。返回停止函数。仅在同步开启且二者 role 均可（删除双向）时挂载。
 */
export function attachDeletePublisher(cfg: StardewSyncConfig): () => void {
  if (!cfg.enabled || typeof window === "undefined") return () => undefined;

  const onDelete = (e: Event) => {
    const msgs = (e as CustomEvent).detail?.messages as ChatMessage[] | undefined;
    if (!msgs || msgs.length === 0) return;
    const first = msgs[0];
    if (!first?.sessionId) return;
    const isStardew = first.sessionId.startsWith("sess_stardew_");
    const isMainChat = !first.sessionId.startsWith("sess_stardew_") && !first.sessionId.startsWith("sess_group_");
    if (!isStardew && !isMainChat) return;
    // 避免把「另一端同步删除」再回传造成循环：仅当这些消息先前由本端发过 fanout 才需要同步，
    // 简化处理：直接上传删除，靠幂等(目标 id 已在另一端删掉则跳过)避免重复。
    uploadDelete(cfg, first.sessionId, msgs.map(m => m.id), cfg.role === "play" ? "play" : "remote")
      .catch((err) => console.warn("[SyncDelete] 上传删除失败:", err));
  };

  window.addEventListener(CHAT_MESSAGES_DELETED_EVENT, onDelete);
  return () => window.removeEventListener(CHAT_MESSAGES_DELETED_EVENT, onDelete);
}

/**
 * 应用到一端（遥控端或游玩端）：拉取云端 deletes，把目标消息在本端删除。
 * 幂等：目标消息已不存在则跳过。返回本次实际删除条数。
 */
export async function applyRemoteDeletes(cfg: StardewSyncConfig, sessionId?: string): Promise<number> {
  const prefixes = await resolveSessionPrefixes(cfg, DELETES_PREFIX, sessionId);
  let removed = 0;
  const seen = new Set<string>();
  for (const prefix of prefixes) {
    const fresh = await listSyncObjects(cfg, prefix);
    for (const obj of fresh) {
      if (seen.has(obj.name)) continue;
      seen.add(obj.name);
      const del = await readSyncObject<SyncedDelete>(cfg, obj.path);
      if (!del || !del.messageIds?.length) continue;
      for (const id of del.messageIds) {
        const exists = loadChatMessages(del.sessionId).some(m => m.id === id);
        if (!exists) continue;
        try {
          deleteChatMessage(id);
          removed += 1;
        } catch { /* 并发/已删，忽略 */ }
      }
    }
  }
  return removed > 0 ? removed : 0;
}