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
