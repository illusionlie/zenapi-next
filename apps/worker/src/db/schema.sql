CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  type INTEGER NOT NULL DEFAULT 1,
  group_name TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  rate_limit INTEGER DEFAULT 0,
  models_json TEXT,
  metadata_json TEXT,
  test_time INTEGER,
  response_time_ms INTEGER,
  api_format TEXT NOT NULL DEFAULT 'openai',
  -- api_formats: JSON 数组，渠道 API 格式能力声明（白名单
  --   openai/responses/anthropic/custom，custom 独占）；api_format 为镜像列，
  --   存规范化数组的首元素（双写保证旧代码回滚可用）。
  api_formats TEXT,
  -- endpoint_overrides: JSON 对象，每格式独立端点覆盖（键白名单
  --   openai/responses/anthropic，custom 不可覆盖）；NULL = 全部格式走
  --   base_url 推导（迁移 0023 加列，无回填）。
  endpoint_overrides TEXT,
  custom_headers_json TEXT,
  disguise_headers_json TEXT,
  disguise_system_prompt TEXT,
  stream_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  token_plain TEXT,
  quota_total INTEGER,
  quota_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  allowed_channels TEXT,
  allowed_models TEXT,
  user_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  token_id TEXT,
  channel_id TEXT,
  model TEXT,
  request_path TEXT,
  total_tokens INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cost REAL,
  latency_ms INTEGER,
  first_token_latency_ms INTEGER,
  stream INTEGER,
  reasoning_effort TEXT,
  status TEXT,
  error_code INTEGER,
  error_message TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS usage_logs_channel_id ON usage_logs(channel_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  linuxdo_id TEXT,
  linuxdo_username TEXT,
  invite_code_id TEXT,
  allowed_models TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS users_linuxdo_id ON users(linuxdo_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS user_sessions_token ON user_sessions(token_hash);

CREATE TABLE IF NOT EXISTS model_aliases (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  alias_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS model_aliases_alias ON model_aliases(alias);
CREATE INDEX IF NOT EXISTS model_aliases_model_id ON model_aliases(model_id);

CREATE TABLE IF NOT EXISTS channel_model_aliases (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  alias_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_model_aliases_ch_alias ON channel_model_aliases(channel_id, alias);
CREATE INDEX IF NOT EXISTS channel_model_aliases_alias ON channel_model_aliases(alias);
CREATE INDEX IF NOT EXISTS channel_model_aliases_ch_model ON channel_model_aliases(channel_id, model_id);

CREATE TABLE IF NOT EXISTS user_checkins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  checkin_date TEXT NOT NULL,
  reward REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS user_checkins_user_date ON user_checkins(user_id, checkin_date);

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invite_codes_code ON invite_codes(code);

CREATE TABLE IF NOT EXISTS recharge_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  out_trade_no TEXT NOT NULL UNIQUE,
  trade_no TEXT,
  ldc_amount REAL NOT NULL,
  balance_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recharge_orders_user ON recharge_orders(user_id);
CREATE INDEX IF NOT EXISTS recharge_orders_trade ON recharge_orders(out_trade_no);

