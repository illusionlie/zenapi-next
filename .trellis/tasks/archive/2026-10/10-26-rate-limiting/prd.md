# 令牌级 RPM 限流与 IP 鉴权失败节流

## Goal

ZenAPI 目前没有任何客户端侧限流（tokenAuth 仅有额度 / 余额预检），失控客户端可以无限
打满网关与上游，D1 鉴权单查也暴露在 token 字典爆破面前。本任务补两层正交防护：

1. **令牌级 RPM 限流**——防单个令牌失控，有归属、可告知；
2. **IP 鉴权失败节流**——防 token 爆破扫描。

复杂任务：`task.py start` 前需补 `design.md` + `implement.md`。

## Requirements

- **R1 令牌级 RPM**：
  - `tokens.rpm_limit INTEGER NULL`（迁移 + schema.sql）；语义（修正于 design 阶段）：
    **NULL = 跟随全局默认**（存量令牌零变化）、**正整数 = 每分钟上限**、
    **0 = 显式不限（豁免全局默认）**；
  - settings 全局默认 `token_rpm_default`（整数，0 = 关闭，默认 0 即现网零行为变化）；
  - 实现：isolate 内存滑动窗（60 秒窗口，按 token id 计数，模块级 Map，照
    `channel-cooldown.ts` 范式）；超限 → 429 `rate_limit_exceeded` + `Retry-After` 头
    （剩余窗口秒数）；
  - 语义诚实写入代码注释与 AGENTS.md：**近似限流**（每 isolate 独立计数，实际有效上限
    ≈ 设定值 × 活跃 isolate 数）；纯内存无外部依赖，天然 fail-open。
- **R2 IP 鉴权失败节流**：
  - 维度 = `cf-connecting-ip`（缺失回退 `x-forwarded-for` 首值，再缺省跳过检查）；
  - 仅对 tokenAuth **鉴权失败**（401 invalid_token / 403 token_disabled /
  token_expired 等）计数，60 秒滑窗；超阈值（settings `ip_auth_fail_limit`，默认 30，
  0 = 关）→ 窗口内该 IP 后续请求直接 429 `auth_throttled`，不再查 D1；
  - 鉴权成功**不清零**计数（防「扫描 + 正常调用混跑」绕过）；
  - 同为 isolate 内存近似。
- **R3 生效范围**：`/v1/*` 与 `/anthropic/v1/*`（tokenAuth 域）。管理台 / 用户端登录
  爆破节流为后续扩展，本任务不做。
- **R4 计费纪律**：被限流请求不发上游、不写 usage_logs、不扣费（在 tokenAuth 通过后、
  渠道选择前的最早环节拦截）。
- **R5 UI**：系统设置页两个默认值（token_rpm_default / ip_auth_fail_limit）；令牌编辑
  表单（管理台 + 用户端）加 rpm_limit 字段（空 = 跟随全局默认、0 = 显式不限、
  正整数 = 上限）。
- **R6 测试**：超限 429 + Retry-After；NULL 令牌跟随全局默认、显式 0 豁免；窗口滑动
  恢复；IP 节流触发后直接 429 且无 D1 查询（mock 断言）；成功请求不推进失败计数；
  默认配置下现网行为零变化。

## Acceptance Criteria

- [ ] rpm_limit=5 的令牌第 6 次/分钟请求 → 429 `rate_limit_exceeded` + Retry-After；
      下一分钟窗口恢复。
- [ ] 全局默认 60 + rpm_limit NULL 的令牌按 60 生效；同配置下 rpm_limit=0 的令牌不受限。
- [ ] 同 IP 连续 31 次无效令牌请求 → 第 31 次（阈值 +1）起 429 `auth_throttled`，
      D1 查询次数不再增长。
- [ ] 全默认配置（两值皆 0、存量令牌全 NULL）下所有既有测试零变化。
- [ ] settings 修改后 ≤30s 生效（走既有 settings 缓存链）。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不做 Durable Objects 精确全局限流（成本不值）。
- 不做每秒级 TPS（RPM 粒度先行）。
- 不做登录端（/api/u/auth）节流、不做验证码。
- 不做按用户（跨令牌聚合）限流。
