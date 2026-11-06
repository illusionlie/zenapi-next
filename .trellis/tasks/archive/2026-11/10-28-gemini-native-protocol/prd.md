# Gemini 原生协议设计评估

## Goal

评估把 Gemini 原生协议（`/v1beta/*`）接入 ZenAPI 的成本。当前格式白名单仅 `openai | responses | anthropic | custom`（`services/channel-types.ts`），全仓无 gemini 形状代码；Gemini 模型只能经上游 OpenAI 兼容端点接入。CLIProxyAPI 与 New API 均已支持 Gemini 原生入站——这是协议矩阵唯一缺的一角，也是 Gemini CLI / Google 生态工具的直连入口。

**本任务交付物是评估报告，不写任何业务代码。** 报告落盘后由用户拍板是否立项实施；实施另开子任务挂批次父任务（`10-28-cpa-newapi-adoption-batch`）下。

## 评估问题（报告必须逐项回答）

- **Q1 协议覆盖与范围裁剪**：`GET /v1beta/models`、`:generateContent`、`:streamGenerateContent`、`:countTokens`、`cachedContents`（上下文缓存管理）——哪些进范围、哪些裁掉，给建议与理由。
- **Q2 转换器清单与成本量级**：作为 `api_formats` 第 5 种声明的双向转换面——`contents/parts`、`systemInstruction`、`generationConfig`、`safetySettings`、`tool/functionCall/functionResponse`、`thinkingConfig` 等形状与 chat 的互转；流式差异（Gemini 是分块 JSON 而非 SSE）；哪些可由既有转换原语组合（照 responses↔anthropic pivot 经验）、哪些必须新写；每部分标成本量级（小/中/大）。
- **Q3 路由矩阵插位**：chat / responses / anthropic / passthrough 四入站的偏好序如何插 gemini；passthrough 域是否维持现有排除逻辑（当前仅排除 anthropic）；`selectTargetFormat` 改动面。
- **Q4 usage 与计费口径**：`usageMetadata`（promptTokenCount / candidatesTokenCount / cachedContentTokenCount / thoughtsTokenCount 等）到 usage_logs 列的映射；与本批次 `10-28-cache-token-billing` 的交叉（缓存折价计价形状依赖方向写明）。
- **Q5 入站/出站不对称性**：入站 gemini（服务 Gemini CLI 类客户端）与出站 gemini（声明 gemini 的渠道上游）是两个独立价值面，分别估工作量，给「只做出站 / 只做入站 / 都做」的分档建议。
- **Q6 Workers 开销与配套**：CPU 限额下大体 JSON 转换的成本量级；连通性测试 / 模型拉取的 gemini 端点语义（`x-goog-api-key` 头 vs `?key=`）与逐格式探测（`Promise.allSettled`）的接入点。
- **Q7 工作量估算**：人日级估算 + 任务拆分建议 + 回滚形状（照 responses-anthropic-pivot 的「纯代码 revert、零配置残留」哲学）。

## Acceptance Criteria

- [ ] 报告落盘本任务 `research/`（主报告一份，可按主题拆文件），逐项回答 Q1–Q7。
- [ ] 给出明确建议：做 / 不做 / 分档做，附理由与成本，供用户拍板。
- [ ] 用户拍板前不修改任何业务代码。

## 非目标

- 不在本任务内实现任何转换器或路由改动。
- 不评估 Vertex AI / AI Studio 的 OAuth 与服务账号凭据体系（CLI OAuth 已拍板不做；API key 直连除外）。
