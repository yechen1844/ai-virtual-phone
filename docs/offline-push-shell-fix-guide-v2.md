# float APK 离线推送 完整修复指南（第 2 版 · 汇总）

> 目标：让 float 壳（Android APK）的**离线推送 / 定时主动消息**真正工作：
> （1）到点收到系统通知；（2）完整消息**写进 float 聊天记录**；（3）通知里**不含思维链**。
> 本文件是新对话唯一需要的修改说明，已经包含此前零散文档的全部内容。
> 注意：全程**绝不写入/引用任何令牌、密钥、cookie 等隐私**。

***

## 0. 一句话结论（已定论，不用重新推理）

推送链路前 4 环全部正常（`push_jobs` 创建 ✅ → cron 到点 ✅ → `push-generate` 生成 ✅ status=done → 写 `push_outbox` ✅）。
**只断在最后 3 处**，逐一修好即可：

| # | 断点               | 一句话                     | 在哪改                           | 是否重打包 APK |
| - | ---------------- | ----------------------- | ----------------------------- | --------- |
| A | 订阅表空 → 服务端不广播    | 要有一条 `shell:` 订阅才会广播    | 壳自动登记                         | 是         |
| B | 壳广播频道身份对不上       | `local_user` ≠ `owner`  | 壳 `PushService.kt:138`        | 是         |
| C | 弹了通知但没写进聊天       | 壳没触发网页去拉 outbox         | 壳 + 前端                        | 是（壳）      |
| D | 通知里混入思维链 + 写不进聊天 | 生成端没剥离推理 + session 匹配不上 | 服务端 `push-generate`（部署）+ 前端排查 | 否         |

***

## 1. 两条推送通道（务必分清）

| 通道            | 触发                                                                                  | 走云端? | 状态        |
| ------------- | ----------------------------------------------------------------------------------- | ---- | --------- |
| **后台通知**      | 页面(WebView)活着，收到 char 消息 → 前端调壳 `AndroidShell.showNotification()`                   | 否    | ✅ 已通      |
| **离线推送/定时主动** | 云端 generate → 写 outbox → Realtime 广播 `shellpush:<user>` → 壳 PushService 长连接收到 → 弹通知 | 是    | ❌ 修复中（本文） |

本文只修第二条。

***

## 2. 断点 A：`push_subscriptions` 表空 → 服务端从不广播

`public/ai-phone-push/push-generate.mjs:1081-1082`：

```js
const webSubs = subs.filter(sub => !sub.endpoint.startsWith("shell:"));
const hasShellSub = webSubs.length < subs.length;  // 有 shell: 订阅才算 true
```

没有 `shell:` 开头的订阅 → `hasShellSub=false` → 不广播。
**修**：让壳自动登记一条 `shell:` 订阅（见 B 所在壳代码的 `registerShellSubscription`）。

***

## 3. 断点 B：壳用户 ID 用错 —— 必须用 `owner`

- 云端 `push_jobs.user_id = "owner"`，广播 topic 用 `job.user_id` → **`shellpush:owner`**。

- 壳 `android-shell/app/src/main/java/app/floatphone/shell/PushService.kt:138` 硬编码 `userId = "local_user"` → 订阅 `realtime:shellpush:local_user`、注册 `shell:local_user`。**地址对不上**。

**修（`PushService.kt`）**：

```kotlin
// L138：改成与云端一致
val userId = "owner"
```

同时修正：订阅 topic `realtime:shellpush:owner`；`registerShellSubscription("owner")` 注册 `shell:owner`。

### 3.1 确认壳能写进个人云库

`registerShellSubscription` 目前写站点 `/api/push/subscribe`。**务必确认这条订阅最终落在「个人云」数据库** **`push_subscriptions`（user\_id='owner'）**。

- 若站点路由写不到个人云 → 改用个人云网关 `action=subscribe` 或壳直连个人云 SUPABASE REST insert。

- 目标：个人云库出现 `endpoint='shell:owner', user_id='owner'`。

***

## 4. 断点 C：通知弹了，但消息没写进聊天

### 现象

到点弹通知 ✅，聊天无记录 ❌。

### 原因

- 广播 payload 只有**标题 + 一句预览**；完整消息在云端 `push_outbox`，需前端 `consumeServerOutbox()` 拉回合并。

- 浏览器靠 Service Worker 收广播 → postMessage `push_outbox_ready`（`lib/push-outbox-client.ts:290`）触发拉取。

- **壳无 SW** → 触发缺失。

### 修（双端）

**壳** **`PushService.kt`** — 收到 `notify` 弹通知后，再通知网页拉 outbox：

```kotlin
runCatching {
  MainActivity.webViewRef?.post {
    it.evaluateJavascript("window.__float_pull_outbox && window.__float_pull_outbox()", null)
  }
}
```

（若 `MainActivity` 无静态可访问的 `webViewRef`，补一个：`companion object { var webViewRef: WebView? = null }`，在 `onCreate` 赋值。）

**前端** **`lib/push-outbox-client.ts`** — 在 `installServerOutboxConsumer` 里注册全局触发：

```ts
window.__float_pull_outbox = () => requestConsume(true);
```

***

## 5. 断点 D：通知里混入「思维链」+ 写不进聊天

### 现象

1. 聊天仍没有该消息。
2. 推送通知/预览里出现模型**思维链**（推理过程）。

### D1：`raw_text` 混入思维链（服务端生成）

- `push-generate.mjs:618` 用 `extractResponseText` 取文本。

- 只对会标 `thought=true` 的片段跳过（`push-generate.mjs:160-161`）；若你的 provider 把推理直接放 `content` → 剥离失效 → 思维链混进 `raw_text`。
  **修（服务端，需重新部署）**：在 `extractResponseText` / 写 outbox 前兜底剥离：

- 有 `reasoning_content`/`reasoning` 字段 → 用 `content` 覆盖、忽略推理；

- 再去掉 `<thinking>`/`思维链` 等包裹的思维块再 trim。

> 部署：个人云里 Deploy `push-generate`，或 `supabase functions deploy push-generate --project-ref <ref>`。

### D2：消费时会话匹配不上就跳过

- `push-outbox-client.ts:173`：`session = loadChatSessions().find(id===sessionId)`，找不到 `continue` 不消费。

- 若 outbox 的 `session_id/meta.sessionId` 对应当地不存在会话 → 永不写入。
  **修**：确认 outbox 的 session 与前端本地一致（对定时主动消息应能 `createOrGetSession`）；在 `!session` 处打日志输出 `entry.id, sessionId` 定位。

***

## 6. 验证流程（改完一起验）

1. 已改服务端：重新部署个人云 `push-generate`。
2. 已改壳：重新打包 APK（固定签名 keystore `C:\Users\Ailu\.float-sign\float.keystore`），手机覆盖安装。
3. 打开 float → 开「离线推送」→ 确认个人云库出现 `shell:owner`。
4. 停在前台，创建 2 分钟定时主动消息。
5. 到点应：弹通知（**不含思维链**）+ 聊天出现该消息 + 杀掉再回来历史已合并不重复。

排查口径：

- 个人云库 `select endpoint,user_id from push_subscriptions where endpoint like 'shell:%'` → 应有 `shell:owner`。

- `push_jobs` 新任务 `pending→done`。

- `push-generate` 日志到点应有实际执行（不止 boot/shutdown）。

***

## 7. 关键文件地图

| 文件                                       | 作用                  | 改动                                     |
| ---------------------------------------- | ------------------- | -------------------------------------- |
| `android-shell/.../PushService.kt`       | 壳长连接+订阅+弹通知+拉outbox | L138 `userId`→`owner`；C 的 webView 回调   |
| `public/ai-phone-push/push-generate.mjs` | 云端生成+广播             | L618 剥离思维链（部署）                         |
| `public/ai-phone-push/gateway.mjs`       | 个人云网关               | `action=subscribe` 是壳登记入口之一            |
| `lib/push-outbox-client.ts`              | 前端拉 outbox 合并       | 注册 `__float_pull_outbox`；D2 session 排查 |
| `lib/push-client.ts`                     | 前端离线开关              | 一般不动                                   |

***

## 8. 坑（前人踩过，别再踩）

1. **不要改回** **`local_user`** —— `owner` 才是云端推送归属真实 ID。
2. 前端壳下 `enableOfflinePush` 只写 localstorage 标志，**真正云端登记靠壳**的 `registerShellSubscription`，改壳即可。
3. 广播 topic 用 `job.user_id`(=owner)，不是前端 resolveUserIdentity() 的 local\_user，别被误导。
4. 改壳必重打包覆盖安装；改服务端函数必重新部署——只改前端不算生效。
5. 纯隐私纪律：整个修复过程**不得**在代码、文档、日志里写入任何密钥/令牌/cookie。

