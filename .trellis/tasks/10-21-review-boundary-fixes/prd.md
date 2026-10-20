# 评审修复父任务：规模边界与错误路径加固

> 父任务只承载评审结论、任务地图与跨子任务验收，自身无直接实现目标；
> AGENTS.md / .trellis/spec 的文档同步在所有子任务完成后由本任务收口（见下方 finish 清单）。

## 来源

2026-10-20 对未推送的「高并发加固」树（62f97e5 / 50f4ad6 / 46e3d8c / f248493）做了双评审员设计评审，
主会话对承重结论逐条核验（代码 + D1/Workers 官方限制文档）。结论：架构方向正确，但存在
四个规模边界 / 错误路径缺陷。本父任务把结论落成 4 个子任务。

已核验的官方限制依据（评审时确认）：

- D1 每次 Worker 调用最多 **1000 条查询（Paid）/ 50 条（Free）**；单条 SQL 30s 时限作用于整个 batch 调用。
- Workers Cron scheduled handler 墙钟上限 15 分钟；waitUntil 收尾窗口约 30 秒。

## 任务地图

| 子任务 | 优先级 | 修复内容 |
|--------|--------|----------|
| 10-21-splitwindow-subday | P1 | splitWindow 对 span ≤ 1 天的窗口绕开 rollup 段（raw-only 精确边界），消除 1d 档恒虚高与 15m/1h 跨 UTC 午夜时的 24x–96x 放大 |
| 10-21-retention-fuse-backfill | P1 | retention 分批 DELETE chunk 500→5000 + 轮数保险丝（预算受控）+ cron 近 7 天 rollup 自愈补漏 + 手动 prune 端点有界化 + rollupMissingDates 去全表扫 + cutoff 计算统一 |
| 10-21-billing-retry-fields | P2 | recordUsage 计费 batch 失败后单次延迟重试；失败日志补 model/channel/tokens 等可对账字段 |
| 10-21-misc-review-fixes | P2 | debug 请求日志 text 回退死代码；管理台 GET 读 debug flag 绕 30s 缓存；渠道冷却 streak 时间衰减 |

## 跨子任务验收

- [ ] 4 个子任务各自验收全过、`bun run check && bun run typecheck && bun run test` 全绿。
- [ ] 子任务间无行为矛盾：splitwindow-subday 与 retention-fuse-backfill 都改 `services/usage-stats.ts`，顺序执行（先 1 后 2），后者兼容前者语义。
- [ ] AGENTS.md §8 更新：预聚合条目（短窗口绕开 + 自愈补漏 + 保险丝）、计费条目（重试 + 日志字段）、冷却条目（衰减语义）、`loadProxyRetryConfig` 描述漂移修正。
- [ ] .trellis/spec/api-worker/backend/usage-accounting.md §8/§9 与新行为同步。
- [ ] 评审确认「不用动」的点（isolate 冷却方向、TTL 缓存、03:17 时序设计、DELETE+INSERT 幂等）未被顺手重构。

## Finish 清单（父任务收口）

1. 全量门禁：`bun run check && bun run typecheck && bun run test`。
2. AGENTS.md §8 与 .trellis/spec 同步（docs(spec) 提交）。
3. 归档 4 个子任务与父任务（chore(task) 提交）。

## 非目标

- 不引入 Queues / Durable Objects / 重试队列服务。
- 不做 rollup 写入的增量聚合或触发器方案。
- 不动计费「宁可漏记不可错记」的取向（只加单次重试与可对账日志，不引入最终一致兜底存储）。
