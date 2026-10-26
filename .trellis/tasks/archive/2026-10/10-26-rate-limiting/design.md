# Design：令牌级 RPM 限流与 IP 鉴权失败节流

> 需求见 prd.md（R1-R6）。核心决策已与维护者拍板：isolate 内存近似 + fail-open，
> 不上 Durable Objects；RPM 粒度先行；仅 tokenAuth 域（/v1/* 与 /anthropic/v1/*）。

## 1. 边界与不变式

- **零行为变化默认态**：`token_rpm_default=0` 且存量令牌全 NULL 时，所有限流路径短路，
  既有测试零改动通过。
- **纯内存近似**：两限流器均为 isolate 内 Map，不跨 isolate 共享——有效上限 ≈ 设定值
  × 活跃 isolate 数；代码注释与 AGENTS.md 明示。无外部依赖 = 无失败路径（fail-open
  是结构性属性而非 catch 兜底）。
- **计费纪律**：被限流请求不发上游、不写 usage_logs、不动额度（tokenAuth 内拦截，
  天然满足）。
- **不改既有门序**：tokenAuth 现有门（status → expiry → quota → user status/balance）
  语义与次序不动；新增两门见 §4。

## 2. 数据模型

- 迁移 `0029_token_rpm_limit.sql`：`ALTER TABLE tokens ADD COLUMN rpm_limit INTEGER;`
- `schema.sql` tokens 表同步（INTEGER NULL）。
- settings 两键（无迁移，settings 表 KV）：`token_rpm_default`、`ip_auth_fail_limit`。

## 3. 组件一：`services/rate-limiter.ts`（新建）

统一滑动窗原语，两个独立实例域：

```ts
export type SlidingWindowResult = { allowed: boolean; retryAfterSec: number };
// RPM：命中即记（allowed 时也记录时间戳——限的是到达速率，非成功速率）
export function checkTokenRpm(tokenId: string, limitPerMin: number, now?: number): SlidingWindowResult;
// IP 失败：显式 record + check 分离（check 在 D1 查询前，record 在失败出口处）
export function recordIpAuthFailure(ip: string, now?: number): void;
export function isIpThrottled(ip: string, limit: number, now?: number): boolean;
export function ipThrottleRetryAfterSec(ip: string, now?: number): number;
// 测试隔离
export function resetRateLimiterState(): void;
```

- 实现：`Map<string, number[]>`（60s 窗口时间戳）；每次 touch 惰性剪枝过期项；
  Map.size 超阈值（10000）全量清扫（照 channel-cooldown 的防增长模式）。
- `now` 可注入（测试确定性锚点，禁 fake-timer 依赖执行耗时）。
- RPM 语义：`checkTokenRpm` 在 allowed 路径**也追加**当前时间戳（第 limit+1 次拒绝时
  不追加，被拒请求不占窗）。retryAfterSec = ceil(窗口剩余)。

## 4. 组件二：tokenAuth 接线（`middleware/tokenAuth.ts`）

次序（全图）：

```
请求 → [新] IP 节流门（isIpThrottled → 429 auth_throttled + Retry-After，零 D1）
     → 提取 Bearer → 既有 D1 单查（SELECT 增列 t.rpm_limit）
     → invalid_token（401）→ [记] IP 失败
     → token_disabled（403）→ [记] IP 失败
     → token_expired（403）→ [记] IP 失败
     → quota_exceeded / insufficient_balance（402）→ 不记（合法客户端资金问题，
       不该被 IP 节流误伤）
     → [新] RPM 门（checkTokenRpm）→ 429 rate_limit_exceeded + Retry-After
     → next()
```

- **失败计数口径**（design 定稿）：仅 401 `token_required`/`invalid_token`、403
  `token_disabled`/`token_expired` 四个出口记录；成功不计数（防「扫描混正常调用
  绕过」由滑窗自身承载：正常流量不增加失败计数）。
- IP 提取：`cf-connecting-ip` → 回退 `x-forwarded-for` 首值 → 再缺省跳过两门。
- settings 读取：两键加入 `PROXY_SETTING_KEYS`（services/settings.ts），随
  `loadProxySettingsCached`（30s TTL）单缓存读；tokenAuth 内经纯函数
  `resolveRateLimitConfig(raw)` 每请求重算（照 resolveProxyRetryConfig 模式）：
  `token_rpm_default` / `ip_auth_fail_limit` 均 parseInt + clamp [0, 1_000_000]，
  脏值降 0（fail-open）。
- Retry-After：Hono `c.header("Retry-After", String(sec))` 后再 `jsonError`。
- TokenRecord 类型增 `rpm_limit: number | null`，SELECT 增列。

## 5. 组件三：CRUD（rpm_limit 三态）

`services/token-update.ts`：照 `resolveExpiresAtValue` 模式新增
`resolveRpmLimitValue(raw)`：undefined 保留 / null·"" → NULL（跟随默认） /
值：整数校验（0 或正整数；负数/非整/非数字 → 400 `invalid_rpm_limit`）。
管理台 tokens.ts 与用户端 user-api.ts 的 POST/PATCH 接线；UI 表单数值输入
（空 = 跟随默认、0 = 显式不限、正整数 = 上限，占位文案说明三态）。

## 6. UI

- `SettingsView.tsx`：系统设置加两个数值字段（令牌默认 RPM / IP 鉴权失败阈值，
  0 = 关闭），照既有数值 settings 字段模式。
- `TokensView.tsx` / `UserTokensView.tsx`：令牌编辑表单加 rpm_limit 输入（管理台
  与用户端同构，照 expires_at 字段的接线模式）；列表不展示（低信息密度）。

## 7. 兼容与回滚

- 迁移列留存无害（NULL 全兼容）；settings 键缺失 = 两限流器关闭，删键即回滚。
- 30s 缓存陈旧窗口 = 管理台改限流值的生效延迟上限，与既有 settings 行为一致。
- 回滚路径：settings 两键置 0 即功能全关，无需回滚代码。

## 8. 测试地图

- `tests/rate-limiter.test.ts`（新）：滑窗边界（now 注入）、allowed 计入 / denied
  不占窗、retryAfter 计算、Map 清扫、reset。
- `tests/token-auth.test.ts`（增）：RPM 超限 429 + Retry-After；NULL 跟随默认 / 0
  豁免 / 值覆盖；IP 节流（达限后零 D1 断言、402 不计数、四失败出口计数、窗口恢复）；
  默认全关零变化（既有用例即回归锚）。
- `tests/token-update.test.ts`（增）：rpm_limit 三态矩阵。
- settings 解析：`resolveRateLimitConfig` clamp / 脏值降 0 直测。
