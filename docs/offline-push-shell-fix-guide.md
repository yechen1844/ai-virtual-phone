# 离线推送（定时主动消息）修复指南 — 给后续 Agent

> 本指南写给**接手的 Agent**。目标：补齐 float APK 壳的「离线推送」，让**定时主动消息**（关掉后台也能收）真正弹到用户手机。
> 已查明的根因在下方**已定论**部分，直接照着改即可，不用重新推理。

***

## 0. 一句话任务

用户装了 float 的本机壳（Android APK），前台推送（后台通知）已通，但**离线推送 / 定时主动消息**收不到。请按本文修复。

***

## 1. 架构：两条推送通道（务必分清，之前一直混）

| 通道              | 触发方式                                                                                                                                           | 是否经过云端 | 现状   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| **后台通知**        | 页面(WebView)活着、收到 char 消息 → 前端直接调壳 `AndroidShell.showNotification()` 弹原生通知                                                                      | 不走云端   | ✅ 已通 |
| **离线推送/定时主动消息** | 云端 `push-generate` 到点生成 → 写 `push_outbox` → 往 Supabase **Realtime 广播** `shellpush:<userId>` → 壳的 `PushService`（OkHttp WebSocket 长连接）收到 → 弹原生通知 | 走云端    | ❌ 未通 |

本文只修第二条。

***

## 2. 已定论的根因（证据确凿，别再猜）

完整链路的前 4 环全部正常，只断在最后"喊+听"：

```
创建 push_jobs(✅) → cron 到点(✅) → push-generate 生成(✅ status=done)
→ 写 push_outbox(✅) → 【广播→壳  ❌ 这里断】
```

### 断点 A：`push_subscriptions` 表是空的 → 服务端从不广播

`push-generate.mjs`：(`public/ai-phone-push/push-generate.mjs:1081-1082`)

```js
const webSubs = subs.filter(sub => !sub.endpoint.startsWith("shell:"));
const hasShellSub = webSubs.length < subs.length;   // 有“shell:”开头订阅才算 true
```

当个人云库 `push_subscriptions` 表里**没有** `endpoint LIKE 'shell:%'` 的记录时，`hasShellSub=false` → 服务端**压根不往 realtime 广播**。

- 实证：旧表为**空**，故一直不广播。

- 已做临时验证：插入了一条 `(endpoint='shell:manual', user_id='owner')`，`hasShellSub` 变 true → 说明**只要有一条 shell 订阅，广播就会发**。✅

### 断点 B：壳监听的用户 ID（"local\_user"）与云端广播的 ID（"owner"）对不上

- 云端：个人云服务端固定 `OWNER_ID="owner"`，`push_jobs.user_id='owner'` → 广播 topic 用 **`job.user_id`** → **`shellpush:owner`**。

- 壳：`android-shell/.../PushService.kt:138` 硬编码 `val userId = "local_user"` → 订阅 **`realtime:shellpush:local_user`**，且注册 `shell:local_user`。

- 结果：**频道地址对不上**。即便 A 修好、广播发出了，壳也听不见（一个喊"owner"，一个听"local\_user"）。

> 这就是之前"壳订阅 local\_user"的假设是错的 → 必须统一成 `owner`。

***

## 3. 修复方案（精确改动点）

### 核心：把壳的 userId 从 `local_user` 改成 `owner`

文件：`android-shell/app/src/main/java/app/floatphone/shell/PushService.kt`

1. **第 138 行**：

   ```kotlin
   val userId = "local_user"
   ```

   改为（与个人云服务端 OWNER\_ID 一致，这样订阅/注册才能对上广播）：

   ```kotlin
   // 个人云服务端固定以 OWNER_ID="owner" 归属推送（push_jobs.user_id='owner'），
   // 广播 topic 为 shellpush:owner。壳必须用同一个 id，否则“喊 owner / 听 local_user”对不上。
   val userId = "owner"
   ```

   这一处同时修正了：`runSocket` 的订阅 topic（`realtime:shellpush:${userId}`）和 `registerShellSubscription` 注册的 `shell:owner`。

2. **`registerShellSubscription`（\~L160）**：确认它真能把 `(endpoint='shell:<userId>', user_id?)` 写进**个人云**数据库，且 `user_id` 列为 `owner`。

   - 当前实现 POST 到站点 `/api/push/subscribe`。**务必核实该路由是否把订阅写进“个人云”库**（本 fork 用的是 AI Phone Personal Cloud，`push_subscriptions` 在个人云库，实名 `user_id` 列）。

   - 若站点路由写不到个人云库 → 改为直接用**个人云**的 subscribe/REST 端点（个人云网关 `gateway.mjs` 有 `action=subscribe`），或壳直接用个人云 SUPABASE REST insert（用壳持有的个人云 url + key），确保写的是 `user_id='owner'`。

   - 目标结果：个人云 `push_subscriptions` 出现一行 `endpoint='shell:owner', user_id='owner'`。

### 验证点（改完后自查表）

- [ ] 壳 `PushService` 注册成功 → 个人云 `push_subscriptions` 有 `shell:owner`

- [ ] 壳订阅 topic 为 `realtime:shellpush:owner`

- [ ] 删除上文临时插入的 `shell:manual` 记录（避免残留干扰）

- [ ] 重新打包 APK（固定签名 keystore 在 `C:\Users\Ailu\.float-sign\float.keystore`），装到手机覆盖安装

***

## 4. 用户侧验证流程

1. 手机装新 APK，打开 float。
2. 聊天设置 → 打开「离线推送」开关（壳下会触发 `registerShellSubscription` → 云端出现 `shell:owner`）。
3. 在「定时主动消息」里创建一个 **2 分钟**后触发的任务。
4. 杀掉 float 前台（让它进系统被回收）or 退到后台等待。
5. 到点应收到**系统通知**；聊天里刷新后也能看到生成的消息。

排查手段（若还不通）：

- 个人云库：`select endpoint,user_id from push_subscriptions where endpoint like 'shell:%'` → 应有 `shell:owner`。

- `push_jobs`：新任务应 `status` 从 `pending`→`done`。

- `push-generate` 日志：到点应有实际业务执行（不是只有 `booted/shutdown`）。

- 对照 `push-generate.mjs:1081` 的 `hasShellSub` 确认广播已发。

***

## 5. 关键文件地图

| 文件                                       | 作用               | 改动点                                       |
| ---------------------------------------- | ---------------- | ----------------------------------------- |
| `android-shell/.../PushService.kt`       | 壳长连接+订阅+弹通知      | L138 `userId` → `owner`；核实 register 写个人云库 |
| `public/ai-phone-push/push-generate.mjs` | 云端生成+选择广播        | L1081 `hasShellSub`（只读依赖）                 |
| `public/ai-phone-push/gateway.mjs`       | 个人云网关            | `action=subscribe` 是壳登记的入口之一              |
| `lib/push-outbox-client.ts`              | 前端拉取 outbox 合并聊天 | 壳收到广播后由壳弹通知，不强制改                          |
| `lib/push-client.ts`                     | 前端离线推送开关         | 壳分支是 localstorage 标志，与广播 topic 无关，一般不动    |

***

## 6. 注意与坑（前人踩过）

1. **别再改回** **`local_user`**。此前所有"站点不可达/未配置/识别不到 APK"的困扰，都是壳身份/桥判定没对上。`owner` 是个人云推送归属的真实 id。
2. **前端** **`enableOfflinePush`** **在壳下目前只写 localstorage 标志**，真正的云端登记靠**壳**的 `registerShellSubscription`。改壳即可，前端不必绕。
3. 广播 topic 用的是 `job.user_id`（=`owner`），不是前端 resolveUserIdentity() 的自托管身份。不要被前端那套"local\_user"误导。
4. 改壳必然要**重打 APK + 用户重装**，属于 APK 层改动，别只改前端就以为生效。

