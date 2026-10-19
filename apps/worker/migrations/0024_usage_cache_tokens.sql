-- 0024: usage_logs 缓存 token 两列（缓存命中 / 缓存写入）
-- cached_input_tokens: 缓存命中的输入 token（优先级 prompt_tokens_details.cached_tokens
--   → input_tokens_details.cached_tokens → prompt_cache_hit_tokens →
--   cache_read_input_tokens）；NULL = 上游未报告，不得当 0，聚合分母自动排除。
-- cache_creation_tokens: 缓存写入 token，仅 Anthropic 语义
--   （cache_creation_input_tokens）；OpenAI 系恒 NULL，不进命中率分子。
-- 回填：无——存量行 NULL 即「上游未报告」，行为与迁移前一致；纯 Anthropic
--   路径的 prompt_tokens 口径修复只对新写入行生效。
ALTER TABLE usage_logs ADD COLUMN cached_input_tokens INTEGER;
ALTER TABLE usage_logs ADD COLUMN cache_creation_tokens INTEGER;
