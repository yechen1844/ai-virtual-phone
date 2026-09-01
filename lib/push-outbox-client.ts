// 离线推送·回端合并：App 打开/回前台时拉取服务端生成的原始输出，
// 用客户端同一条解析管线（输出正则 → parseAndSaveResponse）落进聊天记录。

import { parseAndSaveResponse, scheduleFollowUp } from "./follow-up-service";
import { applyOutputRegex } from "./llm-prompt-assembler";
import type { RegexConfig } from "./settings-types";
import { stripHallucinatedTimestamps } from "./llm-provider-adapter";
import { MacroEngine } from "./macro-engine";
import { getActiveAppTags } from "./content-tag-utils";
import { loadChatMessages, loadChatSessions, reindexSessionMessageOrdersByTime } from "./chat-storage";
import { hasAccountPushSubscription } from "./push-client";
import { isPersonalPushCloudActive, loadPersonalPushCloudState, personalPushFetch } from "./personal-push-cloud";
import { isCloudBackupConfigured, loadCloudBackupConfig } from "./cloud-backup/config";
import { removeTimedWakeSchedule } from "./timed-wake-storage";
import { appendBridgeFeed } from "./reality-bridge/storage";
import { loadScreenChatSettings, saveScreenChatAck } from "./reality-bridge/storage";

type OutboxEntry = {
    id: string;
    session_id: string | null;
    trigger_key: string | null;
    raw_text: string;
    meta: {
        sessionId?: string;
        followUpIndex?: number;
        prevCount?: number;
        regexes?: RegexConfig[];
        characterName?: string;
        userName?: string;
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        armAt?: string;
        /** 云端触发快捷动作失败的摘要；成功时不带这个字段 */
        shortcutDeliveryError?: string;
    } | null;
    created_at: string;
};

let consuming = false;
let lastConsumeAt = 0;
let consumerInstalled = false;
let consumeRequestTimer: number | null = null;
const OUTBOX_BATCH_SIZE = 20;
const MAX_OUTBOX_BATCHES_PER_PASS = 10;
const OUTBOX_FOREGROUND_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 确认能否访问个人云离线推送网关（ai-phone-push?action=outbox）。
 * 优先看「个人云已部署」状态；缺失时（最常见于 APK 壳：独立 WebView 里没有
 * personal_push_cloud_state_v1 标记）只要云备份里有 url+key 就能直连网关。
 */
function hasPersonalGatewayTarget(): boolean {
    if (isPersonalPushCloudActive()) return true;
    const backup = loadCloudBackupConfig();
    return isCloudBackupConfigured(backup) && Boolean(backup.url && backup.key);
}

/**
 * 从个人云网关拉/确认 outbox。个人云即云备份同一项目（isPersonalPushCloudActive
 * 要求两者同 ref），因此可用云备份的 url + service key 直连，与英壳 recordSupabase
 * 推给壳的是同一套凭据——弥补壳没有「已部署」标记时仍能拉取消息。
 */
function personalGatewayFetch(action: "outbox", init?: RequestInit): Promise<Response> | null {
    if (isPersonalPushCloudActive()) return personalPushFetch("outbox", init);
    const backup = loadCloudBackupConfig();
    if (!isCloudBackupConfigured(backup) || !backup.url || !backup.key) return null;
    const headers = new Headers(init?.headers);
    headers.set("x-ai-phone-service-key", backup.key.trim());
    headers.set("x-ai-phone-origin", typeof window !== "undefined" ? window.location.origin : "");
    if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetch(`${backup.url.replace(/\/+$/, "")}/functions/v1/ai-phone-push?action=outbox`, {
        ...init,
        headers,
        cache: "no-store",
    });
}

function getTimedWakeIdFromTriggerKey(triggerKey: string | null): string | null {
    if (!triggerKey?.startsWith("timedwake:")) return null;
    const id = triggerKey.slice("timedwake:".length);
    return id.trim() || null;
}

function clearTimedWakeIfHandled(triggerKey: string | null): void {
    const timedWakeId = getTimedWakeIdFromTriggerKey(triggerKey);
    if (timedWakeId) removeTimedWakeSchedule(timedWakeId);
}

export async function consumeServerOutbox(options?: { silent?: boolean; force?: boolean }): Promise<void> {
    if (typeof window === "undefined") return;
    const force = options?.force === true;
    // 共享回传箱已紧急停用：没有个人 Supabase 时直接结束，不请求 status/outbox。
    if (!isPersonalPushCloudActive()) {
        // 壳由 __float_pull_outbox 强制触发时，最可能卡这里：壳这个 WebView 的本地
        // 状态下没有「个人云已部署」标记，导致 outbox 从不拉取 → 本地聊天不写入。
        if (force) console.warn("[PushOutbox] pull skipped: personal cloud not active in this WebView", {
            hasPersonalState: Boolean(loadPersonalPushCloudState()),
            cloudBackupConfigured: isCloudBackupConfigured(loadCloudBackupConfig()),
        });
        return;
    }
    if (consuming) return;
    if (options?.force !== true && Date.now() - lastConsumeAt < OUTBOX_FOREGROUND_CHECK_INTERVAL_MS) return;
    // 没有任何设备订阅推送时，服务端不可能产生普通离线回传；避免所有在线用户空轮询。
    // 壳（APK）自带原生通道、没有浏览器 Web Push 订阅——必须放行，否则离线回传永不拉取。
    const isShellLike = () => typeof window !== "undefined"
        && !!(window as unknown as Record<string, unknown>)?.AndroidShell;
    if (!loadScreenChatSettings().enabled && !(await hasAccountPushSubscription()) && !isShellLike()) {
        if (force) console.warn("[PushOutbox] pull skipped: gate (无屏幕速聊且账号无离线推送订阅)");
        return;
    }
    consuming = true;
    lastConsumeAt = Date.now();
    const passStartMs = Date.now();
    let consumedAnyThisPass = 0;
    const affectedSessions = new Set<string>();
    try {
        // 共享回传箱已停用，只读取用户自己的 Supabase。
        const sources: Array<"personal" | "shared"> = ["personal"];
        const handledTriggerKeys = new Set<string>();
        for (const source of sources) {
          for (let batch = 0; batch < MAX_OUTBOX_BATCHES_PER_PASS; batch += 1) {
            const response = await (source === "personal"
                ? personalPushFetch("outbox")
                : fetch("/api/push/outbox", { credentials: "include" }))
                .catch(() => null);
            if (!response || !response.ok) break;
            const data = await response.json().catch(() => ({})) as { ok?: boolean; entries?: OutboxEntry[] };
            const entries = data.ok && Array.isArray(data.entries) ? data.entries : [];
            if (entries.length === 0) break;

            const consumedIds: string[] = [];
            for (const entry of entries) {
                try {
                    if (entry.trigger_key && handledTriggerKeys.has(entry.trigger_key)) {
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const meta = entry.meta || {};

                    if ((meta as { kind?: string }).kind === "bridge") {
                        const bridgeMeta = meta as Record<string, unknown> & {
                            reply?: { sessionId?: string; regexes?: RegexConfig[]; characterName?: string; userName?: string; appId?: string; appTags?: string[] } | null;
                            screenChat?: boolean;
                            screenChatCharacterId?: string;
                            screenChatSequence?: number;
                            screenChatResponseBatchId?: string;
                            screenChatAssistantAt?: string;
                        };
                        const engine = await import("./reality-bridge/engine");
                        const applied = await engine.applyServerBridgeEntry(bridgeMeta as Parameters<typeof engine.applyServerBridgeEntry>[0]);
                        const replyMeta = bridgeMeta.reply || null;
                        const replySessionId = applied.sessionId || replyMeta?.sessionId || "";
                        if (entry.raw_text.trim() && replySessionId) {
                            const responseBatchId = typeof bridgeMeta.screenChatResponseBatchId === "string"
                                ? bridgeMeta.screenChatResponseBatchId
                                : undefined;
                            const existing = loadChatMessages(replySessionId);
                            const alreadyImported = Boolean(
                                responseBatchId && existing.some(message => message.responseBatchId === responseBatchId),
                            );
                            if (!alreadyImported) {
                                let text = stripHallucinatedTimestamps(entry.raw_text.trim());
                                const regexes = Array.isArray(replyMeta?.regexes) ? replyMeta.regexes : [];
                                if (regexes.length > 0) {
                                    const macroEngine = new MacroEngine(replyMeta?.characterName ?? "", replyMeta?.userName ?? "用户");
                                    const activeTags = getActiveAppTags(replyMeta?.appId ?? "chat", { appTags: replyMeta?.appTags });
                                    text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                                }
                                const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                                    text,
                                    replySessionId,
                                    0,
                                    undefined,
                                    existing,
                                    {
                                        silent: options?.silent !== false,
                                        responseBatchId,
                                        createdAt: bridgeMeta.screenChatAssistantAt,
                                    },
                                );
                                if (hasVisible && newCount < 10) scheduleFollowUp(replySessionId, newCount, stateValues);
                            }
                            if (bridgeMeta.screenChat === true) reindexSessionMessageOrdersByTime(replySessionId);
                        }
                        if (
                            bridgeMeta.screenChat === true
                            && typeof bridgeMeta.screenChatCharacterId === "string"
                            && Number.isSafeInteger(bridgeMeta.screenChatSequence)
                        ) {
                            saveScreenChatAck(bridgeMeta.screenChatCharacterId, Number(bridgeMeta.screenChatSequence));
                        }
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }
                    // 云端触发快捷动作失败的诊断行：角色已经说了"我去看一眼"却什么
                    // 都没发生，写进现实桥动态让用户查得到原因。这是一条独立的
                    // outbox 行（云端在投递之后才写），不是角色消息——消费掉即可，
                    // 绝不能走下面的建消息流程，否则聊天里会凭空多出一条。
                    if ((meta as { kind?: string }).kind === "shortcut_delivery_error") {
                        const detail = typeof meta.shortcutDeliveryError === "string"
                            ? meta.shortcutDeliveryError
                            : entry.raw_text;
                        try {
                            appendBridgeFeed({
                                id: `shortcut_fail_${entry.id}`,
                                type: "快捷动作",
                                payload: detail,
                                rules: [],
                                actions: [],
                                error: detail,
                                receivedAt: new Date().toISOString(),
                            });
                        } catch { /* 动态写失败不影响其余条目消费 */ }
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const sessionId = meta.sessionId || entry.session_id || "";
                    const session = sessionId ? loadChatSessions().find(s => s.id === sessionId) : undefined;
                    if (!session) {
                        // 会话匹配不上就直接 continue 会让该 outbox 永久 pending、消息写不进聊天。
                        // 落地一条含上下文的可定位日志（id/sessionId/触发键/可用会话列表），
                        // 便于确认是「该设备本地确实没有这个会话」还是「sessionId 字段缺失/格式不一致」。
                        const knownIds = loadChatSessions().map(s => s.id);
                        console.warn(
                            "[PushOutbox] session not found, keep entry pending",
                            { entryId: entry.id, sessionId, triggerKey: entry.trigger_key || null, knownSessionCount: knownIds.length, knownSessionIds: knownIds.slice(0, 10) },
                        );
                        continue;
                    }

                    const periodCare = (meta as { periodCare?: { characterId?: string; cycleKey?: string } }).periodCare;
                    if (periodCare?.characterId && periodCare.cycleKey) {
                        const { saveMenstrualPeriodCareTrigger } = await import("./menstrual-storage");
                        saveMenstrualPeriodCareTrigger({ characterId: periodCare.characterId, sessionId, cycleKey: periodCare.cycleKey });
                    }

                    const idleMeta = (meta as { idleReconnect?: { ruleId?: string; firedAt?: number } }).idleReconnect;
                    if (idleMeta?.ruleId) {
                        const { markIdleReconnectFired } = await import("./idle-reconnect-storage");
                        markIdleReconnectFired(idleMeta.ruleId, typeof idleMeta.firedAt === "number" ? idleMeta.firedAt : Date.now());
                    }

                    const followUpIndex = typeof meta.followUpIndex === "number" ? meta.followUpIndex : undefined;
                    const existingMessages = loadChatMessages(sessionId);
                    if (followUpIndex && existingMessages.some(m => m.role === "assistant" && m.followUpIndex === followUpIndex)) {
                        clearTimedWakeIfHandled(entry.trigger_key);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }

                    const armAtMs = typeof meta.armAt === "string" ? Date.parse(meta.armAt) : NaN;
                    if (Number.isFinite(armAtMs) && existingMessages.some(m => {
                        if (m.role !== "assistant") return false;
                        const createdMs = Date.parse(m.createdAt);
                        return createdMs > armAtMs && createdMs < passStartMs;
                    })) {
                        clearTimedWakeIfHandled(entry.trigger_key);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }

                    let text = stripHallucinatedTimestamps(entry.raw_text.trim());
                    const regexes = Array.isArray(meta.regexes) ? meta.regexes : [];
                    if (regexes.length > 0) {
                        const macroEngine = new MacroEngine(meta.characterName ?? "", meta.userName ?? "用户");
                        const activeTags = getActiveAppTags(meta.appId ?? "chat", { appTags: meta.appTags, followUpCount: meta.followUpCount });
                        text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                    }

                    // 云端执行过的快捷动作标记：在原始位置落一对 tool_call/tool_notice——
                    // 上下文里保留标记原文，UI 显示与小手机内直接调用一致
                    const rawMarker = (meta as { shortcutMarker?: { text?: unknown; insertAt?: unknown; name?: unknown } }).shortcutMarker;
                    const shortcutMarker = rawMarker
                        && typeof rawMarker.text === "string" && rawMarker.text
                        && typeof rawMarker.name === "string" && rawMarker.name
                        ? {
                            text: rawMarker.text,
                            insertAt: typeof rawMarker.insertAt === "number" && Number.isFinite(rawMarker.insertAt)
                                ? rawMarker.insertAt
                                : Number.MAX_SAFE_INTEGER,
                            name: rawMarker.name,
                        }
                        : undefined;
                    const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                        text,
                        sessionId,
                        meta.prevCount ?? 0,
                        followUpIndex,
                        existingMessages,
                        { silent: options?.silent !== false, ...(shortcutMarker ? { shortcutMarker } : {}) },
                    );
                    if (hasVisible && newCount < 10) scheduleFollowUp(sessionId, newCount, stateValues);
                    clearTimedWakeIfHandled(entry.trigger_key);
                    consumedIds.push(entry.id);
                    if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                } catch (err) {
                    console.warn("[PushOutbox] merge failed for entry:", entry.id, err);
                    // 屏幕速聊各轮有严格因果顺序；前一轮未合并时不能越过它消费后一轮。
                    if ((entry.meta as { screenChat?: boolean } | null)?.screenChat === true) break;
                }
            }

            if (consumedIds.length === 0) break;
            consumedAnyThisPass += consumedIds.length;
            for (const e of entries) {
                const s = e.meta?.sessionId || e.session_id;
                if (s) affectedSessions.add(s);
            }
            const ackInit: RequestInit = {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: consumedIds }),
            };
            const ackResponse = await (source === "personal"
                ? personalPushFetch("outbox", ackInit)
                : fetch("/api/push/outbox", { ...ackInit, credentials: "include" }))
                .catch(() => null);
            if (!ackResponse || !ackResponse.ok) break;
            if (entries.length < OUTBOX_BATCH_SIZE) break;
          }
        }
    } finally {
        consuming = false;
        // 前台若开着 float 且当前打开的会话是受影响会话，要让它重载新消息。
        // 注意必须带 detail.sessionId——chat-room 只有当 detail.sessionId === 当前 session.id 才 reload。
        if (affectedSessions.size > 0) {
            for (const sid of affectedSessions) {
                window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: sid } }));
            }
        }
    }
}

/** 安装自动消费钩子：启动后拉一次，之后每次回前台再拉。 */
export function installServerOutboxConsumer(): void {
    if (typeof window === "undefined" || consumerInstalled) return;
    consumerInstalled = true;

    // 启动时保留 5 分钟节流；回前台和 SW 明确告知新消息时强制补拉。
    // iOS 会在后台冻结页面，如果回前台仍被节流，屏幕速聊消息只能等到下次重启才会合并。
    const requestConsume = (force = false) => {
        if (consumeRequestTimer !== null) window.clearTimeout(consumeRequestTimer);
        consumeRequestTimer = window.setTimeout(() => {
            consumeRequestTimer = null;
            void consumeServerOutbox({ force });
        }, 150);
    };

    // 壳（无 Service Worker）收到 Realtime 广播弹完系统通知后，由壳调用它强制
    // 拉取并合并 outbox，让完整消息落进聊天。重复触发靠 consumeServerOutbox 幂等去重。
    (window as unknown as Record<string, unknown>).__float_pull_outbox = () => requestConsume(true);

    requestConsume(false);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) requestConsume(true);
    });
    navigator.serviceWorker?.addEventListener("message", (event) => {
        if (event.data?.type === "push_outbox_ready") {
            requestConsume(true);
            return;
        }
        if (event.data?.type === "run_shortcut" && typeof event.data.url === "string") {
            const url: string = event.data.url;
            // 站点线的 /shortcut-run 票据地址、个人线的同源转发路由，
            // 或个人云网关自己的 run 入口
            const personal = loadPersonalPushCloudState();
            const allowed = url.startsWith(`${window.location.origin}/shortcut-run`)
                || url.startsWith(`${window.location.origin}/personal-shortcut-run?`)
                || (personal !== null && url.startsWith(`${personal.url}/functions/v1/ai-phone-push?action=run&`));
            if (allowed) window.location.href = url;
        }
    });
}
