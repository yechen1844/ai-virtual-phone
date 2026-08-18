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
    /** 模型思维链（reasoning/CoT）原文，独立于回复内容存储，避免被清洗吞掉 */
    reasoning?: string;
};

const MAX_API_LOGS = 50;
const API_LOGS_KEY = "ai_phone_api_logs_v1";
// 工坊（QA 助手）专用调用记录：与聊天/记忆等底层调用日志彻底隔离，
// 只在工坊界面右上角「调用记录」里查看，绝不混进聊天页的「底层调用大模型日志」。
const QA_LOGS_KEY = "ai_phone_qa_api_logs_v1";
registerKvMigration(API_LOGS_KEY);
registerKvMigration(QA_LOGS_KEY);

function _loadLogs(key: string): DebugInfo[] {
    try {
        const raw = typeof window !== "undefined" ? kvGet(key) : null;
        return raw ? JSON.parse(raw) as DebugInfo[] : [];
    } catch { return []; }
}
function _saveLogs(key: string, logs: DebugInfo[]): void {
    try { kvSet(key, JSON.stringify(logs)); } catch { /* quota exceeded — ignore */ }
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(API_LOGS_KEY); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

/** 工坊专用调用记录（仅工坊 UI 读取，与底层日志完全隔离）。 */
export function getQaApiLogs(): DebugInfo[] { return _loadLogs(QA_LOGS_KEY); }
export function clearQaApiLogs(): void { try { kvRemove(QA_LOGS_KEY); } catch { } }

/** 追加一条调用日志（id/timestamp 自动生成），超出上限时裁掉最旧的记录。 */
export function pushApiLog(entry: Omit<DebugInfo, "id" | "timestamp">): void {
    // 工坊（QA 助手）的调用单独归档，不进聊天页的底层调用日志
    if (entry.characterName === "工坊") {
        try {
            const logs = _loadLogs(QA_LOGS_KEY);
            logs.push({
                ...entry,
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                timestamp: new Date().toISOString(),
            });
            while (logs.length > MAX_API_LOGS) logs.shift();
            _saveLogs(QA_LOGS_KEY, logs);
        } catch { /* 日志写入失败不影响主流程 */ }
        return;
    }
    try {
        const logs = _loadLogs(API_LOGS_KEY);
        logs.push({
            ...entry,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
        });
        while (logs.length > MAX_API_LOGS) logs.shift();
        _saveLogs(API_LOGS_KEY, logs);
    } catch { /* 日志写入失败不影响主流程 */ }
}
