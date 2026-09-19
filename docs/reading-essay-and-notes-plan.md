# 阅读·随笔 与 读书笔记 — 计划书

> 状态：**已实施**（2026-09-12）。群聊条数上限与多 char 共读隔离按计划留待后续。
> 验证：`tsc --noEmit` 通过、`next build` 通过、注入逻辑 12 项用例通过。
> 待用户在浏览器内验证：Dexie v5 升级、笔记消息不在主聊天显示、记忆管线吸收。
> 关联代码：`lib/reading-engine.ts`、`lib/reading-storage.ts`、`lib/reading-types.ts`、
> `components/reading/reading-viewer.tsx`、`components/reading/reading-interaction-dialog.tsx`、
> `lib/short-term-assembler.ts`、`lib/builtin-preset.ts`

---

## 一、背景与目标

一起读书时，char 目前有两处记忆断层：

1. **批注没有情感连续性**。批注是自动批量生成的（自动批注 + 预生成），但它：
   - 只在当前窗口注入批注，**不累积**；
   - 调用时**不注入主聊天历史**（见 §三 审计），因此完全不知道你和 char 在私聊/讨论里说过什么。
2. **整次阅读没有"总结产物"**。共读讨论的内容会进主聊天管线，但 char 缺一个"这次我们读了什么、我当时什么感受"的第一人称记录，用于中断后恢复与后续记忆总结。

因此新增两个功能：

| 功能 | 定位 | 解决什么 |
|---|---|---|
| **读书随笔**（essay） | 与摘要同批生成，**每批一条**、两句话、char 第一人称、带当时情绪 | 补上批注缺失的**情感连续性** |
| **读书笔记**（note） | 用户手动触发、每次阅读会话一篇、char 第一人称长文 | 形成**记忆连续性**产物，进入记忆管线，支撑中断后恢复 |

两者都在开头加角色名标识，方便 char 之后以第一人称认出「这是我自己写的」：

- 随笔：`{{char}}的随笔：……`
- 笔记：`{{char}}的读书笔记：……`

---

## 二、已确认的设计决策

| # | 决策 |
|---|---|
| 1 | 随笔**单独建表**（带 `characterId`）；现有摘要保持"全书共享"不变，不动提炼逻辑 |
| 2 | 随笔**每批一条**（与摘要同频，即每次批注批次产出一条） |
| 3 | 随笔**单独上限**到量提炼（与摘要上限分开配置，默认值待定，建议 1500 字） |
| 4 | 笔记**只注入最新一篇**；更早笔记不显式注入，靠 chat 历史 + 长期总结携带 |
| 5 | 笔记的注入**联动**现有开关「回读时仍注入最新前情提要」 |
| 6 | 随笔与笔记**都注入**后续共读讨论与批注上下文 |
| 7 | 笔记触发按钮放在**共读聊天悬浮窗内** |
| 8 | 笔记以 char 视角第一人称写，开头固定 `{{char}}的读书笔记` |
| 9 | 笔记**全部保留**（不压缩） |
| 10 | 批注注入主聊天历史：**加开关，默认开启**，包含共读讨论消息 |
| 11 | 阅读的短期条数上限：**与主聊天对齐** |
| 12 | 批注提示词加约束：聊天历史仅作背景，批注仍只评论书内容 |

### 待定项（明确不在本期做）

- **群聊的条数上限**：`prepareGroupShortTermContext` 签名缺参数，群聊多人时的取值规则（取启用者最小值 / 发起人配置）**以后再说**。
- **多个 char 共读同一本书**的隔离：目前按"一本书一个 char"设计，多 char 场景以后再说。
- 预设条目更新方式：由用户在预设系统手动复制同步（不在本期自动化）。

---

## 三、已查实的现状（关键事实，供实施时对照）

### 3.1 阅读的两个入口与它们的上下文差异

| | 注入来源 A：时间线投影 | 注入来源 B：原始聊天轮次 |
|---|---|---|
| **共读讨论** `generateReadingChat` | 仅其它 app 条目（direct 块被 skip 防重复）+ 共读开始/结束标记 | ✅ 传了 `history`（`loadChatMessages(session.id)`） |
| **批注** `generateAnnotationBatch` | 同上（direct 块同样被 skip） | ❌ **没传**，`history` 为空数组 |

关键代码：
- 讨论传 history：`lib/reading-engine.ts:432`
- 批注未传 history：`lib/reading-engine.ts:294-300`
- 短期记忆两部分来源：`lib/short-term-assembler.ts:1055`（`const history = options?.history ?? [];`）、`:1208-1211`
- direct 聊天投影在 `appId === "chat"` 时被跳过：`lib/short-term-assembler.ts:1058`、`:1160-1165`
- 私聊消息确实会被投影进时间线：`lib/short-term-assembler.ts:419-425`

**结论**：批注拿不到任何主聊天对话内容（原始轮次为空，且时间线的 direct 投影被跳过）。但它照常拿到其它 app 的时间线条目 + 核心/长期记忆。

### 3.2 全 app 审计：「固定短期条数」只有主聊天在遵守

`maxShortTermEntries`（= 复杂记忆的 `fixedShortTermEntries`，当前配置 100 条）全仓库**只有 1 处传入**：
`lib/chat-engine.ts:1944`。

其余入口**全部漏传**（只受 10 万 token 预算约束）：

| 入口 | 位置 |
|---|---|
| 阅读（讨论+批注） | `lib/reading-engine.ts:111` |
| 观影 | `lib/movie-engine.ts:92` |
| 群聊 | `lib/group-chat-engine.ts:349`、`:408`（且群聊函数签名缺该参数） |
| 小红书 | `lib/xiaohongshu-engine.ts:1083` |
| 朋友圈 | `lib/moments-engine.ts:228`、`:259` |
| 查手机 | `lib/checkphone-engine.ts:129`、`:1186` |
| 剧情 / 视觉小说 | `lib/story-engine.ts:194` / `lib/vn-engine.ts:148` |
| 地图冒险 / 游戏 | `lib/map-rpg-engine.ts:1037` / `lib/game-engine.ts:90` |
| 住处 / 日记 / 留言墙 / 日历 | `lib/dwelling-engine.ts:61` / `diary-entry-engine.ts:58` / `notewall-engine.ts:135` / `calendar-engine.ts:190` |
| 共创 / 黑市 / 自定义app / 微信云同步 | `lib/cocreate-engine.ts:489,774` / `black-market-scene-engine.ts:130` / `custom-app-host-api.ts:2146` / `weixin-cloud-sync.ts:1073` |

代码注释本意是「默认取 fixedShortTermEntries」（`lib/short-term-assembler.ts:1226`），实际未生效。

---

## 四、数据模型

### 4.1 新增类型（`lib/reading-types.ts`）

```ts
/** 读书随笔：与摘要同批生成，绑定单个角色，承载当时的情绪。 */
export type ReadingEssay = {
    id: string;
    bookId: string;
    characterId: string;
    characterName: string;
    /** 所属批次位置（与同批摘要一致），注入时按位置判定 */
    chapterIndex: number;
    startParagraph: number;
    endParagraph: number;
    /** 两句左右的第一人称随笔（存储时带「{{char}}的随笔：」前缀） */
    content: string;
    isDistilled: boolean;
    /** 提炼随笔覆盖到的最后位置；仅 isDistilled 时有值 */
    distilledUpTo?: number;
    createdAt: string;
};

/** 读书笔记：每次阅读会话一篇，用户手动触发，第一人称长文。 */
export type ReadingNote = {
    id: string;
    bookId: string;
    characterId: string;
    characterName: string;
    /** 本笔记覆盖的阅读位置区间（用于中断恢复与注入判定） */
    startChapterIndex: number;
    startParagraph: number;
    endChapterIndex: number;
    endParagraph: number;
    /** 正文（存储时带「{{char}}的读书笔记：」前缀） */
    content: string;
    /** 对应的聊天消息 id（笔记同时以 chat 消息形式存在，便于走记忆管线） */
    messageId?: string;
    createdAt: string;
};
```

### 4.2 存储（`lib/reading-storage.ts`，Dexie 版本 4 → 5）

```
essays:  "id, bookId, [bookId+characterId], [bookId+characterId+chapterIndex]"
notes:   "id, bookId, [bookId+characterId]"
```

- 新增缓存：`_essaysCache`、`_notesCache`（key 用 `bookId:characterId`）
- 新增 API：`loadEssays / saveEssay / loadNotes / saveNote / deleteBook` 时一并清理
- 删除书籍时同步删除 essays / notes

### 4.3 聊天消息承载（用于记忆管线）

笔记**同时**存为该 char 私聊会话中的一条 chat 消息：

- `ChatMessage.origin` 联合类型新增 `"reading_note"`（`lib/chat-storage.ts:127`）
- 新增 `isReadingNoteMessage()` 判定函数
- 需同步处理的位置：
  - 主聊天不渲染：`components/chat/chat-room.tsx:5102` 附近加排除
  - 会话列表预览排除：`lib/chat-storage.ts:451` 附近加排除
  - 查手机排除：`lib/checkphone-engine.ts:929` 附近加排除
  - 短期装配器：让笔记**内容**作为时间线条目保留（不被折叠），使其进入短期/长期总结

---

## 五、功能一：读书随笔

### 5.1 生成

- 在 `reading_annotation` 预设（`lib/builtin-preset.ts:3848`）的输出要求中，追加：
  > 另外，用 `<essay>两句左右</essay>` 写下你此刻读这段的真实感受或情绪波动（第一人称，像随手记下的一点心绪，不要复述剧情，不要分析）。
- `generateAnnotationBatch` 解析 `<essay>…</essay>`，产出 `ReadingEssay`（复用同批的 `chapterIndex/startParagraph/endParagraph`）
- 返回值扩展为 `{ annotations, summary, essay }`
- 调用方 `executeBatchAnnotation`（`components/reading/reading-viewer.tsx:1018` 附近）在保存摘要旁一并保存随笔；去重规则与摘要一致（同批范围已存在则不重复生成）
- 存储内容写入前缀：`{{char}}的随笔：`（实际写入角色名）

### 5.2 提炼（到量压缩）

- 复用摘要的提炼思路，但**独立阈值**（`readingConfig.maxEssayChars`，默认建议 1500）
- `getDistillableEssays()` / `distillEssaysIfNeeded()`：与摘要同构
- 提炼以「最新提炼 + 未被覆盖的普通随笔」为源；提炼时 `distilledUpTo` **截断到当前阅读位置**（避免预生成超前导致提炼长期无法接管）
- 旧随笔不删除，仅不注入

### 5.3 注入

与摘要位置判定同构，作用于**共读讨论 + 批注**两条链路：

- 普通随笔：`endParagraph ≤ 当前位置` 才注入
- 提炼随笔：`当前位置 > distilledUpTo` 才注入，且只取覆盖最远的一条
- 被当前生效的提炼随笔覆盖的旧随笔不重复注入
- 开关联动：开启「回读时仍注入最新前情提要」时，随笔也始终注入最新/最全的

注入文本块（追加到现有 `<reading_summary>` 之后）：

```
<reading_essay>
以下是{{char}}之前读这本书时留下的随笔，保留着当时的情绪：
【第N章 · 段落X-Y】{{char}}的随笔：……
</reading_essay>
```

---

## 六、功能二：读书笔记

### 6.1 触发

- 入口：共读聊天悬浮窗内新增按钮「写读书笔记」
- 前置：需已绑定伴读角色与 API；阅读位置有效
- 交互：点击 → 生成中状态 → 成功后提示「已生成」并提供「查看」；失败给可读错误

### 6.2 输入（注入什么）

调用新的 `generateReadingNote(session, book, characterId, context)`，其上下文 = **与共读讨论同级**的完整上下文（由 `resolveReadingInput(characterId, ["reading","note"], …)` 装配）：

- 核心记忆 / 长期记忆 / 短期时间线（含主聊天历史）
- 当前阅读位置的正文窗口（复用 `buildDiscussContext`）
- 当前窗口批注
- **摘要**（当前位置应注入的那批）
- **随笔**（当前位置应注入的那批）
- 新增 `reading_note` 预设条目，提示词要求：以 `{{char}}` 第一人称，写这次一起读到哪、发生了什么、当时的心情与想法；开头固定输出 `{{char}}的读书笔记`

### 6.3 产出与去向

1. 写入 `notes` 表（带覆盖位置区间）
2. 同时作为一条 chat 消息写入该 char 私聊会话（`origin: "reading_note"`），使其进入主聊天记忆管线
3. 内容前缀：`{{char}}的读书笔记：`（写入角色名）

### 6.4 注入

- **只注入最新一篇**满足「覆盖起点已读」的笔记
- 开关联动：开启「回读时仍注入最新前情提要」时，始终注入最新一篇
- 更早的笔记不显式注入（已在 chat 历史中，由短期/长期记忆携带）

注入文本块：

```
<reading_note>
{{char}}最近一次和你共读后写下的读书笔记：
{{char}}的读书笔记：……
</reading_note>
```

### 6.5 中断与恢复的冗余（重点）

由于"一次读完整本书"很少发生，必须支持反复中断：

| 场景 | 处理 |
|---|---|
| 读一半 → 写笔记 → 关闭 | 笔记记录**覆盖位置区间**；下次打开阅读，注入口径按位置判定（见 §6.4），char 能"想起"上次读到哪 |
| 同一本书写多篇笔记 | 全部保留；仅最新一篇参与显式注入；更早的由记忆管线携带 |
| 中断后再写一篇（位置有重叠） | 允许生成；不做位置去重（笔记是"会话产物"，重叠代表再次阅读的感受） |
| 未绑定角色 / 无摘要随笔 | 仍允许生成笔记（上下文缺项时降级，不阻塞） |
| 生成失败 | 不写入任何存储，提示失败原因，可重试；不产生半成品 |
| 生成中切书/切角色 | 用 bookId/characterId 校验，结果过期则丢弃，不污染当前 UI（沿用 `bookIdRef` 现有模式） |
| 笔记消息与总聊天的关系 | 作为 `origin:"reading_note"` 消息**以「读书便签」专属卡样式显示在主聊天**（不套普通气泡）；会话预览与查手机仍排除。因此 char 在主聊天历史中以第一人称读到它 |

---

## 七、附带修复（本次一并做）

### 7.1 批注注入主聊天历史（治本）

**改动**：`generateAnnotationBatch` 增加 `history` 入参，调用方传入该 char 私聊会话的消息。

- 取值口径：**与讨论一致**，即 `loadChatMessages(session.id)`，由短期装配统一按条数上限 + token 预算裁剪
- **包含共读讨论消息**（决策 10）
- **加开关**：阅读设置新增「批注参考聊天历史」，**默认开启**；关闭时不传 history（回到现行为）
- **提示词约束**：在 `reading_annotation` 预设中加入
  > 聊天历史仅用于帮助你理解{{user}}最近的状态与你们的关系；批注仍然只评论书中的内容，不要变成回应聊天、也不要复述你们的私聊。

### 7.2 单点兜底：让所有 app 与主聊天对齐条数上限

**改动位置**：`lib/short-term-assembler.ts` 的 `prepareShortTermContext`

- 当调用方**未显式传** `maxShortTermEntries` 时，内部读复杂记忆配置：
  - 该 char 启用复杂记忆 → 使用 `loadComplexMemoryConfig().fixedShortTermEntries`
  - 未启用 → 维持现状（不设条数上限，只用 token 预算）
- 效果：阅读、观影、小红书、朋友圈、查手机、剧情、视觉小说、地图、游戏、住处、日记、留言墙、日历、共创、黑市、自定义 app、微信云同步等**一次性全部对齐**，且今后新增 app 不会漏
- **群聊**：`prepareGroupShortTermContext` 本期**不动**（待定项）

---

## 八、UI 设计要点

| 位置 | 内容 |
|---|---|
| 共读悬浮窗 | 新增「写读书笔记」按钮（生成中禁用 + 状态提示） |
| 阅读设置 → 情节摘要区 | 新增：随笔字数上限（滑杆，默认 1500）；「批注参考聊天历史」开关（默认开） |
| 摘要对话框 | 新增「随笔」「笔记」标签页（或并入「全部摘要」下方分区），便于查看/管理 |
| 阅读设置 → 情节摘要区 | 现有「回读时仍注入最新前情提要」开关保持不变，随笔/笔记注入与之联动 |

---

## 九、实施步骤（建议顺序）

1. **附带修复先行**（低风险、独立可验证）
   1.1 `prepareShortTermContext` 单点兜底
   1.2 批注 `history` 注入 + 开关 + 预设约束
2. **数据层**：`reading-types.ts` 新增类型；`reading-storage.ts` 升级到 Dexie v5、新增表与 API
3. **随笔链路**：预设 `<essay>` 指令 → 引擎解析 → 保存 → 提炼 → 注入
4. **笔记链路**：`reading_note` 预设条目 → `generateReadingNote` → 保存（表 + chat 消息）→ 注入 → UI 按钮
5. **UI 收尾**：设置项、摘要对话框标签页、笔记查看
6. **回归验证**：见 §十

---

## 十、验证清单

**附带修复**
- [ ] 主聊天短期条数与复杂记忆配置一致（未回退）
- [ ] 阅读讨论/批注的短期条数与该 char 的复杂记忆配置一致
- [ ] 未启用复杂记忆的 char：行为与修改前一致（不设条数上限）
- [ ] 批注开关关闭时：批注仍看不到聊天历史（回到旧行为）
- [ ] 批注开关开启时：批注能看到最近聊天与共读讨论；且不会写成"回应聊天"

**随笔**
- [ ] 每批批注产出一条随笔，前缀为角色名
- [ ] 不同角色各自独立（互不串）
- [ ] 达到上限自动提炼；提炼后旧随笔不注入、不删除
- [ ] 注入随阅读位置动态变化（跳读/回读表现正确）

**笔记**
- [ ] 手动触发生成；开头为 `{{char}}的读书笔记`
- [ ] 写入 notes 表 + 一条 `origin:"reading_note"` 的 chat 消息
- [ ] 主聊天不显示该消息、会话预览不受影响
- [ ] 只注入最新一篇；开启回读开关时始终注入最新一篇
- [ ] 中断多日后恢复阅读：char 能引用上次笔记内容
- [ ] 多篇笔记累积后，注入量恒定（不随篇数膨胀）
- [ ] 生成失败/中途切书：无半成品、无交叉污染

---

## 十一、风险与注意事项

| 风险 | 处理 |
|---|---|
| 批注注入聊天历史后 token 上升 | 条数上限兜底（§7.2）+ 开关可关 |
| 批注被聊天内容带偏 | 预设加明示约束（§7.1） |
| Dexie 升级导致旧数据不可读 | 只新增表、不改动既有表结构；升级用 `version(5).stores(...)` 增量声明 |
| `origin` 联合类型扩展遗漏判定点 | 按 §4.3 清单逐点处理，并全局搜索 `reading_discuss` 比对 |
| 预设条目未同步导致模型不输出随笔/笔记 | 提示用户到「预设管理 → 同步条目」同步；预设字段更新不自动化 |
| 与贡献分支的净化规则冲突 | 涉及 `complex-memory` 配置的读取仅存在于非贡献文件（`short-term-assembler` / `reading-engine`）；提交前按既有净化流程复核 |
