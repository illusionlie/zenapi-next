-- 0031: webhooks — outbound notification endpoints (channel failure alerts
-- via the */5 cron evaluator, optional daily usage report; type whitelist
-- feishu|wecom|dingtalk|slack|generic, payload shapes in
-- services/webhook-senders.ts). The url embeds the bot token and is visible
-- to the admin domain only (routes/webhooks.ts behind adminAuth).
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
