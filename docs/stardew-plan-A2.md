# 星露谷联动 · 阶段 A2（工具真实执行）实施计划书

> 目标：让星露谷 App 里 char 能**真实调用**星露谷工具（查状态/查周围/在游戏说话/查时间），走云端中转，复用 float 执行链路。
> 前提已确认：记忆共享、工具隔离、星露谷跳过重排序（向量召回 6 条）、工具执行不触发记忆召回。

---

## 一、现状回顾（已完成）

| 组件 | 位置 | 现有能力 |
|---|---|---|
| Cloudflare Worker | `nagi-butler/worker/worker.js` | `/health` `/message` `/messages` `/reply` `/replies`（KV 消息队列） |
| 管家 (nagi-butler) | `butler.mjs` | 监听游戏 9000 端口收消息→上行 Worker；轮询 Worker 拉回复→送游戏 7842 |
| float 信箱 | `lib/nagi-bridge.ts` | 独立星露谷会话、appId="stardew" 工具隔离、云端拉消息→写会话→char 回复 |
| 星露谷 App | `phone-stardew-app.tsx` | 设置页 + 聊天页 |

---

## 二、目标架构（工具真实执行）

```
[手机 float 星露谷 App 聊天页]
   │  生成回复时，模型决定调用 stardew_get_state
   ▼
float 执行器 executeToolCalls → 命中 star露谷工具 handler（复用 float 执行链路）
   │
   ▼  handler 调云端（因为 NagiBridge 在电脑 localhost，手机够不着）
[Cloudflare Worker nagi.chajianreader.cc.cd]
   │  GET /state , GET /surroundings , POST /game-say
   ▼
[电脑管家 butler.mjs]（持有 NagiBridge 访问权）
   │  定时把 NagiBridge 的 /state、/surroundings 缓存同步到 Worker
   │  收到 /game-say → POST NagiBridge /chat/push
   ▼
[NagiBridge :7842]（游戏本体）
```

**关键设计决策**（已和你确认）：
- **工具真执行**：4 个工具走云端中转代理。
- **复用 float 执行链路**：用 custom_app 工具方式注册 handler。
- **记忆/重排序**：保持现状（星露谷跳过重排序、向量召回 6 条、记忆共享）。

---

## 三、三个"读/写通道"如何打通

| 工具 | 需要的真实数据 | 云端代理方案 |
|---|---|---|
| `stardew_get_state` | NagiBridge `/state` | Worker 新增 `GET /state`，**返回管家缓存的最近一次状态** |
| `stardew_get_surroundings` | NagiBridge `/surroundings` | Worker 新增 `GET /surroundings?radius=N` 同 |
| `stardew_get_time` | `/state` 里的 time 字段 | 复用 `GET /state` |
| `stardew_speak_in_game` | NagiBridge `/chat/push` | Worker 新增 `POST /game-say`，**转发给管家→NagiBridge** |

**"状态缓存"机制**：NagiBridge 在电脑 localhost，手机访问不到，所以：
1. 管家 `butler.mjs` 新增**定时采集**：每 N 秒调 NagiBridge `/state` + `/surroundings`，POST 到 Worker 存 KV。
2. Worker 的 `GET /state`、`GET /surroundings` 只是**读 KV 缓存**（返回最近一次的采集结果）。
3. 这样手机 float 工具调用时，能拿到"接近实时"的游戏状态（延迟 ≈ 管家采集间隔）。

**"在游戏说话"机制**：float 工具 handler → POST Worker `/game-say` → Worker 把它存进回复队列（复用现有 `/reply`）→ 管家轮询到 → POST NagiBridge `/chat/push` → 游戏聊天框显示。

---

## 四、具体实施步骤

### 4.1 改造 Worker（`worker.js`）
1. 新增 `GET /state`：读 KV `game:state` 缓存，返回 `{ok, player, location, time, inventory}`。
2. 新增 `GET /surroundings?radius=N`：读 KV `game:surroundings` 缓存。
3. 新增 `POST /game-say {sender, text}`：等价于现有 `/reply`（进回复队列供管家拉取）。

### 4.2 改造管家（`butler.mjs`）
1. 新增**状态采集循环**：每 `statePollMs`（默认 3000ms）调 NagiBridge `/state`、`/surroundings`，POST 到 Worker `/state`、`/surroundings`（带 X-Nagi-Key）。
2. 复用现有下行逻辑：Worker `/reply` 已有，管家轮询 `/replies` 已实现，`/game-say` 走同一条即可。

### 4.3 float 侧：星露谷工具注册 + handler（`lib/nagi-bridge.ts` / 新文件）
1. 用 **custom_app 工具**声明 4 个星露谷工具（复用 float 执行链路）。
2. 注册 handler，执行时会调云端 Worker 的 `/state`、`/surroundings`、`/game-say`。
3. 这样模型在星露谷会话里调用工具时，executeToolCalls 能命中 handler，真去查状态/发消息。

### 4.4 星露谷聊天页（`phone-stardew-app.tsx`）
- 聊天页已经接好 generateChatCompletion(appId="stardew")，只需确认传入的 session/history 能让模型看到这几个工具（上一步注册后自动生效）。

### 4.5 部署与验证
- `wrangler deploy`（Worker）、推 main（float）、重启管家（本地）。
- 端到端验证：游戏里发消息 → float 星露谷聊天 → char 调 stardew_get_state → 返回真实状态 → char 回复里引用状态。

---

## 五、风险与规避

| 风险 | 规避 |
|---|---|
| 工具执行触发记忆召回（你的担心） | ✅ 已确认：executeToolCalls 是纯执行，记忆召回只在 generateChatCompletion 开头一次，工具循环不触发 |
| 状态不实时（手机拿的是缓存） | 缓存是管家最近一次采集（间隔可配），对聊天足够实时；`.stardew` 游戏内每 10 分钟才变一次，延迟可接受 |
| Worker 只读缓存拿不到最新 | 管家采集失败时，Worker 返回 `{ok:false, stale:true, ...}`，float 端提示"游戏数据暂不可用"，不阻塞聊天 |
| "在游戏说话"和 char 回复撞车 | `/game-say` 走回复队列，与 char 回复用同一队列，顺序一致不会乱 |
| NagiBridge 未开（游戏没启动） | Worker 返回游戏离线提示，char 用对话回复，不硬调工具 |

---

## 六、验收标准
1. 星露谷 App 聊天页，char 能调用 `stardew_get_state` 并返回**真实**玩家状态（位置/时间/金钱/背包）。
2. char 能调用 `stardew_speak_in_game`，游戏聊天框出现对应文字。
3. 工具执行全程不触发记忆召回（可看网络/日志确认无多余记忆请求）。
4. 主聊天工具、重排序、记忆完全不受影响。

---

## 七、不做的事（边界）
- 不做复杂记忆的改动（保持按 char 全局共享）。
- 不做主聊天的重排序改动（仅星露谷跳过）。
- 不做游戏"行动类"工具（浇水/种田/钓鱼，留到以后阶段）——本阶段只做 4 个只读+聊天工具。
- 不做截图聊天（另立阶段）。