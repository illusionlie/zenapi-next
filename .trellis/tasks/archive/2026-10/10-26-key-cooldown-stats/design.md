# Design：渠道 Key 池冷却与错误统计

> 需求 prd.md（R1-R6）。本 design 基于主会话亲读 proxy.ts 双层循环（:947-1085）、
> `utils/retry.ts:4`、`services/channel-cooldown.ts` 全文、anthropic-proxy 双循环
> （:317/:341）后的定稿。

## 0. 现状确认（2026-10-26 亲读）

- key 选择：`shuffleArray(parseApiKeys(channel.api_key))`（换行分隔，`utils/keys.ts`），
  逐 key 尝试。
- **`isRetryableStatus` = 408 / 429 / ≥500**（`utils/retry.ts:4-6`）。
- 现行为：429/5xx/网络错误 → 换下一把 key + `channelRetryable`；**401/403 与其他
  4xx 一样走 `break` 直接放弃该渠道剩余 key**（`proxy.ts:1044`），401 整请求穿透给
  客户端——多 key 渠道一把 key 失效即请求失败，这是本任务要修的核心痛点。
- 渠道放弃点记账（proxy.ts:1060-1080）：`lastFailedRetryably`（网络错或 retryable
  状态）→ `recordChannelFailure`（每渠道每请求至多 1 次）；否则有任何响应 →
  `recordChannelSuccess`。**401/403 今天就被记成渠道成功**（上游活跃证明）——归因
  分离的现状已经正确，保持即可。

## 1. 新模块 `services/key-cooldown.ts`（isolate 内存，照 channel-cooldown 范式）

```ts
export const KEY_AUTH_COOLDOWN_MS = 600_000;   // 401/403：10 分钟
export const KEY_RETRYABLE_COOLDOWN_MS = 60_000; // 429/5xx/网络错：60s
export function keyFingerprint(apiKey: string): string; // fnv1a32 → 8 hex（同步、无 crypto）
export function recordKeyAuthFailure(channelId: string, apiKey: string, now?: number): void;
export function recordKeyRetryableFailure(channelId: string, apiKey: string, now?: number): void;
export function recordKeySuccess(channelId: string, apiKey: string): void; // 清失败态
export function filterCoolingKeys(channelId: string, keys: string[], now?: number): string[]; // fail-open：全冷却→原样返回
export function isKeyCoolingDown(channelId: string, apiKey: string, now?: number): boolean;
export function getKeyStatsSnapshot(): KeyStatsSnapshot; // 监测读：per-key 计数（见 §4）
export function resetKeyCooldownsForTest(): void;
```

- Map 键：`${channelId}:${keyFingerprint(apiKey)}`——**指纹而非 index/明文**：管理员
  重排 key 行、UI 展示都不泄明文；值：`{ coolingUntil, authFails, retryableFails,
  successes, lastFailureAt, lastSuccessAt }`（计数自 isolate 启动累计，UI 文案如实
  标注）。
- `filterCoolingKeys` 剪枝过期项 + Map size > 10000 全量清扫（防增长，同
  channel-cooldown）。
- fnv1a32 本地私有实现（8 hex 碰撞在单渠道 key 数量级下可忽略；不耦合
  client-presets 的 64-bit 混合哈希——那是指纹语义不同的另一契约）。

## 2. proxy.ts 接线（内层 key 循环）

1. `const keys = shuffleArray(parseApiKeys(channel.api_key));` 之后：
   `const serviceableKeys = filterCoolingKeys(channel.id, keys);`——fail-open。
2. 循环变量改 `for (const apiKey of serviceableKeys)`，循环内维护
   `lastAttemptKeyFp = keyFingerprint(apiKey)`。
3. **失败分类改造**（行为变更点，测试必须锁定）：
   - 401/403：`recordKeyAuthFailure`（10 分钟）+ **`continue` 下一把 key**（原来是
     `break`）；不置 `channelRetryable`。
   - 429/5xx/网络错误（fetch throw）：`recordKeyRetryableFailure`（60s）+ 现行为不变
     （`channelRetryable = true`、换 key 继续）。
   - 其他 4xx（400/404/413/422…）：**不冷却 key**（请求级错误，换 key 无意义）+
     现行为不变（break）。
   - 成功：`recordKeySuccess` + break（现行为不变）。
4. 渠道级记账（`cooldownFailureRecorded` / `recordChannelFailure` /
   `recordChannelSuccess`）**零改动**——§0 已确认 401/403 现状即记渠道成功。
5. **usage 的 key_tag**：新增局部 `servedKeyFp`（成功尝试的 fp）/ 复用
   `lastAttemptKeyFp`（最终失败时）→ 两处 `recordUsage` 入参透传
   `keyTag`（upstream_unavailable 路径 = lastAttemptKeyFp，可能为 null）。

## 3. anthropic-proxy.ts 接线

同构双循环（:317/:341）做 §2 完全相同的改造（含 401/403 continue 语义、key_tag 透传
到该文件的 recordUsage 调用）。实现时先读该循环确认与 proxy 的结构差异再动手。

## 4. 数据与监测

- **迁移 `0030_usage_key_tag.sql`**：`ALTER TABLE usage_logs ADD COLUMN key_tag TEXT;`
  + schema.sql 同步（NULL = 未记录/旧行）。
- `services/usage.ts`：`UsageRecordInput.keyTag?: string | null`，INSERT 列清单 +
  值透传（同 batch，原子性不动）。
- **监测双源**（PRD R4）：
  a. **内存活值**：监测渠道健康 handler（`routes/monitoring.ts`，adminAuth 已有）
     响应增 `keyStats` 段 = `getKeyStatsSnapshot()` 按 channelId 归组（cooling 状态、
     自启动累计 auth/retryable 失败数、successes、lastFailureAt）——零 D1 写；
  b. **持久末次归因**：新查询（同一 handler 或复用现有明细查询模式）
     `SELECT key_tag, status, COUNT(*) FROM usage_logs WHERE channel_id=? AND
     created_at>=? GROUP BY key_tag, status`（24h 窗，raw 行，key_tag 索引不做——
     channel_id + created_at 已有索引选择性足够，量小）。
- **UI（MonitoringView.tsx）**：渠道行展开区显示 per-key 行——指纹前 8 位、冷却中
  徽标、内存计数、24h 末次归因计数；key 显示指纹不显明文。

## 5. 兼容与回滚

- 单 key 渠道：401 → 该 key 冷却 10 分钟但 fail-open 继续服务，客户端可见语义与
  现状一致（401 穿透）；无双杀（渠道冷却不被触发）。
- 多 key 渠道 401 failover 是**有意的客户端可见行为变更**（原 401 穿透 → 现 200 由
  好 key 服务）；既有测试若断言 401 立即穿透，更新断言并在汇报记录。
- 回滚：revert 接线即可；key_tag 列留存无害（NULL 全兼容）；内存态天然易失。

## 6. 测试地图（确定性锚点）

- `tests/key-cooldown.test.ts`（新）：两档冷却时长、fail-open、success 清除、指纹
  稳定性（同 key 同 fp、不同 key 不同 fp、与 key 行序无关）、now 注入边界、清扫、
  reset、快照形状。
- `tests/proxy-key-failover.test.ts`（新，fetch mock 按 `x-api-key` 头区分 key）：
  - key1 401 → key2 200：客户端 200、两把 key 都被打过（顺序断言 via 调用记录）、
    渠道冷却零记账（mock/ spy recordChannelFailure 不可行则断言后续请求仍含该渠道——
    用单渠道池 + 冷却无影响的确定性构造）；
  - 全 key 401 → 客户端 401、usage 行 key_tag = 末次尝试 key 指纹；
  - 429 → key 冷却 60s 且渠道 retryable 语义不变（下一轮仍重试该渠道）；
  - 成功行 key_tag = 服务 key 指纹（fake db 捕获 INSERT 参数）。
- anthropic-proxy 同构用例 ≥1（401 failover）。
- 既有测试回归：`bunx vitest run` 全绿（预期需更新 401 穿透类断言）。

## 7. 范围外

Playground / test-model / count_tokens 的单发 key 选择（管理工具单次尝试，无轮换
语义）；key 健康分 / 轮换向导；key 级禁用；key 维度 rollup。
