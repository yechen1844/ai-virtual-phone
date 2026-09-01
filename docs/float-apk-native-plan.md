# float APK 原生能力二期 · 计划书（保活 / 悬浮球 / 玩具）

> 状态：待评审
> 主题：彻底删除账号依赖（消除"未登录或站点不可达"提示）+ 内置静音音频本地保活 + 系统级悬浮球 + char 玩具工具。

***

## 一、背景与目标

当前 float 安卓壳（`android-shell/`）的**离线推送服务** **`PushService`** **依赖登录账号**：它用 WebView 登录 Cookie 调 `/api/auth/me` 拿 user id，拿不到就提示"**未登录或站点不可达**"。

现状结论：**我们没有 float 账号、也没有登录流程，环境变量恒为 true** → 这条账号依赖是错的，直接导致保活/下载一直报"未登录或站点不可达"。

本计划目标：

1. **删除全部账号依赖**（保活不再尝试拉账号/连站点）。
2. **保活改为内置静音音频本地循环**（`res/raw/*.wav` + 原生 MediaPlayer 循环，前台服务承载，无需网络/账号）。
3. **系统级悬浮球**：关闭 float 界面后仍悬浮在屏幕上的 overlay（`SYSTEM_ALERT_WINDOW`），由前台服务承载。
4. **玩具控制**：给 char 声明工具（tool-calling），工具调原生 `FloatBle` 发 BLE 指令控制玩具（ANKNI MX 协议）。

***

## 二、要删除的账号依赖（定位清单）

集中在 `android-shell/app/src/main/java/app/floatphone/shell/PushService.kt`：

| 删除项                                         | 现状        | 处置                |
| ------------------------------------------- | --------- | ----------------- |
| `fetchConfig()` 里的 `/api/auth/me` + user id | 拿账号       | 整块移除              |
| `registerShellSubscription(cookie, userId)` | 用账号注册推送订阅 | 整块移除（无账号即无效）      |
| `connectionLoop()` 的"未登录或站点不可达"提示           | 误导性报错     | 改为纯本地保活，不再打印账号类错误 |
| `PushConfig`（supabaseUrl/anonKey/userId）    | 账号连接参数    | 移除                |
| OkHttp WebSocket 长连接（订阅 shellpush）          | 依赖账号频道    | 移除或保留纯本地（不订阅账号）   |

> 原则：**保活服务完全本地化**，不读 Cookie、不调站点接口、不依赖任何账号字段。

***

## 三、架构总览：一个前台服务承载全部

新建**一个前台服务**，作为保活 + 悬浮球的地基（替换/扩展现有 `PushService`）：

```
KeepAliveService（前台服务，常驻通知）
  ├── 静音音频循环（MediaPlayer 循环 res/raw silence）→ 系统认为是"播放中"，存活优先级高
  ├── 悬浮球 overlay（WindowManager，SYSTEM_ALERT_WINDOW）→ 退出飞机界面仍显示
  └── 提供 JS 桥给网页启动/停止（window.FloatKeepAlive）
```

- **保活**：前台服务 + 常驻通知 + 静音音频循环。**不依赖账号/网络**。

- **悬浮球**：同一个服务向 `WindowManager` 添加 overlay view；关掉 float 界面后服务仍在 → 悬浮球仍在。

***

## 四、三个子能力

### 4.1 保活服务（本地静音音频）

- 新增 `res/raw/silence.wav`（20 秒静音，循环播放）。

- 前台服务持有 `MediaPlayer`(loop) + 常驻通知（优先级低、常驻）。

- 网页桥：`window.FloatKeepAlive.start() / stop() / status()`，让 float 网页能启停。

### 4.2 系统级悬浮球（overlay）

- 权限：`SYSTEM_ALERT_WINDOW`（`appop`，运行时引导授权）。

- 前台服务的 `onStartCommand` 里用 `WindowManager` 添加一个小圆球 view（可拖动）。

- 网页桥：`window.FloatFloating.show()/hide()/move()`；点击可回主界面或打开控制面板。

- **关键**：即使 float 页面被关/最小化，前台服务存活 → 悬浮球仍在。

- 悬浮球的"内容"（玩具面板、桌宠形象）先在 overlay 里放简洁 HTML/自定义 view，后续扩展。

### 4.3 玩具控制（char 工具 → FloatBle）

- **工具声明在 float 网页/管家侧**（重命名 char 工具，让 char 能调用），**APK 只提供执行桥** **`window.FloatBle`**（已实现）。

- 例：管家注册工具 `toy_control(suction, vibration)` → 网页触发 → `FloatBle.write(…)` 发 `AA 01 02 [吮吸][震动][校验和]`。

- 复用 roche-toy-plugin 的 **ANKNI MX 协议**逻辑，但把它的"Web Bluetooth"分支去掉，只接原生 `FloatBle`。

***

## 五、网页侧要接入的 JS 桥（"连接代码"）

| 桥                       | 方法                          | 网页用法         |
| ----------------------- | --------------------------- | ------------ |
| `window.FloatKeepAlive` | `start()/stop()/status()`   | 启动/停止保活      |
| `window.FloatFloating`  | `show()/hide()/move()`      | 控制系统悬浮球      |
| `window.FloatBle`（已有）   | `scan/connect/write/notify` | char 工具 → 玩具 |

***

## 六、实施步骤（每步独立 commit，可回退）

1. **删账号依赖 + 本地静音保活服务**

   - 新增 `KeepAliveService.kt`（前台服务 + silence.wav 循环）。

   - 删除 `PushService` 里账号相关逻辑；主链路由 `KeepAliveService` 接管。

   - manifest：加 `SYSTEM_ALERT_WINDOW`、`FOREGROUND_SERVICE`（已有）、静音资源 `res/raw/silence.wav`。
2. **系统悬浮球 overlay**

   - `KeepAliveService` 挂 `WindowManager` overlay view + 拖动逻辑。

   - 授权引导（`ACTION_MANAGE_OVERLAY_PERMISSION`）。
3. **玩具工具对接**

   - float 网页/管家侧注册 `toy_control` char 工具 → 调 `FloatBle`。

   - APK 侧确认 `FloatBle` 桥可用（已实现）。
4. **真机验证**（关掉界面看悬浮球仍在、静音保活通知在、玩具可控制）。

***

## 七、验证（真机）

- 保活：通知栏常驻"float 保活"；杀掉后/切后台仍存活。

- 悬浮球：点 Home/退出 float，球仍在屏幕；可拖动、点击回 float。

- 玩具：char 调用工具 → 玩具震动（`FloatBle` 连接 + 写入）。

- 无账号：全流程不出现"未登录或站点不可达"。

***

## 八、不做（边界）

- 不实现无账号下的"离线推送接收"（没有身份可订阅频道）。

- 悬浮球内容先做基础外壳（球/拖动/回浮点），桌宠形象、玩具面板 UI 后续扩展。

- 不改站点域名 / 不改在线逻辑。

