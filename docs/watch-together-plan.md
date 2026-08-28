# 一起观影功能 · 计划书

> 工作笔记，不入库。2026-08-23 整理。先定方案，不动代码。

## 一、需求回顾

1. 导入影视资源（本地视频文件 + 字幕），和 char 一起看电影。
2. 评估能否直接使用 B 站视频作为片源。
3. 导入后调用一次模型：注入片名、简介、全字幕 → 模型按「起承转合」整理出 4~8 个整体划分，每个划分 = 该部分情节的概括与摘要。
4. 观影时：注入当前段的概括摘要 + 该段字幕 + 当前位置前后各约 5 张间隔截屏（不紧挨，隔一段时间一张）→ char 生成弹幕。
5. 可与 char 观影讨论。整体架构参考阅读 app。

## 二、B 站片源调研结论

社区事实标准文档库：[bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect)（多个镜像 fork）。我们只需其中 3 个接口，无需引入第三方 SDK（现有开源多为 PHP/Python 全量客户端，引库不如自实现干净）：

| 用途 | 接口 | 关键约束 |
|---|---|---|
| 取视频流 | `GET /x/player/wbi/playurl` | 需 Wbi 签名；480P 及以上需登录 Cookie（SESSDATA）；1080P60/1080P+ 需大会员账号 |
| 取播放器元数据（含字幕列表） | `GET /x/player/wbi/v2` | 未登录时字幕列表为空 |
| 取字幕内容 | 字幕列表里的 JSON 地址 | B 站原生格式 `{ from, to, content }[]`，天然就是我们要的时间轴结构 |

**三个硬约束（必须在计划里明示）：**

1. **CORS**：B 站 API 不允许浏览器直连，所有请求须经自部署服务端转发。项目已有 `/api/llm-proxy` 先例，新建 `/api/bilibili` 路由同模式实现。
2. **视频流反盗链**：取到的流地址在 `*.bilivideo.com` / `upos*.akamaized.net`，校验 Referer，浏览器 `<video>` 直接播不了。须由服务端代理转发流并在请求头补 Referer —— **播放流量全走自部署服务器，流量成本高**。缓解：默认限 360/480P（最低档免登录），设置页放 SESSDATA 输入框供用户自备账号提清晰度，并明示流量代价。
3. **Wbi 签名**：`wbi/playurl`、`wbi/v2` 需要 Wbi 签名（mixinKey 重排 + md5），算法在文档里有，需自行实现一个约 40 行的工具函数。

**结论：可行，但 B 站源是「受限模式」。v1 先做本地源，B 站源放二期。**

## 三、数据模型

```ts
// lib/movie-types.ts
type Movie = {
    id: string;
    title: string;
    intro?: string;              // 简介（B站源自动拉取；本地源用户填写或留空）
    source: "local" | "bilibili";
    bvid?: string;               // B站源
    cid?: number;
    durationSeconds?: number;
    createdAt: string;
};

type MovieSegment = {
    id: string;
    movieId: string;
    index: number;               // 0..N，起承转合顺序
    title: string;               // 如「第一幕·起」
    startSeconds: number;
    endSeconds: number;
    summary: string;             // 该段情节概括与摘要（LLM 产出）
    subtitleText: string;        // 该段时间范围内的完整字幕文本（分段时切好存储，观影时不再实时切）
};

type WatchProgress = {
    movieId: string;
    positionSeconds: number;
    companionCharacterId?: string;
    segmented: boolean;          // 是否已完成分段
    lastWatchAt: string;
};

type MovieDanmaku = {
    id: string;
    movieId: string;
    timeSeconds: number;         // 弹幕出现时间点
    characterId: string;
    characterName: string;
    content: string;             // 弹幕短评（≤30字）
    createdAt: string;
};
// 讨论消息复用 chat-storage 会话体系，origin: "movie_discuss"（照抄 reading_discuss 模式）
```

存储：Dexie 新库 `movie-db`（movies / segments / progress / danmaku / rawFiles 五表），完全照抄 `reading-db` 结构。本地视频 Blob 存独立 IDB（`movie-raw-files`），**注意大文件配额**——导入超过 ~500MB 时提示用户浏览器剩余配额，拒绝后提供「仅本次会话播放（不保留副本）」降级选项。

## 四、核心流程

### 1. 导入

- **本地**：`<input type=file>` 收视频 + 可选 SRT/VTT 字幕 → 解析字幕为统一时间轴 JSON → 存库。SRT 自写解析器（~60 行），VTT 近似。
- **B 站**（二期）：粘贴 URL → 服务端 `/api/bilibili` 解析 bvid/cid → 返回标题、简介、字幕 JSON、（签名后的）流地址。

### 2. 分段（一次 LLM 调用，用户点「生成分段」触发）

- Prompt 组装：片名 + 简介 + **全字幕文本**（2 小时电影字幕约 30~60K 字符；超长时按 token 预算截断并提示「仅按前 N 分钟内容划分」）。
- 要求模型输出结构化标记：`[划分 序号=N 开始=秒 结束=秒] 标题 + 概括摘要 [/划分]`，数量 4~8。
- 解析入库 `segments`。解析失败静默重试（复用阅读 `withAnnotationRetry` 模式）。
- 内置预设条目 `movie_segment`（tags: `["movie", "segment"]`）。

### 3. 观影中上下文注入（对应阅读的 buildDiscussContext）

- 播放时间 → 定位当前段（线性/二分查 segments）。
- 注入内容三件套：
  1. **当前段概括摘要**（ MovieSegment.summary ）+ 前一段的一句话衔接；
  2. **当前段字幕的滑动窗口**：以当前播放时间为锚，向前取已播 ~2000 字符、向后预取 ~1000 字符（对应阅读的焦点窗口逻辑）；
  3. **间隔截屏**：当前位置前后各取约 5 张、相邻间隔 ≈ 段长/12 的帧。**仅本地源可行**：IndexedDB Blob → objectURL 同源无污染，`video.currentTime = t` → seeked 事件 → canvas.drawImage → toDataURL 缩略图。B 站源跨域画布被污染 + 代理流 seek 成本高，二期降级为「无截屏，纯字幕+摘要驱动」。

### 4. 弹幕

- **触发时机**（不做逐句实时调模型，控制成本）：
  - 进入新段时一次性批量生成：注入该段摘要 + 字幕窗口 + 截屏 → 模型按 `[弹幕 秒=xx] 内容 [/弹幕]` 输出 5~10 条散布在本段时间轴上的弹幕，落库；
  - 用户手动点「来点弹幕」按钮补充生成。
- **渲染**：播放器上方绝对定位弹幕层，横向滚动动画，CSS 实现（复用项目内已有 keyframes 风格）；点击弹幕可直接展开为讨论话题。
- 内置预设条目 `movie_danmaku`（tags: `["movie", "danmaku"]`）。

### 5. 讨论

完全照抄阅读 discuss 架构：

- `createOrGetSession(companionId)` 复用聊天会话，消息标 `origin: "movie_discuss"`，会话预览过滤；
- `generateMovieChat()` → `resolveMovieInput(appTags: ["movie","discuss"])` → `assemblePromptPayload` → `sendLLMRequest(options.appId: "movie")`；
- 动作尾注扩展一条：【发弹幕 秒=N】内容 —— char 讨论中可以顺手发弹幕；
- 内置预设条目 `movie_discuss`（tags: `["movie", "discuss"]`）。

### 6. 预设条目同步

三个新内置条目通过既有的两条路到达用户预设：

1. `BUILTIN_PRESET_VERSION` 升版（261→262）→ 内置预设自动更新；
2. 复制出来的预设 → 用上次做的「同步条目」按钮勾选添加（tags 分组里会出现「movie/影视」组）。

## 五、UI 结构

```
components/movie/
├── movie-app.tsx          # 片架 + 播放器切换（对标 reading-app）
├── movie-shelf.tsx        # 片架：导入/列表/删除
├── movie-player.tsx       # 播放器：<video> + 弹幕层 + 控制条
├── movie-discuss-panel.tsx# 讨论悬浮窗（对标阅读的聊天悬浮窗）
└── movie-segment-dialog.tsx # 分段结果查看/重新生成
app/api/bilibili/route.ts   # （二期）B站代理：元信息/字幕/取流
lib/
├── movie-types.ts / movie-storage.ts / movie-engine.ts / movie-parser.ts
└── wbi-sign.ts            # （二期）Wbi 签名工具
```

## 六、风险与决策点（待你拍板）

1. **B 站源的流量成本**：视频流全走自部署服务器代理。是否接受？还是 v1 干脆只做本地源？
2. **SESSDATA 配置**：放全局设置还是观影 app 设置里？（涉及账号安全，建议放观影 app 内 + 明确警示）
3. **大文件配额**：电影动辄 1~4GB，IndexedDB 可能装不下。「不保留副本」降级模式要不要做进 v1？
4. **弹幕成本控制**：进入新段批量生成一次（推荐）vs 定时逐条生成（贵）。我倾向前者。
5. **截屏仅本地源**：B 站源无截屏，弹幕纯靠字幕+摘要驱动，效果会打折。接受吗？
6. **分段超长字幕截断**：全字幕超预算时砍尾部还是提示用户手动先分 P？

## 七、分期实施建议

| 期 | 内容 |
|---|---|
| P0 | 本地源全链路：导入（视频+SRT/VTT）→ 分段 → 播放器 → 上下文注入 → 讨论 |
| P1 | 弹幕系统（段首批量生成 + 手动补充 + 渲染层 + 发弹幕尾注）+ 本地源间隔截屏 |
| P2 | B 站源：`/api/bilibili` 代理 + Wbi 签名 + SESSDATA 设置 + 无截屏降级模式 |
| P3 | 多角色同看（弹幕多角色混排）、观影记录统计、断点续看优化 |

P0 改动面预估：新增 ~7 个文件，改 3 个（builtin-preset、llm-prompt-assembler、reading-viewer 之外的入口注册如 desktop-shell），风格与阅读 app 完全对齐。
