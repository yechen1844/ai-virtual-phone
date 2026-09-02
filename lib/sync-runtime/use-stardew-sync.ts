"use client";
// lib/sync-runtime/use-stardew-sync.ts
// 星露谷「实时同步」React hook：封装引擎的轮询 + 事件订阅 + 生命周期。
// 挂载时按配置启动；卸载/关闭时清理。两端(游玩端/遥控端)共用。

import { useEffect, useRef, useState, useCallback } from "react";
import {
  loadSyncConfig, saveSyncConfig, isSyncConfigured, type StardewSyncConfig,
} from "./config";
import {
  remoteSendUser, remoteRequestReply, remotePullFanout,
  playPullUsers, playHandleReplyRequests, applyRemoteDeletes,
  attachPlayFanoutPublisher, attachDeletePublisher, cleanDuplicateSyncedMessages,
} from "./engine";

export type SyncUiState = {
  configured: boolean;
  enabled: boolean;
  role: "play" | "remote";
  /** 最近一次同步状态：running / stopped / error */
  state: "running" | "stopped" | "error";
  errorMsg: string;
};

/**
 * 开关：更新配置（url/anonKey/enabled/role）。返回新的配置对象。
 */
export function useStardewSync() {
  const [cfg, setCfg] = useState<StardewSyncConfig>(() => loadSyncConfig());
  const [ui, setUi] = useState<SyncUiState>(() => ({
    configured: isSyncConfigured(loadSyncConfig()),
    enabled: loadSyncConfig().enabled,
    role: loadSyncConfig().role,
    state: "stopped",
    errorMsg: "",
  }));
  const runningRef = useRef(false);
  const busyRef = useRef(false); // 防重入：上一轮 tick 未结束则跳过本轮，避免并发触发重复生成
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const apply = useCallback((patch: Partial<StardewSyncConfig>) => {
    const next = { ...loadSyncConfig(), ...patch };
    saveSyncConfig(next);
    setCfg(next);
    setUi(u => ({ ...u, configured: isSyncConfigured(next), enabled: next.enabled, role: next.role }));
    return next;
  }, []);

  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    cleanupRef.current?.();
    cleanupRef.current = null;
    runningRef.current = false;
    setUi(u => ({ ...u, state: "stopped" }));
  }, []);

  const start = useCallback((nextCfg: StardewSyncConfig) => {
    stop();
    if (!nextCfg.enabled || !isSyncConfigured(nextCfg) || typeof window === "undefined") {
      setUi(u => ({ ...u, enabled: nextCfg.enabled, state: "stopped" }));
      return;
    }
    runningRef.current = true;
    setUi(u => ({ ...u, enabled: true, state: "running", errorMsg: "" }));

    // 挂事件发布器（游玩端 fanout + 双端删除）
    const detachFanout = attachPlayFanoutPublisher(nextCfg);
    const detachDelete = attachDeletePublisher(nextCfg);
    cleanupRef.current = () => { detachFanout(); detachDelete(); };

    // 启动时清理历史同步复制出来的重复消息（按 role+content+createdAt 幂等去重）
    cleanDuplicateSyncedMessages();

    // 短轮询：游玩端拉 user + 处理 reply-request；两端拉 fanout 与 deletes
    const tick = async () => {
      if (!runningRef.current) return;
      if (busyRef.current) return; // 上一轮还没跑完，跳过本轮，避免并发导致重复生成
      busyRef.current = true;
      try {
        const cur = loadSyncConfig();
        if (!cur.enabled) { stop(); return; }
        if (cur.role === "play") await playPullUsers(cur, "");            // 拉遥控端 user（按需过滤会话）
        if (cur.role === "play") await playHandleReplyRequests(cur);       // 游玩端触发生成
        if (cur.role !== "play") await remotePullFanout(cur, "*");         // 仅遥控端拉下游消息（避免与遥控端争抢同一水位）
        await applyRemoteDeletes(cur, "*");                                // 应用删除（双端）
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setUi(u => ({ ...u, state: "error", errorMsg: m }));
      } finally {
        busyRef.current = false;
      }
    };
    void tick();
    timerRef.current = setInterval(tick, nextCfg.pollIntervalSeconds * 1000);
  }, [stop]);

  // 卸载清理
  useEffect(() => () => { stop(); }, [stop]);

  return { cfg, ui, start, stop, apply, remoteSendUser, remoteRequestReply };
}