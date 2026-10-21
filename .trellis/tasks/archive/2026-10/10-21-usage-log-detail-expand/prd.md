# 管理台使用日志详情展开视图

## Goal

管理台「使用日志」（`apps/ui/src/features/UsageView.tsx`）目前只渲染精简表格列：错误只显示 `status` 字符串（"ok"/"error"），缓存 tokens、费用、错误码、错误详情、请求路径等**已入库且 API 已返回**的字段完全不可见。本任务改为 New API 风格的「点击行展开详情」交互：表格保持精简，完整信息收进展开面板。

背景盘点（2026-10-21 主会话勘察）：

- `usage_logs` 表已有 `error_code` / `error_message`（上游错误响应体前 512 字符，`proxy.ts` / `anthropic-proxy.ts` 写入）/ `cached_input_tokens` / `cache_creation_tokens` / `cost` / `total_tokens` / `request_path` 列。
- `GET /api/usage` 用 `SELECT usage_logs.*` 返回全列，**后端零改动**。
- 前端 `UsageLog` 类型（`core/types.ts`）缺 `request_path` / `cached_input_tokens` / `cache_creation_tokens` / `error_code` / `error_message` 五个字段，需补类型。
- 用户输入提示词：无存储、不展示——用户已拍板后续任务再做。

## Requirements

### R1 行展开详情交互

- 每条日志行可点击展开 / 收起（点击行任意处切换）；允许多行同时独立展开互不影响。
- 展开内容渲染在数据行下方的全宽详情面板（`colSpan` 跨全列），风格延续现有 stone/amber 设计语言（`Modal.tsx` / `SecretValueModal.tsx` 可作键值排版参考，不强求复用）。
- 行有可点击暗示（cursor / hover 态或展开指示）。

### R2 表格列调整

- 删除独立「首 token 延迟」列，与「用时」合并：主文本 = 总用时；当流式且 `first_token_latency_ms` 非 null 时，以次级小字附首 token（如「首 0.61 s」，同行或双行均可，实现自定）。非流式不展示首 token（后端非流式取 latencyMs，重复展示无信息量）。
- 「状态」列文案保持 `ok` / `error` 不变；`error` 行加红色系视觉标记（文本色 / 浅底自定），`ok` 保持现状或中性色。
- 其余列不变；空态行与展开行的 `colSpan` 随列数同步修正。

### R3 详情面板内容

面板展示该行日志的完整字段（NULL / 缺失统一显示 "-"）：

- 请求路径 `request_path`、时间 `created_at`（完整值）。
- 模型；渠道（名称，附 id）；令牌（名称，附 id）；用户（名称，附 email）。
- Tokens：输入 / 输出 / 总 / 缓存命中（`cached_input_tokens`）/ 缓存写入（`cache_creation_tokens`）；缓存两列 NULL = 上游未报告。
- 费用 `cost`、总用时、首 token 延迟、流式、推理强度。
- 错误信息区：错误码 `error_code` + 错误详情 `error_message`。展示策略：尝试 `JSON.parse`，成功且能提取 `error.message`（或顶层 `message`）时以可读文本主展示、原始报文以等宽小字 / 折叠形式辅助展示；解析失败按纯文本原样展示；`status` 为 `ok` 或字段为 NULL 时该区显示 "-" 或收敛为一行（实现自定，保持简洁）。

### R4 类型补全

- `core/types.ts` 的 `UsageLog` 补齐上述五个缺失字段（可空类型，与表列语义一致），不引入 `any`。

### R5 明确不做（范围外）

- 用户输入提示词：不存储、不展示（后续任务）。
- `UserUsageView`（用户端日志视图）不动。
- 后端 / DB / API 零改动；不做服务端分页与筛选（维持现有客户端分页与刷新）。

## 约束

- 纯 `apps/ui` 改动；Biome 规范（tab 缩进、双引号）；hono/jsx/dom；遵循 `.trellis/spec/api-worker-ui/frontend/` 规范。
- 测试命令必须用 `bunx vitest run`（`bun run test` 是 watch 模式会挂起）；禁止 `wrangler dev` 等长驻进程。
- 本任务无后端逻辑变更，不强制新增单测；现有测试不得回退。门禁：`bun run check && bun run typecheck && bunx vitest run` 全绿。

## Acceptance Criteria

- [ ] AC1 行展开：点击任意日志行，其下方出现全宽详情面板，再次点击收起；多行可同时独立展开。
- [ ] AC2 合并用时列：表格无独立「首 token 延迟」列；流式日志用时单元格同时呈现总用时与首 token；非流式仅总用时。
- [ ] AC3 状态列：文案仍为 `ok` / `error`；`error` 行有可见红色系区分。
- [ ] AC4 详情面板：含 R3 全部字段；错误日志可读到错误码与具体错误详情（JSON 提取的可读主消息 + 原始报文）；正常请求错误区显示 "-" 或收敛。
- [ ] AC5 缓存 tokens：面板展示缓存命中 / 缓存写入，NULL 显示 "-"；数据全部来自现有 `/api/usage` 返回，无新增请求。
- [ ] AC6 类型完整：`UsageLog` 补齐五字段后 `bun run typecheck` 通过，无 `any`。
- [ ] AC7 质量门禁：`bun run check`、`bun run typecheck`、`bunx vitest run` 全绿。
