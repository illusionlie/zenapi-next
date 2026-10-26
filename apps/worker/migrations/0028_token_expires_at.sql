-- 0028: tokens 可选过期时间（ISO-8601 UTC，与 created_at 同格式；NULL = 永久）。
-- 语义：到期禁用不删除 —— tokenAuth 鉴权时惰性判定（now >= expires_at → 403 token_expired），
-- 不翻 status、无 cron 清理；行、quota 字段与 usage_logs.token_id 引用全部保留
-- （任务 10-26-token-expiry R1/R2/R5）。存量行（NULL）行为与迁移前逐字节一致。
ALTER TABLE tokens ADD COLUMN expires_at TEXT;
