-- 0026: usage_stats_daily 每日预聚合表（P2 用量预聚合与保留策略 cron 化）
-- 粒度：stat_date + model + channel_id + token_id；user_id 为冗余列
--   （rollup 时 LEFT JOIN tokens 取得，token 删除后归属仍可追溯）。
-- 写入路径：services/usage-stats.ts rollupDate —— 同 stat_date 先 DELETE 再
--   INSERT SELECT，单次 db.batch（D1 batch = 单事务）。DELETE-INSERT 而非
--   upsert：SQLite UNIQUE 对 NULL 视为相异，channel_id/token_id/user_id 可空
--   会使 upsert 键不完整；先删后插天然幂等。
-- 列口径（对齐 usage-accounting §3.4 与被切换聚合端点的输出契约）：
--   cache_prompt_base = SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN
--   prompt_tokens ELSE 0 END)——缓存命中率分母（NULL≠0）在 rollup 段同样成立；
--   latency_ms_sum 供 avg_latency_ms = SUM(latency_ms_sum)/SUM(requests) 两段
--   拼装还原（usage_logs.latency_ms 由 recordUsage 恒写非 NULL，行数即分母；
--   design 原稿列名 first_token_latency_sum 对应的 first_token_latency_ms
--   在全部聚合端点中零消费，故改为被消费的 latency_ms）；
--   last_seen_at = MAX(created_at)，monitoring 的 last_seen 从 rollup 还原。
-- model 可空（镜像 usage_logs.model；recordUsage 的 model ?? null 允许 NULL，
--   dashboard byModel 的 null 分组与 models.ts 的 model IS NOT NULL 过滤
--   语义据此逐字节保持）。
-- 保留期独立 180 天（ROLLUP_RETENTION_DAYS，services 常量），cron 每日清理。
-- 全部幂等（IF NOT EXISTS）。表对旧代码不可见，回滚代码保留本表无害。
CREATE TABLE IF NOT EXISTS usage_stats_daily (
  id TEXT PRIMARY KEY,
  stat_date TEXT NOT NULL,
  model TEXT,
  channel_id TEXT,
  token_id TEXT,
  user_id TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_prompt_base INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms_sum INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS usage_stats_daily_date ON usage_stats_daily(stat_date);
CREATE INDEX IF NOT EXISTS usage_stats_daily_user_date ON usage_stats_daily(user_id, stat_date);
