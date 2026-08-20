# 复杂记忆 · 提示词适应性改造方案（供过目）

> 状态：待确认。涉及模板格式的重大取舍（见 §5），确认后再实施代码改动。

## 1. 目标

把复杂记忆四类生成（事件 / 每日 / 周期 / 核心）的提示词改造成与 float 原生同风格的「第一人称独白/日记」，并补齐此前缺失的上下文注入：

- 事件、日记、核心生成时注入：**char 人设 + 性格规则词 + user 人设 + 世界介绍 + 同世界其他角色理解**
- 事件生成追加注入：**核心记忆 + 活跃周期 + 昨日日记 + 短期上下文（含共享事件）**
- 每日生成追加注入：**核心记忆 + 活跃周期 + 周期主线（含起始主线）**
- 核心生成（按周期和每日更新）：**对应周期记忆 + 每日记忆**

## 2. 素材获取途径（代码级，已核实）

| 素材 | 来源 | 获取方式 |
|---|---|---|
| char 人设 | `Character.persona` | `loadCharacters().find(c => c.id === id)?.persona`（已接入） |
| 性格规则词 | `Character.personality` | 同上，`personality` 字段（可空） |
| user 人设 | `UserIdentity` | `resolveUserIdentity(characterId, "chat")` → `{ name, bio, gender, age, occupation, customSettings }`，组装成一段文本 |
| 世界介绍 + 其他角色理解 | 世界画布 `CharacterWorldGroup` | `formatCharacterRelationsForPrompt(characterId)`（已有现成函数，输出：世界观名/描述/同世界角色/角色关系/关联角色简介） |
| 核心记忆 | `getCurrentCoreView(characterId).text` | 已接入（事件/日记） |
| 活跃周期 | `loadActivePeriods(characterId)` | 已接入（事件/日记） |
| 昨日日记 | `getDaily(characterId, dateString(-1))` | 新增接入（事件生成） |
| 短期上下文（含共享事件） | `loadNativeTimeline` + float 同口径过滤 | 新增接入（事件生成；含共享 = 用户朋友圈/群聊/访谈共享期） |
| 周期记忆 / 每日记忆（核心更新用） | `loadPeriods` / `loadDailies` | 新增接入（核心生成） |

## 3. 各生成类型注入清单

| 生成类型 | 注入内容 | 输出格式 |
|---|---|---|
| **事件记忆** | char 人设 + 性格规则 + user 人设 + 世界观/其他角色 + 核心记忆 + 活跃周期 + 昨日日记 + 短期上下文（含共享事件）+ 本窗时间线素材 | 独白正文 + JSON 尾注 `{ emotion, importanceScore }` |
| **每日记忆** | char 人设 + 性格规则 + user 人设 + 世界观/其他角色 + 核心记忆 + 活跃周期 + 周期主线 + 当日时间线/事件素材 | 日记正文 + JSON 尾注 `{ emotion, periodCheck, periodProgress }` |
| **周期记忆** | 活跃周期滚动累积 + 关联日记/事件 +（可选）世界观/其他角色 | 轻收尾 summary + timelineIndex（维持现状） |
| **核心记忆** | char 人设 + 性格规则 + user 人设 + 世界观/其他角色 + 既有核心 + 新材料（周期总结 + 日记） | **待确认**（见 §5） |

## 4. 模板草案（基于你给的模板做变量化改造）

### 4.1 事件记忆（默认模板草案）

```
[角色：{{char}} 的私人记忆记录指令]
从现在起，你是 {{char}}。请严格依据以下提供的事件记录，以 {{char}} 的第一人称写下这段时间的私人回忆。
时间跨度：{{earliest}} 至 {{latest}}

【你是什么样的人（人设参考）】
{{persona}}
{{personality}}
【你眼中的 {{user}}】
{{userPersona}}
【你所在的世界与其他角色】
{{worldContext}}
【你已有的核心认知（可引用，不必复述）】
{{coreMemory}}
【你正在经历的长期事件（活跃周期）】
{{activePeriods}}
【昨天的你（昨日日记）】
{{yesterdayDaily}}
【这段时间发生在你身边的原始记录（短期上下文，含共享事件）】
{{shortTermTimeline}}

事件记录：
{{events}}

（第一人称独白要求：……此处沿用你提供的 1-5 条要求……）

输出 JSON：{ content: "独白正文", emotion: { valence, arousal }, importanceScore }
```

### 4.2 每日记忆（默认模板草案）

```
从现在起，你是 {{char}}。请严格依据之前的角色扮演对话内容，以 {{char}} 的第一人称写下这段剧情的私人记录。
【你是什么样的人】{{persona}} / {{personality}}
【你眼中的 {{user}}】{{userPersona}}
【你所在的世界与其他角色】{{worldContext}}
【你的核心记忆】{{coreMemory}}
【活跃周期与主线】{{activePeriods}} / {{periodMainlines}}
【今日原始素材】{{todayTimeline}} + {{todayEvents}}

（日记要求：……沿用你提供的 1-6 条 + 其他要求……）

输出 JSON：{ diary, emotion: { valence, arousal }, periodCheck: { ... }, periodProgress: [...] }
```

### 4.3 核心记忆（默认模板草案，方案 A）

```
[角色：{{char}} 的核心记忆提取指令]
你是 {{char}}。请依据下方材料，从第一人称视角写下你对这段关系最核心的记忆。
时间跨度：{{earliest}} 至 {{latest}}

【你是什么样的人】{{persona}} / {{personality}}
【你眼中的 {{user}}】{{userPersona}}
【你所在的世界与其他角色】{{worldContext}}
【既有核心记忆（延续，可增删改）】{{existingCore}}
【新材料：周期总结与每日记忆】{{newMaterials}}

请逐条拆成一条条独立的核心事实（每条 80–180 字，一条一段自然叙述，不要列表/标题），
每条标注分类 identity / bond / principle / milestone。
语气像在回忆、在认定，把模糊与不确定也如实保留。

输出条目数组 JSON：[{ "text": "…", "category": "identity|bond|principle|milestone" }, ...]
```

## 5. 待你拍板的分歧点

1. **核心记忆格式**（最关键）：
   - **方案 A（推荐）**：保持 M2 已锁定的「条目数组」，但每条改为 80–180 字、float 同款「一段自然叙述」风格（不再是 30–80 字一句话事实）。与 float 逐条镜像同步、可单条编辑的能力全部保留。
   - 方案 B：退回 float 原生式的「整段 80–180 字独白」——与 M2 条目化冲突，会丢失单条编辑/镜像能力。
   - 你给的模板原文是「篇幅控制在 80–180 字之间，只要一段自然的叙述」，倾向方案 B；但 M2 你刚确认了条目化，所以需要你明确二选一。

2. **输出 JSON 尾注**：事件/日记模板需要模型在独白/日记正文之外附带情绪与周期判定（程序要读），默认在正文后追加 JSON 尾注。是否接受？（当前系统解析依赖这个结构）

3. **"额外的规则词"具体指什么**：我按 `Character.personality`（角色性格）理解；如果你指的是设置里的其他规则文本（如 preset 规则/自定义规则），请指出具体字段，我补进素材清单。
