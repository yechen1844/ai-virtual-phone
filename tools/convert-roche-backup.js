#!/usr/bin/env node
/**
 * Roche/Noir 聊天备份 → float 聊天导入包 转换脚本
 *
 * 用法:
 *   node tools/convert-roche-backup.js <备份.json> [输出.json]
 *
 * 输出: float 聊天导入包 JSON（format = "ai-phone-chat-import", version 1）
 *
 * 转换要点:
 *   - 只关心聊天记录：消息按时间正序转成 float 原生 ChatMessage 形状
 *     (role: user/assistant, content, createdAt, status: sent)
 *   - 【翻译】Roche 用 「原文『翻译：译文』」内嵌标记；float 原生用 「原文|译文」竖线分隔，
 *     且译文须含中文才识别为双语。这里把 Roche 标记统一转成 float 的 原文|译文 格式。
 *   - 【富文本清洗】Roche 虚拟形象动作码 <vi s="0" v="1" d="5"/> 等 xml 标签不属于对话内容，
 *     从原文/正文中剔除（否则会污染喂给模型的内容）。
 *   - 【媒体文本化】备份不含实际媒体文件（无 mediaUrl/imageUrl/voiceUrl），
 *     voice / sticker / pat / innerVoice / spoiler / video_call_notice 统一文本化并带类型标记，
 *     确保内容完整、可辨识、且不会被 float 误渲染成缺失资源的特殊气泡。
 *   - 消息 id 保留原始值，导入接口按 id 幂等去重(重复导入不产生重复记录)。
 *
 * 校验报告打印到 stderr，转换结果写入输出文件(默认 <输入名>.float-chat.json)。
 */

const fs = require("fs");
const path = require("path");

// ── Roche 虚拟形象动作码 / xml 标签清洗（不属于对话内容） ──
function cleanRocheTags(text) {
  return String(text ?? "")
    .replace(/<vi\b[^>]*?\/?>/gi, " ")   // Roche 动作码，替换为空格
    .replace(/<[^>]+>/g, " ")            // 其余 xml 标签兜底
    .replace(/[ \t]+/g, " ")            // 折叠连续空格/制表符为单空格
    .trim();
}

// ── 解析 Roche 双语：「原文『翻译：译文』」 ──
function parseRocheBilingual(text) {
  const m = String(text).match(/^(.*?)『\s*翻译\s*[：:]\s*(.*?)』\s*$/s);
  if (!m) return null;
  const original = cleanRocheTags(m[1]).replace(/\s+/g, " ").trim();
  const translated = m[2].trim();
  if (!original || !translated) return null;
  // 与 float splitBilingualText 一致：译文必须含中文，否则视为不是双语
  if (!/[\u3400-\u9fff]/.test(translated)) return null;
  return { original, translated };
}

// ── 消息 → float 原生 content（含翻译转换 + 媒体文本化 + 富文本清洗） ──
function buildFloatContent(m) {
  const type = m.type || "text";
  const raw = typeof m.text === "string" ? m.text : "";

  // 1) 翻译：text / voice 且含 『翻译：…』 标记 → 原文|译文
  if (type === "text" || type === "voice") {
    const bilingual = parseRocheBilingual(raw);
    if (bilingual) return `${bilingual.original}|${bilingual.translated}`;
  }

  // 2) 媒体文本化（无实际媒体文件，统一文本化 + 类型标记）
  switch (type) {
    case "voice":
      return `[语音] ${cleanRocheTags(raw).replace(/\n+/g, " ")}`;
    case "sticker": {
      // 原始形如 [表情:月薪喵摸鱼中]，剥离外层，取名字
      const label = (raw.match(/^[\[【]\s*表情\s*[:：]\s*(.*?)[\]】]\s*$/) || [])[1] || raw;
      return `[表情] ${label.trim()}`;
    }
    case "pat": {
      const action = m.patAction && m.patAction.trim() ? m.patAction : "拍了拍";
      const target = m.patTarget && m.patTarget.trim() ? m.patTarget : "";
      return target ? `[${action}] ${target}` : `[${action}]`;
    }
    case "innerVoice":
      return `[内心]\n${cleanRocheTags(raw)}`;
    case "spoiler":
      return `[画面描述] ${cleanRocheTags(raw)}`;
    case "video_call_notice":
      return cleanRocheTags(raw);
    default:
      // text / 其它：清洗富文本后保留原文
      return cleanRocheTags(raw);
  }
}

// 每条消息 → float ChatMessage 形状（sessionId 由导入接口按目标角色补全）
function convertMessage(m, index) {
  const ts = Number(m.timestamp);
  const createdAt = Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null;
  return {
    id: typeof m.id === "string" && m.id ? m.id : `import_${index}_${Date.now()}`,
    role: m.isMe === true ? "user" : "assistant",
    content: buildFloatContent(m),
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
  // 翻译统计：转换后 content 命中 原文|译文 的条数
  let bilingualCount = 0;
  for (const c of converted) {
    if (typeof c.content === "string" && /\|/.test(c.content)) bilingualCount += 1;
  }
  // media 标记统计
  const mediaMark = { voice: 0, sticker: 0, pat: 0, inner: 0, picture: 0 };
  for (const c of converted) {
    if (typeof c.content !== "string") continue;
    if (c.content.startsWith("[语音]")) mediaMark.voice += 1;
    else if (c.content.startsWith("[表情]")) mediaMark.sticker += 1;
    else if (c.content.startsWith("[拍了拍]") || /^\[[^\]]*拍了拍/.test(c.content)) mediaMark.pat += 1;
    else if (c.content.startsWith("[内心]")) mediaMark.inner += 1;
    else if (c.content.startsWith("[画面描述]")) mediaMark.picture += 1;
  }

  console.error("── 转换校验报告 ──");
  console.error(`输入: ${path.basename(input)}`);
  console.error(`角色: ${pkg.character.name} (${pkg.character.handle || pkg.character.sourceId})`);
  console.error(`消息总数: ${pkg.messageCount}`);
  console.error(`user(我): ${roles.user || 0} / assistant(角色): ${roles.assistant || 0}`);
  console.error(`时间范围: ${pkg.earliest} → ${pkg.latest}`);
  console.error(`双语(原文|译文)条数: ${bilingualCount}`);
  console.error(`媒体文本化: 语音${mediaMark.voice} · 表情${mediaMark.sticker} · 拍一拍${mediaMark.pat} · 内心${mediaMark.inner} · 画面${mediaMark.picture}`);
  console.error(`无时间戳消息: ${noTime.length}`);
  console.error(`空/占位内容消息: ${emptyContent}`);
  console.error(`重复 id: ${dupIds}`);
  console.error(`类型分布: ${JSON.stringify(typeCount)}`);
  console.error(`输出: ${output} (${(fs.statSync(output).size / 1024 / 1024).toFixed(2)} MB)`);
  if (dupIds > 0) console.error("⚠ 存在重复 id，导入接口将按 id 幂等去重");
  if (noTime.length > 0) console.error("⚠ 存在无时间戳消息，导入后排序可能异常，请检查");
  if (emptyContent > 0) console.error("⚠ 存在空内容消息，请检查源备份");
  console.error("── 转换完成 ──");
}

main();
