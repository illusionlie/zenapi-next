-- 0029: tokens 令牌级 RPM 限流上限（任务 10-26-rate-limiting R1）。
-- 三态语义：NULL = 跟随全局默认（settings.token_rpm_default，存量令牌零变化）；
-- 0 = 显式不限（豁免全局默认）；正整数 = 每分钟请求上限。判定在 tokenAuth 尾部
-- 惰性执行（isolate 内存滑窗近似），超限 429 rate_limit_exceeded + Retry-After，
-- 不发上游、不写 usage_logs、不扣费。无回填；存量行（NULL）行为与迁移前逐字节一致。
ALTER TABLE tokens ADD COLUMN rpm_limit INTEGER;
