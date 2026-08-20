// lib/complex-memory/context-builder.ts
// 生成上下文组装：char 人设 + 性格规则词 + user 人设 + 世界观/同世界角色 + 用户自定义规则词。
// 供事件 / 每日 / 核心 / 周期生成统一注入，避免各生成器各取一套、口径漂移。

import { loadCharacters } from "../character-storage";
import { resolveUserIdentity } from "../settings-storage";
import { formatCharacterRelationsForPrompt } from "../character-world-storage";
import { loadCharacterRules } from "./config";

export type GenerationContext = {
  persona: string;        // char 人设
  personality: string;    // 角色性格（辅助理解人设）
  rules: string;          // 用户自定义规则词（按角色绑定）
  userPersona: string;    // user 人设（组装成文本）
  worldContext: string;   // 世界观 + 同世界角色 + 关系 + 关联角色简介
};

/** 组装某角色的生成上下文（供提示词注入）。 */
export function buildGenerationContext(characterId: string, appId = "chat"): GenerationContext {
  const char = loadCharacters().find((c) => c.id === characterId);
  const identity = resolveUserIdentity(characterId, appId);
  const userPersona = identity
    ? [
        identity.name ? `姓名：${identity.name}` : "",
        identity.bio ? `简介：${identity.bio}` : "",
        identity.gender ? `性别：${identity.gender}` : "",
        identity.age ? `年龄：${identity.age}` : "",
        identity.occupation ? `职业：${identity.occupation}` : "",
        identity.customSettings ? `补充设定：${identity.customSettings}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  return {
    persona: char?.persona ?? "",
    personality: char?.personality ?? "",
    rules: loadCharacterRules(characterId),
    userPersona,
    worldContext: formatCharacterRelationsForPrompt(characterId),
  };
}
