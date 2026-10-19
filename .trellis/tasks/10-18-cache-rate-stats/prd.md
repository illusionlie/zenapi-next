# 缓存命中率统计与双端仪表盘可视化

## Goal

让 ZenAPI 捕获上游 API 返回的缓存 token 字段并持久化到 `usage_logs`，在管理员与用户两个仪表盘页面展示平均缓存命中率及其按天趋势（可视化）。同时修复 Anthropic 原生透传路径 `prompt_tokens` 口径偏小的现存偏差。

## 背景（已核实的事实）

- 三种上游协议均返回缓存字段：OpenAI chat `usage.prompt_tokens_details.cached_tokens`、OpenAI Responses `usage.input_tokens_details.cached_tokens`、Anthropic `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`、DeepSeek 系 `prompt_cache_hit_tokens`。
- 当前 `NormalizedUsage`（`apps/worker/src/utils/usage.ts`）只取 total/prompt/completion 三个数，缓存字段在解析层被丢弃；`usage_logs` 表无缓存列。
- `format-converter.ts` 已在协议转换产物中折算缓存口径（`prompt_tokens = input + cache_read + cache_creation`、`prompt_tokens_details.cached_tokens`），但仅面向客户端响应，未持久化。
- 现存偏差：Anthropic 原生透传路径（`anthropic-proxy.ts` 对响应体直接 `normalizeUsage(usage)`）只记 `input_tokens`，而 Anthropic 的 `input_tokens` **不含**缓存 token，导致该路径 prompt_tokens 记账偏小。
- 流式解析 `parseUsageFromSse` 采用 last-wins 覆盖：Anthropic 原生流中 `message_start` 携带的缓存字段会被 `message_delta`（仅 output）覆盖丢失。
- 前端无图表库；现有可视化惯例为纯 Tailwind 卡片 + CSS 条形图（`MonitoringView.tsx` uptime 条 + `monitoring-shared.ts`）。

## Requirements

- **R1 持久化**：`usage_logs` 新增 `cached_input_tokens`、`cache_creation_tokens` 两列（INTEGER 可空）。NULL = 上游未报告；不得用 0 表示「无数据」。
- **R2 解析统一**：`normalizeUsage` 按优先级提取缓存命中数（`prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens` → `prompt_cache_hit_tokens` → `cache_read_input_tokens`），提取缓存写入数（`cache_creation_input_tokens`）。对纯 Anthropic 形态（prompt 取自 `input_tokens` 别名且存在 cache 字段）将 promptTokens 折算为 `input + cache_read + cache_creation`；转换产物（OpenAI 形态、已折算）不得二次叠加。
- **R3 流式合并**：`parseUsageFromSse` 由 last-wins 改为逐字段合并（后到 chunk 的非空字段覆盖，缺失字段保留先前值），保证 Anthropic 原生流 `message_start` 的缓存字段不丢。
- **R4 管理员仪表盘**：`/api/dashboard` summary 增加缓存命中总数与平均缓存命中率；`byDay` 每日行增加当日缓存命中数与命中率。命中率 = `SUM(cached_input_tokens) / SUM(prompt_tokens WHERE cached_input_tokens IS NOT NULL)`，分母只计有数据行，无数据时为 `null`。
- **R5 用户仪表盘**：`/api/u/dashboard` summary 与 `recent_usage` 行同构增加缓存命中数与命中率，口径同 R4，仅统计该用户令牌的日志。
- **R6 可视化**：管理员 `DashboardView` 与用户 `UserDashboard` 各增加「缓存命中率」统计卡片与每日趋势可视化（沿用仓库零依赖 CSS 条形图惯例）；无数据显示 `—`。
- **R7 测试**：新增单测覆盖 normalizeUsage 各协议形态、折算规则、SSE 逐字段合并、recordUsage 落库列；修复受类型扩展影响的既有断言。

## 非目标

- 缓存 token 的差异化计价（如 OpenAI cached 0.5x 折价）不改 `cost` 计算。
- `/api/monitoring`、用户监测页、usage 明细日志页不加缓存维度。
- 不引入任何前端图表库。

## Acceptance Criteria

- [ ] 上游返回 `prompt_tokens_details.cached_tokens` 时，`usage_logs.cached_input_tokens` 正确落库；`cache_creation_tokens` 为 NULL。
- [ ] Anthropic 原生响应含 `cache_read_input_tokens=50, cache_creation_input_tokens=10, input_tokens=100` 时，记录 `prompt_tokens=160, cached_input_tokens=50, cache_creation_tokens=10`。
- [ ] 上游不含缓存字段时两列为 NULL，聚合分母不含这些行，`cache_rate` 返回 `null`。
- [ ] `/api/dashboard` 与 `/api/u/dashboard` 响应含 `cache_rate` / `cached_tokens`（byDay / recent_usage 行含 `cached_tokens` + `cache_rate`）。
- [ ] 管理员与用户仪表盘页面渲染缓存命中率卡片与每日趋势条形可视化，无数据时显示 `—`。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。
