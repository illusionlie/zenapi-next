# Research: Gemini 原生协议接入 ZenAPI 设计评估

- Query: PRD Q1–Q7（`gemini-native-protocol` 设计评估报告）
- Scope: mixed（仓库代码盘点 + 官方文档核验 + 参考实现对照）
- Date: 2026-11-06
- 性质: 评估报告，不含任何代码改动

---

## 0. 结论先行（TL;DR）

| 问题 | 结论 |
|---|---|
| **总体建议** | **分档做**：第一阶段只做「出站 gemini」（渠道声明 `gemini`，服务既有 chat/responses/anthropic 入站），约 **8–10 人日**；入站 `/v1beta`（服务 Gemini CLI）为第二阶段独立立项，约 **6–8 人日**。两者共享转换器层（同一套双向原语），但价值面、风险面、接线点完全不同。 |
| **协议范围** | 进：`generateContent` + `streamGenerateContent`（核心）、`countTokens`（照 anthropic `count_tokens` 先例）、`GET /v1beta/models`（探测/拉取 + 入站发现）。裁：`cachedContents`（Google 自己已在新模型放弃显式缓存）、Live API / embeddings / batch / `auth_tokens`。 |
| **流式形态** | Gemini 默认分块 JSON 数组；**`?alt=sse` 后即标准 SSE `data:` 帧**（官方 quickstart 即用此形态，Gemini CLI 也用）。上游统一追加 `alt=sse` 即可完全复用既有 TransformStream 管线——CLIProxyAPI 正是这么做的（未指定 alt 时默认按 sse 处理）。 |
| **计费交叉** | `usageMetadata.cachedContentTokenCount` 是**纯缓存读**（无缓存写 token 字段，已核验）→ 映射 `cachedInputTokens`，`cacheCreationTokens` 恒 NULL。`calculateCost` 六参签名（10-28-cache-token-billing 已落地）**零改动**直接可用；依赖方向单向：gemini 计费 → 既有缓存折价，反向无依赖。 |
| **路由插位** | chat 入站 `openai > responses > anthropic > gemini > custom`（gemini 对 chat 是新单跳）；responses/anthropic 入站 gemini 经 chat 枢纽两跳，插在 pivot 位（anthropic 之后、custom 之前）；passthrough 域**维持排除**（与 anthropic 同理：无转换边）。 |
| **回滚形状** | 照 pivot 哲学：`API_FORMAT_WHITELIST` / 偏好序常量 / UI 常量移除 `gemini` 即回滚，零迁移、零 settings 残留。 |

关键战略背景（影响「要不要做」的判断）：Google 官方文档已把 **Interactions API**（`/v1beta/interactions`）定位为推荐主路径，`generateContent` 标记为 "legacy API, still supported for existing integrations"（来源：官方 llms.txt 索引头部声明，https://aistudio.google.com/llms.txt）。但 Gemini CLI 与整个 Google 生态工具链当前仍说 generateContent 方言（Gemini CLI 源码 `packages/core/src/core/geminiChat.ts` 走 `generateContentStream`），且 Interactions API 尚未声明 generateContent 的日落时间表。**接入 generateContent 家族在数年窗口内有效，但若追求长期形态，应在报告中标注 Interactions API 为未来第二落点，不在本次范围。**

---

## 1. 仓库现状盘点（读代码结论，全部带锚点）

### 1.1 格式白名单与插入点

- `apps/worker/src/services/channel-types.ts:3` — `ChannelApiFormat = "openai" | "anthropic" | "custom" | "responses"`，加 `gemini` 需同步 4 处常量：type union（:3）、`API_FORMAT_WHITELIST`（:45）、`CANONICAL_ORDER`（:56，镜像列首元素排序依据）、`ENDPOINT_OVERRIDE_KEYS`（:148）。`EndpointOverrideKey` 是 `Exclude<ChannelApiFormat, "custom">` 派生类型，自动跟随。
- `apps/worker/src/services/channel-routing.ts:34-40` — `FORMAT_PREFERENCE` 四入站偏好序；`:46` `inboundProtocolForPath` 按路径判入站协议；`:65` `selectTargetFormat` 纯函数（proxy / anthropic-proxy / playground 三处共用，playground 固定传 `"chat"`，见 `routes/playground.ts:93`）。
- `apps/worker/src/services/channel-routing.ts:95` — `resolveEndpointBaseUrl`：anthropic 走 `normalizeBaseUrl`（剥 `/v1`），openai/responses 仅去尾斜杠（保留版本路径）。**gemini 应归 openai 类**（base 形如 `https://generativelanguage.googleapis.com/v1beta`，版本路径必须保留）。

### 1.2 既有转换原语（`services/format-converter.ts`，3050 行）

导出清单（行号为当前文件锚点）：

| 原语 | 行 | 方向 |
|---|---|---|
| `openaiToAnthropicRequest` / `anthropicToOpenaiRequest` | :296 / :504 | 请求 |
| `anthropicToOpenaiResponse` / `openaiToAnthropicResponse` | :752 / :828 | 非流响应 |
| `createAnthropicToOpenaiStreamTransform` / `createOpenaiToAnthropicStreamTransform` | :908 / :1225 | 流 |
| `openaiToResponsesRequest` / `responsesToOpenaiRequest` | :1525 / :2321 | 请求 |
| `responsesToChatResponse` / `openaiToResponsesResponse` | :1742 / :2474 | 非流响应 |
| `createResponsesToChatStreamTransform` / `createOpenaiToResponsesStreamTransform` | :1811 / :2557 | 流 |
| pivot 组合函数 ×4（`responsesToAnthropicRequest` 等） | :2943–:2984 | 两跳组合 |

架构事实：**openai chat 是转换枢纽**。每对格式 = 请求/非流/流 三件套；斜边（responses↔anthropic）由枢纽组合出一行式纯函数（:2943 每个 3 行）。gemini 照此加一条辐条 `gemini↔chat` 三件套 ×2 方向，其余斜边全部组合可得。

### 1.3 请求构造与响应转换接线

- `apps/worker/src/routes/proxy.ts:209` — `buildChannelRequest` 按目标格式分支构造 URL/头/body：anthropic 分支（:244，`{base}/v1/messages` + `x-api-key` + `anthropic-version`）、responses 分支（:297）、custom（:406）、openai（:425，default 兜底段）。gemini 需新增分支：`{base}/models/{model}:generateContent|streamGenerateContent?alt=sse` + `x-goog-api-key` 头。
- `apps/worker/src/routes/proxy.ts:560` — `convertResponse` 按目标格式 + 入站路径选择转换（含 pivot 双 transform 串联，:628-633）。gemini 目标加两个分支（chat 入站单跳 / responses 入站两跳）。
- 流式 usage 注入 gate（proxy.ts:933-960）：条件是「最终上游体为 chat completions 形状」——gemini 上游体非 chat 形状，天然跳过（与 anthropic/responses 上游同理），无需改。
- 错误/重试/多 Key 语义（proxy.ts:1068-1130）：`isRetryableStatus` 格式无关；gemini 的 429（RESOURCE_EXHAUSTED）/5xx 照旧进渠道冷却与 Key 轮换，401/403 照旧 Key 长冷却——**零改动继承**。

### 1.4 usage 解析与计费

- `apps/worker/src/utils/usage.ts:48` — `normalizeUsage` 的别名链：prompt 取 `prompt_tokens/promptTokens/input_tokens/inputTokens`（**:53-58，无 `promptTokenCount`**）；cached 取 `prompt_tokens_details.cached_tokens → input_tokens_details.cached_tokens → prompt_cache_hit_tokens → cache_read_input_tokens`（:84-89）。gemini 形状不在任何别名链上。
- `apps/worker/src/utils/usage.ts:120` — `extractRawUsage` 查 `usage / data.usage / response.usage / message.usage`（message 分支就是 anthropic 原生流能落库的原因）——**无 `usageMetadata` 分支**。
- `apps/worker/src/services/pricing.ts:64` — `calculateCost(price, prompt, completion, total?, cachedInput?, cacheCreation?, ratios?)`，缓存读/写折价已落地；「cached ⊆ prompt」仓库口径 + 双零短路守卫。
- 计费接线：proxy.ts:1250-1259 `record` 闭包消费 `NormalizedUsage` → `recordUsage`（原子 batch）。

### 1.5 连通性测试 / 模型拉取 / 主动探测

- `apps/worker/src/services/channel-testing.ts:55` — `probeChannelFormat` 按格式分支：openai/responses 打 `{base}/models`，anthropic 打 `{base}/v1/models`，头规则各异（anthropic 用 `x-api-key`+`anthropic-version`，其余 `Authorization: Bearer` + `x-api-key` 双发）；「有响应即可达」语义（:107-110）。gemini 需新分支：`GET {base}/v1beta/models`——**注意响应形状是 `{models: [{name: "models/gemini-2.5-pro", ...}]}`**，当前解析 `payload.data ?? payload`（:112-117）取不到，且 `name` 带 `models/` 前缀需剥离。
- `fetchChannelModels`（:139）`Promise.allSettled` 逐格式探测 + 模型 id 并集——gemini 作为 `api_formats` 数组元素自动进入循环，只需单格式分支正确。
- `services/channel-probe.ts` 复用 `fetchChannelModels`（文件头注释 :6-10），零额外改动。
- `routes/channels.ts:494/:741` 与 newapi 兼容层 `routes/newapiChannels.ts:390+` 调 `fetchChannelModels`——接线点自动跟随。

### 1.6 UI / 常量 / 挂载

- `apps/ui/src/core/constants.ts:59-78` — 格式多选常量（`API_FORMAT_OPTIONS` 类）、端点覆盖键列表、格式标签 map（openai/responses/anthropic/custom 各一条）。加 gemini = 3 处常量 + ChannelsView 表单自然渲染（多选 + 覆盖输入框是数据驱动）。
- `apps/worker/src/index.ts:181-182` — 现挂载 `/v1` 与 `/anthropic/v1`；入站 gemini 需新增 `app.route("/v1beta", geminiProxyRoutes)`。
- `apps/worker/src/utils/request.ts:6-11` — `getBearerToken` 读 `Authorization: Bearer / x-api-key / x-admin-token`，**不读 `x-goog-api-key`**（Gemini CLI 的原生鉴权头）。
- `apps/worker/src/services/stream-aggregate.ts:23` — `AggregateProtocol = "chat" | "anthropic" | "responses"`（预设强制流式聚合用）；gemini 目标 + 强制流式预设的组合目前不存在（预设白名单仅 opencode），防御性处理即可。

### 1.7 测试锚点形态（成本参照）

`tests/proxy-pivot.test.ts`（1193 行）：makeChannel/makeDb 最小 mock（:22-89）+ 逐分支集成断言（两方向 × 流/非流 × usage 注入 × 工具往返 × error 终止形态 × 偏好序）。gemini 测试照此模板复制，单文件预计 800–1200 行，成本 ~1.5–2 人日。

---

## 2. 官方文档核验摘要（全部亲自核验，URL 可溯）

以下断言均以 2026-11-06 官方文档为准，非训练记忆。

### 2.1 端点与请求体（generateContent 家族）

- `POST /v1beta/models/{model}:generateContent`、`POST /v1beta/models/{model}:streamGenerateContent`、`POST /v1beta/auth_tokens`——方法表见 https://ai.google.dev/api/generate-content （Methods 节）。
- **GenerateContentRequest 顶层字段**：`contents[]`（Content：`role ∈ {user, model}` + `parts[]`）、`systemInstruction`（Content 类型，官方注 "Only text should be used in parts"）、`generationConfig`、`safetySettings[]`、`tools[]`、`toolConfig`、`cachedContent`（字符串，引用显式缓存）。来源同上（AuthToken 内嵌的 BidiGenerateContentSetup 展示了 model/generationConfig/systemInstruction/tools 同构字段；contents/safetySettings/cachedContent 为 generateContent 请求体标准字段，与 new-api `dto.GeminiChatRequest`、CLIProxyAPI 转换器实现一致——双参考实现交叉印证）。
- **Part union**（https://ai.google.dev/api/generate-content Content/Part 节）：`text` | `inlineData{mimeType,data}` | `functionCall{name,id?,args}` | `functionResponse{name,id?,response,parts?}` | `fileData{fileUri,mimeType}` | `executableCode` | `codeExecutionResult` | `thought:boolean` | `thoughtSignature` | `videoMetadata` 等。转换器只需处理 text/inlineData/functionCall/functionResponse/thought 五类，其余丢弃 + warn（照既有「未知部件丢弃并 warn」惯例）。
- **GenerationConfig**：`candidateCount`、`stopSequences`（≤5）、`maxOutputTokens`、`temperature/topP/topK`（官方注：**Gemini 3.6+/4 已忽略并返回弃用警告头**）、`seed`、`responseMimeType`（`application/json` 即 JSON mode）、`responseJsonSchema`、`presencePenalty/frequencyPenalty`、`thinkingConfig{includeThoughts, thinkingBudget, thinkingLevel(MINIMAL/LOW/MEDIUM/HIGH)}`、`speechConfig`/`imageConfig` 等（来源同上 GenerationConfig 节）。
- **Schema**：OpenAPI 3.0 子集（type 大写枚举 STRING/NUMBER/...、format、enum、items、properties、required、propertyOrdering）——与 chat `response_format.json_schema` / tools `parameters` 的 JSON Schema 有命名差异（`type: "string"` vs `type: "STRING"`），转换需大小写归一（new-api `GeminiGenerateContentRequestToOpenAIChat` 同样处理此差异）。
- **finishReason 枚举**（响应侧映射 finish_reason 用）：STOP / MAX_TOKENS / SAFETY / RECITATION / MALFORMED_FUNCTION_CALL / OTHER / IMAGE_* / CONTINUATION 等（来源同上 Candidate.finishReason 节）。

### 2.2 流式形态（Q2 关键）

- **默认**：`streamGenerateContent` 不带参数返回**分块 JSON 数组**（`[{...},{...}]` 逐块流出）。
- **`?alt=sse`**：标准 SSE，每帧 `data: {GenerateContentResponse}`，末帧携带 `finishReason` + `usageMetadata`。官方 quickstart 即此形态：`curl ".../v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse&key=..."`（https://github.com/google-gemini/cookbook/blob/main/quickstarts/rest/Streaming_REST.ipynb ，官方原文："With `sse` each stream chunk is a GenerateContentResponse object ... Without `sse` it str[eams a JSON array]"）。逐帧样例（developer.chrome.com/docs/ai/streaming）确认每帧自带 usageMetadata 增量计数。
- **结论**：上游请求统一追加 `alt=sse` 后，既有 `pipeThrough(TransformStream)` 管线、`parseUsageFromSse`（读 `data:` 行）**形态完全兼容**；「分块 JSON 数组」形态无需网关解析。CLIProxyAPI 实证此路线（未指定 alt 时默认按 sse 响应客户端，DeepWiki 核验）。

### 2.3 鉴权头（Q6 关键）

- **现行文档统一用 `x-goog-api-key: $GEMINI_API_KEY` 请求头**（text-generation.md、api-key.md、tokens 指南的 REST 示例全部如此，https://aistudio.google.com/docs/api-key.md ）。
- `?key=` 查询参数仍被官方 quickstart / models 文档 curl 使用（https://ai.google.dev/api/models ），但会进 URL 日志，**网关侧应统一用头**。
- Gemini CLI 在 `gemini-api-key` 模式下把 key 放 `x-goog-api-key` 头（LangWatch 网关文档实证："Gemini CLI sends the VK secret as x-goog-api-key (its native auth header)"，https://langwatch.ai/docs/ai-gateway/cli/gemini-cli ）。
- OAuth/服务账号：PRD 非目标（已拍板不做），API key 直连除外——本报告全部按 API key 形态设计。

### 2.4 usageMetadata（Q4 关键，字段全部核验）

来源 https://ai.google.dev/api/generate-content （GenerateContentResponse.usageMetadata 节），官方原文摘录：

| 字段 | 官方语义（原文翻译） | 备注 |
|---|---|---|
| `promptTokenCount` | "Number of tokens in the prompt. **When cached_content is set, this is still the total effective prompt size meaning this includes the number of tokens in the cached content.**" | **prompt 含 cached**——与仓库「cached ⊆ prompt」口径逐字吻合 |
| `cachedContentTokenCount` | "Number of tokens in the cached part of the prompt (the cached content)" | **纯缓存读语义；usageMetadata 无任何缓存写字段（已核验完整字段表）** |
| `candidatesTokenCount` | "Total number of tokens across all the generated response candidates" | 不含 thoughts |
| `toolUsePromptTokenCount` | "Number of tokens present in tool-use prompt(s)" | 隐式工具（搜索接地）提示 token |
| `thoughtsTokenCount` | "Number of tokens of thoughts for thinking models" | 思考输出 token |
| `totalTokenCount` | "Total token count for the generation request (**prompt + tool-use prompt + thoughts + response candidates**)" | ≠ prompt + candidates 简单和 |
| `promptTokensDetails[] / cacheTokensDetails[] / candidatesTokensDetails[]` | ModalityTokenCount（modality + tokenCount） | 模态拆分，可先忽略 |

### 2.5 models.list / countTokens（Q1）

- `GET /v1beta/models`：query `pageSize`（默认 50，上限 1000）/`pageToken`；响应 `{models: [Model], nextPageToken}`；`Model.name = "models/{model}"`（带前缀）、`baseModelId`、`supportedGenerationMethods` 等。来源 https://ai.google.dev/api/models 。
- `POST /v1beta/{model=models/*}:countTokens`：请求 `contents[]` **或** `generateContentRequest`（二者互斥，官方原文 "You can either send Model + Contents or a generateContentRequest, but never both"）；响应 `{totalTokens, cachedContentTokenCount?, promptTokensDetails?}`（注意是 `totalTokens` 不是 `totalTokenCount`）。来源 https://ai.google.dev/api/tokens 。
- 全方法索引：https://ai.google.dev/api/all-methods （embedContent/batchGenerateContent/Live 等均在此，评估为范围外）。

### 2.6 上下文缓存（Q1 裁剪依据）

来源 https://aistudio.google.com/docs/caching.md ，关键事实：

- **Interactions API 只支持 implicit caching；显式缓存（cachedContents 手动管理）在 Interactions API 与 Gemini 4 Argon 起不被支持**（官方原文："Explicit caching (manually creating and managing cache objects) is not supported in the Interactions API, or for Gemini 4 Argon and onward. To use explicit caching on supported Gemini 3 and 2.5 models, switch to the generateContent API"）。
- implicit caching 对 2.5+ 全系默认开启（最低 token 门槛 2048/4096），命中折扣经 `usageMetadata.cachedContentTokenCount` 自动回报，**客户端零配置零管理端点**。
- 含义：`cachedContents` CRUD 是一条正在被 Google 自己废弃的有状态资源管理面（仅限 Gemini 3/2.5 旧模型），且与 ZenAPI「无上游状态的逐请求路由」模型相性差（缓存对象绑定单一上游 key，跨渠道无意义）。**裁掉，折扣计费经 implicit caching 的 usage 回报照常享受。**

### 2.7 参考实现范围对照（不照抄架构，只对照裁剪）

| 维度 | CLIProxyAPI（router-for-me） | new-api（QuantumNous） | ZenAPI 建议 |
|---|---|---|---|
| 端点范围 | generateContent / streamGenerateContent / countTokens / models.list（+ 实验性 `/v1beta/interactions`） | generateContent / streamGenerateContent / countTokens / models.list（+ native embeddings） | 同左四件套；embeddings 裁掉 |
| cachedContents | **不实现端点**，只消费 usageMetadata.cachedContentTokenCount | **不实现**（DeepWiki 无记录） | 同左：裁掉 |
| 双向性 | 入站 handler（/v1beta/models/*:action）+ 出站 GeminiExecutor 双向 | 入站 native relay（relay-gemini-native.go）+ 转换 relay（relay-gemini.go）双向 | 出站先行，入站二阶段 |
| alt=sse | 未指定 alt 时**默认按 sse** | native 流处理 | 上游恒加 `alt=sse`（同 CLIProxyAPI） |
| usage 映射 | promptTokenCount→prompt_tokens 等直接改名 | prompt=prompt+toolUse；completion=candidates+thoughts；total=totalTokenCount；cached→details.cached_tokens | 采 new-api 口径（§5.2） |
| 内部枢纽 | 自有 SDK translator 层 | 内部 OpenAI 形状 | openai chat 枢纽（既有） |

---

## 3. Q1 协议覆盖与范围裁剪

| 端点 | 建议 | 理由 | 成本标签 |
|---|---|---|---|
| `POST :generateContent` | **进范围**（出站 + 入站） | 核心生成面；无它整条协议无意义 | 中（转换器三件套之一） |
| `POST :streamGenerateContent` | **进范围** | 流式是 CLI 工具默认形态；`alt=sse` 让它与既有 SSE 管线同构 | 中 |
| `POST :countTokens` | **进范围**，照 `/anthropic/v1/messages/count_tokens` 先例：gemini 目标渠道透传（`{base}/v1beta/models/{model}:countTokens` + `x-goog-api-key`），非 gemini 目标/上游失败 → 本地粗估 `totalTokens = max(1, ceil(len/4))` 恒 200，**零计费零冷却** | Gemini CLI 用它做上下文管理；anthropic-proxy.ts:191 `estimateCountTokensResponse` 已是现成模板，响应只是字段名不同（`totalTokens` vs `input_tokens`） | 小（0.5 人日） |
| `GET /v1beta/models` | **进范围（双角色）**：出站=连通性测试/模型拉取端点（复用 `fetchChannelModels`）；入站=模型发现聚合（把 `/v1/models` 聚合结果包装成 `{models:[{name:"models/{id}",...}]}`） | 探测语义已定（有响应即可达）；入站发现是 Gemini CLI 探活路径（LangWatch 实证未路由也能跑，但补上更稳） | 小（探测 0.5 + 入站 0.5 人日） |
| `cachedContents`（create/list/get/patch/delete） | **裁掉** | ① Google 官方在 Interactions API 与 Gemini 4+ 已不支持显式缓存——投入做一条正在死的管理面不划算；② 有状态资源与多渠道加权路由相性差（缓存对象绑定特定上游 key）；③ implicit caching 零配置自动生效且经 `cachedContentTokenCount` 回报，折扣计费不依赖 cachedContents 端点 | — |
| Live API（`BidiGenerateContent`/WebSocket）、`:embedContent`/`:batchEmbedContents`、`batchGenerateContent`、`auth_tokens`、Files API | **裁掉** | WebSocket 双向流（Workers 支持但架构完全不同）、embedding 非本任务协议矩阵目标、batch 非交互、auth_tokens 服务 Live API | — |

范围裁定额外说明：`safetySettings` 请求字段**透传不解释**（chat 侧无对应面，丢弃 + warn 亦可；建议字段级丢弃并 `[format-converter]` warn，与 input_audio 丢弃惯例一致）。

---

## 4. Q2 转换器清单与成本量级

### 4.1 新写原语（gemini↔chat 辐条，6 个函数）

| # | 函数（建议名） | 覆盖形状 | 可组合性 | 成本 |
|---|---|---|---|---|
| 1 | `openaiToGeminiRequest` | messages→contents/parts（role: system→systemInstruction hoist、assistant→model、tool→functionResponse parts）；多模态 image_url（http(s)→fileData / data URL→inlineData）、input_audio→inlineData、file→inlineData（仅 base64 PDF）；tools（function.parameters JSON Schema→Gemini Schema，`type` 小写→大写枚举归一）；tool_choice→toolConfig.functionCallingConfig（auto→AUTO / required→ANY / none→NONE）；generationConfig（max_tokens/max_completion_tokens→maxOutputTokens、temperature/top_p（新模型已忽略仍照发）、stop→stopSequences、response_format json_schema→responseMimeType+responseJsonSchema、reasoning_effort→thinkingConfig 映射：minimal→MINIMAL/low→LOW/medium→MEDIUM/high·xhigh·max→HIGH 或 effort×max_tokens→thinkingBudget，照 anthropic `EFFORT_BUDGET_RATIOS` 先例）；**推理强度→thinkingConfig 是本函数最重的部件** | 新写（无既有原语可组） | **中**（1.5–2 人日） |
| 2 | `geminiToOpenaiRequest` | 反向：contents→messages（model→assistant、functionCall part→tool_calls、functionResponse→role:"tool"）；systemInstruction→首条 system；generationConfig→顶层参数；thinkingConfig→reasoning_effort（budget→无精确反推，档位直映）；Gemini Schema→JSON Schema（type 大写→小写） | 新写 | **中**（1 人日；入站阶段才需要，出站可缓） |
| 3 | `geminiToOpenaiResponse` | candidates[0]→choices[0]（text parts 拼接→content；thought:true parts→reasoning_content；functionCall→tool_calls；finishReason→finish_reason 映射 STOP→stop/MAX_TOKENS→length/SAFETY·RECITATION·OTHER→stop+finish_message 保底）；usageMetadata→usage（§5.2 口径）；promptFeedback.blockReason→content_filter 结果 | 新写 | **中**（1 人日） |
| 4 | `openaiToGeminiResponse` | 反向（入站阶段用） | 新写 | **中**（1 人日，可缓） |
| 5 | `createGeminiToOpenaiStreamTransform` | 上游 SSE（`data: {GenerateContentResponse}`）→ chat SSE chunk 流：text part→delta.content、thought part→delta.reasoning_content、functionCall→delta.tool_calls、finishReason 帧→finish_reason + usage 尾 chunk（OpenAI 形状，供 `parseUsageFromSse` 原样消费——照 `createOpenaiToResponsesStreamTransform` usage 单尾帧惯例） | 新写 | **中**（1–1.5 人日，接缝最多） |
| 6 | `createOpenaiToGeminiStreamTransform` | 反向（入站阶段用）：chat SSE→gemini SSE 帧 | 新写 | **中**（1 人日，可缓） |

### 4.2 组合可得（照 pivot 经验，每个 3–6 行纯组合函数 + 锚点测试）

| 斜边 | 组合 | 成本 |
|---|---|---|
| `responsesToGeminiRequest` = `responsesToOpenaiRequest` → `openaiToGeminiRequest` | 两跳 | **小**（函数 0.1 + 测试 0.5 人日） |
| `geminiToResponsesRequest` = `geminiToOpenaiRequest` → `openaiToResponsesRequest` | 两跳 | **小** |
| `anthropicToGeminiRequest` / `geminiToAnthropicRequest`（经 chat 枢纽） | 两跳 | **小** |
| 响应侧 4 个斜边组合（`geminiToResponsesResponse` 等） | 两跳 | **小** |
| 流式斜边：transform 串联（geminiSSE→chatSSE→responsesSSE 等），照 proxy.ts:628-633 pivot 双 transform 串联模式 | 两跳 | **小**（管线接线在 convertResponse，各 0.25 人日） |

### 4.3 流式差异结论（Q2 专项）

- Gemini「分块 JSON 而非 SSE」的差异**被 `alt=sse` 抹平**：出站构造时恒追加 `?alt=sse`（CLIProxyAPI 同策略），上游即回 SSE，网关全部既有流式机械（TransformStream 串联、`parseUsageFromSse` 的 `data:` 行解析、20s 闲置超时、waitUntil 收尾）原样工作。
- 唯一入站侧反向义务：gemini 入站客户端若未请求 `alt=sse`（默认 JSON 数组形态），需把聚合结果以 JSON 数组回吐——可用 `stream-aggregate.ts` 聚合后单次 JSON 数组返回（非流式近似）或建议只支持 `alt=sse`（Gemini CLI 恒带 alt=sse，风险极低）。**建议一阶段只支持 `alt=sse`，未带者按 JSON 数组整体返回**（复用聚合器，fail-open）。

---

## 5. Q3 / Q4 路由插位与计费口径

### 5.1 偏好序插位（`channel-routing.ts:34-40`）

```
chat:        openai > responses > anthropic > gemini > custom   （gemini 新单跳，排既有单跳之后）
responses:   responses > openai > anthropic > gemini > custom   （gemini 经 chat 枢纽两跳，pivot 位）
anthropic:   anthropic > openai > responses > gemini > custom   （同上）
passthrough: openai > responses > custom                         （维持排除——gemini 与 anthropic 同理无透传/转换边）
```

- 规则自洽性：「单跳优先于双跳」不受破坏——gemini 在 chat 域是新单跳（排 anthropic 之后仅因成熟度），在 responses/anthropic 域是两跳 pivot。
- `selectTargetFormat`（:65）**本体零改动**（纯 preference 查表）；`inboundProtocolForPath`（:46）仅在入站阶段加 `"gemini"` 分支（`/v1beta` 前缀）。
- `resolveEndpointBaseUrl`（:95）：gemini 归 openai 消费语义（仅去尾斜杠、保留 `/v1beta` 版本路径）；`normalizeEndpointOverrides`（channel-types.ts:229）的 gemini 覆盖走 openai 分支（不剥版本路径）。
- passthrough 域维持现有排除逻辑的依据：透传域定义是「openai 协议族其余路径」（embeddings 等），gemini 没有对应方言，与 anthropic 被排除的理由逐字相同。

### 5.2 usageMetadata → usage_logs 映射（采 new-api 口径，字段语义已按官方文档核验）

| Gemini 字段 | usage_logs 列 | 说明 |
|---|---|---|
| `promptTokenCount`（+ `toolUsePromptTokenCount` 若存在） | `prompt_tokens` | 官方确认 prompt 含 cached（§2.4）——与仓库「cached ⊆ prompt」口径吻合，`calculateCost` 的 `nonCached = max(0, prompt − cacheRead − 0)` 公式直接成立 |
| `candidatesTokenCount` + `thoughtsTokenCount` | `completion_tokens` | thoughts 按 Google 定价计入输出价（new-api 同口径）；usage_logs 无 reasoning_tokens 列，不新增迁移 |
| `totalTokenCount` | `total_tokens` | 官方口径 prompt+toolUse+thoughts+candidates；直接采信上游值，不重算 |
| `cachedContentTokenCount` | `cached_input_tokens` | **纯缓存读**（usageMetadata 无缓存写字段，§2.4 已核验完整字段表） |
| （无对应字段） | `cache_creation_tokens` | 恒 NULL——Gemini 无缓存写 token 语义（显式缓存按存储时长计费而非 token，且已裁掉） |
| 请求体 `reasoning_effort`（chat 入站）/ `thinkingConfig`（gemini 入站） | `reasoning` | 照既有 `extractReasoningEffort` 惯例 |

- **与 cache-token-billing 的交叉（PRD 明确要求写清依赖方向）**：`services/pricing.ts:64` 六参签名已落地 → gemini 计费**单向依赖**它，`pricing.ts` 零改动；反向无依赖（cache_read_ratio / per-model `cache_read_price` 对 gemini 模型照常生效——Gemini implicit caching 的缓存读折扣恰好就是这个旋钮的用途）。
- 双零短路守卫天然覆盖无缓存命中请求（字节级原路径）。
- 实现落点：出站 gemini 的响应在 `convertResponse` 已转成 chat 形状（usage 由 #5 transform / #3 转换器产 OpenAI 形状），`normalizeUsage` 别名链**不用加 gemini 字段**；仅在**入站 gemini**（响应保持 gemini 形状）时需给 `extractRawUsage` 加 `usageMetadata` 分支 + `normalizeUsage` 加 `promptTokenCount/candidatesTokenCount/totalTokenCount/cachedContentTokenCount/thoughtsTokenCount` 别名（小，0.25 人日；这些字段名与其他协议无碰撞，防御性安全）。

---

## 6. Q5 入站 / 出站不对称性与分档

### 6.1 两个价值面

- **出站 gemini**（渠道声明 `gemini`）：让既有全部入站（chat/responses/anthropic）的客户端使用 Gemini 原生上游。价值：① 部分中转站只暴露原生端点（OpenAI 兼容面阉割 thinking/缓存）；② 原生 `thinkingConfig` 与 implicit caching 折扣的保真度最高；③ CLIProxyAPI/new-api 均以此为主面。改动集中在**后端 + UI**，客户端零感知。
- **入站 gemini**（挂 `/v1beta`）：让 Gemini CLI 等 Google 生态工具直连 ZenAPI，经转换使用 openai/responses/anthropic 上游。价值：拉新用户群（Gemini CLI 免费额度人群）；Google 官方明确「Gemini CLI 不做其他 LLM 直连支持」（官方 discussion #1974），网关转换是唯一路径。改动是**新路由文件 + 鉴权适配 + 反向转换**，且 `GOOGLE_GEMINI_BASE_URL` 环境变量即指到网关域名（CLI 自己拼 `/v1beta`，LangWatch 实证此接入契约）。

### 6.2 分档工作量（细化见 §8）

| 档 | 内容 | 人日 |
|---|---|---|
| A：只做出站 | gemini↔chat 三件套 + buildChannelRequest/convertResponse 分支 + 路由/白名单/UI/探测 + 组合斜边 + 测试锚点 | **8–10** |
| B：A + 入站 | `/v1beta` 路由（generateContent/streamGenerateContent/countTokens/models.list）+ `x-goog-api-key` 鉴权适配 + 反向三件套（#2/#4/#6）+ usageMetadata 别名 + 测试 | +6–8（合计 **14–18**） |
| C：只做入站 | 不可行——入站转换的响应侧 = 出站原语 #3/#5 复用，入站单独做也要写大半出站转换器，无独立节省 | ≈B |

**建议：A 先行（独立价值闭环、风险小、客户端零感知），B 视 Gemini CLI 用户需求排期。** A 的转换器产线（#1/#3/#5）是 B 的直接资产，无返工。

---

## 7. Q6 Workers 开销与配套

### 7.1 CPU 量级判断

- 转换 = 一次 `JSON.parse` + 单遍对象图遍历 + 一次 `JSON.stringify`。既有 anthropic/responses 转换已同量级运行（含 base64 多模态部件的拷贝）。V8 JSON 往返吞吐经验值数百 MB/s：1MB body（含 base64 图像的典型 agent 请求）单次转换 ≈ 5–15ms CPU；两跳 pivot ≈ 2×。Workers 付费档 CPU 上限 30s、免费档 10ms（免费档大体量多模态请求本就紧张，非 gemini 特有风险）。**结论：不构成新风险类，与既有转换同量级；无需基准测试先行，上线后经 `x-usage`/日志观察即可。**
- 流式转换逐 chunk 处理（TransformStream），内存占用 O(单 chunk)，无聚合点（入站 JSON 数组回吐例外，复用 stream-aggregate 已有界限）。

### 7.2 连通性测试 / 模型拉取 / 探测接入点

- `probeChannelFormat`（channel-testing.ts:55）加 gemini 分支：`GET {resolveEndpointBaseUrl(row,"gemini")}/models`（base 已含 `/v1beta`，与 openai 拼法相同）+ 头 **`x-goog-api-key`**（官方现行头形态，§2.3；不用 `?key=` 避免进 URL 日志）。
- 响应解析补两处：`payload.models` 数组识别 + `name` 剥 `models/` 前缀（`normalizeModelsInput` 前小适配）。
- `fetchChannelModels` 的 `Promise.allSettled` 逐格式循环与并集去重自动覆盖；channel-probe.ts / channels.ts / newapiChannels.ts 零改动。**「有响应即可达」语义对 gemini 401/403 同样成立**（可达性 ≠ 鉴权成功，与现状一致）。

### 7.3 endpoint_overrides 键白名单

**顺延加 `gemini`**（channel-types.ts:148 `ENDPOINT_OVERRIDE_KEYS` + UI constants 同步）。规范化语义归 openai 类（trim + 去尾斜杠，保留 `/v1beta`）。备份导出/导入对 `endpoint_overrides` 字符串 round-trip 自动保真（既有契约），`BACKUP_SETTINGS_EXPORT_KEYS` 无涉。

### 7.4 鉴权适配（入站阶段）

Gemini CLI 发 `x-goog-api-key` 头；`getBearerToken`（utils/request.ts:6）不读它。两个选项：① 在 gemini 路由入口做头归一化小中间件（`x-goog-api-key` → `Authorization: Bearer`，再进 `tokenAuth`）——**推荐**，影响面限死在 `/v1beta`，不碰全局鉴权面；② 扩 `getBearerToken` 别名——一行但改全局提取面，审慎者会反对。IP 节流门/RPM 门/额度预检/白名单全部随 tokenAuth 自动继承。

---

## 8. Q7 工作量估算、任务拆分与回滚

### 8.1 任务拆分建议（A 档 = 出站，8–10 人日）

| # | 子任务 | 文件 | 人日 |
|---|---|---|---|
| A1 | 白名单/规范序/端点覆盖键/偏好序/UI 常量 | channel-types.ts, channel-routing.ts, ui constants | 0.5 |
| A2 | `openaiToGeminiRequest`（含 thinkingConfig/Schema 大小写归一/工具映射）+ 单测 | format-converter.ts | 1.5–2 |
| A3 | `geminiToOpenaiResponse` + `createGeminiToOpenaiStreamTransform`（usage 尾帧 OpenAI 形状）+ 单测 | format-converter.ts | 1.5 |
| A4 | pivot 组合函数（8 个一行式）+ 斜边流串联 + 单测 | format-converter.ts, proxy.ts | 0.5–1 |
| A5 | `buildChannelRequest` gemini 分支（URL 拼接 + `alt=sse` 追加 + `x-goog-api-key` + Authorization 剥除）+ `convertResponse` gemini 分支 | proxy.ts | 1 |
| A6 | 探测/模型拉取 gemini 分支（`payload.models` + 前缀剥离）+ 单测 | channel-testing.ts | 0.5 |
| A7 | 集成锚点测试（照 proxy-pivot.test.ts 模板：两方向 × 流/非流 × usage prompt>0 × 工具往返 × error 形态 × 偏好序） | tests/proxy-gemini.test.ts | 1.5–2 |
| A8 | UI 表单验证 + `bun run check && typecheck && test` 全绿 + AGENTS.md §6/§8 补记 | ui, AGENTS.md | 0.5 |

B 档增量（+6–8 人日）：B1 `geminiToOpenaiRequest`/`openaiToGeminiResponse`/`createOpenaiToGeminiStreamTransform`（3 人日）；B2 `/v1beta` 路由文件（路径解析 `models/{model}:action`、鉴权头归一化中间件、热态复用、countTokens/models.list，2 人日）；B3 `usageMetadata` 别名 + 单测（0.5）；B4 入站集成测试锚点（1.5–2.5）。

### 8.2 回滚形状（照 responses-anthropic-pivot 哲学）

- **零迁移**：`api_formats` 是字符串 JSON 列，白名单外的值被 `filterWhitelisted`（channel-types.ts:66）静默剔除——revert 后残留 `["gemini"]` 声明的渠道经三级兜底回落 `["openai"]`（:92 parseApiFormats），fail-open 可路由，不炸。
- **零 settings 残留**：无新 settings 键、无新表。
- **回滚动作** = 纯代码 revert（白名单/偏好序/转换器/分支/UI 常量一并回退）；`endpoint_overrides` 残留 `gemini` 键被读侧键白名单过滤（parseEndpointOverrides :186 只认白名单键），无害。
- 行为回滚语义与 pivot 完全同构：斜边回 503 `no_available_channels`（无合格候选），存量渠道回落 openai 目标。

### 8.3 风险清单（如实）

1. **`reasoning_effort → thinkingConfig` 映射的档位语义**是转换保真度最弱点（effort 是比值、thinkingLevel 是离散档 + thinkingBudget 是绝对值）——建议照 anthropic 先例（`EFFORT_BUDGET_RATIOS` × maxOutputTokens clamp），并接受「无法精确反推」为声明损失。
2. **thoughtSignature 往返**：gemini 的 function-call thinking 签名（`MISSING_THOUGHT_SIGNATURE` finishReason）与 anthropic 签名回传同病——chat 协议无携带面，两跳场景可能触发上游拒答；如实声明为已知限制（与 pivot 的 thinking 签名限制同款）。
3. **`alt=sse` 未带时的 JSON 数组回吐**（入站）是非流式近似，极端慢流下体验降级——一阶段建议直接不支持非 sse 流式（400 引导）， observing 需求后补。
4. Gemini 3.6+ 忽略 temperature/topP/topK——转换器照发不误（上游静默忽略），无需特判；但文档应提醒运营者。
5. **`totalTokenCount` ≠ prompt + completion**（含 toolUse prompt）——计费用上游原值，统计页若做「prompt+completion 对账 total」会出差异，如实标注即可。

---

## 9. 最终建议：分档做（A 先行）

- **做 A（出站 gemini，8–10 人日）**：理由——① 协议矩阵补齐的最小闭环，客户端零感知零风险；② implicit caching 折扣 + thinkingConfig 保真是中转场景的实打实收益；③ CLIProxyAPI/new-api 双参考实现均以出站为主面，路线被验证；④ 全部资产（转换器 #1/#3/#5）为 B 复用。
- **B（入站 `/v1beta`，+6–8 人日）按需排期**：价值真实（Gemini CLI 用户群 + Google 官方不做他模型直连的空白）但不紧迫——ZenAPI 现有用户以 OpenAI 系客户端为主；建议观察 A 上线后是否有 Gemini CLI 接入诉求再启动。
- **不做**：cachedContents（Google 自己在废弃）、Live API、embeddings、batch、Interactions API（未来再评估——它是 Google 的主推方向，若 generateContent 宣布日落窗口应立即重评本报告）。
- **总成本口径**：A = 8–10 人日；A+B = 14–18 人日（单人含测试与文档；不含用户拍板后的 PRD/design 往返）。

---

## 附：核验来源清单

- Gemini API generateContent 参考（方法/请求体/Part/GenerationConfig/Schema/usageMetadata/finishReason）：https://ai.google.dev/api/generate-content
- 流式 REST quickstart（alt=sse 形态官方原文）：https://github.com/google-gemini/cookbook/blob/main/quickstarts/rest/Streaming_REST.ipynb
- SSE 逐帧行为样例：https://developer.chrome.com/docs/ai/streaming
- countTokens 参考（请求互斥/响应 totalTokens）：https://ai.google.dev/api/tokens
- models.list 参考（分页/name 前缀/响应形状）：https://ai.google.dev/api/models
- 全方法索引：https://ai.google.dev/api/all-methods
- 上下文缓存（implicit 默认开/显式缓存 Gemini 4+ 不支持）：https://aistudio.google.com/docs/caching.md
- API key 文档（x-goog-api-key 头形态）：https://aistudio.google.com/docs/api-key.md
- 文档索引与 Interactions API 定位声明：https://aistudio.google.com/llms.txt
- Gemini CLI 原生 API 行为 + GOOGLE_GEMINI_BASE_URL 契约：https://langwatch.ai/docs/ai-gateway/cli/gemini-cli 、https://github.com/google-gemini/gemini-cli/discussions/1974
- 参考实现（DeepWiki 核验）：router-for-me/CLIProxyAPI、QuantumNous/new-api（§2.7 表）

## Caveats / Not Found

- GenerateContentRequest 顶层字段（contents/safetySettings/cachedContent/toolConfig）未从单一官方页面整段抓到（该页数据模型节被截断），经 BidiGenerateContentSetup 同构字段 + new-api `dto.GeminiChatRequest` + CLIProxyAPI 转换器三源交叉印证——置信度高，但实施 PRD 阶段建议再拉一次 https://aistudio.google.com/llms-full.txt 定稿字段清单。
- Gemini implicit caching 的具体折扣比例（如 2.5 系 25%）未在本报告核验（属运营配置项，非协议形状）；落地时按 https://aistudio.google.com/docs/pricing.md 现值配 `cache_read_ratio` / per-model `cache_read_price`。
- 本报告未评估 Vertex AI 形态（PRD 非目标）；Vertex 的 `:streamGenerateContent` 路径方言（`?alt=sse` 同样存在）未核验。
