# cron 维护链规模加固与 rollup 自愈

## Goal

让每日 cron 维护链（rollup → retention 分批删 → sessions 清理 → rollup 清理）在真实
写入量下可持续运转：删除能力不撞 D1 每调用查询配额、单晚 rollup 失败可自愈、手动 prune
端点有界化、全表扫描查询消灭。

## 缺陷（已核验，评审 Critical 1 / 2 + Warning 5 / 6）

- **配额炸弹**：`pruneUsageLogsBatched`（services/usage-stats.ts:224-246）chunk=500 的
  无界 `for(;;)`。D1 限制每次 Worker 调用 1000 条查询（Paid）/ 50 条（Free）——稳态下
  每日删除量 ≈ 每日写入量，Paid 约 49 万行/日触顶，Free 约 2.1 万行/日触顶。触顶后同一
  invocation 内后续 D1 查询全被拒：sessions 清理与 rollup 180d 清理陪葬（runDailyMaintenance
  的「单步失败不阻断」在配额面前失效），且每天都重复。
- **统计黑洞**：cron 只 roll「新的昨天」（:293-302），某晚 rollup 失败（D1 瞬时故障）后
  无自愈——读取侧 raw 段只服务今天，该日在所有聚合端点永久不可见，尽管原始行还在库里。
- **手动 prune 端点**：`POST /api/usage/prune`（routes/usage.ts:52-63）在 HTTP 请求内同步
  跑同一个无界循环，撞同一配额；cutoff 用本地时区日历运算（`setDate`），与 cron 的 UTC
  毫秒口径（usage-stats.ts:305-306）不一致。
- **全表扫描**：`rollupMissingDates`（:190-199）`substr(created_at,1,10) NOT IN (...)` 让
  `usage_logs_created_at` 索引失效，30d × 大流量 = 千万行级全扫，撞 30s 时限。

## Requirements

- **R1 chunk 提量**：默认 chunkSize 500 → 5000（`DELETE ... rowid IN (SELECT rowid ...
  LIMIT ?)` 走索引的有界语句，单语句 30s 时限内裕量充足）。
- **R2 轮数保险丝**：pruneUsageLogsBatched 每次调用最多 `maxRounds` 轮（默认 180），到顶
  退出并显式标记「未删完」；返回值从裸 number 改为 `{ deleted, complete }`。全链查询预算
  ≤ ~250 条（Paid 1000 配额的四分之一），留足余量。
- **R3 rollup 自愈**：cron 链把「只 roll 昨天」改为「扫近 7 天（含昨天），逐日探测
  `SELECT 1 FROM usage_stats_daily WHERE stat_date = ? LIMIT 1`（走索引），缺失才
  rollupDate」；逐日容错（单日失败不阻断其余日）。
- **R4 prune 端点有界化**：复用同一有界实现；响应带 `complete` 标志（未删完时管理员重跑）；
  cutoff 计算抽成共享 helper（UTC 毫秒口径），cron 与端点统一使用。
- **R5 rollupMissingDates 去全表扫**：改为 `SELECT MIN(created_at) FROM usage_logs`（索引
  探底，一行）+ JS 侧枚举 [min 日, 昨天] 日期序列 + `SELECT DISTINCT stat_date FROM
  usage_stats_daily`（rollup 小表，≤180 行）差集。查询数 O(1)+O(days)。
- **R6 测试**：保险丝行为（注入小 maxRounds）、自愈补漏（7 天中缺 2 天只补缺的）、单日
  失败容错、端点 complete 标志、cutoff helper 时区确定性（注入 now 断言与本地时区无关）、
  rollupMissingDates 新实现的差集正确性。全部注入时钟/固定数据，禁止依赖真实时间。

## Acceptance Criteria

- [ ] 注入 maxRounds=2、chunk=10、残留 35 行 → 返回 `{deleted: 20, complete: false}`，不抛错。
- [ ] 7 天窗口内 2 天缺 rollup → 恰好补这 2 天，已有 rollup 的日期不执行写操作。
- [ ] 某日 rollupDate 抛错 → 其余日期继续，错误按日打日志。
- [ ] `POST /api/usage/prune` 未删完时响应含 incomplete 语义字段。
- [ ] rollupMissingDates 不再包含对 created_at 的函数运算 SQL（grep 验证无 substr(created_at)）。
- [ ] cron 全链查询数静态可算：design.md 给出逐步预算表，总和 ≤ 250。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿；被改语义的既有测试逐条列出。

## 非目标

- 不改 rollupDate 的防丢守卫与 DELETE+INSERT 幂等形态（评审确认正确）。
- 不改 cron 时刻（03:17 UTC）与保留期默认值。
- 不引入跨 invocation 的断点续传状态（可重入谓词已够）。
