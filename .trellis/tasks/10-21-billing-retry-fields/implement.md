# implement：计费 batch 失败单次重试与可对账日志

测试一律 `bunx vitest run`（禁 watch / dev / wrangler 长驻进程）。

## 步骤

1. [ ] `services/usage.ts` recordUsage：
   - 抽 `runBillingBatch(attempts)` 或等价内联结构：第一次 `db.batch(statements)` 失败 →
     `await delay()` → 第二次；两次都败 → console.error（载荷见 prd R2，含 attempts）。
   - delay ~250ms（`new Promise(r => setTimeout(r, 250))`）；为可测性把延迟暴露为可选
     注入参数（如 `recordUsage(db, input, opts?: { retryDelayMs?: number })`，默认 250），
     测试传 0 或 fake timers，不真实等待。
   - tag、条件语句省略、MAX(0,…) 钳制、不抛错语义全部不动。
2. [ ] `tests/usage-billing.test.ts`：新增/更新用例——
   - 拒一次成功：无失败日志、batch 共 2 次、quota/balance 已更新。
   - 拒两次：失败日志含 model/channelId/requestPath/promptTokens/completionTokens/
     totalTokens/status/attempts=2，函数 resolve 不 reject。
   - 成功路径：batch 恰 1 次。
   - 既有用例更新（如有依赖日志载荷形状的）→ 逐条列出：
     - (实现时填写)
3. [ ] 门禁：`bun run check` → `bun run typecheck` → `bunx vitest run`。

## 完成判据

- prd.md Acceptance Criteria 全勾。

## 回滚点

- 单 feat commit revert。
