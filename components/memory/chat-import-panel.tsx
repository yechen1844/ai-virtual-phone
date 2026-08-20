"use client";

// components/memory/chat-import-panel.tsx
// 聊天记录导入面板：选择 float 角色 + 选择转换脚本产物（.float-chat.json 导入包）→ 导入。
// 导入走 float 原生聊天存储管线（importChatMessages），记录与原生聊天完全一致；
// 按消息 id 幂等去重，重复导入不产生重复记录。记忆部分不在此处理（复杂记忆走一键迁移）。

import { useMemo, useState } from "react";
import { ArrowLeft, FileUp, Loader2, CheckCircle2 } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import {
  parseChatImportPayload,
  importChatHistory,
  type ChatImportPayload,
} from "@/lib/chat-import";
import { hydrateChatStorage } from "@/lib/chat-storage";

type Props = {
  onBack: () => void;
  onNotice?: (msg: string) => void;
};

type Preview = {
  payload: ChatImportPayload;
  userCount: number;
  assistantCount: number;
};

export function ChatImportPanel({ onBack, onNotice }: Props) {
  const characters = useMemo(() => loadCharacters(), []);
  const [charId, setCharId] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [parseError, setParseError] = useState<string>("");
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<{ imported: number; skipped: number } | null>(null);

  const handleFile = async (file: File | undefined) => {
    setParseError("");
    setPreview(null);
    setImported(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      const res = parseChatImportPayload(text);
      if (!res.ok) {
        setParseError(res.error);
        return;
      }
      const { payload } = res;
      const userCount = payload.messages.filter((m) => m.role === "user").length;
      const assistantCount = payload.messages.length - userCount;
      setPreview({ payload, userCount, assistantCount });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "文件读取失败");
    }
  };

  const handleImport = async () => {
    if (!charId || !preview) return;
    setImporting(true);
    setImported(null);
    try {
      await hydrateChatStorage();
      const res = await importChatHistory(charId, preview.payload);
      setImporting(false);
      if (!res.success) {
        setParseError(res.error ?? "导入失败");
        return;
      }
      setImported({ imported: res.imported ?? 0, skipped: res.skipped ?? 0 });
      onNotice?.(
        `已导入 ${res.imported} 条聊天记录到「${characters.find((c) => c.id === charId)?.name ?? ""}」` +
          (res.skipped && res.skipped > 0 ? `，跳过重复 ${res.skipped} 条` : ""),
      );
    } catch (err) {
      setImporting(false);
      setParseError(err instanceof Error ? err.message : "导入异常");
    }
  };

  return (
    <div className="mem-picker">
      <div className="mem-picker-card" style={{ maxWidth: 520 }}>
        <div className="mem-picker-body">
          <button type="button" className="ui-btn ui-btn-outline ts-12" onClick={onBack} style={{ alignSelf: "flex-start" }}>
            <ArrowLeft size={14} /> 返回
          </button>
          <p className="mem-picker-prompt" style={{ marginTop: 8 }}>
            导入外部聊天记录<br />
            <span className="mem-picker-hint">先选角色（须已在 float 中新建），再选择转换脚本生成的 .float-chat.json 导入包</span>
          </p>

          {/* 1. 目标角色 */}
          <p className="ts-13" style={{ margin: "12px 0 6px", color: "var(--text-secondary)" }}>① 目标角色</p>
          <div className="mem-picker-chips">
            {characters.map((c) => (
              <button
                key={c.id}
                type="button"
                className="ui-chip"
                {...(charId === c.id ? { "data-selected": "" } : {})}
                onClick={() => setCharId(charId === c.id ? "" : c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>

          {/* 2. 选择导入包 */}
          <p className="ts-13" style={{ margin: "14px 0 6px", color: "var(--text-secondary)" }}>② 选择导入包文件</p>
          <label
            className="ui-chip"
            style={{ cursor: "pointer", justifyContent: "center", gap: 6 }}
          >
            <FileUp size={15} />
            {fileName || "选择 .json 导入包"}
            <input
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
          </label>
          {fileName && (
            <p className="ts-12" style={{ marginTop: 4, color: "var(--text-secondary)" }}>{fileName}</p>
          )}

          {/* 解析结果预览 */}
          {preview && (
            <div className="mem-picker-card" style={{ marginTop: 12, padding: 12, boxShadow: "none", border: "1px solid var(--line-weak, rgba(128,128,128,.25))" }}>
              <p className="ts-13" style={{ fontWeight: 600 }}>
                待导入：{preview.payload.character?.name || "（未知名）"} · {preview.payload.messages.length} 条
              </p>
              <p className="ts-12" style={{ color: "var(--text-secondary)", marginTop: 4 }}>
                我 {preview.userCount} 条 · 角色 {preview.assistantCount} 条
                {preview.payload.earliest ? ` · ${preview.payload.earliest.slice(0, 10)} → ${preview.payload.latest?.slice(0, 10)}` : ""}
              </p>
              {!charId ? (
                <p className="ts-12" style={{ color: "#d97757", marginTop: 6 }}>请先选择目标角色</p>
              ) : imported ? (
                <p className="ts-13" style={{ color: "#2f9e77", marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                  <CheckCircle2 size={15} /> 导入完成：{imported.imported} 条
                  {imported.skipped > 0 ? `（跳过重复 ${imported.skipped} 条）` : ""}，可返回查看
                </p>
              ) : (
                <button
                  type="button"
                  className="ui-btn ui-btn-primary ts-12"
                  style={{ marginTop: 8 }}
                  onClick={() => void handleImport()}
                  disabled={importing}
                >
                  {importing ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
                  {importing ? "正在导入…" : "开始导入"}
                </button>
              )}
            </div>
          )}
          {parseError && (
            <p className="ts-12" style={{ color: "#d97757", marginTop: 8 }}>{parseError}</p>
          )}

          <div className="mem-picker-footer">
            <span>CHAT IMPORT · 只迁移聊天记录，记忆请走一键迁移</span>
          </div>
        </div>
      </div>
    </div>
  );
}
