# PR 批次 #130~#139：修复说明与后续路径

> 工作笔记，不入库（保持未跟踪状态）。改动已推送到自己的 fork；对评审的回复已定稿（见一），自测后经工坊助手提交。

## 一、给原作者的回复（已定稿，粘贴到评审评论线程）

粘贴位置：收到那条长评论的 PR（按评论内容判断是 #130），评论下方 Reply。GitHub 评论支持 Markdown，加粗与列表会正常渲染。

---

谢谢这么细致的评审，两个阻断问题的定位都很准。

**关于 llm-http.ts**：确实漏带了。根因是它在 fork 上「适配 OpenCode 网关」的提交里创建，拆 PR 时被我当成了与本批无关的基础设施，但它引入的 fetchLlmPayload 后续改动都在用，于是七个分支集体缺了地基。

**合入方式**：按您建议的第二种——新开底层基础 PR，共享底层件集中进去，后续依次依赖。基础 PR 内容（基于最新 main）：

- `lib/llm-http.ts`：fetchLlmPayload 统一请求出口
- `lib/api-log-store.ts`：底层调用日志存储（含下述第 1/2/3 条建议的修复）
- `lib/stream-preview.ts`：cleanStreamText 流式预览净化
- `lib/chat-storage.ts`：streamChatGeneration 设置项 + isChatStreamingEnabled()
- `lib/llm-provider-adapter.ts`：LlmRequestPayload 增加 serverProxy? 可选字段（llm-http 依赖）

依赖顺序：基础 → A(#130) → B(#131) → C(#132) → D(#133) → 善后(#136/#138/#139)。本地已验证：基础分支单独 `npm run build` 通过；基础 + #130 全部内容叠加后 build 也通过，`Module not found: './llm-http'` 的场景已消除。

**关于 isRealUserHistoryMessage**：确认不是预期行为，感谢抓住这个边界。history 末尾是 tool_result / tool_notice / memory_write_request 时，本次请求是同一次生成在工具循环中的延续，追加「禁止引用工具结果」的续写提示是反效果的。已修复：这三种末尾同样跳过追加，行为与旧逻辑对齐。

**四条建议全部采纳**：

1. **日志环**：50 → 150，条目增加 source 字段（chat / background / qa；后台调用的具体功能名仍在 characterName 标签里，面板现有的来源过滤直接可用）
2. **写放大**：入库前单条截断（消息内容 4000 字符、回复与思维链 8000），另加单环 2MB 序列化体积预算，超预算从最旧丢弃，防止单条超大 prompt 撑爆 localStorage
3. **工坊分流**：改为显式 channel: "qa" | "chat" 字段，characterName === "工坊" 的判断已删除，角色恰好叫「工坊」的聊天不会再被误归档
4. **摘要补提**：不再重发完整 llmMessages，只带系统提示 + 最后一条用户消息 + 本次输出（摘要本来就只针对本轮事件）

`npm run build` 的提醒也收到了——之前确实只跑 dev，ignoreBuildErrors 把 TS 报错挡住了，只有 webpack 模块解析会挂，这次栽的就是这个。相关分支这次都完整跑过了 build，之后提交前都会跑。我自测一轮就把基础 PR 提上来，合入后再依次重提 A~D 和善后系列，到时候再请您逐个过。

---

## 二、已推送到 fork（origin）的内容

| 分支 | 提交 | 内容 |
|---|---|---|
| `main` | `f8389a6` | 评审反馈的 5 项修复（4 文件，+81/−28） |
| `main` | `fe429a5` | chore：gitignore 增补 `.worktrees/`、`.next-*/` |
| `main` | `d05f842` | fix：工坊 Agent 工具循环的日志漏进底层调用日志环（f8389a6 的回归，用户实测发现） |
| `base/llm-foundation` | `3c8af89` | 底层基础件分支（基于 upstream/main `462e91f`，5 文件，+169） |

审查命令：
```
git show f8389a6                      # 5 项修复完整 diff
git show fe429a5                      # gitignore
git diff upstream/main..base/llm-foundation   # 基础分支相对 upstream 的全部内容
```

## 三、f8389a6 修改明细（审 bug 时逐条对照）

### 1. lib/api-log-store.ts（重写，改动最大）

- `DebugInfo` 增加两个可选字段：`source?: "chat" | "background" | "qa"`（调用来源，供日志面板过滤/展示）、`channel?: "chat" | "qa"`（归属环）。
- `MAX_API_LOGS` 50 → 150；新增常量：`MAX_QA_API_LOGS=50`、`MAX_API_LOGS_BYTES=2MB`、`MAX_QA_LOGS_BYTES=1MB`、`MAX_LOG_MESSAGE_CHARS=4000`、`MAX_LOG_RESPONSE_CHARS=8000`。
- `pushApiLog` 分流条件从 `characterName === "工坊"` 改为 `channel === "qa"`。
- 入库前截断：`messages[].content` 4000 字符、`rawResponse`/`reasoning` 8000 字符，截断时追加「…[日志截断：原文共 N 字符]」标记。
- 数量上限之外新增体积预算：序列化超过 2MB 时从最旧丢弃，至少保留 1 条。

**审查要点**：
- 「查看原始」里超长内容现在会看到截断标记——是有意行为（防 localStorage 撑爆），确认能接受。
- 体积预算循环每次迭代 `JSON.stringify` 全量日志，超预算时最多跑约 150 次；频率低（仅在超 2MB 时触发），但逻辑上存在。
- 旧日志数据兼容：两个环的存储 key 没变，旧条目无 `source`/`channel` 字段也不影响读取。

### 2. lib/chat-engine.ts（3 处逻辑改动 + 4 处日志字段）

**a) 续写提示边界修复（评审问的那个行为）**：新增 `isToolFlowHistoryMessage()`，`appendEmptyGenerateGuardMessage` 在 history 末尾为 `tool_result` / `tool_notice` / `memory_write_request` 时同样不追加续写提示——工具循环中段追「禁止引用工具结果」的续写提示是反效果的，确认为非预期行为并修复。

**b) 摘要补提瘦身**：`retryMessages` 从完整 `llmMessages` 改为 `[系统提示(若首条是) + 最后一条 user 消息 + 本次输出 + 补提指令]`。

**c)** 4 处 `pushApiLog` 调用点补 `source: "chat", channel: "chat"`。

**审查要点**：
- 摘要补提上下文变薄：若摘要需要更早对话才能写准，现在拿不到（这是评审建议的方向，可自行判断）。
- 极端边界：末尾消息是「已撤回的工具结果」时会跳过追加（`isToolFlowHistoryMessage` 未检查 `isRetracted`）；该场景实际基本不存在。
- `lastUserMessage` 为 undefined（无任何 user 消息）时补提仍能工作，只是上下文更薄。

### 3. lib/api-helpers.ts

3 处 `pushApiLog` 调用点（simpleLLMCall 的成功/失败/异常路径）补 `source: "background"`，不设 channel（进主环）。无逻辑改动。

### 4. lib/qa-agent-engine.ts

`logQaCall` 补 `source: "qa", channel: "qa"`（`characterName` 仍为「工坊」，仅作显示标签）。无逻辑改动。

### 5. d05f842：修复 f8389a6 引入的回归（工坊日志漏进主环）

**现象**：用户实测发现工坊的调用记录出现在聊天页「底层调用大模型日志」里。

**根因**：工坊答疑 Agent 的原生工具循环并不走 qa-agent-engine 自己的日志（`logQaCall`），而是复用 chat-engine 的 `sendLLMToolStreamRequest`，meta 里只带 `characterName: "工坊"`。旧分流逻辑靠这个名字识别工坊；f8389a6 改成显式 `channel` 字段后，chat-engine 四处调用点硬编码 `channel: "chat"`，工坊这批调用全部漏进主环。

**修复**：新增 `apiLogChannelFor(options)`，从 `options.appId` 派生分流——`appId === "qa"` 归工坊环，其余归主环（"qa" 在全部 appId 取值中为工坊独有）。四处调用点改为展开该函数结果。

**附带行为说明**：工坊原生工具循环的非流式降级路径（qa-agent-engine.ts 内直接 `fetchLlmPayload`）本来就不写日志，新旧行为一致，未改动。

## 四、base/llm-foundation（3c8af89）内容

相对 upstream/main `462e91f` 的 5 个文件：

| 文件 | 改动 |
|---|---|
| `lib/llm-http.ts` | 新增（36 行）：`fetchLlmPayload` 统一请求出口 + serverProxy 转发 |
| `lib/stream-preview.ts` | 新增（27 行）：`cleanStreamText` 流式预览净化 |
| `lib/api-log-store.ts` | 新增：与 main 上 `f8389a6` 同版本 |
| `lib/llm-provider-adapter.ts` | `LlmRequestPayload` + `serverProxy?: boolean` |
| `lib/chat-storage.ts` | `ChatAppSettings` + `streamChatGeneration?: boolean`、新增 `isChatStreamingEnabled()` |

**已验证**：该分支独立 `npm run build` 通过；叠加 #130 全部 diff 后再 build 也通过（`Module not found: './llm-http'` 场景已消除）。

## 五、本地布局

- 主仓库 `main`：完整 fork 线 + 2 个新提交。
- `.worktrees/base/`：基础分支检出。可在此目录直接 `npm run dev` 测试基础分支状态（Node 模块解析会向上找到主仓库的 node_modules，build 已验证可用）。
- `.next-verify/`：沙箱限制删不掉的构建残留，可手动删除。
- `git status` 里 11 个文件的「modified」是 LF/CRLF 行尾假阳性（`autocrlf=true`，在我动手之前就存在），`git diff` 为空。
- 本文档 `docs/pr-130-139-review-response.md` 保持未跟踪，避免将来经共同建设通道混进 upstream。

## 六、后续路径（2026-08-19 深夜更新：pr/A~D 已构造并推送到 fork）

### 已完成

1. ~~回复评审~~ **已完成**：工坊助手提交 #141 时把回复全文折进了 PR 正文。
2. ~~提交基础 PR~~ **已完成**：PR #141（https://github.com/xiaolongbao0709/ai-virtual-phone/pull/141），state=open，基点 = 官方 main 462e91f。
3. ~~构造 pr/A~D 并推送~~ **已完成**：四个分支基于官方最新 main（32ecfcc，含 #134 阅读优化），已推送到 fork。

### 构造方式（不等 #141 合入，直接基于最新 main 堆叠）

因 #141 合入方式未知（普通 merge 则树相同；squash 则 GitHub compare 的 merge-base 退回旧 main，diff 会带出基础件 5 文件造成重复），改为：**pr/A~D 直接基于官方最新 main（32ecfcc）构造，不含基础件文件**。工坊通道对比官方版本时指定 `branch=pr/A`，出来的差异就是干净的 PR 内容，不受 #141 合并方式影响。

构造步骤：
1. 从旧 PR 分支 checkout 目标文件到 pr/A~D worktree（基于 upstream/main 32ecfcc）
2. 去掉已进基础 PR 的文件（api-log-store.ts、stream-preview.ts、chat-storage.ts 的 streamChatGeneration 部分）
3. 折叠评审修复（f8389a6 + d05f842 的最终形态）
4. 叠加官方在旧基线后对目标文件的改动（3 个文件有官方改动：api-helpers.ts 时间戳正则升级、phone-qa-app.tsx 和 chat-room.tsx 的 CustomAppForegroundBoundary）

### 四个分支明细

| 分支 | 提交 | 文件数 | 净改动 | 说明 |
|---|---|---|---|---|
| `pr/A` | 89e4b29 | 5 | +294/−153 | 旧 #130 的 5 文件（chat-engine/api-helpers/chat-offline-storage/offline-prompt-builder/settings-types）+ 评审修复折叠（isToolFlowHistoryMessage 守卫、apiLogChannelFor 分流、摘要补提瘦身、source:background）+ 官方 api-helpers 时间戳正则升级叠加 |
| `pr/B` | 5fda45e | 5 | +353/−7 | 旧 #131 的 5 文件（user-profile-panel/phone-qa-app/preset-manager/qa-agent-engine/qa.css）+ logQaCall 补 source/channel:qa + **剔除 OpenCode 半成品**（3 处 fetchLlmPayload 恢复原生 fetch）+ 官方 phone-qa-app CustomAppForegroundBoundary 叠加 |
| `pr/C` | dfb8cc4 | 4 | +531/−55 | 旧 #132 的 4 文件（chat-room/chat-settings-panel/group-chat-engine/chat.css）+ 官方 chat-room CustomAppForegroundBoundary 叠加 |
| `pr/D` | 29f60e1 | 2 | +11/−10 | 旧 #133 的 2 文件（memory-summarizer/sticker-search-suggest），官方无后续改动，直接取用 |

### 验证

- **叠加构建**：基础件 + A + B + C + D 五提交 cherry-pick 到 verify/all 分支，`next build` 编译阶段通过（✓ Compiled successfully，100s）——当初 7 个 PR 翻车的 `Module not found: './llm-http'` 场景已消除。
- page data 阶段因 worktree 构建环境问题（distDir 路径解析 + 残留构建目录无法清理）失败，与代码无关；这批 PR 未动任何 API 路由。

### 提交指令（给温铎）

**提交顺序：A → B → C → D**（A 是底层依赖，B/C 依赖 A，D 依赖 A 的 api-helpers label 参数）。

每个 PR 走工坊「共同建设」通道，对比官方版本时指定对应分支名。以下为四个 PR 的标题与正文：

---

#### PR A（branch=pr/A）

**标题**：
```
A: fix(chat) 修正预设末尾模型消息时误追加续写请求 + AI 调用日志重构（含评审反馈修复）
```

**正文**：
```
贡献者：温铎（@yechen1844）

这是 A~D 系列的第一个 PR（重提版），依赖基础 PR #141 合入后才能 build（本 PR 不含基础件文件）。

本组为「核心 bug 修复 + 日志底层」层，改动基于旧 #130 重构，并折叠了评审反馈的修复：

1. lib/chat-engine.ts：
   - 修正预设末尾模型消息时误追加续写请求（isRealUserHistoryMessage 守卫）+ 新增 isToolFlowHistoryMessage：history 末尾为 tool_result / tool_notice / memory_write_request 时同样不追加续写提示（工具循环中段追「禁止引用工具结果」是反效果的）
   - AI 调用日志重构：sendLLMStreamRequest / sendLLMRequest / sendLLMToolStreamRequest / sendLLMToolRequest 四处 pushApiLog 调用点接入 apiLogChannelFor(options) 分流（appId === "qa" 归工坊环，其余归主环），不再硬编码 channel
   - 线下摘要补提瘦身：不再重发完整 llmMessages，只带系统提示 + 最后一条 user 消息 + 本次输出

2. lib/api-helpers.ts：3 处 pushApiLog 补 source: "background"（simpleLLMCall 的成功/失败/异常路径）

3. lib/chat-offline-storage.ts、lib/offline-prompt-builder.ts、lib/settings-types.ts：配套调整

评审反馈修复已折叠进本 PR（不再需要单独的修复提交）。旧 #130 可在本 PR 合入后关闭。

---
_经小手机「共同建设」通道提交_
```

---

#### PR B（branch=pr/B）

**标题**：
```
B: feat(工坊) 大模型调用日志 UI：来源过滤/查看原始/思维链 + 答疑引擎接入统一日志
```

**正文**：
```
贡献者：温铎（@yechen1844）

【请结合 A/C/D 一起审阅】本组为「日志/工坊 UI」层，依赖 A 组的日志底层（pushApiLog）。

本次贡献内容：
1. user-profile-panel.tsx：聊天设置页的「底层调用大模型日志」新增——来源过滤、查看原始、思维链展示
2. qa-agent-engine.ts：工坊答疑引擎所有 LLM 调用接入统一日志（logQaCall 带 source: "qa", channel: "qa"，只进工坊右上角「调用记录」）
3. phone-qa-app.tsx：工坊问答界面对接日志入口
4. preset-manager.tsx：预设管理器配套调整
5. styles/qa.css：工坊答疑相关样式

说明：旧 #131 中 qa-agent-engine.ts 混有的 OpenCode 半成品改动（fetchLlmPayload）已剔除，3 处恢复原生 fetch 调用。stream-preview.ts 已进基础 PR #141，本 PR 不含。

---
_经小手机「共同建设」通道提交_
```

---

#### PR C（branch=pr/C）

**标题**：
```
C: feat(chat) 聊天流式生成：线上/线下、单聊/群聊 AI 回复边生成边显示
```

**正文**：
```
贡献者：温铎（@yechen1844）

【请结合 A/B/D 一起审阅】本组为「聊天流式生成」功能，依赖 A 组的 sendLLMStreamRequest / sendLLMToolStreamRequest 与基础 PR #141 的 isChatStreamingEnabled / cleanStreamText。

1. chat-settings-panel.tsx：聊天设置面板新增「流式生成」开关
2. group-chat-engine.ts：群聊引擎接入流式——启用时走 sendLLMStreamRequest / sendLLMToolStreamRequest
3. chat-room.tsx：流式预览接入（线上/线下各一份，生成中实时刷新）+ 阅读优化（滚动跟随仅在用户停在底部附近时才跟随；rAF 合并限频；组件卸载清理挂起帧）
4. chat.css：流式预览相关样式

本组 4 个文件均为干净贡献内容，无任何非贡献的个人改动。stream-preview.ts 与 chat-storage 的 streamChatGeneration / isChatStreamingEnabled 已进基础 PR #141。

---
_经小手机「共同建设」通道提交_
```

---

#### PR D（branch=pr/D）

**标题**：
```
D: feat(chat) 记忆总结来源标签 + 表情搜索联想 UI 优化
```

**正文**：
```
贡献者：温铎（@yechen1844）

【请结合 A/B/C 一起审阅】本组为两个小配套改动，依赖 A 组 api-helpers 新增的 label 参数：

1. memory-summarizer.ts：给记忆总结的 simpleLLMCall 增加请求来源标签 label: "记忆总结·角色名"
2. sticker-search-suggest.tsx：表情搜索联想列表的 UI 微调（贴纸/表情尺寸加大）

本组 2 个文件均为干净贡献内容，无任何非贡献的个人改动。

---
_经小手机「共同建设」通道提交_
```

---

### 旧 PR 处置

#130~#133（旧版）仍 open。等 A~D 重提完成后由管理员关闭或自行关闭。

### 遗留：善后系列（#136/#138/#139）

尚未构造。待 A~D 合入后再处理（文件归属已分析完毕，构造机制相同）。

## 七、遗留决策点

`02c2998`（OpenCode Go/Zen 网关适配）的完整功能（`/api/llm-proxy` 路由、api-settings 配置界面等）仍在 fork main 上未进任何 PR。基础 PR 只带了休眠状态的 `llm-http.ts` + `serverProxy` 类型字段，不影响现有行为；网关功能是否单独提交 upstream 待定。
