-- 0025: 热路径索引补齐（鉴权 lookup + usage_logs 查询维度）
-- tokens(key_hash) / admin_sessions(token_hash)：tokenAuth / adminAuth 每请求
--   等值查询，此前全表扫描；admin_sessions 惰性清理单调增长，扫描代价随时间放大。
-- usage_logs(token_id, created_at)：令牌维度日志过滤与时间窗聚合
--   （routes/usage.ts、user-api.ts per-user JOIN、dashboard byToken）。
-- usage_logs(channel_id, created_at)：渠道维度聚合；最左前缀覆盖旧单列
--   usage_logs_channel_id 的全部查询（channel_id = ? 与 channel_id + created_at），
--   DROP 旧索引避免同列双索引写放大。usage_logs_created_at 单列保留
--   （retention DELETE 与无渠道条件时间窗仍需要）。
-- 全部幂等（IF NOT EXISTS / IF EXISTS）。非 UNIQUE：脏数据（理论不应存在的重复
--   hash）不应阻塞迁移；UNIQUE 化留待数据审计后另议。
CREATE INDEX IF NOT EXISTS tokens_key_hash ON tokens(key_hash);
CREATE INDEX IF NOT EXISTS admin_sessions_token_hash ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS usage_logs_token_created ON usage_logs(token_id, created_at);
DROP INDEX IF EXISTS usage_logs_channel_id;
CREATE INDEX IF NOT EXISTS usage_logs_channel_created ON usage_logs(channel_id, created_at);
