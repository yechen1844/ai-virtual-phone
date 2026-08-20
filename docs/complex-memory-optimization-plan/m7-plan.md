# M7 计划书：动态迁移重构 + 提示词重构收尾 + 角色规则词

> 状态：实施中 · 更新时间：2026-08-20
> 背景：用户计划将另一台小手机中 3 个多月的恋人聊天记录迁移进 float，再经一键迁移进入复杂记忆系统。因此迁移必须**完全仿照正常动态生成机制**（事件/日记/周期/核心互相反馈、滚动生成），而不是批处理式各阶段孤立生成。

---

## 一、目标

1. **一键迁移动态化**：将历史短期记录按时间正序"回放"一遍，逐段生成事件记忆，一天结束生成当日日记，周期开合照常判定，核心记忆持续反哺后续生成，产物形态与正常逐日累积完全一致。
2. **提示词重构收尾**：事件/日记/核心模板注入全部上下文变量（char 人设、性格、规则词、user 人设、世界观、核心/周期/昨日日记/主线等），核心记忆采用方案 A（80-180 字自然叙事条目，JSON 数组）。
3. **角色规则词**：user 自定义、按角色绑定，用于辅助理解人设，每个角色可配置不同规则词，并提供编辑 UI。

## 二、已完成项（M6.5，代码已落地）

| 项 | 文件 | 状态 |
|---|---|---|
| 方案 A 核心模板（80-180 字叙事条目） | `lib/complex-memory/prompts.ts` | 完成 |
| 事件/日记/核心模板变量注入（persona/personality/rules/userPersona/worldContext/coreMemory/activePeriods/yesterdayDaily/periodMainlines） | `prompts.ts` + 三个生成器 | 完成 |
| 统一上下文组装器 | `lib/complex-memory/context-builder.ts` | 完成 |
| 角色规则词存储（KV，按角色） | `lib/complex-memory/config.ts` | 完成 |
| 生成锁过期抢占（10 分钟）+ bootstrap 失败全局通知 | `config.ts` | 完成 |
| 查看原始记忆面板（SourceMaterialsView）+ 向量化徽章（VecBadge） | `components/complex-memory/explorer.tsx` | 完成 |
| 原生记忆页签（短期上下文 + 共享事件） | `explorer.tsx` | 完成 |
| 迁移后台驱动循环（driveMigration） | `lib/complex-memory/migration.ts` | 完成（将被 P2 重构） |

## 三、待办

### P1 角色规则词编辑 UI

- 在复杂记忆查看器中提供按角色编辑规则词的入口（textarea + 保存）。
- 保存走 `saveCharacterRules`，读取走 `loadCharacterRules`，空值删除键。
- 规则词注入事件/日记/核心提示词的 `{{rules}}` 变量（已完成注入，只缺 UI）。

### P2 动态迁移重构（核心）

**现状问题**：批处理 5 阶段（events → dailies → distill → core → legacy），各阶段孤立：事件生成时核心为空、日记倒序生成导致周期开合失序、核心最后 bootstrap 不反哺上游。

**目标规格（用户已确认）**：

1. **素材**：现有 `loadSourceTimeline` 全来源、按条计算（不做特殊过滤；本次数据只有聊天记录）。1 条 = 1 条有效消息。
2. **推进节奏**：事件按条数窗正序切分（沿用 `eventWindowMaxEntries`，默认 200 条/窗），每窗生成 1 条事件记忆；窗口覆盖到哪天、该日事件即累积完成。
3. **事件生成注入**（与正常一致）：当时的核心记忆 + 当时活跃周期 + 当时的昨日日记 + 该窗短期上下文（含共享）。
4. **日记生成**：某天消息已全部处理完且该天 ≥1 条消息 → 生成当日日记，注入核心 + 活跃周期 + 当天事件，LLM 照常输出周期开合判定（newPeriods/closedPeriods/activePeriodIds）与周期进度累积（periodProgress）。**空白天（无消息）跳过，不写日记、不占完成度。**
5. **周期链**：日记中判定的周期关闭 → 立即 `distillPeriod` 提炼 → 提炼后微调核心（fineTuneCoreMemory）。
6. **核心链**：日记累计满 `coreDailyInterval`（默认 7）篇 → 照常 `rebuildCoreMemory` 定期重构；核心更新后继续参与后续事件/日记生成。
7. **电压衰减减半**：迁移期间无正常召回机制对抗衰减，衰减因子向 1 靠拢一半（如 0.98 → 0.99），起始电压照旧 1；保留衰减不取消。
8. **断点续跑**：沿用角色 state 键存断点（推进到的时间线索引 / 日期指针），页面刷新后由调度器驱动续跑。
9. **只回放一遍**，推进到"现在"结束；结束前仍执行 legacy（旧 float 沉淀压缩）与报告生成。

**涉及文件**：
- `lib/complex-memory/migration.ts`（重构状态机为动态推进）
- `lib/complex-memory/voltage.ts`（迁移衰减减半支持，如 `halfDecayFactor` 参数）
- `components/complex-memory/explorer.tsx`（MigrationTab 进度展示适配）
- `lib/complex-memory/types.ts`（迁移状态字段扩展：时间线游标等）

### P3 验证与交付

- `npx tsc --noEmit` 全量类型检查（已知仅两个无关 API 路由 Buffer 错误）。
- git 提交并 push，触发 Vercel 自动部署。
- 更新计划书状态为完成。

## 四、验收标准

1. 一键迁移从最早消息开始，事件/日记/周期/核心按时间顺序互相反馈生成，全程无需手动操作。
2. 空白天跳过；稀疏日（每天几条）正常累积。
3. 迁移产物可查看原始素材、向量化徽章；核心为方案 A 叙事条目。
4. 角色规则词可编辑、可保存、可注入提示词。
5. 迁移中断（刷新/退出）后续跑不重复、不遗漏。
