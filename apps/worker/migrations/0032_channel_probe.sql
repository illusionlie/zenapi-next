-- 0032: 渠道主动健康探测（任务 10-26-channel-probe，默认关）。
-- channels.probe_enabled: 渠道级开关（INTEGER NOT NULL DEFAULT 0，公益站/
--   中转站禁测活——定时同特征流量敏感）；探测仅 GET /models（无 prompt、
--   零 token 消耗），结果只展示、绝不参与路由裁决（不进候选过滤、不触发/
--   退出渠道冷却、不动权重）。
-- channels.last_probe_at: 末次探测 ISO 时间戳（NULL = 从未探测，调度立即
--   到期）；仅由探测调度器写，渠道 CRUD 不触碰。
-- channel_probes: 探测历史（status ∈ healthy|degraded|down，detail 为逐格式
--   结果 JSON {format: "ok" | "err: 截断消息"}），保留 7 天，由 03:17 UTC
--   cron 保留链尾清理（services/usage-stats.ts runDailyMaintenance）。
-- 两列均无回填；存量行（probe_enabled=0）行为与迁移前逐字节一致。
ALTER TABLE channels ADD COLUMN probe_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels ADD COLUMN last_probe_at TEXT;

CREATE TABLE IF NOT EXISTS channel_probes (
  channel_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  detail TEXT,
  PRIMARY KEY (channel_id, checked_at)
);

-- 保留清理与监测页窗口查询都按 checked_at 过滤（与 usage_logs_created_at 同惯例）
CREATE INDEX IF NOT EXISTS channel_probes_checked_at ON channel_probes(checked_at);
