# float 打包成安卓 APK · 完整实战指南

> 适用：把 float（网页版）打包成 Android APK 壳，并打通「后台通知 + 离线推送/定时主动消息」。
> 全部内容基于真实踩坑整理。**全程遵守隐私纪律：凡涉及令牌、密钥、token、域名、项目 ID、Cookie，一律用** **`<占位>`** **表示，绝不写入真实值。**

***

## 0. 为什么决定打包 APK（起因）

- 现象：手机浏览器 / Chrome PWA 打开 float，**弹软键盘（开/收）会偶发整屏闪黑**。

- 排查结论：黑屏是 **Chrome 的 standalone(全屏 PWA) 环境下、软键盘改变视口时浏览器重合成整壳画面**导致的；跟网页是否用毛玻璃、是否位移整壳都只是放大器，**真因在浏览器/PWA 环境本身**。

- 关键的对照实验：

  - 同手机 Chrome 标签（浏览器模式）→ 不黑；

  - 同手机 **PWA 全屏图标 / Edge**（全屏 standalone）→ 黑。

  - 说明黑屏绑定「全屏 standalone 的 WebView/合成器」，而不是页面代码。

- 于是**改用原生 Android WebView 壳（APK）**，绕开 Chrome PWA 那套 standalone 环境。装 APK 后黑屏消失。

> 教训：先分清「到底是不是浏览器环境特有」。不要一开始就跑进页面代码里改毛玻璃/位移，都是绕。

***

## 1. APK 壳怎么来的（架构）

float 自带一个 **`android-shell`** 安卓工程（Kotlin + WebView）。我们复用它：

- 一个 `MainActivity`，加载在线站点 `<你的站点>` 的全屏 WebView。

- 若干通过 `WebView.addJavascriptInterface` 注入网页的原生桥：

  - `AndroidShell`（改名/全屏/通知/下载等）

  - `FloatBle`（蓝牙 BLE）

  - `FloatKeepAlive`（保活/悬浮球）

- 一个前台 `PushService`：不依赖 Google FCM 的自建长连接（OkHttp WebSocket 直连 Supabase Realtime）。

***

## 2. 打包环境与依赖（先装齐）

| 依赖          | 要求                      | 说明                                     |
| ----------- | ----------------------- | -------------------------------------- |
| Node.js     | 18+                     | 构建/脚本用                                 |
| JDK         | **21+**（自带 jlink）       | 17 会因部分依赖编译失败                          |
| Android SDK | Android Studio 的 SDK 即可 | 自动探测 `%LOCALAPPDATA%\Android\Sdk` 等    |
| Gradle      | 随工程                     | 中文路径需 `android.overridePathCheck=true` |

打包入口：`build-apk.cmd`（调 `build-apk.ps1`），或用 CI（GitHub Actions）构建 `app-debug.apk`。

***

## 3. APK 侧的改造清单（坑逐个）

### 3.1 改名 float + 换图标 + 沉浸式全屏

- 应用名 → `float`；图标 → 站点 PWA 图标。

- 全屏：`windowFullscreen=true` + `onCreate` 时立刻 `hideSystemBars()`（隐藏状态栏**和**导航栏）。

- **坑**：只看 `flags` 不够——要主题里 `windowFullscreen` + 立即隐藏，否则首帧出现黑条/底部导航条。

### 3.2 固定签名（非常重要）

- 第一次生成的 debug 签名每次构建都会变 → 装新包必须卸旧包。

- 解决：生成固定 keystore，**debug 与 release 共用**，并把签名密钥放到 CI（GitHub Secrets）里。

- **教训**：私钥一丢就再也无法原签名升级，只能卸载重装。keystore 要单独备份保密。

### 3.3 后台保活 + 悬浮球

- 前台 Service + 常驻通知 + **内置 20 秒静音音频循环**（`res/raw/silence.wav`，MediaPlayer，音量 0，不抢音频焦点），存活优先级高且不影响前台放歌。

- 悬浮球：`SYSTEM_ALERT_WINDOW` overlay，**默认不显示**，只在需要时由网页调 `showBall()`。

- **坑**：别用网页内 fixed 小球当"系统悬浮球"——真正要的是「关掉 float 界面后仍悬浮在屏幕」的 overlay，必须依赖原生悬浮窗 + 前台服务承载。蓝牙玩具那套的悬浮球跟这个不是一回事。

### 3.4 浏览器 vs APK 的本质差异（反复踩，前三个最要命）

| 能力                                         | 浏览器/PWA   | APK (WebView)             |
| ------------------------------------------ | --------- | ------------------------- |
| Service Worker (`navigator.serviceWorker`) | ✅ 有       | ❌ 没有                      |
| `Notification` / `PushManager`             | ✅（需授权/支持） | ❌ 依赖受限                    |
| Web Push 离线推送                              | ✅（靠 SW）   | ❌ 走不通，得用原生长连接             |
| 下载文件                                       | ✅ 浏览器触发   | ❌ 需 `setDownloadListener` |
| 全屏 standalone 合成导致的键盘黑屏                    | ⚠️ 偶发闪黑   | ✅ 无（这就是打包 APK 的原因）        |

**一句话**：所有"依赖浏览器 Service Worker 的能力"，在 APK 里都要换原生方案。这是理解后面所有坑的钥匙。

***

## 4. 消息推送：先把两个概念分清楚

- **后台通知**：float 页面(WebView)还活着，char 发消息 → 前端**直接调壳** `AndroidShell.showNotification()` 弹原生通知。**不经过云端。**

- **离线预览/定时主动消息**：走云端生成 → 回传 → 弹通知 + 写进聊天。**即使杀掉 float 也能收**（前提是壳的前台长连接还活着）。

之前整天混一起、改来改去，是因为没先分清这两条路。**先分清，再定位。**

***

## 5. 「站点不可达 / 未登录」这个坑（绕了最久）

### 现象

浏览器打开没事；一装进 APK 就提示「站点不可达 / 未登录」。

### 根因

壳的 `PushService.fetchConfig()` **一开始依赖站点 Cookie**（`getCookie(SITE_URL)`）去拿身份。但 float **自托管模式（`NEXT_PUBLIC_SELF_HOSTED_MODE=true`）免登录、页面不留 Cookie** → `getCookie` 返回 null → 壳误判"未登录/站点不可达"，连 Realtime 长连接都不建。

### 解决思路

- 不要再强求"登录/Cookie"。

- 壳**直连服务端接口拿身份**（自托管身份），或由**前端把配置通过桥喂给壳**，壳存 `SharedPreferences`，优先用它连 Supabase。

- **教训**：报错文案"站点不可达"没有揭示真因（是"没拿到身份/配置"），导致误判成网络/域名。要顺着"壳到底靠什么拿配置"去查，而不是怀疑网络。

***

## 6. 离线推送全链路（最终打通的完整图）

```
你在 float 创建"定时主动消息"
  → 写入云端 push_jobs (status=pending)
  → pg_cron(每分钟)扫描到期任务
  → 到点调 push-generate (个人云边缘函数)
  → push-generate 调 LLM 生成回复 → status=done
  → 写入 push_outbox (完整文本)
  → 若 exists shell: 订阅(hasShellSub) → 往 Supabase Realtime 广播 shellpush:<userId>
  → 壳 PushService 收到 → 弹系统通知
  → 壳回调前端 window.__float_pull_outbox()
  → 前端 consumeServerOutbox() 拉 push_outbox → parseAndSaveResponse() 写进本地聊天
  → dispatch chat-messages-updated → 前台聊天界面即时渲染
```

**这就是为什么"数据库负责、杀掉后台也能推"**：生成和投递都在云端，壳只要保持 Realtime 长连接就能收。

***

## 7. 离线推送踩的坑（按顺序，攒成血泪）

### 7.1 断点 A：订阅表是空的 → 服务端从不广播

`push-generate` 用 `hasShellSub` 决定要不要广播：

```js
const webSubs = subs.filter(s => !s.endpoint.startsWith("shell:"));
const hasShellSub = webSubs.length < subs.length;
```

个人云 `push_subscriptions` 表**空** → `hasShellSub=false` → **从不广播**。
**解决**：壳必须登记一条 `shell:` 开头的订阅（`registerShellSubscription` 写 `endpoint='shell:<userId>'`）。

### 7.2 断点 B：壳监控的用户 ID 对不上

- 广播 topic 用 `job.user_id`（个人云固定 **`owner`**）→ `shellpush:owner`。

- 壳却硬编码 **`local_user`** → 订阅 `shellpush:local_user`。**频道地址对不上** → 听到广播也收不到。
  **解决**：`PushService.kt` 里使用者 ID 改为与云端一致（`owner`）。**别再用** **`local_user`** 那个自托管身份——那是另一层的前端概念，不是推送归属 ID，很容易误导。

### 7.3 断点 C：弹了通知但没写进聊天

- 广播 payload 只有**标题+一句预览**；完整消息在 `push_outbox`。

- 浏览器靠 **Service Worker** 收广播 → postMessage 触发前端拉 outbox；**壳没有 SW** → 没人触发拉取。
  **解决**：壳收到广播后，`evaluateJavascript("window.__float_pull_outbox && …")` 调网页；前端注册 `window.__float_pull_outbox = () => requestConsume(true)`。

### 7.4 断点 D1：通知里混入"思维链"

`push-generate` 用 `extractResponseText` 抽文本，但对某些 provider（推理没标 `thought`、直接塞进 content）剥不掉 → 思维链混进 `raw_text`，既写进 outbox 又当预览推给用户。
**解决**：生成后做兜底剥离（`reasoning_content`/`<thinking>` 等）再存。**改的是服务端函数，要重新部署个人云。**

### 7.5 断点 D2：outbox 拉不到

前端 `consumeServerOutbox` 有个 gate：

```js
if (!screenChat.enabled && !(await hasAccountPushSubscription())) return;
```

`hasAccountPushSubscription()` 查的是**浏览器 Web Push 订阅**，壳里是空 → **直接 return，连 outbox 都不拉** → 云端消息一直在、本地没有。
**解决**：检测到壳就**放行**这个 gate。判断方式用 `window.AndroidShell` 存在即可（别用 UA 猜）。

### 7.6 断点 D3：写进本地库了，但前台界面不显示

消息其实已写进本地库，但要**重进/回前台**才看得到。
**解决**：`consumeServerOutbox` 消费到数据后 `dispatchEvent(new CustomEvent("chat-messages-updated"))`，让当前聊天界面收到"有新数据"去重画 → 前台即时显示。

***

## 8. 排查方法（APK 没有 F12 怎么办）

APK 里没有浏览器开发者面板、没有 console。**不要指望打日志在真机 console 看。** 改打日志到**云端可查**的地方，或直接查自己的数据库判断：

- 是否被触发、写了没 —— 查个人云表：

  - `push_jobs.status`：`pending → done`（生成是否完成）

  - `push_subscriptions`：有没有 `shell:%` 订阅（广播开没开）

  - `push_outbox.consumed_at`：**是否为空**（为空=前端根本没消费）← 这一列最值钱

- 用 `<你的令牌>` 通过 Supabase 管理 API / Dashboard 查这些表即可判断断在哪一环。

> 教训：与其在真机 console 里瞎调，不如直接看"云端那条到底卡在哪个状态字段"，一步定位。

***

## 9. 已验证的最终正确口径（写死，别改）

1. **壳的推送归属 ID =** **`owner`**（个人云 `job.user_id`），不是 `local_user`。
2. **壳是否 APK 的判定 = 看** **`window.AndroidShell`** **是否存在**，别用 UA。
3. **离线消息要拉出来合并 = 靠壳回调** **`__float_pull_outbox`** **触发前端 consume**（壳没有 SW，必须自己触发）。
4. **拉取 gate 在壳下要放行**。
5. **消费成功后 dispatch** **`chat-messages-updated`** 让前台即时刷新。
6. **服务端函数改动后必须重新部署个人云**；**壳改动后必须重打包并覆盖安装**；只改前端→只重新部署网页。

***

## 10. 尚未完全收尾 / 后续方向（备忘）

- 云端"创建定时主动消息"后，**删除本地计划时是否把云端预约一并撤销**——用户观察到删了有时还在推（多为已派发/延迟收尾），后续可把删除联动云端撤约做彻底。

- 蓝牙玩具 / 系统悬浮球（关掉 float 仍悬浮的 overlay）等原生能力已打好基础，按需再接。

> 记住：本指南全程加密痛点、占位隐私，交接给下一位 Agent 可直接照做、不会泄露任何机密。

