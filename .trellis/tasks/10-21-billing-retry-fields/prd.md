# 计费 batch 失败单次重试与可对账日志

## Goal

recordUsage 的计费三写 batch（usage_logs INSERT + tokens.quota_used + users.balance，
单事务）失败时：吃掉绝大多数 D1 瞬时抖动（单次延迟重试），并让最终失败留下可离线对账
的完整日志载荷。不改变「宁可漏记不可错记」取向、不引入重试队列。

## 缺陷（已核验，评审 C1 子集）

services/usage.ts:100-112：`db.batch` 失败只 `console.error("[usage] billing batch failed",
{ tokenId, userId, cost, error })`——

- 无重试：D1 瞬时抖动（overloaded / 网络断连）占失败多数，一次重试可吃掉大半。
- 载荷缺 model、channelId、prompt/completion/total tokens、status：接了 Logpush 也只能
  补金额，无法重建统计行。

## Requirements

- **R1 单次重试**：batch 失败 → 延迟 ~250ms → 重放同一 statements（batch 原子，失败即
  整体回滚，重放无半态风险）。两次都失败才落失败日志。重试仅一次，不做指数退避。
- **R2 日志补全**：失败载荷增加 `model`、`channelId`、`requestPath`、`promptTokens`、
  `completionTokens`、`totalTokens`、`status`、`attempts`。tag `[usage] billing batch
  failed` 字面不变（可告警签名锚点）。
- **R3 行为不变式**：成功路径恰好一次 batch 调用（零额外延迟）；不抛错（post-response
  epilogue 语义）；条件语句省略逻辑（无 tokenId/totalTokens=0 跳 quota、cost=0 跳 balance）
  不动。
- **R4 测试**：fake db（batch 拒绝一次后成功 → 恢复且无失败日志；拒绝两次 → 失败日志含
  全部新字段与 attempts=2）；成功路径 batch 恰一次。定时器不依赖真实 250ms 等待——延迟
  函数可注入或用 vi.useFakeTimers。

## Acceptance Criteria

- [ ] 瞬时失败（1 次拒绝）被重试吸收，无 `[usage] billing batch failed` 日志。
- [ ] 持续失败（2 次拒绝）日志包含 R2 全部字段，attempts=2，函数不抛错。
- [ ] 成功路径 batch 调用次数恰为 1。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不引入 Queues/DO/持久重试队列；不做跨 invocation 兜底。
- 不改 recordUsage 的语句构成与 MAX(0,…) 钳制（评审确认正确）。
