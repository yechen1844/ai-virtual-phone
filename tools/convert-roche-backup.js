#!/usr/bin/env node
/**
 * Roche/Noir 聊天备份 → float 聊天导入包 转换脚本
 *
 * 用法:
 *   node tools/convert-roche-backup.js <备份.json> [输出.json]
 *
 * 说明:
 *   - 输入: Roche/Noir 应用的完整备份导出 JSON（含 conversation / messages / personas 等顶层键）
 *   - 输出: float 聊天导入包 JSON（format = "ai-phone-chat-import", version 1）
 *   - 只关心聊天记录: 消息按时间正序转成 float 原生 ChatMessage 形状
 *     (role: user/assistant, content, createdAt, status: sent)
 *   - 媒体类消息(sticker/pat/voice/video_call_notice/innerVoice/spoiler)统一文本化,
 *     保证在 float 里 100% 原生渲染(资产文件无法迁移, 文本内容完整保留)
 *   - 消息 id 保留原始值, 导入接口按 id 幂等去重(重复导入不产生重复记录)
 *
 * 校验报告打印到 stderr, 转换结果写入输出文件(默认 <输入名>.float-chat.json)。
 */

const fs = require("fs");
const path = require("path");

// ── 消息类型 → 文本化内容（原 text 为空时的兜底，避免丢消息） ──
function normalizeContent(m) {
  const raw = typeof m.text === "string" ? m.text.trim() : "";
  if (raw) return raw;
  // 空文本兜底：pat / 占位
  switch (m.type) {
    case "pat": {
      const action = m.patAction || "拍了拍";
      return `[${action}]`;
    }
    default:
      return "[消息]";
  }
}

// 每条消息 → float ChatMessage 形状（sessionId 由导入接口按目标角色补全）
function convertMessage(m, index) {
  const ts = Number(m.timestamp);
  const createdAt = Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
  return {
    id: typeof m.id === "string" && m.id ? m.id : `import_${index}_${Date.now()}`,
    role: m.isMe === true ? "user" : "assistant",
    content: normalizeContent(m),
    ...(createdAt ? { createdAt } : {}),
  };
}

function main() {
  const input = process.argv[2];
  const output = process.argv[3] || input.replace(/\.json$/i, "") + ".float-chat.json";
  if (!input) {
    console.error("用法: node tools/convert-roche-backup.js <备份.json> [输出.json]");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(input, "utf8"));
  const conv = data.conversation || {};
  const msgs = Array.isArray(data.messages) ? data.messages : [];

  // 1) 时间正序排序（备份通常已正序，兜底排序保证顺序正确）
  const sorted = msgs
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = Number(a.m.timestamp) || 0;
      const tb = Number(b.m.timestamp) || 0;
      return ta !== tb ? ta - tb : a.i - b.i;
    })
    .map((x) => x.m);

  // 2) 转换
  const converted = sorted.map((m, i) => convertMessage(m, i));
  const withTime = converted.filter((c) => c.createdAt);
  const noTime = converted.filter((c) => !c.createdAt);

  // 3) 组装导入包
  const pkg = {
    format: "ai-phone-chat-import",
    version: 1,
    sourceApp: data._app || "Roche/Noir",
    exportedAt: typeof data._exportedAt === "number" ? data._exportedAt : Date.now(),
    character: {
      sourceId: conv.id || "",
      name: conv.name || "",
      handle: conv.handle || "",
    },
    messageCount: converted.length,
    earliest: withTime.length ? withTime[0].createdAt : null,
    latest: withTime.length ? withTime[withTime.length - 1].createdAt : null,
    messages: converted,
  };

  fs.writeFileSync(output, JSON.stringify(pkg, null, 2), "utf8");

  // 4) 校验报告（stderr）
  const roles = {};
  for (const c of converted) roles[c.role] = (roles[c.role] || 0) + 1;
  const emptyContent = converted.filter((c) => !c.content || c.content === "[消息]").length;
  const typeCount = {};
  for (const m of sorted) typeCount[m.type || "text"] = (typeCount[m.type || "text"] || 0) + 1;
  const uniqueIds = new Set(converted.map((c) => c.id));
  const dupIds = converted.length - uniqueIds.size;

  console.error("── 转换校验报告 ──");
  console.error(`输入: ${path.basename(input)}`);
  console.error(`角色: ${pkg.character.name} (${pkg.character.handle || pkg.character.sourceId})`);
  console.error(`消息总数: ${pkg.messageCount}`);
  console.error(`user(我): ${roles.user || 0} / assistant(角色): ${roles.assistant || 0}`);
  console.error(`时间范围: ${pkg.earliest} → ${pkg.latest}`);
  console.error(`无时间戳消息: ${noTime.length}`);
  console.error(`空/占位内容消息: ${emptyContent}`);
  console.error(`重复 id: ${dupIds}`);
  console.error(`类型分布: ${JSON.stringify(typeCount)}`);
  console.error(`输出: ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(2)} MB)`);
  if (dupIds > 0) console.error("⚠ 存在重复 id，导入接口将按 id 幂等去重");
  if (noTime.length > 0) console.error("⚠ 存在无时间戳消息，导入后排序可能异常，请检查");
  console.error("── 转换完成 ──");
}

main();
