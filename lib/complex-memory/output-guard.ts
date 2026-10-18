// lib/complex-memory/output-guard.ts
// 复杂记忆系统 · 生成结果「门卫」：所有记忆总结链路共用的输出质量校验。
// 校验不通过时调用方必须拒绝入库，并计入失败/重试。

export type SummaryOutputKind = "event" | "daily" | "period" | "core" | "float";

export type SummaryOutputValidation =
  | { ok: true; text: string; json?: unknown }
  | { ok: false; reason: string };

/** 去掉空白与标点后是否还剩正文内容。 */
function hasBody(text: string): boolean {
  return text.replace(/[\s\p{P}]/gu, "").length > 0;
}

function extractCoreEntryTexts(json: unknown): string[] {
  const arr = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { entries?: unknown[] }).entries)
      ? (json as { entries: unknown[] }).entries
      : null;
  if (!arr) return [];
  return arr
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const text = (item as Record<string, unknown>).text;
      return typeof text === "string" ? text.trim() : "";
    })
    .filter(Boolean);
}

/**
 * 校验模型输出是否可以写入记忆库。
 *
 * 检查项：截断 / 纯思维链 / 空内容或无正文 / 非 JSON / JSON 不完整。
 * @param raw 模型返回的原始正文
 * @param kind 记忆类型（决定是否要求 JSON、正文取哪个字段）
 * @param opts 调用方可覆盖的检查项
 */
export function validateSummaryOutput(
  raw: string | null | undefined,
  kind: SummaryOutputKind,
  opts?: {
    /** 是否要求 JSON。默认除 float 外都要求。 */
    requireJson?: boolean;
    /** 调用方已知正文实际上来自 reasoning_content 回退。 */
    fromReasoning?: boolean;
    /** 调用方已知输出因长度上限被截断。 */
    wasTruncated?: boolean;
  },
): SummaryOutputValidation {
  if (opts?.wasTruncated) {
    return { ok: false, reason: "输出被截断（未写完），已拒绝入库" };
  }
  if (opts?.fromReasoning) {
    return { ok: false, reason: "只拿到思维链（reasoning_content），没有正文，已拒绝入库" };
  }

  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "模型返回空内容" };

  // 代码围栏未闭合 = 典型截断。
  const fences = text.match(/```/g);
  if (fences && fences.length % 2 === 1) {
    return { ok: false, reason: "代码围栏未闭合（疑似截断），已拒绝入库" };
  }
  // 明显以逗号/冒号结尾 = 话没说完。
  if (/[,:，：、]\s*$/.test(text)) {
    return { ok: false, reason: "输出以逗号/冒号结尾（疑似截断），已拒绝入库" };
  }

  const requireJson = opts?.requireJson ?? kind !== "float";

  if (!requireJson) {
    if (!hasBody(text)) {
      return { ok: false, reason: "正文为空（只有空白/标点），已拒绝入库" };
    }
    return { ok: true, text };
  }

  // JSON 结构检查：按类型确定起止符号。
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  let start = -1;
  let closeChar = "}";
  if (kind === "core") {
    // 核心记忆允许裸数组 [{...}] 或对象 { entries: [...] }。
    if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
      start = arrayStart;
      closeChar = "]";
    } else if (objectStart >= 0) {
      start = objectStart;
    }
  } else if (objectStart >= 0) {
    start = objectStart;
  }

  if (start < 0) {
    return { ok: false, reason: "模型没有输出 JSON（该类型要求 JSON），已拒绝入库" };
  }
  const end = text.lastIndexOf(closeChar);
  if (end <= start) {
    return { ok: false, reason: "JSON 不完整（缺少闭合符号，疑似截断），已拒绝入库" };
  }

  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "JSON 解析失败，已拒绝入库" };
  }

  let body = "";
  if (kind === "core") {
    const entries = extractCoreEntryTexts(json);
    if (entries.length === 0) {
      return { ok: false, reason: "核心记忆条目为空或格式不对，已拒绝入库" };
    }
    body = entries.join("\n");
  } else {
    const key = kind === "event" ? "content" : kind === "daily" ? "diary" : "summary";
    const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
    const value = obj[key];
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, reason: `JSON 缺少 ${key} 正文，已拒绝入库` };
    }
    body = value.trim();
  }

  if (!hasBody(body)) {
    return { ok: false, reason: "正文为空（只有空白/标点），已拒绝入库" };
  }

  return { ok: true, text: body, json };
}
