// lib/browser-notification.ts
// Browser Notification API wrapper for background alerts.

import { loadChatAppSettings } from "./chat-storage";
import { isShellEnvironment } from "./push-client";

let _notifCounter = 0;

/** Check if notifications are enabled in app settings. */
export function isNotificationEnabled(): boolean {
    if (typeof window === "undefined") return false;
    // 壳（APK）：用安卓原生通道，不依赖浏览器 Notification API。直接 feature-detect 桥，最可靠。
    if ((window as unknown as Record<string, unknown>)?.AndroidShell) {
        return loadChatAppSettings().browserNotificationsEnabled === true;
    }
    if (!("Notification" in window)) return false;
    const settings = loadChatAppSettings();
    return settings.browserNotificationsEnabled === true && Notification.permission === "granted";
}

/** Request notification permission. In shell, permission is native (already granted by system). */
export async function requestNotificationPermission(): Promise<boolean> {
    if (isShellEnvironment()) return true;
    if (typeof window === "undefined" || !("Notification" in window)) return false;
    if (Notification.permission === "granted") return true;
    if (Notification.permission === "denied") return false;

    const result = await new Promise<NotificationPermission>((resolve) => {
        let settled = false;
        const finish = (permission: NotificationPermission) => {
            if (settled) return;
            settled = true;
            resolve(permission);
        };

        try {
            const request = Notification.requestPermission(finish);
            if (request && typeof request.then === "function") {
                request.then(finish).catch(() => finish(Notification.permission));
            }
        } catch {
            finish(Notification.permission);
        }

        window.setTimeout(() => finish(Notification.permission), 3000);
    });

    return result === "granted";
}

function constructNotification(title: string, payload: NotificationOptions): void {
    try {
        const notification = new Notification(title, payload);
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch {
        // Android Chrome/Edge: "Illegal constructor" — handled by the SW path below.
    }
}

/**
 * Send a browser notification if enabled and page is hidden.
 * Does nothing if page is visible, permission denied, or setting is off.
 *
 * Android Chrome/Edge does NOT support the `new Notification()` constructor in
 * pages (throws Illegal constructor) — notifications there must go through the
 * service worker's showNotification(). We prefer the SW path everywhere and fall
 * back to the constructor (desktop / dev where the SW isn't registered).
 */
export function sendBrowserNotification(
    title: string,
    options?: { body?: string; icon?: string },
): void {
    if (!isNotificationEnabled()) return;
    if (!document.hidden) return;

    // 壳（APK）：走安卓原生通知，不依赖 ServiceWorker / Notification API。
    if (isShellEnvironment()) {
        const shell = (window as unknown as Record<string, unknown>).AndroidShell as
            | { showNotification?: (title: string, body?: string, tag?: string) => void }
            | undefined;
        try { shell?.showNotification?.(title, options?.body, `char-${_notifCounter++}`); } catch { /* ignore */ }
        return;
    }

    const payload: NotificationOptions = {
        body: options?.body,
        icon: options?.icon || "/icon-192.png",
        tag: `ai-phone-${Date.now()}-${_notifCounter++}`,
    };

    if ("serviceWorker" in navigator) {
        // `ready` never rejects and may hang forever when no SW is registered
        // (dev mode) — race it with a short timeout, then fall back.
        const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 800));
        Promise.race([navigator.serviceWorker.ready, timeout])
            .then((registration) => {
                if (registration && typeof registration.showNotification === "function") {
                    return registration.showNotification(title, payload);
                }
                constructNotification(title, payload);
            })
            .catch(() => constructNotification(title, payload));
        return;
    }
    constructNotification(title, payload);
}
