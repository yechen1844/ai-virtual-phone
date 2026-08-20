// lib/complex-memory/utils.ts
// 复杂记忆系统 · 共享小工具。

import { resolveUserIdentity } from "../settings-storage";

/** 生成素材截断上限（字符）：sourceMaterials 只存摘要供回查，避免体积失控。 */
export const SOURCE_MATERIALS_CAP = 3000;

/** 截断生成素材：超限保留头部并附说明。 */
export function capSourceMaterials(text: string): string {
  if (!text) return "";
  if (text.length <= SOURCE_MATERIALS_CAP) return text;
  return `${text.slice(0, SOURCE_MATERIALS_CAP)}\n…[原始素材过长已截断，共 ${text.length} 字符]`;
}

export function getUserName(characterId: string): string {
  try {
    return resolveUserIdentity(characterId, "chat")?.name || "用户";
  } catch {
    return "用户";
  }
}

export function dateString(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 提取文本中第一个 { ... } JSON 对象（容忍 markdown 代码围栏与前后说明文字）。 */
export function extractJsonObject(text: string): string | null {
  const cleaned = text
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/\s*```$/g, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}
