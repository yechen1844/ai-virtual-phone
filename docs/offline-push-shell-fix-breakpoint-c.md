# float APK 离线推送·断点 C 修复（通知弹了但没写进聊天）

> 作用：配合 `offline-push-shell-fix-guide.md`。断点 A（空订阅表→不广播）与断点 B（壳身份 `local_user`≠`owner`）已修复且**推送通知已通**。
> 本文件单独讲**剩下的最后一个 bug**：定时主动消息到点，壳**弹了系统通知**，但**完整消息没写进 float 聊天**。
> 请先做本文件里的修复并重打包 APK，验证通过后，再按 `offline-push-shell-fix-guide.md` 写最终教程。

***

## 1. 现象

- 定时主动消息到点 ✅ 壳弹出系统通知

- 但 float **聊天记录里没有**这条消息 ❌

## 2. 根因

- 云端广播（`push-generate.mjs`）payload 只带**标题 + 一句预览**，完整消息存在云端 **`push_outbox`** 表。

- 完整消息要写进聊天，需前端 `lib/push-outbox-client.ts` 的 **`consumeServerOutbox()`** 去拉 `push_outbox` 并合并（去重）。

- 浏览器版靠 **Service Worker** 收到广播后 postMessage `push_outbox_ready` 触发拉取（`push-outbox-client.ts:290`）。

- **壳没有 Service Worker** → 这个"收到广播就去拉 outbox"的触发没了 → 消息只弹通知、不入聊天。

## 3. 修复（双端，必须一起改）

### 3.1 壳端 `android-shell/.../PushService.kt`

在收到 `broadcast … notify` 后弹通知的**同时**，通知网页去拉 outbox：

```kotlin
// onMessage 里，showMessageNotification(...) 之后追加：
runCatching {
    MainActivity.webViewRef?.post {
        it.evaluateJavascript("window.__float_pull_outbox && window.__float_pull_outbox()", null)
    }
}
```

说明：

- 需要一个可从 PushService 访问到的 `WebView` 引用（`MainActivity.webViewRef`）。

- 若 `MainActivity` 还没有可静态访问的 `webViewRef`，请给它加一个（`companion object { var webViewRef: WebView? = null }`，在 `onCreate` 里赋值）。

### 3.2 前端 `lib/push-outbox-client.ts`

给壳一个可触发拉取的全局函数，放进 `installServerOutboxConsumer`：

```ts
window.__float_pull_outbox = () => requestConsume(true);
```

这样壳收到广播 → 执行 `window.__float_pull_outbox()` → 前端 `requestConsume(true)` → `consumeServerOutbox({force:true})` 拉取并合并进聊天。

> 也可用 `window.addEventListener("float:outbox-ready", ...)` 事件方案，二选一即可。

## 4. 验证

1. 让 float **停在前台**，创建一个 2 分钟后的定时主动消息。
2. 到点应**同时**发生：系统通知弹出 + 聊天列表出现该消息。
3. 杀掉 float 再回来，历史里也应已合并、不重复。

## 5. 注意事项

- 改壳必须**重打包 APK（固定签名）并让用户**覆盖安装。

- `consumeServerOutbox` 已有全局幂等/去重逻辑，重复触发不会造成聊天重复。

- 不要只改前端就以为生效——缺壳侧那行「通知网页去拉」就不会在后台触发。

