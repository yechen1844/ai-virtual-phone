"use client";

import { useEffect } from "react";

import { isCloudBackupConfigured, loadCloudBackupConfig } from "@/lib/cloud-backup/config";
import { loadCloudBackupState, runCloudBackup } from "@/lib/cloud-backup/engine";

// Module-level guard so overlapping timers/mounts never run two backups at once.
let backupRunning = false;

/**
 * Invisible component that drives auto cloud backup. Mounted once at the app
 * root. It checks every few minutes whether a backup is due (per the user's
 * interval) and, when idle, runs an incremental backup in the background. The
 * engine skips when nothing changed and processes module-by-module with awaits,
 * so it stays off the critical path and doesn't freeze the UI.
 */
export function CloudBackupScheduler() {
  useEffect(() => {
    let cancelled = false;

    const runWhenIdle = (fn: () => void) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => fn(), { timeout: 4000 });
      } else {
        window.setTimeout(fn, 400);
      }
    };

    const tick = () => {
      if (cancelled || backupRunning) return;
      const config = loadCloudBackupConfig();
      if (!config.enabled || !isCloudBackupConfigured(config)) return;

      const state = loadCloudBackupState();
      const dueMs = config.intervalHours * 3600_000;
      // 上次「成功备份」和上次「检查完成（数据没变）」都算有效时间戳：
      // 取较新的一个，保证数据没变时不会每 5 分钟重跑一遍检查。
      const lastCreated = state.lastCreatedAt ? Date.parse(state.lastCreatedAt) : 0;
      const lastChecked = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0;
      const last = Math.max(Number.isFinite(lastCreated) ? lastCreated : 0, Number.isFinite(lastChecked) ? lastChecked : 0);
      if (last > 0 && Date.now() - last < dueMs) return;

      runWhenIdle(async () => {
        if (cancelled || backupRunning) return;
        backupRunning = true;
        try {
          // Cloud uploads are chunked, so large media is fine — always back up in full.
          await runCloudBackup(config, { excludeMedia: false });
        } catch (error) {
          // 不再静默吞掉——通知用户备份失败了
          const msg = error instanceof Error ? error.message : String(error);
          console.error("[CloudBackup] 自动备份失败:", msg);
          // 通过 postMessage 触发桌面通知（desktop-shell 监听 OS_CMD/show_notice）
          window.postMessage({ type: "OS_CMD", action: "show_notice", message: `☁️ 自动备份失败：${msg}` }, "*");
        } finally {
          backupRunning = false;
        }
      });
    };

    const interval = window.setInterval(tick, 5 * 60_000);
    const initial = window.setTimeout(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(initial);
    };
  }, []);

  return null;
}
