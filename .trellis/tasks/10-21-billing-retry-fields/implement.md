# implement：计费 batch 失败单次重试与可对账日志

测试一律 `bunx vitest run`（禁 watch / dev / wrangler 长驻进程）。

## 步骤

1. [x] `services/usage.ts` recordUsage：
   - 抽 `runBillingBatch(attempts)` 或等价内联结构：第一次 `db.batch(statements)` 失败 →
     `await delay()` → 第二次；两次都败 → console.error（载荷见 prd R2，含 attempts）。
     （实现取等价内联结构：`while (attempts < BILLING_BATCH_MAX_ATTEMPTS)` 循环 + 成功即 `return`，
     `BILLING_BATCH_MAX_ATTEMPTS = 2` 模块常量，`delay` 为模块级私有 helper。）
   - delay ~250ms（`new Promise(r => setTimeout(r, 250))`）；为可测性把延迟暴露为可选
     注入参数（如 `recordUsage(db, input, opts?: { retryDelayMs?: number })`，默认 250），
     测试传 0 或 fake timers，不真实等待。
   - tag、条件语句省略、MAX(0,…) 钳制、不抛错语义全部不动。
2. [x] `tests/usage-billing.test.ts`：新增/更新用例——
   - 拒一次成功：无失败日志、batch 共 2 次、quota/balance 已更新。
     （"absorbs a transient batch failure via the single delayed retry"）
   - 拒两次：失败日志含 model/channelId/requestPath/promptTokens/completionTokens/
     totalTokens/status/attempts=2，函数 resolve 不 reject。
     （"logs with [usage] context and resolves (no throw) when both attempts fail"）
   - 成功路径：batch 恰 1 次。
     （既有首用例 `toHaveLength(1)` 断言承载，补 R3 注释锚点）
   - 既有用例更新（如有依赖日志载荷形状的）→ 逐条列出：
     - "logs with [usage] context and resolves (no throw) when the batch fails" → 更名
       "...when both attempts fail"：makeDb 参数从 `batchRejects`（恒拒）改为 `rejectFirst: 2`；
       recordUsage 新传 `{ retryDelayMs: 0 }`（否则真实等待 2×250ms）；payload 断言从
       tokenId/userId/cost/error 四字段扩为 R2 全字段（model/channelId/requestPath/
       promptTokens/completionTokens/totalTokens/status/attempts: 2）；新增
       `batchAttemptCount() === 2` 断言。保留不变：resolve 不 reject、tag 字面
       `[usage] billing batch failed`、`batchCalls` 长度 0。
     - makeDb 重构：`batchRejects` 恒拒参数替换为 `rejectFirst`（前 N 次拒，之后成功）+
       `rejectReason`，并新增 `batchAttemptCount()`（成功 + 被拒调用总数）。恒拒语义在
       attempts=2 上限下与 `rejectFirst: 2` 等价。
     - 首个成功路径用例：断言未改（`batchCalls` 长度 1、errSpy 静默、19 列 INSERT /
       MAX(0,…) SQL 文本），仅补「R3 恰一次 batch」注释。
     - 其余 4 个条件省略用例（no tokenId / totalTokens=0 / cost=0 / no userId）：零改动，
       默认走成功路径且不受新参数影响。
3. [x] 门禁：`bun run check` → `bun run typecheck` → `bunx vitest run`。
   （check 0 error、typecheck exit 0、vitest 31 files / 598 tests 全绿）

## 完成判据

- prd.md Acceptance Criteria 全勾。

## 回滚点

- 单 feat commit revert。
