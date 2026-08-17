// lib/api-log-store.ts
// 底层模型调用日志存储（独立模块，避免 chat-engine ↔ api-helpers 循环依赖）。
// 聊天引擎（整段/流式/原生工具）与 simpleLLMCall（记忆总结、朋友圈、日历等
// 通用 LLM 调用）共用这份日志，统一在「底层调用大模型日志」面板查看。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type DebugInfo = {
    id: string;
    characterName?: string;
    model?: string;
    messages: { role: string; content: string; marker?: string }[];
    rawResponse: string;
    timestamp: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

const MAX_API_LOGS = 50;
const API_LOGS_KEY = "ai_phone_api_logs_v1";
registerKvMigration(API_LOGS_KEY);

function _loadLogs(): DebugInfo[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(API_LOGS_KEY) : null;
        return raw ? JSON.parse(raw) as DebugInfo[] : [];
    } catch { return []; }
}
function _saveLogs(logs: DebugInfo[]): void {
    try { kvSet(API_LOGS_KEY, JSON.stringify(logs)); } catch { /* quota exceeded — ignore */ }
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

/** 追加一条调用日志（id/timestamp 自动生成），超出上限时裁掉最旧的记录。 */
export function pushApiLog(entry: Omit<DebugInfo, "id" | "timestamp">): void {
    try {
        const logs = _loadLogs();
        logs.push({
            ...entry,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
        });
        while (logs.length > MAX_API_LOGS) logs.shift();
        _saveLogs(logs);
    } catch { /* 日志写入失败不影响主流程 */ }
}
