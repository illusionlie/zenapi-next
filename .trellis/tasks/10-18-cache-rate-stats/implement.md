# 执行计划 — 缓存命中率统计与双端仪表盘可视化

依赖侦察结论（file:line 见 prd/design，此处只列动作）。按序执行，每步可独立提交回退。

## Checklist

1. [ ] **迁移 + schema**
   - 新建 `apps/worker/migrations/0024_usage_cache_tokens.sql`（ALTER TABLE 加 `cached_input_tokens` / `cache_creation_tokens` INTEGER 可空）。
   - `apps/worker/src/db/schema.sql` 的 `usage_logs` 同步加两列。
2. [ ] **解析层 `apps/worker/src/utils/usage.ts`**
   - `NormalizedUsage` 加 `cachedInputTokens` / `cacheCreationTokens`（number | null）。
   - `normalizeUsage`：提取优先级 details→DeepSeek→cache_read；纯 Anthropic 形态折算 promptTokens（条件见 design，防二次叠加）。
   - `parseUsageFromSse`：last-wins → 逐字段合并。
3. [ ] **记录层 `apps/worker/src/services/usage.ts` + 调用点**
   - `UsageInput` + INSERT 加两列。
   - grep 所有 `recordUsage` 调用（`routes/proxy.ts`、`routes/anthropic-proxy.ts`），从 usage 透传新字段。
4. [ ] **聚合层**
   - `routes/dashboard.ts`：summary 与 byDay 加 `cached_tokens` / `cache_creation_tokens` / `cache_prompt_base` 聚合，输出 `cache_rate`（null 安全）。
   - `routes/user-api.ts` GET `/dashboard`：summary 与 recent_usage 同构。
5. [ ] **前端**
   - `core/types.ts`：扩展 `DashboardData` 与 `UserDashboardData`（snake_case 直通）。
   - `features/DashboardView.tsx`：命中率卡片 + 按日表格缓存列 + mini bar。
   - `features/UserDashboard.tsx`：命中率卡片 + recent_usage 缓存列 + mini bar。
   - 无数据显示 `—`；配色与 `monitoring-shared.ts` 色带思路一致。
6. [ ] **测试**
   - 新增 `tests/usage-cache.test.ts`：normalizeUsage 全协议形态（openai details / responses details / deepseek / anthropic 折算 / 双形态防叠加 / 无字段→NULL）、parseUsageFromSse 逐字段合并、recordUsage 落库列（D1 mock 仿 `tests/turnstile-endpoints.test.ts`）。
   - 修复受 `NormalizedUsage` 扩展影响的既有 deep-equal 断言。
7. [ ] **文档**
   - `AGENTS.md` §8「usage 记录」bullet 补缓存字段与口径；§10 `usage_logs` 描述补两列。

## 验证命令（每步后按需、完成后必跑）

```bash
bun run check && bun run typecheck && bun run test
```

涉及本地 D1 行为时：`bun run --filter api-worker db:migrate` 后 `bun run dev:worker` 手验 `/api/dashboard`。

## 审查门

- 步骤 2 完成后自查：转换产物路径无二次折算（含 `format-converter.ts:741` 产出的 body 走 normalizeUsage 不重复加）。
- 步骤 4 完成后自查：分母 `CASE WHEN cached_input_tokens IS NOT NULL`，无数据行不进分母。
- 步骤 5 完成后自查：`cache_rate` 为 null 时 UI 显示 `—` 而非 0% 或 NaN。

## 回滚点

- 迁移独立成文件，回滚代码不回滚列即可（列可空无害）。
- 前后端可分开回退：响应新增字段对旧前端无害（多余字段被忽略）。
