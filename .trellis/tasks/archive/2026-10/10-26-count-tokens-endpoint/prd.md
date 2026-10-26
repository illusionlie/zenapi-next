# Anthropic count_tokens 端点支持

## Goal

补齐 Claude Code 依赖的 `POST /anthropic/v1/messages/count_tokens` 端点。现状全仓库无
`count_tokens` 处理（`routes/anthropic-proxy.ts` 仅挂 `POST /messages`，:69），客户端调用
直接 404——这是 Anthropic 协议兼容的硬缺口，Claude Code 高频用它做上下文管理。

## Requirements

- **R1 端点与鉴权**：`anthropic-proxy` 挂载 `POST /messages/count_tokens`，走 `tokenAuth`
  （与 `/messages` 同域）；请求体为 Anthropic 形状 `{model, messages, system?, tools?}`。
- **R2 模型治理同语义**：模型别名解析、用户级 + 令牌级白名单校验与 `/messages` 完全同
  语义（白名单外 403 `model_not_allowed`）；禁用模型同样不可达。
- **R3 anthropic 目标格式渠道**：经 `selectTargetFormat` 选中 anthropic 的渠道，请求体
  透传至 `{resolveEndpointBaseUrl(channel,"anthropic")}/v1/messages/count_tokens`，响应
  （`{input_tokens}`）原样回传；复用 `/messages` 的渠道选择逻辑（权重随机 + 重试语义
  可简化——见 R5）。
- **R4 非 anthropic 目标（openai / responses / custom）**：不发上游请求，本地估算
  `input_tokens ≈ 文本内容字符数 / 4`（对请求体 JSON 序列化后按可打印字符长度估算，
  口径注释写明是粗估），恒返回 200。上游确实存在更准的途径但成本不值——count_tokens
  对客户端只是上下文提示，不用于计费。
- **R5 零成本纪律**：不记 usage_logs、不扣费、不占额度预检（quota/balance 照常走
  tokenAuth 既有检查）；上游探测失败（网络错/5xx）不重试轮换渠道，直接降级本地估算
  返回 200——轻查询不值得故障转移。
- **R6 测试**：单测覆盖——401 无令牌；白名单外 403；anthropic 渠道透传往返（fetch mock
  断言 URL 与响应透传）；openai 渠道 200 且 `input_tokens` 为正整数；别名解析命中。

## Acceptance Criteria

- [ ] Claude Code 形态的 count_tokens 请求（带合法令牌、白名单内模型）返回 200 与
      `input_tokens` 数值，anthropic 渠道为上游真实值、openai 渠道为估算值。
- [ ] 无令牌 401；白名单外模型 403 `model_not_allowed`；模型别名解析生效。
- [ ] usage_logs 无新增行、令牌额度不变。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不做精确 tokenizer（无 tiktoken 依赖）。
- 不做 OpenAI 侧等价端点（该协议无此标准端点）。
- 不做 anthropic 入站 → openai 上游的转换式真实计数。
