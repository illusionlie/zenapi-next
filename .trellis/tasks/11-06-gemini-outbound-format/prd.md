# Gemini 原生协议 A 档：出站渠道格式

## Goal

渠道声明 `gemini`（`api_formats` 第 5 种）作为出站目标格式：openai chat 入站 ↔ gemini 上游双向转换、`alt=sse` 流式复用、逐格式探测接线、usage/计费口径接线。**本任务是评估报告 A 档的实施**——需求、范围、成本量级、任务拆分、风险清单的唯一事实来源是评估报告：`.trellis/tasks/10-28-gemini-native-protocol/research/gemini-native-protocol-evaluation.md`（规划 design.md / implement.md 时以其 §3–§8 为纲）。

B 档（入站 `/v1beta` 端点服务 Gemini CLI 类客户端）2026-11-06 拍板**挂起观察**，不在本任务范围。

## Requirements

- **格式声明**：`channel-types.ts` 白名单 + 规范序 + 覆盖键白名单 + 两处 normalize 顺延加 `gemini`（插入点见报告 §1.1）；`custom` 独占约束不变。
- **转换器**（报告 §4）：新写 6 个原语（gemini↔chat 请求 / 非流响应 / 流响应三件套 ×2 方向，各标成本「中」）+ 8 个斜边组合函数照 pivot 经验纯组合（responses/anthropic 域经 chat 枢纽）；`reasoning_effort ↔ thinkingConfig` 档位映射按报告 §4.x 口径；Schema type 大小写归一坑见报告。
- **流式**：上游恒加 `?alt=sse` 参数，全复用既有 SSE 管线（报告 §2.2 官方核验）；usage 解析接 `usageMetadata`。
- **路由**（报告 §5.1）：chat 偏好序 `openai>responses>anthropic>gemini>custom`；responses/anthropic 入站域 gemini 居 pivot 位；passthrough 域维持排除；`selectTargetFormat` 本体零改动（只扩常量数组）。
- **计费**（报告 §5.2）：`completion = candidatesTokenCount + thoughtsTokenCount`、`cachedContentTokenCount → cached_input_tokens`、`cache_creation_tokens` 恒 NULL；`pricing.ts` 零改动（单向依赖六参 `calculateCost`）。
- **探测**（报告 §7）：连通性测试 / 模型拉取 / channel-probe 加 gemini 分支（`{base}/models` + `x-goog-api-key` 头 + `payload.models` 数组识别 + `models/` 前缀剥离）；`endpoint_overrides` 键白名单顺延加 `gemini`。
- **count_tokens**：照 anthropic count_tokens 先例——gemini 目标透传 `{base}/v1beta/models/{model}:countTokens`，非 gemini 目标本地粗估兜底，零计费。

## Acceptance Criteria

- [ ] 评估报告 §8.1 列出的子任务全部落地（实施时以其为 checklist 基准，允许微调但须在 implement.md 记录偏差与理由）。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿；新增转换 / 路由 / 计费锚点测试（照 `tests/proxy-pivot.test.ts` 形态：两方向 × 非流式/流式 × usage 口径 × 工具往返 × error 终止形态）。
- [ ] 回滚形状验证：纯代码 revert 后，存量渠道残留 `["gemini"]` 声明经三级兜底回落 `["openai"]` fail-open，零迁移、零 settings 残留。
- [ ] AGENTS.md §6/§8/§10 相应小节（路由矩阵、格式转换、渠道配套）同步更新。

## 非目标

- B 档入站 `/v1beta` 端点（挂起观察，需求出现再立项）。
- `cachedContents` 上下文缓存管理（评估已裁：Google 主推 Interactions API，显式缓存 Gemini 4+ 不受支持）。
- Vertex AI OAuth / 服务账号凭据（API key 直连 only）。
- Interactions API / Live API / embeddings / batch。
