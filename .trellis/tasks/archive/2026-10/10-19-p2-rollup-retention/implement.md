# 执行计划 — P2 用量预聚合与保留策略 cron 化

前置：P0/P1 已归档（工作树应只有簿记改动）。按序执行，每步可独立提交回退。
**沙箱禁令：禁止启动长驻进程（dev server / wrangler dev / watch）；`bun run test` 是 watch，一律用 `bunx vitest run`。**

## Checklist

1. [ ] **迁移 + schema**：`migrations/0026_usage_stats_daily.sql`（design 的表 + 2 索引）+ schema.sql 同步；`bun run --filter api-worker db:migrate` 本地应用。
2. [ ] **services/usage-stats.ts**：rollupDate / rollupRange / pruneUsageLogsBatched / pruneExpiredSessions / pruneRollup / splitWindow，纯函数化；既有 services/usage.ts 的顺带清理改调 batched 版。
3. [ ] **scheduled handler**：index.ts 导出 scheduled + wrangler.toml `[triggers]`（03:17 UTC）；任务链与单步容错按 design。
4. [ ] **聚合端点切换**：dashboard / monitoring / models / user-api 四处按 splitWindow 两段拼装；输出列两段对齐。
5. [ ] **手动端点**：POST /api/dashboard/rollup、POST /api/usage/prune（既有路由文件内追加）。
6. [ ] **测试**（内存 D1 仿 P0 的 getPlatformProxy 模式，见 tasks/10-19-p0-index-billing/verification.md）：
   - rollup 幂等（同日重跑行数不变、数值一致）；日切边界（23:59:59 / 00:00:00 归属）；NULL≠0 分母口径（usage-accounting §3.4 锚点：混合 NULL 行的 cache_rate 与 raw 直查一致）。
   - splitWindow：纯当日 / 跨日 / 跨月边界。
   - pruneUsageLogsBatched：终止条件、可重入、删除计数。
   - 聚合端点：同一天数据 raw 直查 vs rollup+raw 并集数值一致（核心回归锚点）；短窗口纯 raw。
   - scheduled handler 单测（mock event/ctx）：一步失败不阻断其余。
7. [ ] **文档（Phase 3.3 一并，本次不做）**：AGENTS §8/§10、database-guidelines、usage-accounting。

## 验证命令

```bash
bun run check && bun run typecheck && bunx vitest run
```

本地行为验证（deferred to user，步骤写入 verification.md）：`wrangler dev --test-scheduled` 触发 cron；管理台对比切表前后 dashboard 数值。

## 审查门

- 步骤 2 后自查：rollupDate 幂等（重跑无重复行）。
- 步骤 4 后自查：四处端点输出列两段对齐；cache_rate 分母口径不变。
- 部署注记：上线后先 `POST /api/dashboard/rollup` 全量回填，再等 cron 接管。

## 回滚点

- 迁移独立成文件；表残留无害。
- 端点切换逐文件独立 commit，可单点回退 raw 直查。
