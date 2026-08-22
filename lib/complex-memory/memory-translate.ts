// lib/complex-memory/memory-translate.ts
// 记忆翻译查看：调用配置页绑定的「翻译 API」（reasoningTranslateApiConfigId，未设置时回退全局默认 API），
// 把记忆原文（角色母语的叙事/日记/事件/核心）翻译成简体中文供用户查看。
// 仅用于界面展示，不回写记忆、不参与投喂、不进入记忆上下文。
// 带内存级缓存（同原文复用，避免重复计费）与 90s 超时（避免请求挂死）。

import { resolveAuxiliaryApiConfig } from "../settings-storage";
import { simpleLLMCall } from "../api-helpers";

const TRANSLATE_INSTRUCTION = [
  "你是专业翻译。把下面【待翻译内容】里的文字忠实翻译成自然、地道的简体中文。",
  "",
  "铁律（最重要，违反即失败）：",
  "- 这是「翻译」，不是「改写」「续写」或「表演」。原文表达什么意思，就译成什么意思，逐句对应；不增删、不脑补、不解释、不评论。",
  "- 保留原文的人设口吻与叙事语气（角色第一人称回忆、日记、事件叙事），不要把它转写成中性说明或总结。",
  "- 人名、称呼、专有名词沿用原文或上下文中已有的译法，不要另起译名。",
  "- 保留原有段落结构与 Markdown 格式（加粗、列表等）。",
  "- 只输出译文本身，不要复述以上要求。",
].join("\n");

function buildTranslateUserMessage(text: string): string {
  return `${TRANSLATE_INSTRUCTION}\n\n【待翻译内容】\n"""\n${text}\n"""`;
}

const cache = new Map<string, string>();
const CACHE_MAX = 120;

/** 把记忆文本翻译成简体中文（供用户查看，不写库、不投喂）。带内存缓存。 */
export async function translateMemoryText(
  text: string,
  options?: { signal?: AbortSignal },
): Promise<{ content?: string; error?: string }> {
  const trimmed = (text || "").trim();
  if (!trimmed) return { error: "没有可翻译的内容" };

  const cached = cache.get(trimmed);
  if (cached) return { content: cached };

  const apiConfig = resolveAuxiliaryApiConfig("reasoningTranslateApiConfigId");
  if (!apiConfig) {
    return { error: "未配置翻译 API（请先在 设置 → 绑定配置 → 辅助 API 中设置翻译/思维链翻译 API，或设置全局默认 API）" };
  }

  // 默认 90 秒超时，避免请求挂死导致始终显示「翻译中」
  const controller = options?.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 90_000) : null;
  try {
    const result = await simpleLLMCall(
      apiConfig,
      [{ role: "user", content: buildTranslateUserMessage(trimmed) }],
      { temperature: 0.2, signal: options?.signal ?? controller?.signal },
    );
    if (!result.content?.trim()) {
      return { error: result.error || "翻译失败，请重试" };
    }
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(trimmed, result.content.trim());
    return { content: result.content.trim() };
  } catch (e) {
    if (controller?.signal.aborted) return { error: "翻译超时，请重试" };
    return { error: e instanceof Error ? e.message : "翻译失败，请重试" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
