# Format Conversion（services/format-converter.ts）

> 协议转换器契约：OpenAI Chat Completions ↔ Anthropic Messages ↔ OpenAI Responses 的请求/响应/SSE 三面。改动此文件前必读；行为摘要见 AGENTS.md §8，本文件只写可执行契约与踩坑。
> 沉淀自任务 09-20-chat-anthropic-converter（2026-09-20）。

## 1. Scope / Trigger

- 跨层协议契约变更（转换产物即上游/客户端请求体），命中 code-spec 强制深度。
- 触发场景：新增转换字段、新增协议方向、改动 usage/thinking/多模态映射。

## 2. Signatures

| 导出 | 方向 | 消费方 |
|------|------|--------|
| `openaiToAnthropicRequest` / `anthropicToOpenaiResponse` / `createAnthropicToOpenaiStreamTransform` | chat→anthropic | `routes/proxy.ts` |
| `anthropicToOpenaiRequest` / `openaiToAnthropicResponse` / `createOpenaiToAnthropicStreamTransform` | anthropic→chat | `routes/anthropic-proxy.ts` |
| `openaiToResponsesRequest` / `responsesToChatResponse` / `createResponsesToChatStreamTransform` | chat→responses | `routes/proxy.ts` |
| `responsesToOpenaiRequest` / `openaiToResponsesResponse` / `createOpenaiToResponsesStreamTransform` | responses→chat（responses 入站降级，2026-09-20 增） | `routes/proxy.ts` |
| `responsesToAnthropicRequest` / `anthropicToResponsesResponse` | responses↔anthropic pivot（responses 入站 → anthropic 目标，2026-10-27 增） | `routes/proxy.ts` |
| `anthropicToResponsesRequest` / `responsesToAnthropicResponse` | anthropic↔responses pivot（anthropic 入站 → responses 目标，2026-10-27 增） | `routes/anthropic-proxy.ts`（请求腿组合恒等式 `openaiToResponsesRequest(anthropicToOpenaiRequest(body))` 内联展开——per-channel 别名模型须在 chat 中间体上改写，见 §3.7） |
| `mapStopReason` / `mapFinishReason`（导出） | 共享停止原因映射 | 两侧响应/流式转换共用，改枚举必须两侧同看 |

## 3. Contracts

### 3.1 usage 必须「单末 chunk、完整三值」

转换器产出的 OpenAI 格式流，usage 仍只允许出现在终止 chunk 且 prompt/completion/total 三值齐全（生产侧契约不变）。解析侧自 2026-10-18 起 `parseUsageFromSse` 不再 last-wins，改为 **raw usage 对象逐字段合并**（非 null 覆盖、null/缺失保留，支持 `message.usage` 兜底），流结束才 `normalizeUsage` 一次——拆进 `message_start` 不再丢 prompt/缓存字段（缓存统计依赖此行为，详见 [usage-accounting](./usage-accounting.md)）。

### 3.2 usage 口径换算（两 API 相反，最易踩坑）

Anthropic `input_tokens` **不含**缓存 token（`total_input = input + cache_read_input_tokens + cache_creation_input_tokens`）；OpenAI `prompt_tokens` 是**总量**（`cached_tokens` 是其中子集）。anthropic→chat 必须三项求和，并把 cache_read 映射进 `prompt_tokens_details.cached_tokens`、`output_tokens_details.thinking_tokens` 映射进 `completion_tokens_details.reasoning_tokens`。反向（openai→anthropic）无法精确拆分，不做。

### 3.3 thinking 映射（chat→anthropic）

- `reasoning_effort`/`reasoning.effort` 经 `utils/reasoning.ts` 的 `extractReasoningEffort`（优先级 `reasoning_effort` → `reasoningEffort` → `reasoning.effort`）→ `thinking:{type:"enabled", budget_tokens}`；档位 ratio minimal 0.1 / low 0.2 / medium 0.5 / high 0.8 / xhigh·max 0.95，clamp `[1024, max_tokens-1]`；`"none"` 与未知字符串**不发** thinking 字段；数字型视为显式 budget clamp 后直用。
- 客户端直发 `thinking` 对象且 `type ∈ {enabled, adaptive, disabled}` → 直通逃生舱（覆盖 adaptive/精确预算；非法 type 回退 effort 映射）。
- **产物含 thinking 时必须剥离 `temperature` / `top_p`**（映射与直通两路同一剥离点）：旧模型二者与 thinking 不兼容，新代模型非默认采样一律 400。
- 不做 adaptive 自动选择：模型代际网关侧不可靠可知，adaptive 仅 4.6+ 支持，存量 4.5 代会 400（决策记录见任务 design.md D4）。

### 3.4 fail-open 部件丢弃

白名单式转换：不认识的部件/字段**丢弃并 `console.warn("[format-converter]", …)`**，绝不让单个脏部件 400 整个请求（与 client-disguise 同哲学）。image_url：http(s)→`url` source、data URL→`base64` source（mime 限 jpeg/png/gif/webp）；file：仅 PDF base64→`document`；input_audio 恒丢弃（Anthropic 无音频输入）。user content 转换后为空时回退单空 text 块（Anthropic 拒绝空 content）。

### 3.5 流式输出不变量

- `data: [DONE]` **恰好一次**（由 `message_stop` 分支负责；`flush()` 不得再补发）。
- Anthropic 流内 `error` 事件 → 单个终止 chunk（`finish_reason:"stop"`、`delta:{}`）+ warn，此后吞掉迟到 delta——流已 200 无法改状态码，悬挂客户端比降级终止更糟。
- `message_delta.usage` 是**累计值**非增量，直接取用，不得二次累加。
- 已知缺口（存量，2026-10-27 质检确认，勿默认已覆盖）：chat 上游流以 `[DONE]` 正常收尾时 `createOpenaiToAnthropicStreamTransform` 会在 `message_stop` 分支与 `flush()` 各入队一次 `message_stop`——客户端收到**双 message_stop**。Anthropic SDK 容忍，修复属既有路径行为变更，留待单独任务裁决。

### 3.6 responses→chat 方向（responses 入站降级，2026-09-20 增）

- **请求侧 `responsesToOpenaiRequest`**：`instructions`→system 前置；`input` 字符串→单 user；`message` 项 text/image_url 映射、`function_call`→assistant.tool_calls（arguments 为 JSON 字符串）、`function_call_output`→`role:"tool"`（tool 消息**永不合并**——每条对应唯一 tool_call_id）；`text.format`→`response_format` 与反向 `openaiToResponsesRequest`（:1584 起）逐字段对称（json_schema 默认值 `name:"response"`/`schema:{}` 双向 `??` 补齐后仍须互逆）；`reasoning.effort`→`reasoning_effort`；`store`/`previous_response_id`/`conversation`/`background` 等 stateful 字段丢弃 + **单条汇总** warn（勿逐字段刷屏）；未知项 fail-open 丢弃 + `[format-converter]` warn。
- **响应侧 `openaiToResponsesResponse`**：`status:"completed"`；`finish_reason:"length"`→`incomplete_details:{reason:"max_output_tokens"}`（`mapFinishReason` 的精确逆）；usage 口径 prompt→input、completion→output、cached→`input_tokens_details`、reasoning→`output_tokens_details`。
- **流式 `createOpenaiToResponsesStreamTransform`**：事件序列 `response.created`→`output_item.added`→（`output_text.delta` | `function_call_arguments.delta`）*→`output_item.done`→`response.completed`，`sequence_number` 自 0 递增；**usage 仅 `response.completed` 单事件且三值齐全**（§3.1 last-wins 同款红线；上游无 usage → 零值对象不虚构）；`delta.reasoning_content`→`response.reasoning_summary_text.delta`；chat 上游 `data:[DONE]` **仅作终止信号消费、绝不外泄**（Responses 协议无 [DONE]）；流内 error 载荷→发 `response.failed` + warn 后 `finished` 守卫吞掉全部后续 delta，flush 不补发；**缺 `[DONE]` 但无 error 的截断流视为健康收尾**——正常发 `response.completed`，不误标 `response.failed`（显式终止优于悬挂，但不上报假失败）。

### 3.7 responses↔anthropic pivot（经 chat 枢纽两跳，2026-10-27 增）

- **零新增单跳转换器铁律**：两条斜边只允许组合既有 8 原语——`responsesToAnthropicRequest = openaiToAnthropicRequest(responsesToOpenaiRequest(body))`、`anthropicToResponsesRequest = openaiToResponsesRequest(anthropicToOpenaiRequest(body))`、`anthropicToResponsesResponse = openaiToResponsesResponse(anthropicToOpenaiResponse(body))`、`responsesToAnthropicResponse = openaiToAnthropicResponse(responsesToChatResponse(body))`。**流式不设组合 helper**：pipeThrough 双 transform 在接线点串联（proxy.ts anthropic 分支 / anthropic-proxy.ts responses 分支），中间 chat 流不落线。
- **组合可行性根基 = 既有契约**：§3.1 usage「单末 chunk、完整三值」使中间 chat 流是双方共同遵守的生产契约；§3.5 anthropic→chat `[DONE]` 恰一次；§3.6 chat→responses 将 `[DONE]` 仅作终止信号消费——首尾相接语义闭合。
- **usage 接缝**：方向 A（responses 客户端 / anthropic 上游）`message_delta` 终止 chunk 的 chat usage（含 `prompt_tokens_details.cached_tokens`）经 `chatUsageToResponses` → `input_tokens_details.cached_tokens` 存活、`cache_creation` 折入总量不再单列（该路径 `usage_logs.cache_creation_tokens` = NULL）。方向 B（anthropic 客户端 / responses 上游）usage 降级总量（cache 无精确拆分，既有惯例）；`createOpenaiToAnthropicStreamTransform` 的 `message_delta.usage` **会在终止 chunk 携带 `prompt_tokens` 时转发 `input_tokens`**——message_start 只见过无 usage 的首 chunk（input_tokens 基线 0），parseUsageFromSse 的非 null 覆盖语义靠这个转发把 prompt 恢复出来，缺了它方向 B 流式 prompt 恒记零（计费缺陷）。
- **stream_options.include_usage 注入边界**：注入条件键于「最终上游体为 chat completions 形状」。两个 pivot 分支的出站体分别是 anthropic 形状与 responses 形状——**都不该注入**（anthropic 流 message_delta 自带 usage、responses 流 response.completed 自带），实现与测试均按此锁定。**已知缺口（存量，非 pivot 引入）**：anthropic 入站 + openai 目标的**普通流式**分支（非预设强制流式）不注入 include_usage（anthropic-proxy 仅预设路径一处注入）——该路径 usage 依赖上游自愿携带 SSE 尾块，不携带则记零；留待注入矩阵补全任务裁决。
- **error 终止形态（测试锁定，属预期非缺陷）**：anthropic 上游流内 error → chat 终止 chunk（`finish_reason:"stop"`）→ responses 侧 `response.completed` 健康收尾（内容截断，**非** `response.failed`）；反向 responses 上游 `response.failed` → chat 终止 chunk（`finish_reason:"stop"`）→ anthropic 侧 `message_delta`（`stop_reason:"end_turn"`）+ `message_stop` 健康终止。哲学同 §3.5：流已 200 无法改状态码，显式终止优于悬挂，不上报假失败。
- **有损声明（均继承自既有腿，非组合新增）**：thinking 签名 / redacted_thinking 不跨协议回传；responses stateful 字段（store / previous_response_id / conversation / background）丢弃；chat→anthropic 方向无法从 chat 总量反拆 cache_read/creation。
- **测试锚**：`tests/proxy-pivot.test.ts`（两方向 × 非流式/流式 × usage 接缝 prompt>0 × 工具往返 × error 终止形态 × AC4 单跳优先于 pivot）；路由矩阵 2 格翻转锚 `tests/channel-routing.test.ts`。

## 4. Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| 部件解析失败（畸形 data URL / 不支持的 mime） | 丢块 + warn，请求继续 |
| `thinking.type` 非法 | 忽略直通值，走 effort 映射 |
| effort = "none" | 不产 thinking 字段（非 `disabled`，兼容最老上游） |
| `max_tokens` 极小致 clamp 区间为空 | 取严格上界 `max_tokens-1`（交由上游语义裁决，不上浮用户预算） |
| 上游流 `error` 事件 | 终止 chunk + warn（见 3.5） |

## 5. Good/Base/Bad Cases

- Good：`reasoning_effort:"high"` + `max_tokens:8192` → `budget_tokens:6553` 且无 temperature/top_p。
- Base：无 effort、无多模态的请求 → 除 usage 末 chunk 与 `[DONE]` 单发外与透传语义一致（零回归红线，tests A/B 锁定）。
- Bad：给 thinking 请求保留 `temperature:0.7`；把 prompt usage 留在 `message_start` chunk；`flush()` 补发第二个 `[DONE]`。

## 6. Tests Required

`tests/format-converter-anthropic.test.ts`（模式照抄 `format-converter-responses.test.ts`：纯函数直调 + `runStreamTransform` + `parseSseData`）。关键断言点：档位表逐档值、clamp 双边界、采样剥离两分支、`[DONE]` 计数恰一、`thinking_delta`→`reasoning_content` 逐块、末 chunk usage 三项和 + `parseUsageFromSse` 联动（`promptTokens > 0`）、stop_reason 七值、`mapStopReason`/`mapFinishReason` 直测。注意：`tests/` 被 biome（`!tests`）与 tsconfig（`exclude`）双重排除，测试正确性**仅由 vitest 运行时保障**。

responses→chat 方向：`tests/format-converter-responses-inbound.test.ts`（29+ 用例）——请求映射全分支（fail-open 丢弃 + warn 断言、stateful 汇总 warn）、`text.format`↔`response_format` 双向互逆（含 `??` 默认值对称往返）、响应 usage 口径、流式事件序列与 sequence_number、usage 仅 response.completed、无 `[DONE]` 外泄、error→`response.failed` + 吞后续；集成层在 `tests/proxy-responses.test.ts`（AC3 非流式/流式/tools 往返 + `parseUsageFromSse` prompt>0）。

## 7. Wrong vs Correct

### Wrong（修复前的真实 bug）

```typescript
// message_start chunk 带一半 usage
usage: { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: 0, ... }
// message_delta chunk 带另一半，prompt 恒 0
usage: { prompt_tokens: 0, completion_tokens: usage.output_tokens ?? 0, ... }
```

### Correct

```typescript
// message_start 只发 role chunk，缓存三值；唯一 usage 在终止 chunk
usage: {
	prompt_tokens: input + cacheRead + cacheCreation,
	completion_tokens: outputTokens, // message_delta.usage 为累计值
	total_tokens: prompt + completion,
	prompt_tokens_details: { cached_tokens: cacheRead },
}
```

**Why**：`parseUsageFromSse` last-wins + OpenAI 官方惯例（usage 单 chunk 完整出现）共同决定；拆开即计费错。
