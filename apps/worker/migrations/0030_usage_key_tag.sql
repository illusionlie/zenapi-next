-- 0030: usage_logs.key_tag 末次归因列（任务 10-26-key-cooldown-stats）。
-- 记录渠道多 Key 轮换中实际服务该请求的 API key 指纹（fnv1a32 前 8 hex，与
-- services/key-cooldown.ts keyFingerprint 同源）；最终失败的请求记录末次尝试
-- 的 key 指纹。NULL = 旧行 / 无 key 归因的写入路径（upstream_unavailable 且
-- 零尝试、非代理调用方）。不回填：存量行保持 NULL，读侧必须容忍 NULL。
-- 不加索引：key 维度只查 24h 内 raw 行，channel_id + created_at 既有索引的
-- 选择性已足够。rollup（usage_stats_daily）不含 key 维度，零改动。
ALTER TABLE usage_logs ADD COLUMN key_tag TEXT;
