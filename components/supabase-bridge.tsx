"use client";

import { useEffect } from "react";
import { loadCloudBackupConfig } from "@/lib/cloud-backup/config";

/**
 * 把 float 设置里配好的 Supabase 推给原生壳（window.AndroidShell.recordSupabase）。
 * 壳的离线推送据此用你前端配的库连 Realtime，不再依赖服务器环境变量。
 * kv 是异步水合的，这里轮询重试几次，读到有值的云端配置就推一次。
 */
export function SupabaseBridge() {
  useEffect(() => {
    let tries = 0;
    const timer = window.setInterval(() => {
      try {
        const cfg = loadCloudBackupConfig();
        const shell = (window as unknown as Record<string, unknown>).AndroidShell as
          | { recordSupabase?: (url: string, key: string) => void }
          | undefined;
        if (shell?.recordSupabase && cfg.url && cfg.key) {
          shell.recordSupabase(cfg.url, cfg.key);
          window.clearInterval(timer);
          return;
        }
      } catch {
        // ignore
      }
      tries += 1;
      if (tries > 10) window.clearInterval(timer);
    }, 800);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}