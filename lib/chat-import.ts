// lib/chat-import.ts
// float 聊天记录导入接口：解析「ai-phone-chat-import」导入包（转换脚本产物），
// 写入 float 原生聊天存储，使外部角色聊天记录在 float 中与原生聊天完全一致。
// - 不处理记忆：人设/核心/事实/向量记忆由用户自行生成，复杂记忆走一键迁移
// - 幂等：按消息 id 去重，重复导入同一角色不产生重复记录
// - 目标角色必须在 float 中已存在（用户自行新建角色后选择导入）

import { loadCharacters } from "./character-storage";

export const CHAT_IMPORT_FORMAT = "ai-phone-chat-import";

export type ChatImportMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  mediaType?: ChatMessage["mediaType"];
  mediaData?: ChatMessage["mediaData"];
};

// 动态类型引用（运行时由 import() 拉取，类型层保持准确）
import type { ChatMessage } from "./chat-storage";

export type ChatImportPayload = {
  format: string;
  version: number;
  sourceApp?: string;
  exportedAt?: number;
  character?: { sourceId?: string; name?: string; handle?: string };
  messageCount?: number;
  earliest?: string | null;
  latest?: string | null;
  messages: ChatImportMessage[];
};

/** 解析并校验导入包文本。 */
export function parseChatImportPayload(
  raw: string,
): { ok: true; payload: ChatImportPayload } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { ok: false, error: "JSON 解析失败，请确认选择的是转换脚本输出的导入包文件" };
  }
  if (!obj || typeof obj !== "object") return { ok: false, error: "导入包格式错误" };
  const p = obj as ChatImportPayload;
  if (p.format !== CHAT_IMPORT_FORMAT) {
    return {
      ok: false,
      error: `不是 float 聊天导入包（format=${p.format ?? "未知"}）。请先用转换脚本（tools/convert-roche-backup.js）转换备份文件`,
    };
  }
  if (p.version !== 1) return { ok: false, error: `不支持的导入包版本（version=${p.version}）` };
  if (!Array.isArray(p.messages) || p.messages.length === 0) {
    return { ok: false, error: "导入包内没有消息记录" };
  }
  return { ok: true, payload: p };
}

/**
 * 将导入包写入指定角色（float 原生聊天存储）。
 * 目标角色必须已存在（用户在 float 中新建）；会话不存在时自动创建（createOrGetSession）。
 */
export async function importChatHistory(
  characterId: string,
  payload: ChatImportPayload,
): Promise<{ success: boolean; error?: string; imported?: number; skipped?: number; total?: number }> {
  const chars = loadCharacters();
  const char = chars.find((c) => c.id === characterId);
  if (!char) {
    return { success: false, error: "目标角色不存在，请先在 float 中新建该角色再导入" };
  }

  // 运行时动态导入存储模块：强制取当前构建产物，并做类型守卫。
  // 规避浏览器/服务器缓存了「不含 importChatMessages 的旧 chunk」导致的 (0, ty.xx) 原生报错。
  const storage = await import("./chat-storage");
  const { createOrGetSession, importChatMessages } = storage;
  if (typeof createOrGetSession !== "function" || typeof importChatMessages !== "function") {
    const miss = [
      typeof createOrGetSession !== "function" ? "createOrGetSession" : "",
      typeof importChatMessages !== "function" ? "importChatMessages" : "",
    ].filter(Boolean).join("、");
    return {
      success: false,
      error: `导入逻辑未完整加载（缺：${miss}），大概率是页面加载的是旧构建。请强制刷新（Ctrl/Cmd+Shift+R）后重试；若仍失败请确认线上已是最新部署`,
    };
  }

  const session = createOrGetSession(characterId);
  // 仅接受 user / assistant 消息（system/tool 等不迁移），空内容/无时间戳由 importChatMessages 过滤
  const msgs = payload.messages.filter(
    (m): m is ChatImportMessage => m.role === "user" || m.role === "assistant",
  );
  const res = importChatMessages(session.id, msgs);

  return { success: true, imported: res.imported, skipped: res.skipped, total: msgs.length };
}
