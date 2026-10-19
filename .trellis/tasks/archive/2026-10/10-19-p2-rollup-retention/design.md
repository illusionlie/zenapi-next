# 技术设计 — P2 用量预聚合与保留策略 cron 化

## 开放问题定稿（PRD → 决策）

- **rollup 粒度**：`stat_date + model + channel_id + token_id + user_id`，user_id 为**冗余列**（rollup 时从 tokens JOIN 取得，token 删除后归属仍可追溯）。幂等靠「同 date 先 DELETE 再 INSERT SELECT」，不用 UNIQUE 约束（SQLite UNIQUE 对 NULL 视为相异，token_id/channel_id 可空会导致 upsert 失效）。
- **大小窗口拼装阈值**：查询起点早于「今日 UTC 零点」即走 rollup+raw 并集；纯当日窗口直查 raw。阈值就是日切，不引入第二常数。
- **时区**：UTC 日切（stat_date = `substr(created_at, 1, 10)`，与 created_at ISO 存储一致）；管理台展示时区是前端职责，不在本任务范围。

## 数据层（迁移 0026）

`apps/worker/migrations/0026_usage_stats_daily.sql`（类型以 schema.sql 实际列型为准，id 均为 TEXT 系）：

```sql
CREATE TABLE IF NOT EXISTS usage_stats_daily (
	id TEXT PRIMARY KEY,
	stat_date TEXT NOT NULL,          -- YYYY-MM-DD（UTC 日切）
	model TEXT NOT NULL,
	channel_id TEXT,
	token_id TEXT,
	user_id TEXT,                     -- 冗余列：rollup 时 JOIN tokens 取得
	requests INTEGER NOT NULL DEFAULT 0,
	error_count INTEGER NOT NULL DEFAULT 0,
	prompt_tokens INTEGER NOT NULL DEFAULT 0,
	completion_tokens INTEGER NOT NULL DEFAULT 0,
	total_tokens INTEGER NOT NULL DEFAULT 0,
	cached_input_tokens INTEGER NOT NULL DEFAULT 0,
	cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
	cost REAL NOT NULL DEFAULT 0,
	first_token_latency_sum INTEGER NOT NULL DEFAULT 0 -- 供均值，行数即分母
);
CREATE INDEX IF NOT EXISTS usage_stats_daily_date ON usage_stats_daily(stat_date);
CREATE INDEX IF NOT EXISTS usage_stats_daily_user_date ON usage_stats_daily(user_id, stat_date);
```

- id 生成：`lower(hex(randomblob(16)))`（与仓库现有 TEXT 主键风格对齐，实现时 grep 一处现有 INSERT 确认）。
- schema.sql 同步（表 + 两条索引，放 usage_logs 定义之后）。
- rollup 保留期 180d：`ROLLUP_RETENTION_DAYS = 180`（services 常量）。

## 服务层（新 services/usage-stats.ts，纯函数化可测）

- `rollupDate(db, date)`：`DELETE WHERE stat_date = ?` → `INSERT INTO usage_stats_daily SELECT ... FROM usage_logs WHERE created_at >= ? AND created_at < ? GROUP BY model, channel_id, token_id`（user_id 经 LEFT JOIN tokens），聚合列 SUM + COUNT(CASE WHEN status<>'ok') error_count。幂等：重跑同 date 先删后插。
- `rollupRange(db, fromDate, toDate)`：逐日循环 rollupDate（回填/手动触发用）。
- `pruneUsageLogsBatched(db, beforeIso, chunkSize=500)`：循环 `DELETE FROM usage_logs WHERE rowid IN (SELECT rowid FROM usage_logs WHERE created_at < ? LIMIT ?)` 直到 changes < chunkSize；返回删除总数。可重入（每批独立提交）。
- `pruneExpiredSessions(db)`：`DELETE FROM admin_sessions WHERE expires_at < ?` + `DELETE FROM user_sessions WHERE expires_at < ?`（小表单语句）。
- `pruneRollup(db)`：`DELETE FROM usage_stats_daily WHERE stat_date < ?`（180d 前，单语句）。
- 既有 `pruneUsageLogs`（services/usage.ts 单条大 DELETE）**保留但改调** batched 版本，GET /api/usage 的顺带清理自动获得分批语义（或直接替换实现，实现者择一，报告说明）。

## 聚合端点切换（raw + rollup 并集）

- 新 util（services/usage-stats.ts 导出）：`splitWindow(fromIso, toIso)` → `{ rollupFrom, rollupTo, rawFrom, rawTo }`；`rawFrom > rawTo` 时无 raw 段。
- 各端点把原单条聚合 SQL 改为两段：
  - rollup 段：`SELECT ... FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ? GROUP BY ...`（日期粒度聚合，列名映射到与 raw 段一致的输出形态）。
  - raw 段：原 SQL 加 `created_at >= rawFrom AND created_at < rawTo`。
  - 外层聚合或 JS 侧合并两段结果（按各端点输出形态择简，两段输出列对齐是硬要求）。
- 切换端点清单：`routes/dashboard.ts`（summary/byDay/byModel/byChannel/byToken）、`routes/monitoring.ts`（5 条）、`routes/models.ts`（3 条 30d 聚合）、`routes/user-api.ts` 用户 monitoring 与 /dashboard（经 tokens 关联 user_id——rollup 表已有冗余 user_id 列，直接 `WHERE user_id = ?`，不再 JOIN tokens）。
- 缓存命中率口径（usage-accounting §3.4，NULL≠0 分母）在 rollup 段天然成立：rollup 行只累加有数据行的 prompt 与 cached。**聚合语义回归是硬验收**：同一天数据 rollup 前后 summary 数值一致（测试锚点）。

## Cron 接线

- `wrangler.toml` 增：
  ```toml
  [triggers]
  crons = ["17 3 * * *"]   # 03:17 UTC 每日（避开整点高峰）
  ```
- `index.ts` 导出 `scheduled(event, env, ctx)`：rollup 昨日 → pruneUsageLogsBatched（retention 读 settings `usage_retention_days`，缺省回落既有默认）→ pruneExpiredSessions → pruneRollup；全程 await（Cron 墙钟 15 分钟），每步 try/catch console.error 继续（一步失败不阻断其余清理），复用 runPostResponse 的降级思想但 scheduled 内直接 await。
- fetch handler 不变；scheduled 与 fetch 共存导出。

## 手动端点（管理员，测试与首次回填用）

- `POST /api/dashboard/rollup`（body `{ date?: string }`：单日或缺省全量缺失日期回填）→ `{ rolled: string[] }`。
- `POST /api/usage/prune` → `{ deleted: number }`（调 batched prune）。
- 挂载点在既有 routes 文件内追加（不新建路由文件），走默认 adminAuth（不在放行清单，天然管理员专用）。

## 兼容与回滚

- 新表对旧代码不可见；回滚代码保留表无害。
- 聚合端点切换为纯查询改造：回滚即回 raw 直查。
- cron 部署后首次跑前必须手动回填（POST /api/dashboard/rollup 全量），写入 implement 部署注记。

## 权衡记录

- 不做实时增量聚合：日粒度 + 当日 raw 并集，复杂度与收益平衡。
- user_id 冗余：空间换 token 删除后的可追溯性。
- DELETE-INSERT 而非 upsert：SQLite NULL UNIQUE 语义使 upsert 键不完整，先删后插最直白且天然幂等。
- sessions 清理并入同一 cron：复用调度，不加第二个 trigger。
