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
    /** 调用来源：chat=聊天引擎、background=simpleLLMCall 后台功能（具体功能名看 characterName 标签）、qa=工坊答疑引擎 */
    source?: "chat" | "background" | "qa";
    /** 归属通道：qa 进工坊专用环，其余进底层调用日志环。分流只认这个显式字段，不看角色名 */
    channel?: "chat" | "qa";
};

// 底层调用日志环容量。原为 50：聊天请求与 18 处 simpleLLMCall 后台调用（记忆总结、
// NPC 生成、剧情、地图等）共享一个环，用户想看自己刚才那次聊天时很容易已被后台调用
// 挤掉，因此扩容；配合单条截断与体积预算控制总占用。
const MAX_API_LOGS = 150;
// 工坊环容量：只有答疑引擎写入，量小，维持原值。
const MAX_QA_API_LOGS = 50;
// 单环序列化体积预算（字节）：超预算时从最旧开始丢弃，防止单条超大 prompt 撑爆 localStorage。
const MAX_API_LOGS_BYTES = 2 * 1024 * 1024;
const MAX_QA_LOGS_BYTES = 1024 * 1024;
// 单条文本截断上限：记忆总结类调用的完整 prompt 动辄几十 KB，写日志前先截断，
// 控制每次 push 的 parse/stringify 写放大与常驻体积。
const MAX_LOG_MESSAGE_CHARS = 4000;
const MAX_LOG_RESPONSE_CHARS = 8000;

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

function truncateForLog(text: string, limit: number): string {
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n…[日志截断：原文共 ${text.length} 字符]`;
}

function truncateEntryForLog(entry: Omit<DebugInfo, "id" | "timestamp">): Omit<DebugInfo, "id" | "timestamp"> {
    return {
        ...entry,
        messages: entry.messages.map(m => ({
            ...m,
            content: typeof m.content === "string" ? truncateForLog(m.content, MAX_LOG_MESSAGE_CHARS) : m.content,
        })),
        rawResponse: truncateForLog(entry.rawResponse, MAX_LOG_RESPONSE_CHARS),
        reasoning: entry.reasoning !== undefined ? truncateForLog(entry.reasoning, MAX_LOG_RESPONSE_CHARS) : undefined,
    };
}

export function getApiLogs(): DebugInfo[] { return _loadLogs(API_LOGS_KEY); }
export function clearApiLogs(): void { try { kvRemove(API_LOGS_KEY); } catch { } }

/** 工坊专用调用记录（仅工坊 UI 读取，与底层日志完全隔离）。 */
export function getQaApiLogs(): DebugInfo[] { return _loadLogs(QA_LOGS_KEY); }
export function clearQaApiLogs(): void { try { kvRemove(QA_LOGS_KEY); } catch { } }

/** 追加一条调用日志（id/timestamp 自动生成、超限文本截断），超出数量/体积上限时裁掉最旧的记录。 */
export function pushApiLog(entry: Omit<DebugInfo, "id" | "timestamp">): void {
    // 工坊（QA 助手）的调用单独归档，不进聊天页的底层调用日志。
    // 分流只认显式 channel 字段：角色名恰好叫「工坊」的聊天不会被误扔进工坊记录。
    const isQa = entry.channel === "qa";
    const key = isQa ? QA_LOGS_KEY : API_LOGS_KEY;
    const maxCount = isQa ? MAX_QA_API_LOGS : MAX_API_LOGS;
    const maxBytes = isQa ? MAX_QA_LOGS_BYTES : MAX_API_LOGS_BYTES;
    try {
        const logs = _loadLogs(key);
        logs.push({
            ...truncateEntryForLog(entry),
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: new Date().toISOString(),
        });
        while (logs.length > maxCount) logs.shift();
        while (logs.length > 1 && JSON.stringify(logs).length > maxBytes) logs.shift();
        _saveLogs(key, logs);
    } catch { /* 日志写入失败不影响主流程 */ }
}
