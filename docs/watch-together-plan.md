# 一起观影功能 · 计划书 v2

> 工作笔记，不入库。2026-09-08 全面修订。参考调研：Open Watch Cinema（预处理AI包/防剧透门控/分镜按需取）、couchmate（画面diff守门/帧去重/防自言自语）、映屿 CineIsle（字幕解析兼容清单/时间轴笔记）。整体架构参考阅读 app。

## 一、需求与范围

1. 导入本地影视资源（视频 + 字幕），和自选 char 一起看电影。
2. 内置 app「观影」，注册方式照抄 reading（desktop-shell `activeApp` 分支 + 顶部 import）。
3. **砍掉 B 站源**（原二期方案整体废弃）：无 /api/bilibili、无 Wbi 签名、无 SESSDATA。
4. **不做**：观影手记、双端同步/房间码（char 在同一设备，天然同步）、内嵌字幕 OCR。
5. **视频本体不进应用存储**——文件留在原地流式播放，重进时重新选一次文件；库里只存「观影包」（元数据+分段+字幕+预抽帧，单部 ≈5MB）。

## 二、分段机制（两级 + 物理边界候选）

核心原则（学 Open Watch Cinema 的 ai-packages）：**分段在观影前预处理完成，播放全程零 seek、零实时解码**。

- **幕（Act）**：4~8 个，对应起承转合，仅叙事骨架，由场次聚合而来（不单独调模型）。
- **场（Scene）**：20~40 个（2 小时片 → 每场 3~6 分钟），实际注入单元。
- **物理边界候选先行**：字幕静默间隙（>10s 无台词）+ 低频帧差采样（canvas 抽帧 + 感知哈希去重，学 couchmate「画面没变不算变化」）产出候选切点 → LLM 在候选边界上做语义归并与摘要。LLM 从「自由划分」变「在物理边界中选择与命名」，不会只分出几大块，token 更省。
- 全字幕超 token 预算时按预算截断并提示「仅按前 N 分钟划分」；解析失败复用阅读 `withAnnotationRetry` 模式。
- 预抽帧：分段时顺手完成，每场 ≈10 张 JPEG 缩略图（~50KB/张），**入库前感知哈希去重**（相邻重复帧不存，如纯黑屏/静帧段落自动少存）。

## 三、字幕：解析与获取工作流

### 解析（movie-parser.ts 验收清单，抄映屿踩坑清单）

- 格式：SRT / VTT / ASS / SSA。
- 编码自动尝试：UTF-8 / UTF-8 BOM / GB18030 / UTF-16LE / UTF-16BE。
- 兼容：CRLF 换行、零宽字符、逗号毫秒时间轴（`00:01:02,500`）。
- ASS/SSA：解析 `Dialogue:` 行，剥离样式标签、位置代码、绘图代码，仅保留台词+时间轴。
- 导入 0 条时给出具体原因提示。

### 获取（引导文案 + 片架「字幕从哪来」帮助页）

1. 外挂字幕下载：SubHD / 字幕库 / OpenSubtitles，按资源名搜索，下载 SRT。
2. 无字幕：**剪映**（手机/电脑）→ 智能字幕 → 语音转字幕 → 导出 SRT，免费且中文优化好；备选通义听悟（网页）、Buzz（开源离线）、VideoCaptioner（LLM断句优化）。
3. mkv 内封字幕：电脑上 PotPlayer 右键另存字幕 / MKVToolNix 提取；mkv 浏览器播不了时引导先用剪映/ffmpeg 转一次 mp4。
4. 原计划的 Gemini 音频转写兜底取消，由剪映工作流替代（省一整块工程）。

## 四、数据模型

```ts
// lib/movie-types.ts
type Movie = {
    id: string;
    title: string;
    intro?: string;              // 用户填写或留空
    durationSeconds?: number;
    createdAt: string;
};

type MovieAct = {                // 幕：叙事骨架（由场聚合，LLM 一次产出）
    id: string;
    movieId: string;
    index: number;
    title: string;               // 如「第一幕·起」
};

type MovieScene = {              // 场：实际注入单元
    id: string;
    movieId: string;
    index: number;               // 全局顺序 0..N
    actIndex: number;
    title: string;
    startSeconds: number;
    endSeconds: number;
    summary: string;             // LLM 产出的情节概括
    subtitleText: string;        // 该场完整字幕（分段时切好存储）
};

type MovieFrame = {              // 预抽帧（去重后）
    id: string;
    movieId: string;
    sceneId: string;
    timeSeconds: number;
    thumbnail: Blob;             // JPEG ~50KB
};

type WatchProgress = {
    movieId: string;
    positionSeconds: number;
    companionCharacterId?: string;
    segmented: boolean;
    lastWatchAt: string;
};

type MovieDanmaku = {
    id: string;
    movieId: string;
    timeSeconds: number;
    characterId: string;
    characterName: string;
    content: string;             // ≤30字
    createdAt: string;
};
// 讨论消息复用 chat-storage：origin: "movie_discuss"，detail 带 timeSeconds 锚点
```

存储：Dexie 新库 `movie-db`（movies / acts / scenes / frames / progress / danmaku 六表），结构照抄 `reading-db`。**不建视频 Blob 表**。

## 五、观影中上下文注入（防剧透门控，学 OWC spoiler-gating）

所有注入内容严格门控到已播放位置——**摘要、字幕、帧都一样，没看过的绝不注入**。

- 播放时间 → 线性/二分定位当前场。
- 注入四件套：
  1. **当前场摘要** + 前一场一句话衔接；
  2. **前情提要**：已看场次摘要（照抄阅读 `getSummariesForInjection` 位置过滤 + 多了自动提炼 `distillSummariesIfNeeded` 模式）；
  3. **当前场字幕滑动窗口**：以当前播放时间为锚，向前已播 ~2000 字符、向后预取 ~1000 字符；
  4. **当前场预抽帧**：讨论/弹幕生成时一次性注入该场全部去重帧（对应 OWC「分镜批量给、按需取」的折中——我们的调用是前端主动发起的一次性调用，无需游标轮询）。
- 防自言自语（学 couchmate）：组装上下文时过滤 char 自己已发过的弹幕/消息。

## 六、弹幕与主动开口

- **触发时机**（成本控制）：进入新场时一次性批量生成——注入该场摘要 + 字幕窗口 + 帧图 → 模型按 `[弹幕 秒=xx] 内容 [/弹幕]` 输出 5~10 条散布本场时间轴，落库；另设「来点弹幕」手动补充按钮。不做逐句实时调用。
- **主动开口**（P1）：进新场时除弹幕外，char 有机会以**聊天消息**形式发一条感想（非弹幕），用户可点进去聊。走 movie_discuss 会话正常调用。
- **渲染**：播放器上方绝对定位弹幕层，横向滚动 CSS 动画；点击弹幕可展开为讨论话题。
- **消息时间锚点**（学 OWC）：讨论消息 detail 带 `timeSeconds`，重看时可在时间轴上回看讨论记录（P2 渲染，P0 先存锚点）。
- 预设条目：`movie_segment`（tags `["movie","segment"]`）、`movie_danmaku`（`["movie","danmaku"]`）、`movie_discuss`（`["movie","discuss"]`）。经 `BUILTIN_PRESET_VERSION` 升版 + 同步条目两条路到达用户预设。

## 七、讨论会话与记忆联动（严格照抄阅读 app 正规注册路径）

> 星露谷的教训：自立门户搞 `stardew:` 前缀 contactId，导致会话/记忆泄漏进主聊天，事后补救。观影从第一天起走正式注册路径。

### 7.1 App 正式注册（settings-types.ts）

- `ContentAppId` 联合类型加 `"movie"`、`CONTENT_APP_IDS` 数组加 `"movie"`、`CONTENT_APP_LABELS` 加 `movie: "观影"`（约 L240-273）。
- 注册后绑定系统自动生效：`resolveBinding(config, characterId, "movie")` 可解析 `appDefaults["movie"]` / `charBinding.appOverrides["movie"]`（apiConfig / preset / worldBook / regex / userIdentity 五件套级联：全局 → 角色 → app 覆盖）。设置面板的 app 绑定列表走 `CONTENT_APP_IDS` 迭代，无需额外 UI 改动。
- **绝不**新增独立 contactId 前缀、绝不改会话主键。

### 7.2 讨论会话 = 复用 char 主会话 + origin 标记（阅读同款）

阅读的实际做法（已逐行确认）：

- 讨论消息**存在 char 的普通主会话里**：`createOrGetSession(companionId)`，`companionId` 就是普通角色 id（reading-viewer.tsx:590-594）。
- 消息打标 `origin: "reading_discuss"`，隔离靠**三层过滤**，而非独立会话：
  1. 主聊天渲染过滤：chat-room.tsx:5087 `dedupedMessages` 里 `isReadingDiscussMessage(m)` 直接剔除 → 主聊天界面看不到；
  2. 会话列表静默：`getChatMessagePreview` 对其返回空串（chat-storage.ts:318）、未读计数不计（chat-storage.ts:434）；
  3. app 内反向过滤：阅读悬浮窗只显示 `filter(isReadingDiscussMessage)` 的消息（reading-viewer.tsx:734）。

观影照抄：chat-storage 新增 `isMovieDiscussMessage`（`origin === "movie_discuss" || mediaType === "movie_discuss"`）、`ChatMessage.origin` 类型扩展 `"movie_discuss"`；上述三处过滤点各加一行；`movie-discuss-panel` 只渲染 movie_discuss 消息。讨论消息 `detail` 带 `timeSeconds` 播放锚点。

### 7.3 短期记忆互通（不是隔离，是「知晓但不刷屏」）

short-term-assembler.ts:881 `buildCoReadingBoundaryEntries` 把阅读讨论消息纳入**统一短期时间线**，并以边界条目标注：「（共读时间）{user}和{char}开始了共读《书名》」——主聊天里 char 因此"知道"你们刚才一起读了什么，但讨论细节不会灌进主聊天上下文。

观影照抄：新增观影边界条目（同函数或并列函数）：「{user}和{char}开始了观影《片名》」，消息带播放位置时可在边界条目中体现进度。**短期记忆完全互通，绝不另建独立记忆流。**

### 7.4 水位线联动（complex-memory/guard.ts 统一入口）

- 每次 LLM 调用前 `recordCharacterActivity(characterId, name, 1)`——**不带 trigger**（副 app 正确姿势，guard.ts:14-39）：
  - L1 环形缓冲：所有 app 活动累加进同一 count，触发 L2 事件生成的阈值检查只归主聊天（trigger=true）；
  - L3 每日日记：跨天即补，副 app 活动同样计入；
  - 未启用复杂记忆时回退旧计数 + 总结，行为不变。
- 这就是「app 记忆进水位线、不跑主聊天」的机制：**活动计数进统一记忆管线，消息本体留在 app 域内**。调用点与阅读完全一致（reading-engine.ts:457-458 同款）。

### 7.5 记忆召回（resolveMovieInput 内，阅读同款）

resolveReadingInput（reading-engine.ts:105-114）的召回三件套，观影对齐：

1. `retrieveCoreMemoriesForPrompt(characterId, memConfig)` —— 核心记忆；
2. `retrieveMemoriesForPrompt(characterId, query, memConfig)` —— 长期记忆相关性召回，阅读用**书名**作 query，观影用 **片名 + 当前场摘要**作 query（更精准）；
3. `prepareShortTermContext(characterId, "chat", { history, userName })` —— 短期上下文（含 7.3 的边界条目）。

注意：召回涉及 memory-service / embedding 等私有模块，本功能整体为私有主分支功能，不进贡献净化分支。

### 7.6 专属预设条目（builtin-preset.ts 正式注册）

三条内置条目，模板占位符模式照抄 reading_annotation / reading_discuss（builtin-preset.ts:3846-3910）：

| identifier | name | tags | 关键占位符 |
|---|---|---|---|
| `movie_segment` | ▸ 观影·分段 | `["movie","segment"]` | `{{movieTitle}}` `{{sceneBoundaries}}` |
| `movie_danmaku` | ▸ 观影·弹幕 | `["movie","danmaku"]` | `{{movieTitle}}` `{{sceneSummary}}` `{{sceneSubtitleWindow}}` `{{frameHint}}` |
| `movie_discuss` | ▸ 观影·讨论 | `["movie","discuss"]` | `{{movieTitle}}` `{{sceneTitle}}` `{{sceneSummary}}` `{{movieSummary}}` `{{sceneSubtitleWindow}}` `{{frameHint}}` |

- `BUILTIN_PRESET_VERSION` 升版（261→262）→ 内置预设自动更新；已复制预设走「同步条目」按钮（tags 分组出现「movie/观影」组）。
- `AssemblerInput`（llm-prompt-assembler.ts）新增 `appId: "movie"` 与对应观影字段；appTags `["movie","segment"]` 等驱动条目筛选。
- 动作尾注扩展：【发弹幕 秒=N】内容（char 讨论中顺手发弹幕，解析同 reading 动作尾注模式）。
- 前情提要注入字段 `{{movieSummary}}` 格式对齐阅读 `formatReadingSummary`（`【第N场 · MM:SS-MM:SS】摘要`），含自动提炼标记。

## 八、UI 结构

```
components/movie/
├── movie-app.tsx           # 片架 + 播放器切换（对标 reading-app，含 hydrate/onClose 模式）
├── movie-shelf.tsx         # 片架：导入/列表/删除/「字幕从哪来」帮助页
├── movie-player.tsx        # 播放器：<video> + 弹幕层 + 控制条 + 进场开场面板
├── movie-discuss-panel.tsx # 讨论悬浮窗（对标阅读聊天悬浮窗）
└── movie-segment-dialog.tsx# 分段结果查看/重新生成
lib/
├── movie-types.ts / movie-storage.ts / movie-engine.ts / movie-parser.ts
```

注册：desktop-shell.tsx 顶部 import + `activeApp === "movie"` 分支（照 reading 模式）。样式走独立 movie.css 或并入现有 app 样式，风格与阅读 app 对齐。

## 九、导入与播放细节

- 导入：`<input type="file">` 收视频 + 可选字幕；视频仅取 File → objectURL 流式播放，**不复制不落库**。
- 重进会话：进度/分段/弹幕全在库中，视频需重新选择一次文件（片架卡片提示「继续观看」）。
- mkv 播不了：Chrome Android 对 h264+mkv 支持不稳定，帮助页引导转 mp4（剪映导入再导出即可）。
- 删除影片 = 级联删观影包（scenes/frames/danmaku/progress/讨论消息保留与否弹窗确认）。

## 十、分期实施

| 期 | 内容 |
|---|---|
| **P0** | 本地源全链路：导入（视频+SRT/ASS/VTT 多兼容解析）→ 物理边界候选 + LLM 两级分段 + 预抽帧（去重）→ 播放器 → 防剧透上下文注入 → 讨论会话 + `recordCharacterActivity` 水位线联动 |
| **P1** | 弹幕系统（进场批量生成 + 手动补充 + 渲染层 + 发弹幕尾注）+ 主动开口（char 进新场发感想消息） |
| **P2** | 讨论记录时间轴回放渲染、多角色同看（弹幕多角色混排）、观影卡片（票根/回执，学映屿） |

P0 改动面预估：新增 ~9 个文件（components/movie/×5 + lib/movie-×4），改 3 个（builtin-preset、llm-prompt-assembler、desktop-shell）。
