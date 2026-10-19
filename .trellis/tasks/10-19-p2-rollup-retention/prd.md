# P2：用量预聚合与保留策略 cron 化

> 状态：PRD 已定稿；design.md / implement.md / jsonl 在本任务激活前补齐（复杂任务门槛）。
> 前置：P1（10-19-p1-hotpath-cache）归档后启动；首次部署需回填历史数据。

## Goal

给 usage_logs 建每日预聚合表并接 Workers Cron：仪表盘/监测的大窗口聚合从「全表扫原始行」变为「扫 rollup 小表」；日志保留从「管理员打开日志页顺带触发一次性大 DELETE」变为「cron 每日分批删除」；顺带清理过期会话。解除「数据越积 → 统计越慢 → 大聚合排队拖累同库代理请求」的正反馈。

## 背景（已核实的事实）

- dashboard.ts:35-81 单端点 5 条聚合 SQL（from/to 缺省即全表）；monitoring.ts:7-89 五条（默认 7d 原始行 + substr 分组）；models.ts:169-243 三条 30d 聚合；user-api.ts:113-211 用户端同型 5 条。usage_logs 除 P0 补的 token/channel 复合索引外无 model 索引，且**无任何汇总表**（grep CREATE TABLE 验证）。
- retention 唯一触发点 = 管理员 GET /api/usage（usage.ts:42-43）；DELETE 无 LIMIT（services/usage.ts:91-94），大表上撞 D1 单语句 30s 上限风险；wrangler.toml 无 [triggers]，index.ts 无 scheduled handler。
- admin_sessions / user_sessions 仅惰性清理（各鉴权中间件遇过期单条才 DELETE），过期行永久残留、单调增长。
- D1 平台特性：单库单线程逐查询，大聚合/大删除会排队阻塞同库代理请求；官方要求百万行级写入/删除必须分批。Cron 触发墙钟 15 分钟，足够分批循环。

## Requirements

- **R1 rollup 表 + 迁移**：`usage_stats_daily`（粒度：date + model + channel_id + token_id + user_id，聚合列含请求数、prompt/completion/total tokens、缓存命中/写入、cost、错误数），schema.sql 同步；幂等回填语义（同 date 先 DELETE 再 INSERT SELECT）。
- **R2 scheduled handler**：index.ts 导出 scheduled；wrangler.toml `[triggers]` 每日一次。任务链：昨日 rollup → 分批 DELETE 过期原始日志（LIMIT 循环，如 1000/批）→ 分批删除过期 sessions。
- **R3 聚合端点切换**：大窗口读 rollup + 近窗（当日）读原始行的并集拼装；管理端 dashboard/monitoring、用户端 monitoring 同构切换；拼装阈值与 SQL 在 design 定稿。
- **R4 保留策略 settings 化**：沿用 usage_retention_days 配置；rollup 表保留期独立（如 180d）——原始日志缩短后统计仍可回看长历史。
- **R5 手动触发端点**：管理员可手动执行 rollup / 清理（便于测试与首次回填）。
- **R6 首次回填**：对既有 usage_logs 按日分批回填 rollup，写入 implement。
- **R7 测试**：rollup SQL 幂等、分批 DELETE 终止条件与可重入、聚合端点 raw+rollup 并集正确性。

## 非目标

- 不做实时增量聚合（触发器/流式聚合）——日粒度 + 当日原始行并集够用。
- 不引入 Queues / DO 计数器。
- 时区口径默认 UTC 日切（与 created_at ISO 存储一致）；本地时区日切作为激活时决策项。

## Acceptance Criteria

- [ ] 30d 窗口的 dashboard/monitoring 响应不再聚合 usage_logs 原始行（EXPLAIN / 代码审查确认走 rollup）。
- [ ] 本地造数十万行级数据，30d 聚合响应较改造前有量级改善（基准数值记录进任务）。
- [ ] cron 手动触发（wrangler dev --test-scheduled）全链路通过：rollup → 分批删除 → sessions 清理。
- [ ] 删除分批循环单批失败可重入（幂等），不产生重复 rollup 行。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 开放问题（激活 design 前定稿，不阻塞本 PRD）

- rollup 粒度是否冗余 user_id 列（token 删除后的归属追溯）→ design 决。
- 大小窗口拼装阈值（24h / 48h）与当日数据的实时性取舍 → design 决。
