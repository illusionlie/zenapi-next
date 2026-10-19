# Usage Accounting（utils/usage.ts + services/usage.ts + 聚合端点）

> 2026-10-18 由缓存命中率任务沉淀。usage 解析→落库→聚合的完整口径契约；协议转换层的产物契约见 [format-conversion](./format-conversion.md)。

## 1. Scope / Trigger

- 触发场景：改动 `NormalizedUsage` 结构、usage 解析优先级、`usage_logs` 列、dashboard/user-api 聚合口径。
- 本任务是 DB schema 变更 + 跨层契约变更，code-spec 深度强制。

## 2. Signatures

```ts
// utils/usage.ts
type NormalizedUsage = {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	cachedInputTokens: number | null; // null = 上游未报告，不得用 0 表示无数据
	cacheCreationTokens: number | null;
};

// services/usage.ts — usage_logs 两列：cached_input_tokens / cache_creation_tokens INTEGER 可空
// 迁移 0024_usage_cache_tokens.sql；recordUsage INSERT 19 列，NULL 直通
// 计费三写（INSERT + quota + balance）经单次 db.batch 原子执行，余额钳制不为负 → 见 §8
```

## 3. Contracts

### 3.1 缓存命中提取优先级（互斥生效，首个有限数字命中即停）

`prompt_tokens_details.cached_tokens`（OpenAI chat）→ `input_tokens_details.cached_tokens`（Responses）→ `prompt_cache_hit_tokens`（DeepSeek 系）→ `cache_read_input_tokens`（Anthropic）。

缓存写入仅 Anthropic 语义：`cache_creation_input_tokens`（不进命中率分子）。

### 3.2 prompt 折算条件（精确，防二次叠加）

仅当 `promptTokens` 取自 `input_tokens`/`inputTokens` 别名（即 `prompt_tokens`/`promptTokens` 均缺失）**且** cache_read/creation 至少一个非 null，才折算 `promptTokens = input + cacheRead + cacheCreation`。转换产物（`format-converter` 折算后的 OpenAI 形态）带 `prompt_tokens`，永不二次折算。

### 3.3 流式合并（raw 层，非候选层）

`parseUsageFromSse` 累积 raw usage 对象逐字段合并（非 null 覆盖、null/缺失保留，提取链含 `message.usage` 兜底），流结束一次性 `normalizeUsage`。**禁止**在 `NormalizedUsage` 候选层合并：该类型把缺失 prompt/total 压成 0，后到 chunk（如 Anthropic `message_delta` 仅 output）会把 `message_start` 的 input/cache 覆盖成 0。

### 3.4 聚合分母（NULL ≠ 0）

```
cache_rate = SUM(cached_input_tokens) / SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END)
```

base ≤ 0 → `null`（`computeCacheRate`，dashboard.ts 与 user-api.ts 共用同语义实现）。无数据行不进分母；响应字段 `cached_tokens` / `cache_creation_tokens` / `cache_rate`（snake_case 直通到 `core/types.ts`）。

## 4. Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| usage 对象缺失 / 全字段 null | `normalizeUsage` 返回 null，记录走零值兜底对象（两新列为 null） |
| 缓存字段存在但非有限数字 | 视为缺失，继续优先级链下一级 |
| 上游无任何缓存字段 | 两列 NULL，聚合分母排除该行，`cache_rate: null` |
| 响应头路径（`parseUsageFromHeaders`） | 两列恒 NULL（头协议无缓存字段） |

## 5. Good/Base/Bad Cases

- Good：Anthropic `input=100, cache_read=50, cache_creation=10` → `prompt_tokens=160, cached=50, creation=10`（JSON 与流式两路径同值）。
- Base：无缓存字段请求 → 既有三值不变、两新列 NULL、`cache_rate` 不受影响（零回归红线）。
- Bad：DeepSeek 形态带 `prompt_cache_hit_tokens` 却折算 prompt（`prompt_tokens` 别名在 → 不折算）；混合形态（prompt_tokens + details + anthropic cache 同在）二次叠加；NULL 记成 0 拉低均值。

## 6. Tests Required

`tests/usage-cache.test.ts`：优先级链逐级、折算/防叠加、SSE 合并（null 不清位、仅 output chunk 保 input/cache、全量终端 chunk 与 last-wins 等价）、recordUsage 列绑定（D1 mock 仿 turnstile 测试）、dashboard 路由 `cache_rate` null/有值两分支。断言锚点：Anthropic 折算 160/50/10 精确值。

## 7. Wrong vs Correct

### Wrong（修复前的两个真实偏差）

```ts
// ① last-wins：message_delta 仅 output，覆盖丢掉 message_start 的 input/cache
usage = candidate; // 每次整体替换
// ② anthropic 原生路径直接 normalizeUsage(usage)
//    input_tokens 不含 cache → prompt_tokens 记账偏小
```

### Correct

```ts
// raw 层逐字段合并后一次性 normalize
mergeRawUsage(acc, extractRawUsage(parsed)); // 非 null 覆盖
// normalizeUsage 内按 §3.2 条件折算 prompt，cache_read/creation 落库为独立列
```

## 8. 计费原子化契约（2026-10-19 P0 增补）

### 8.1 Scope / Trigger

- 触发：改动 `recordUsage` 写入形态、计费语句组装、余额扣减语义。DB 写路径 + 跨层契约变更。

### 8.2 Signatures

```ts
// services/usage.ts
type UsageInput = {
	// ...既有 19 列字段不变
	cost?: number | null;      // 与 INSERT 的 cost 列同值，复用不另设
	userId?: string | null;    // 计费主体（users.id 为 TEXT 列）
};
// recordUsage 组装 [INSERT usage（恒有）+ UPDATE tokens.quota_used（tokenId && totalTokens）
//                + UPDATE users.balance（userId && cost > 0）] → 单次 env.DB.batch(statements)
```

### 8.3 Contracts

- **batch = 单事务**（D1 batch 语义）：三写同生共死，不存在「记了日志没扣费」中间态。
- 余额 SQL 固定为 `UPDATE users SET balance = MAX(0, balance - ?), updated_at = ? WHERE id = ?`：**钳制不为负**（2026-10-19 用户决策）；`usage_logs.cost` 记真实成本，差额 = cost − Δbalance 仅发生在余额不足边缘场景，可对账审计；正常路径最终态与旧三写形态完全一致。
- quota 条件照旧（`tokenId && totalTokens`，无条件累加）；并发上浮有界 = 在途数 × 单次增量，AGENTS §8 文档化，不做条件更新。
- 失败：`console.error("[usage] billing batch failed", { tokenId, userId, cost, error })`，**不 rethrow**——计费收尾失败不影响已成功的上游响应（logging-guidelines 已批准例外）。
- 调用方（`routes/proxy.ts` / `routes/anthropic-proxy.ts`）只算 cost 并传 `userId`，**禁止**在路由层自行扣余额；错误路径零值 INSERT 不带 userId/cost（即单语句 batch 形态）。

### 8.4 Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| 无 tokenId / totalTokens = 0 | 无 quota 语句，其余照常 |
| cost = 0 或无 userId | 无 balance 语句 |
| batch 任一语句失败 | 整批回滚 + `[usage]` console.error，调用方 promise 正常 resolve |
| balance < cost | 扣至 0，`usage_logs.cost` 记真实值 |

### 8.5 Good/Base/Bad Cases

- Good：正常计费请求 → 三语句一批落库；余额充足时最终态与旧三写独立形态逐字段一致。
- Base：错误路径零值记录 → 单语句 batch（无 quota/balance 语句），INSERT 失败仅日志不抛。
- Bad：路由层恢复独立 `UPDATE users SET balance = balance - ?`（无钳制、脱离事务）；把 `[usage]` 失败改成 rethrow（已成功的上游响应会变 5xx）；钳制差额改写 usage_logs.cost（破坏真实成本口径）。

### 8.6 Tests Required

`tests/usage-billing.test.ts`：三语句形态与逐位绑定（含 `MAX(0, balance - ?)` SQL 文本 toBe 断言）、条件省略三分支、batch reject → console.error 载荷断言 + `resolves.toBeUndefined()` + 成功路径静默。锚点：cost=0.5 且余额不足时 balance 绑定 `[0]`。

### 8.7 Wrong vs Correct

#### Wrong（修复前）

```ts
await db.prepare("INSERT INTO usage_logs ...").run();          // 三条独立语句
await db.prepare("UPDATE tokens SET quota_used = quota_used + ?").run();
await db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(); // 无守卫，并发可深度负数
```

#### Correct

```ts
await env.DB.batch([insertUsage, quotaStmt, balanceStmt]); // 单事务；balance 用 MAX(0, balance - ?)
// 失败：console.error("[usage] billing batch failed", ...) 不 rethrow
```
