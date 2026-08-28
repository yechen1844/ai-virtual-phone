# 星露谷 Agent 计划书 —— char 作为 AI 玩家（A 方案：复用 NagiBridge tool_agent）

> 核心原则：**不重造轮子**。NagiBridge 的 tool_agent.py 已实现"LLM + 17 游戏工具"的完整 agent 循环，
> 我们只替换它的「输入源」和「大脑」，工具执行与循环逻辑一行不改。

---

## 一、tool_agent.py 现状拆解（读源码确认）

| 组成 | 现状 | 处置 |
|---|---|---|
| **17 个游戏工具** | get_state / get_surroundings / warp / move_to / use_tool / select_item / interact / face / use_item / press_key / run_script / craft / sell / sleep / get_machines / get_animals / give_item / heal | ✅ 完全复用，不写一行 |
| **工具执行器** | `execute_tool()` → 纯 HTTP 调 NagiBridge :7842 | ✅ 完全复用 |
| **agent 循环** | LLM 说调工具 → 执行 → 结果以 tool_result 回喂 → 再问 LLM → 最多 `--max-turns`(默认10) 轮；工具结果超 2000 字符截断；历史超 40 条裁剪到 30 | ✅ 完全复用 |
| **多 provider 适配** | claude / deepseek / openai 兼容格式互转 | ✅ 复用，同时是"接 float"的天然入口 |
| **输入源** | `input("You > ")` 命令行打字，用户一条条敲 | 🔴 **替换** → 改为游戏内聊天 + float |
| **人格** | 写死的 SYSTEM_PROMPT（"You are an AI companion..."） | 🔴 **替换** → float char 的人设+记忆+预设 |

**一句话：这是一套现成的"轮询 + 行动 + 思考下一行动"AI 玩家骨架，我们只换头。**

---

## 二、目标架构（换头术）

```
┌─ 电脑 ────────────────────────────────────────┐
│ 星露谷 + NagiBridge :7842（游戏对讲机，不变）     │
│      ↑ HTTP                                    │
│ char-agent（改造 tool_agent.py）                │
│   · 工具执行器、agent循环 —— 原封不动            │
│   · 输入源：不再 input()，改为监听两个入口        │
│       ① 游戏内聊天（NagiBridge Channel 9000）   │
│       ② float 星露谷App（经管家 /say 转发）      │
│   · 大脑：不再写死 prompt，改为调 float 的        │
│     generateChatCompletion（appId="stardew"）    │
│     → char 带原版人设/记忆/预设思考              │
└──────────────────────────────────────────────┘
```

**char 玩游戏时的一个回合（turn）：**

```
你说"帮我把防风草浇了水"
  ↓（游戏聊天框 / float 星露谷App）
char-agent 收到
  ↓ 调 float char 大脑（人设+记忆+游戏上下文+17工具定义）
char 决定：调 get_state（先看状态）
  ↓ 执行 → 状态回喂给 char
char 决定：调 run_script("water_crops")
  ↓ 执行 → 结果回喂
char 决定：不调工具了，回复"浇好啦，84株都浇了"
  ↓ 回复送回游戏聊天框（/chat/push）
你在游戏里看到她汇报
```

**记忆闭环**：每个回合结束，行动摘要写进 float 星露谷会话 → 复杂记忆蒸馏 → char 记得自己干过什么。

---

## 三、实施步骤（4 步，每步可独立验证）

### 步骤 1：char-agent 骨架（接管输入 + 换脑）
- 复制 tool_agent.py → `nagi-butler/char_agent.py`
- 删掉 `input()` 循环，改成**两个输入源**：
  - 监听 localhost:9000（游戏内聊天，NagiBridge Channel Mode 本来就 POST 到这）——float 端管家已在收，char-agent 也监听同一端口或改由管家转发
  - 暴露 HTTP 端口收 float 侧消息
- 删掉写死的 SYSTEM_PROMPT + 直连 LLM 的 `call_api`，改为：**把 messages 发给 float**（float 端新增一个内部端点/或本地 float 页面驱动 `generateChatCompletion`），拿回 char 的决策（文本 + 工具调用）
- **验收**：游戏里说"帮我看下状态" → char 调 get_state → 游戏聊天框回"你现在在农场，7点30，体力252"

### 步骤 2：float 端"stardew agent 大脑"接口
- float 星露谷 App（电脑端访问）新增驱动方式：
  - 收到 char-agent 的"思考请求"（含最近对话 + 游戏状态摘要）
  - 组装 prompt：char 人设 + 记忆（复杂记忆召回，跳过重排序）+ 17 工具定义 + 当前任务
  - 走 `generateChatCompletion`（appId="stardew"，工具隔离），返回 char 决策
- **验收**：char-agent 发来的思考请求，返回的决策里带正确的工具调用 JSON

### 步骤 3：行动回写记忆
- char-agent 每完成一个任务（任务结束=模型不再调工具），把"行动摘要"（用户指令 + 做了什么 + 结果）写进 float 星露谷会话
- 复用现有 ingestNagiGameMessage 的入库路径 → 复杂记忆自动蒸馏
- **验收**：char 完成浇水后，第二天问她"昨天浇了多少地"，她记得

### 步骤 4：自主循环（可选进阶）
- char-agent 加"自主 tick"：每游戏时段（约7分钟真实时间）无任务时，问一次 char"要主动做点什么吗"（喂状态+记忆+性格）
- 大额消耗有护栏：花钱>500g 先问用户；体力<20% 自动休息；睡觉锁（ready 期间禁移动指令——NagiBridge 已有文档警告）
- **验收**：早上你说"今天你自由活动"，她自己安排浇水、钓鱼、回屋睡觉

---

## 四、复用清单（明确哪些一行不改）

| 组件 | 文件 | 动作 |
|---|---|---|
| 17 工具定义+执行 | NagiBridge/scripts/tool_agent.py 的 TOOLS/execute_tool | 原样搬进 char_agent.py |
| agent 循环结构 | tool_agent.py run() 的 turn 循环 | 结构保留，输入源换掉 |
| 农场自动化 | farm_row/water_crops/mine_run 等 9 个脚本 | 原样保留（run_script 工具调用它们） |
| 游戏侧 | NagiBridge mod（C#） | 不动 |
| 管家 | butler.mjs | 保留传话；云端部分停用不删 |
| float 记忆 | 复杂记忆体系 | 不动，靠会话入库自然进记忆 |
| 星露谷App聊天页 | phone-stardew-app.tsx | 保留（UI已按主聊天气泡修复） |

---

## 五、风险与对策

| 风险 | 对策 |
|---|---|
| float 端大脑不在电脑开浏览器时无法响应 | 阶段1先绑定"电脑端开 float 页面"为前提；后续做无头模式（浏览器后台跑） |
| 工具循环烧 token | 沿用 max-turns=10 + 结果截断 2000 字符 + 历史裁剪，tool_agent 已内置 |
| 多人睡觉死锁（NagiBridge 已知坑） | sleep 工具描述里已有完整警告，char 大脑提示词里再强调一遍 |
| char 行动把存档搞坏 | 先只开放安全工具（浇水/收割/采集），卖出/购买/作弊默认禁用，用户在设置里解锁 |
| 双端消息串号（手机+电脑同时开） | 阶段1只用电脑端；手机端恢复用备份同步（后续优化项） |

---

## 六、验收标准（最终效果）

1. 游戏里对 char 说"帮我浇水" → 她真的走去浇水 → 游戏聊天框汇报结果
2. 她的回复带 float 原版人设（用她的语气说话）
3. 行动进记忆：隔天问她昨天干了什么，她答得上来
4. （步骤4后）说"今天你自由活动"，她自主安排一整天的农活
