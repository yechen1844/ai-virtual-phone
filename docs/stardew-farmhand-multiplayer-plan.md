# 星露谷 · char 独立玩家联机计划（NagiBridge farmhand）

## 一、目标

让 char 作为\*\*独立的农场玩家（farmhand）\*\*加入你的星露谷存档，和你（host / 真人玩家）真正一起玩：

* char 有**独立角色、独立位置、独立背包**

* char 能**自主行动**：种田、浇水、砍树、挖矿、钓鱼、卖东西、睡觉、聊天

* 不需要你时刻盯着，char 按自己的判断干活

## 二、现状（已跑通的部分）

* float + 管家 + char\_agent 已连通，能正常生成回复

* char 已能读到 16 个星露谷工具（已加 `forceEnableTools: true`），会调用工具

* 星露谷聊天页已显示"char 正在执行动作…"系统提示

* **当前问题**：float 星露谷工具控制的角色是 **host（端口 7842）** —— 也就是说现在的 char 和你共用**同一个角色**，不是独立的

## 三、关键机制：NagiBridge 双端口

NagiBridge 会自动起两个 HTTP 端口：

| 端口       | 对应角色        | 谁来控制                  |
| -------- | ----------- | --------------------- |
| **7842** | host 角色     | 玩家本人（键盘/手柄）；或某个 AI 控制 |
| **7843** | farmhand 角色 | 另一台"设备/AI"控制的**独立玩家** |

NagiBridge 官方说明（AGENTS.md 原文）：

> "你控制端口 7842（host 角色）。另一个 AI 控制端口 7843（farmhand）。不要动 7843。"

**结论：`7843`** **就是 char 独立玩家的入口。** 只要存档里有第二个玩家（farmhand）在线，NagiBridge 就会在 7843 提供完整 API 来控制它。

## 四、方案总览

```
[星露谷 · 多人存档]
   ├── host 玩家 (7842)   ←  玩家本人（键盘/手柄）
   └── farmhand (7843)    ←  char，通过 float / char_agent 控制
                                 ↑
   把 float 星露谷工具 + char_agent 的端口，从 7842 改到 7843
```

关键点：**玩家自己玩 host（键盘），char 用 farmhand（7843）独立活动**。二者拥有完全不同的角色、位置、背包。

## 五、实施步骤

### 第 1 步：建立多人存档

星露谷人 farmhand 必须依托**多人存档**（不能是单人存档）。

* 进入游戏 → 新建/选择存档 → 用「**多人**」方式开局

* 在游戏内拉第二个角色（farmhand）加入（本地分屏，或局域网/主机邀请）

* 确认存档里有**两个可控制的角色**：一个是你的（host），一个是农工（farmhand）

### 第 2 步：确认 NagiBridge 开了 7843

* 两个角色都在线后，访问 `http://localhost:7843/status` 应返回 `{ worldReady: true }`

* 访问 `http://localhost:7842/status` 是 host（玩家）

### 第 3 步：把 float 星露谷工具端口切到 7843

改动点：

* `lib/nagi-bridge.ts` 的 `NAGIBRIDGE_URL`：默认从 `http://localhost:7842` 改为 `http://localhost:7843`

* `ensureStardewToolsRegistered()` 的 `endpointMap`：所有 endpoint 从 `localhost:7842` 改为 `localhost:7843`

* 效果：float 星露谷工具控制的角色变成 **farmhand**

### 第 4 步：char\_agent 端口切到 7843（若走 char\_agent 路线）

* `char_agent.py` 启动时加 `--port 7843`（或环境变量 `NAGI_GAME_PORT=7843`）

* 让 char\_agent 执行的游戏操作打到 farmhand

### 第 5 步：float 星露谷工具定义补充（可选）

farmhand 也能用全部 17 个工具；但**聊天**（`/chat/push`、`/chat/history`）在 farmhand 端口上同样可用，确保 char 能在游戏里说话。

### 第 6 步：联调测试

1. 你在游戏里用 host 角色移动
2. 对 char 说："去农场帮我浇水"
3. 观察：

   * char 的 farmhand 角色是否**真的传送/移动/浇水**

   * float 星露谷聊天页是否显示工具调用提示

   * 两者位置是否独立（不重叠）

## 六、需要你确认 / 准备

1. **是否接受使用多人存档**（这是 farmhand 独立玩家的前提，不能单人）
2. **farmhand 角色由谁创建/登录**：你手动加入，还是游戏里开邀请
3. **玩家操作方式**：你本人用键盘/手柄玩 host 角色；char 用 farmhand
4. **是否还需要 char\_agent**：如果 float 星露谷 app 能自己执行工具（当前已可），char\_agent 可不用；若想要 char 完全自主行动，可保留 char\_agent 并切 7843

## 七、风险与注意

* **睡觉卡黑屏**：多人模式下 `/sleep` 有卡黑屏风险。NagiBridge 已做修复（`state: ready` 表示在等所有人就绪），此时不要让她移动/起床

* **端口别搞混**：7842 是玩家 host，7843 是 char farmhand。float 控制的是**farmhand**，别把玩家的角色也接管了

* **工具作用于 farmhand**：所有 float 星露谷工具作用于 farmhand，不会影响你的 host 角色（除了共享农场/仓库）

* **管家/云**：float 星露谷聊天页的消息收发仍走管家（7869），游戏控制走 7843，二者分离

* **多人存档断线**：farmhand 掉线会导致 char 暂时失联，需重连存档

## 八、交付物

* [ ] `nagi-bridge.ts` 端口切到 7843

* [ ] `char_agent.py` 默认端口切到 7843（如需）

* [ ] 多人存档建立与 farmhand 角色

* [ ] 联调验证：char 独立移动/干活

