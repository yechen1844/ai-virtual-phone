"use client";

// 主动消息设置：按角色控制是否允许「追发」（AI 因焦虑等状态主动发消息）。
// 默认所有角色都允许；关闭后该角色即使输出高焦虑值，也不会主动追发消息。

import { useState } from "react";
import { loadCharacters } from "@/lib/character-storage";
import { loadFollowUpConfig, saveFollowUpConfig } from "@/lib/settings-storage";
import { Toggle } from "@/components/ui/form";
import { ChatFallbackAvatar } from "@/components/chat/chat-fallback-avatar";

export function FollowUpSettings() {
  const characters = loadCharacters();
  const [disabledIds, setDisabledIds] = useState<Set<string>>(
    () => new Set(loadFollowUpConfig().disabledCharacterIds ?? []),
  );

  const setAllowed = (characterId: string, allowed: boolean) => {
    const next = new Set(disabledIds);
    if (allowed) next.delete(characterId);
    else next.add(characterId);
    setDisabledIds(next);
    saveFollowUpConfig({
      ...loadFollowUpConfig(),
      disabledCharacterIds: [...next],
    });
  };

  const enabledCount = characters.length - disabledIds.size;

  return (
    <div className="flex flex-col gap-[24px] h-full">
      <div className="ui-group-card">
        <div className="menu-label font-semibold">主动消息（追发）</div>
        <div className="menu-desc !mt-0">
          角色回复后，如果它的「焦虑值」等状态超过阈值，会在你不回复时主动发消息追问。默认全部开启；关闭某个角色后，它不会再主动追发，只在你发消息时回复。
        </div>
        <div className="menu-desc !mt-0">
          已开启 {enabledCount} / {characters.length} 个角色
        </div>
      </div>

      {characters.length === 0 ? (
        <div className="ui-empty-compact mt-2">
          <span className="menu-desc">还没有角色，先创建或导入角色卡吧。</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {characters.map((char) => {
            const disabled = disabledIds.has(char.id);
            return (
              <div key={char.id} className="ui-group-card !flex-row !items-center">
                <div className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden">
                  <div className="w-[38px] h-[38px] rounded-full overflow-hidden bg-[var(--c-input)] shrink-0">
                    {char.avatar ? (
                      <img src={char.avatar} className="w-full h-full object-cover" alt="" />
                    ) : (
                      <ChatFallbackAvatar />
                    )}
                  </div>
                  <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                    <span className="menu-label truncate min-w-0">{char.name || "UNNAMED"}</span>
                    <span className="menu-desc !mt-0 truncate">
                      {disabled ? "不会主动发消息" : "允许主动发消息"}
                    </span>
                  </div>
                </div>
                <Toggle
                  checked={!disabled}
                  onChange={(allowed) => setAllowed(char.id, allowed)}
                  aria-label={`${char.name || "该角色"} 允许主动发消息`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
