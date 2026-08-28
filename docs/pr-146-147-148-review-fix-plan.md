# PR #146 / #147 / #148 评审修复计划书

> 交付前必读。以下所有"我们仓库"指 fork `yechen1844/ai-virtual-phone` 的本仓库本地分支。

## 零、核心结论（先讲明白，不再混淆）

**我们的仓库没有缺任何东西。**

用 `git diff` 逐一对账证明：
- 我们 fork 的 `final/1|2|3`（db3eee9 / 8350f7a / a8ad34f）**比上游 PR head 多一整套 #141 基础件文件**（`api-log-store.ts`、`llm-http.ts`、`llm-provider-adapter.ts`、`stream-preview.ts`），这三个分支自身**互相独立、各自代表一个 PR**。
- 云同步修复 `fda57db`（微信三问题修复）**同时存在于**我们的 `main` 祖先链 和 上游 main —— 我们从来没有丢过它。
- 上游 PR #146/#147/#148 的"阻断/依赖"判断，源于**共同建设通道从我们的 fork 切片生成上游 PR 时，把基础件和相关修复切在了旧基座之外**。不是我们的代码有洞。

**因此三份评审真正的诉求不是"往我们仓库塞东西"，而是：**

1. 每个 PR 的**交付坐标**要对齐官方当前 main（避免把已收走的 fda57db / #141 又覆盖成旧版 → 编译炸）。
2. 一两处**纯观感改动**（ctx-menu 美化）应单独交，别混进功能 PR。
3. 未申报的配套改动（表情清空输入 / 触发按钮逻辑 / sticker-search-suggest）要在 PR 说明里**写清楚**。
4. 若干**真·逻辑小项**（下面逐条列出）。

---

## 一、真·逻辑小项（我们确实需要动手改代码的地方）

### A. 对应 PR #146（进入 final/1）

| # | 评审意见 | 核对现状（在 fork 的 final/1 = db3eee9 上验） | 修法 |
|---|---------|----------------------------------------------|------|
| A1 | 群聊版摘要补提未瘦身，仍重发完整 `llmMessages`，与单聊版不一致 | **属实**。`group-chat-engine.ts` 的离线补提写了 `const retryMessages = [...llmMessages, {role:"assistant",content:rawOutput}]`，完整重发。单聊版已改为「系统提示 + 最后一条 user + 本次输出」 | 把群聊补提对齐单聊版：只带 system + 最后一条 user 消息 + 本次输出 |
| A2 | 增量缓存优化（pushChatMessage 直改 `_sessionsCache` + dbPut，跳过 saveChatSessions）需确认行为对等 | 属评审"请确认"，非硬改 | 逐行核对会话列表排序 / 预览刷新事件 / 存储镜像是否仍成立，报告结论 |
| A3 | 流式分支少传 `debugSessionId`，提示词快照面板在流式下缺会话关联 | **待核对**。流式调用点 `sendLLMStreamRequest(..., { appId: "group_chat" })` 未见 `debugSessionId` | 补传 `options?.debugSessionId` |
| A4 | 阻断一：PR 会连带删掉云同步修复（连续即编译失败） | **我们 fork 已含 fda57db，本条在我们侧不成立**；仅存在于"切片+旧基座"的上游 PR。修法=重切到含 fda57db 的基座 | 重切（见第二章） |
| A5 | 阻断二：与最新 main 在 chat-engine.ts 真实冲突（skipTimestampStrip） | **我们 fork 的 final/1 也没有 skipTimestampStrip**（上游 `d1ca227` 新加的）——这是唯一真正"我们缺、上游有"的新改动 | 重切时引入 skipTimestampStrip，并把 `readSseStream(..., !options?.skipTimestampStrip)` 与 `rawOutput` 三元合成 |

### B. 对应 PR #147（进入 final/2）

| # | 评审意见 | 核对现状（在 fork 的 final/2 = 8350f7a 上验） | 修法 |
|---|---------|----------------------------------------------|------|
| B1 | 恢复 `qa.css` 被删的两行「消息级懒渲染」注释（官方 #135） | **属实**。`styles/qa.css` 只有 `content-visibility: auto;`，上面说明注释没了 | 恢复注释（对齐上游 #135 原文） |
| B2 | 线下「重试」路径的流式预览没走 rAF 合并，每个增量全文重解析，长输出会卡 | 待精确定位 retry 里的 `onOfflineDelta`；首次路径已 walk rAF（`streamParseFrameRef`） | 把 retry 路径的 delta 处理对齐首次路径的 rAF 限频写法 |
| B3 | 两处未申报改动需在 PR 说明申报：表情联想发送后清空输入；「触发回复」按钮有字时改"先发送再触发" | 属申报项，非改代码 | 写进 PR 说明 + 补 sticker-search-suggest 配套关系一句 |
| B4 | ctx-menu 美化（毛玻璃+胶囊+隐藏箭头+字号 12.6→14）拆出去单独提 | **属实**。`chat.css` 含 `--ctx-menu-bg`、`.chat-floating-ctx-menu`、`.ctx-menu-triangle` 等美化 | 从本 PR 拆出，单独成一个小改动/小 PR |

### C. 对应 PR #148（进入 final/3）

| # | 评审意见 | 核对现状（在 fork 的 final/3 = a8ad34f 上验） | 修法 |
|---|---------|----------------------------------------------|------|
| C1 | 顺带在 `regexFromString` 注释补：返回共享实例，g/y 调用方需自行 reset lastIndex 或复制 | **属实**。已有"编译缓存：同一 findRegex 字符串复用编译结果"注释但未说 read-only 约束 | 补一句共享实例 / g-y reset 提示（可选、不阻断） |

---

## 二、交付方式重构（本计划书的核心动作）

### 原则
**以我们的 fork 为唯一真相源，把三个 PR 的交付坐标对齐到官方当前 main，不向任何上游灌入我们的源码之外的东西。**

### 具体步骤（对 A/B/C 三个 PR 各自执行）

1. **取最新上游 main**（`2d96f2e`，已 fetch）作为交付新基座。
2. **取我们的 fork 对应分支**作为内容源：
   - PR #146 ← `final/1`（db3eee9）
   - PR #147 ← `final/2`（8350f7a）
   - PR #148 ← `final/3`（a8ad34f）
3. **以最新上游 main 为基座重建各分支**，把内容源分支相对其基座的"祖传 diff"嫁上去，**冲突手动合并**：
   - 云同步修复 fda57db、#141 基础件、以及我们全部改动都随重切保留（它们本就在我们仓库）。
   - 新引入上游的 `skipTimestampStrip`（d1ca227），按 A5 合成。
4. **逐一执行第一章的修复项**（A1/A2/A3/A4/A5、B1/B2/B3/B4、C1）。
5. **自验**：`tsc --noEmit` + build 全绿，再交付。
6. **交付**：由我们 fork 推送到共同建设通道/为上游 PR 生成新版 head（具体推送目标以届时双方确认为准，本次不擅自推任何未确认的分支）。

### 与评审顺序呼应
评审要求 146 → 147 → 148 依次合入（#147/#148 类型级依赖 #146）。重切后同样保持该顺序提交。

---

## 三、不动的东西 / 红线

- **用户现有工作树与未提交改动绝不覆盖**（prA 工作树有 5 个未提交修改：api-helpers/chat-engine/phone-qa-app/qa-agent-engine/chat-room，全程隔离）。
- 记忆相关提交（58a9ecc / 73d1c80 / c9e563f）与阅读功能（23954e7 及其前文）是仓库的一部分，不因本次交付被改写。
- 不擅自 push 到任何远端；每完成一个 PR 的重建+修复+自验，交用户确认后再送。

---

## 四、交付检查清单（每个 PR 提交前逐条打钩）

- [ ] 云同步修复 fda57db 在重建分支中真实存在（非仅父链）
- [ ] #141 基础件文件随重切保留
- [ ] skipTimestampStrip 按 A5 合成，`readSseStream`/`rawOutput` 两行正确
- [ ] 群聊补提瘦身（A1）
- [ ] 增量缓存行为核对报告（A2）
- [ ] 流式补传 debugSessionId（A3）
- [ ] qa.css 注释恢复（B1）
- [ ] 重试路径 rAF 对齐（B2）
- [ ] PR 说明申报两句 + sticker-search-suggest 配套（B3）
- [ ] ctx-menu 美化拆出（B4）
- [ ] regexFromString 注释（C1）
- [ ] `tsc --noEmit` + build 全绿
- [ ] 用户确认后再 push