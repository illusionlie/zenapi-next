# 技术设计 — 缓存命中率统计与双端仪表盘可视化

## 口径定义（唯一事实）

- `cached_input_tokens`：缓存**命中**的输入 token。来源优先级：`prompt_tokens_details.cached_tokens`（OpenAI chat）→ `input_tokens_details.cached_tokens`（Responses）→ `prompt_cache_hit_tokens`（DeepSeek 系）→ `cache_read_input_tokens`（Anthropic）。
- `cache_creation_tokens`：缓存**写入** token，仅 Anthropic 语义（`cache_creation_input_tokens`）；OpenAI 系恒 NULL。**不进命中率分子**。
- `prompt_tokens` 口径全路径统一为「含缓存的总输入」：
  - OpenAI/Responses/转换产物：原生已含，直取。
  - 纯 Anthropic 形态：`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 折算（修复 `anthropic-proxy.ts:525` 现存偏小偏差）。
- 平均缓存命中率 `cache_rate = SUM(cached_input_tokens) / SUM(prompt_tokens WHERE cached_input_tokens IS NOT NULL)`；分母只计有数据行（NULL ≠ 0），无数据返回 `null`。聚合层（SQL SUM）计算，不做逐请求平均。

## 数据层

- 新迁移 `apps/worker/migrations/0024_usage_cache_tokens.sql`：
  ```sql
  ALTER TABLE usage_logs ADD COLUMN cached_input_tokens INTEGER;
  ALTER TABLE usage_logs ADD COLUMN cache_creation_tokens INTEGER;
  ```
- `apps/worker/src/db/schema.sql` 的 `usage_logs` 定义同步加两列（列序放在 `completion_tokens` 之后，与迁移一致即可；SQLite ALTER 只能追加，schema.sql 中顺序不影响运行时）。
- NULL 语义贯穿：解析层无字段 → NULL；聚合分母 `CASE WHEN cached_input_tokens IS NOT NULL`。

## 解析层（apps/worker/src/utils/usage.ts）

```ts
export type NormalizedUsage = {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	cachedInputTokens: number | null;
	cacheCreationTokens: number | null;
};
```

- `normalizeUsage` 扩展：
  - cached：依次读 `data.prompt_tokens_details?.cached_tokens`、`data.input_tokens_details?.cached_tokens`、`data.prompt_cache_hit_tokens`、`data.cache_read_input_tokens`，首个有限数字生效。
  - creation：`data.cache_creation_input_tokens`。
  - 折算条件（精确）：promptTokens 取自 `input_tokens` / `inputTokens` 别名 **且** cache_read/creation 至少一个存在 → `promptTokens = input + cacheRead + cacheCreation`。取自 `prompt_tokens` / `promptTokens` 别名（OpenAI 形态/转换产物）不折算，避免二次叠加。
  - totalTokens 缺省仍为 prompt + completion（折算后自动正确）。
- `parseUsageFromSse`：last-wins 改为逐字段合并——新候选的每个非 null 字段覆盖累积值，null 字段保留。OpenAI 流（终端 chunk 全量）结果不变；Anthropic 原生流保住 `message_start` 的 input/cache 字段。
- `parseUsageFromHeaders`：响应头路径无缓存字段，恒 NULL，不改。

## 记录层

- `services/usage.ts`：`UsageInput` 增加 `cachedInputTokens?: number | null`、`cacheCreationTokens?: number | null`；INSERT 增加两列（NULL 直通）。
- 调用点（grep `recordUsage`）：`routes/proxy.ts`、`routes/anthropic-proxy.ts` 从 `NormalizedUsage` 透传新字段。playground 不记录用量，无关。

## 聚合层

- `routes/dashboard.ts`：
  - summary 增加 `SUM(cached_input_tokens) AS cached_tokens`、`SUM(cache_creation_tokens) AS cache_creation_tokens`、`SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END) AS cache_prompt_base`；JS 侧 `cache_rate = cache_prompt_base > 0 ? cached_tokens / cache_prompt_base : null`。
  - byDay 每日行同样加三个聚合，行内输出 `cached_tokens`、`cache_rate`。
- `routes/user-api.ts` GET `/dashboard`（summary 与 recent_usage）：同构改造，WHERE/JOIN 维持现状（经 tokens 关联用户）。
- 响应字段命名沿用仓库 snake_case 直通惯例。

## 前端（apps/ui）

- `core/types.ts`：`DashboardData.summary` 增加 `cached_tokens: number; cache_rate: number | null`；byDay 行类型增加 `cached_tokens: number; cache_rate: number | null`；`UserDashboardData` 同构。
- `features/DashboardView.tsx`：
  - 统计卡片 grid `lg:grid-cols-3` → `lg:grid-cols-4`，新增「缓存命中率」卡片（`cache_rate ?? null` 显示 `—`）。
  - 按日趋势表格新增「缓存命中」列：token 数 + 命中率，命中率单元格内嵌 mini bar（div 宽度百分比，零依赖）。
- `features/UserDashboard.tsx`：统计卡片 grid 加第五张（`grid-cols-2 lg:grid-cols-4` 换行自然排布或调列数由实现者定）；`recent_usage` 表格加「缓存命中」列 + mini bar。
- 配色：复用 `monitoring-shared.ts` 的色带思路（命中率梯度），可提小工具函数或内联，两视图保持一致。

## 兼容与回滚

- 新列可空，历史行 NULL → 前端 `—`，聚合分母自动排除，无数据迁移需求。
- 回滚：仅回退代码即可，残留列无害；迁移由 d1_migrations 按文件名一次性执行，无幂等负担。

## 权衡记录

- 不做逐请求缓存率列：平均值只在聚合层算，避免存储冗余且口径集中。
- 分母只计有数据行：防止「无数据」以 0 计入拉低均值，符合「缓存率」语义。
- 成本差异化计价不在本期：`cost` 继续按现有口径，缓存折价留待后续任务。
