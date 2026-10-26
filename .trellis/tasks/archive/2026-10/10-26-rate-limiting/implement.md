# Implement：令牌级 RPM 限流与 IP 鉴权失败节流

> 执行顺序自上而下，每步后跑该步验证命令；全部完成后跑全量门禁。
> 设计依据 design.md；需求锚点 prd.md。

## Step 1：滑动窗原语 + 单测

- [ ] 新建 `apps/worker/src/services/rate-limiter.ts`（design §3 签名：checkTokenRpm /
      recordIpAuthFailure / isIpThrottled / ipThrottleRetryAfterSec / resetRateLimiterState；
      now 注入；60s 窗；惰性剪枝 + size>10000 全量清扫）
- [ ] 新建 `tests/rate-limiter.test.ts`：滑窗边界、allowed 计入 / denied 不占窗、
      retryAfterSec、清扫、reset
- 验证：`bunx vitest run tests/rate-limiter.test.ts`

## Step 2：settings 接线

- [ ] `services/settings.ts`：`TOKEN_RPM_DEFAULT_KEY = "token_rpm_default"`、
      `IP_AUTH_FAIL_LIMIT_KEY = "ip_auth_fail_limit"` 加入 `PROXY_SETTING_KEYS`；
      新增导出纯函数 `resolveRateLimitConfig(raw)`（parseInt + clamp [0, 1e6]，脏值降 0）
      + 直测（可并入 Step 4 的 token-auth 测试或独立文件，按邻近惯例）
- 验证：`bunx vitest run`（既有全绿——PROXY_SETTING_KEYS 扩列不得破坏既有 settings
  消费方；若某测试断言键集合字面量，同步更新）

## Step 3：迁移 + schema

- [ ] `apps/worker/migrations/0029_token_rpm_limit.sql`
      （`ALTER TABLE tokens ADD COLUMN rpm_limit INTEGER;`）
- [ ] `apps/worker/src/db/schema.sql` tokens 表同步
- 验证：bun:sqlite 迷你库跑迁移（照 token-expiry 任务的验证方式）

## Step 4：tokenAuth 接线 + 测试

- [ ] SELECT 增 `t.rpm_limit`；TokenRecord 增 `rpm_limit: number | null`
- [ ] 顶部 IP 节流门（D1 查询前）+ 四失败出口 record + 尾部 RPM 门（design §4 次序图；
      Retry-After 用 `c.header` 预设再 jsonError；IP 提取链 cf-connecting-ip →
      x-forwarded-for 首值 → 缺省跳过）
- [ ] `tests/token-auth.test.ts` 增：RPM 429+Retry-After / NULL 跟随 / 0 豁免 / 值覆盖；
      IP 节流达限后零 D1（断言 prepare 调用数不增）、402 不计数、四出口计数、窗口恢复
- 验证：`bunx vitest run tests/token-auth.test.ts`；`bun run typecheck`

## Step 5：CRUD 三态

- [ ] `services/token-update.ts`：`resolveRpmLimitValue`（undefined 保留 / null·"" →
      NULL / 0 或正整数 / 非法 400 `invalid_rpm_limit`）；两个 resolver 接线
- [ ] `routes/tokens.ts` + `routes/user-api.ts`：POST/PATCH 接线（SELECT 列表接口
      增列 rpm_limit）
- [ ] `tests/token-update.test.ts` 增三态矩阵
- 验证：`bunx vitest run tests/token-update.test.ts`

## Step 6：UI

- [ ] `SettingsView.tsx`：两个数值字段（0 = 关闭文案），照既有 settings 表单模式；
      settings GET/PUT 若有键白名单需同步
- [ ] `TokensView.tsx` / `UserTokensView.tsx` + `core/types.ts` / `constants.ts`：
      令牌表单 rpm_limit 数值输入（空 = 跟随全局默认 / 0 = 显式不限 / 正整数 = 上限）
      + 两 App 提交体接线（照 expires_at 的模式）
- 验证：`bun run typecheck`

## Step 7：全量门禁 + 文档锚点

- [ ] `bun run check && bun run typecheck && bunx vitest run` 三绿
- [ ] AGENTS.md：§7 tokenAuth 行为补充（新两门）或 §8 新增「客户端限流」bullet
      （近似语义、失败计数口径、settings 键、三态语义）；§6 tokens 行提 rpm_limit；
      §10 tokens 描述同步
- [ ] `.trellis/spec/api-worker/backend/settings-config.md`：两新键入
      数值型 settings 契约清单（若该 spec 维护键清单）
- 验证：`bun run check`（md 也过 biome）

## 回滚点

- 任一步失败：Step 1/2 纯新增可整体丢弃；Step 4 之后需回退 tokenAuth 接线
  （迁移列留存无害）；运行时回滚 = settings 两键置 0。
