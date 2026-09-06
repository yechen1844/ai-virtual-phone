# 前后端主动消息「撞车」修复专案（断点 E）——新立档

> 本文是**独立**文档，不合并进任何旧指南（旧文件易被覆盖/覆盖回滚，故单独成文）。
> 隐私纪律：涉及令牌/密钥/域名/项目 ID 一律用 `<占位>`，绝不写入真实值。

***

## 1. 背景与问题

float 的定时/主动类消息，同一个到期周期里**前端(本地)和后端(push-generate/云端)会在同一时刻各自生成一次**：

- 用户实际只看到前端那条；

- 云端那条被消费去重(`push-outbox-client` 的 `followUpIndex`/`armAt` 判重)吞掉，

- 但云端仍然完整跑了一次 LLM 生成 → **双生成、白耗资源**。

***

## 2. 竞态根因（为什么"先撤/后查"会失效）

- 前端在本地触发批 N 后，会调 `cancelBailoutPrefix(idle:<ruleId>:)` 撤销云端**同计划**里 `status=pending` 的 job。

- 但它的撤销条件是 `where status=pending`：

  - 若云端 `push-generate` **抢先 claim**（`pending → running`），

  - 前端的撤销**匹配不到 pending → 失败** → 云端照跑 → 双生成。

- 本质：**没有先后顺序保证时，谁先谁后不确定，任何"先写标记再查"的方案都不可靠。**

***

## 3. 修复方案（已落地并部署）

> ⚠️ 定时主动消息是**长期规则**（如"char 间隔 N 未回复就主动说一句"）。
> **计划本身绝不删除**。绝不能把本轮到期当一次性任务去 cancel/删除——那样会破坏长期性、逼用户反复重建。正确做法只对"本轮"让路。

### 核心：后端对"定时/主动类 job"抢锁前先让 120 秒

在 `push-generate` 里，对这类 job **claim（抢** **`where status=pending`）之前先** **`sleep(120_000)`**，再走原本的原子抢锁：

```ts
// 主动/定时类判定
const isProactive = kind === "timed_task"
  || trigger_key.startsWith("idle:")
  || trigger_key.startsWith("timedwake:")
  || trigger_key.startsWith("periodcare:");
if (isProactive) await sleep(120_000);
// 仍用原逻辑 claim：PATCH ... where status=pending ...
```

### 为什么成立

- **前端活着**：前端本来同刻触发，120 秒内必已在本端生成，并把本轮云端 `pending` job 置 `cancelled` → 后端 120s 后 `where status=pending` 抢锁**落空 → 跳过**，**只出前端 1 条**。

- **前端被杀**：无人撤销 → 120s 后仍 `pending` → 后端抢锁成功，**兜底生成 1 条**。

- **计划保留**：每次到期都用各自批次号 N，下周期 N+1 照常 → **计划不删、长期有效**。

***

## 4. 关键文件与"真正上线源"（重要）

- **真正上线的函数源码 =** **`supabase/functions/push-generate/index.ts`**（不是 `public/ai-phone-push/` 那一份！`public/` 那份不是部署源，改了也**不会**上线）。

- 修改点：`claim(...)` 之前插入上文的 `isProactive && await sleep(120_000)` 预检块。

***

## 5. 部署方式（Management API，单函数）

等价于浮点前端 `app/api/push/deploy-personal/route.ts` 的 `deployFunction`：

```
POST https://api.supabase.com/v1/projects/<个人云项目ref>/functions/deploy?slug=push-generate
Authorization: Bearer <Supabase Personal Access Token>
multipart/form-data:
  metadata = {"name":"push-generate","entrypoint_path":"index.ts","verify_jwt":false}
  file      = 整个 supabase/functions/push-generate/index.ts (content-type: application/typescript)
```

> 注意：`metadata` 不能经 PowerShell `-F "metadata=..."` 直接传（会被拆成数组、json 解析失败）。
> 用 Node 的 `FormData`+`Blob` 构造最稳。
> 部署成功的标志：HTTP `201`，返回体里 `"slug":"push-generate"`、`"version":N`（比当前大）、`"status":"ACTIVE"`。

### 已验证

本次已部署到个人云，`push-generate` 升到 **version 4 / ACTIVE**，改动已生效。

***

## 6. 验证

1. 前端开着 float，创建一个短周期的定时主动消息。
2. 到点后：聊天**只出现前端 1 条**；云端同一批 `push_jobs` **未重复新增** **`done`**（或已提前被置 `cancelled`）。
3. 杀掉 float 再等一个周期：云端 120s 后**兜底出 1 条**并进聊天。
4. 长期观察：计划一直在、每个周期恰好 1 条、不重复。

排查口径（个人云表）：

- `push_jobs.status`：前端活着时应见 `cancelled`（前端撤了）或 `pending`（被杀/超时后端兜底执行）；

- 双生成是否消失：对比前后端同时触发时 `push_jobs` 是否只有一次真正 `done`。

***

## 7. 一句话口径（写死，别改）

- 主动/定时类 = `timed_task` 或 `trigger_key` 前缀 `idle:`/`timedwake:`/`periodcare:`。

- 后端对这些 **claim 前 sleep 120s**，靠 `where status=pending` 抢锁实现"前端活=前端出，前端死=后端兜底"。

- **计划本体不删**；只对"本轮"让路。

- **真正部署源是** **`supabase/functions/push-generate/index.ts`，改完必须用 Management API** **`functions/deploy`** **重新部署**才算生效。

