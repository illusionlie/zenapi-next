# responses↔anthropic 经 chat 枢纽互转

## Goal

让 `/v1/responses` 入站能服务仅声明 anthropic 的渠道、`/anthropic/v1/*` 入站能服务仅声明 responses 的渠道——经 chat 协议枢纽两跳转换（pivot），消除路由矩阵中最后的两条「无转换」排除边。

用户价值：混合上游池（OpenAI 系 + Claude 系中转混布）在单协议客户端下的可用渠道数最大化；把「协议不匹配 → 503 no_available_channels」变成「有损转换成功」，提升可用性。架构价值：把「Responses 双向」护城河升级为全连通转换矩阵。

## Background（仓库证据，已核实）

- **8 个单跳转换原语全部已存在**（`apps/worker/src/services/format-converter.ts`）：chat↔anthropic 请求/响应/流式三面（:296/:504/:752/:828/:908/:1225）+ chat↔responses 三面（:1506/:1723/:1792/:2302/:2455/:2538）。缺的只是两条斜边，可由 chat 枢纽组合。
- **唯一挡板是路由资格集合**：`apps/worker/src/services/channel-routing.ts:35-38` responses 入站排除 anthropic、anthropic 入站排除 responses；`.trellis/spec/api-worker/backend/channel-routing.md` §3.1 契约行「responses↔anthropic 转换不存在……不得在路由层另写特判」将被本任务改写。
- **两跳接缝由既有转换器契约保障**（`.trellis/spec/api-worker/backend/format-conversion.md`）：§3.1 usage「单末 chunk、完整三值」使中间 chat 流是双方共同遵守的契约形态；§3.5 `[DONE]` 恰一次；§3.6 `[DONE]` 仅作终止信号消费、绝不外泄——纸面自洽，接缝行为需测试锁定。
- **reasoning effort 链路通**：`responsesToOpenaiRequest`（:2302 起）透传 `reasoning.effort` → `reasoning_effort`，chat→anthropic 侧映射 thinking budget，responses 入站的推理档位可贯通到 anthropic 上游。
- **接线点**：`routes/proxy.ts` responses 入站分支（请求 :421 附近、响应 :556-595 附近）；`routes/anthropic-proxy.ts`（请求 :239、响应 :547-571）。**playground 零改动**（`routes/playground.ts:93` 硬编码 chat 入站，而 chat 入站本就四格式全通）。count_tokens 对非 anthropic 目标本就本地粗估恒 200，天然覆盖新目标。
- **直连转换器增量收益趋近零**：responses 与 anthropic 的重叠概念（instructions↔system、tools、图片输入、采样参数）chat 均有等价物，两跳皆活；真正有损的字段（anthropic `cache_control`、thinking 签名、server tools；responses hosted tools、`previous_response_id`/store）在目标协议中本无等价物——损失来自协议差异而非绕道。
- **有损面（如实声明，均非本任务新增回归）**：anthropic `cache_creation` 经折入总量后不再单独可分（`usage_logs.cache_creation_tokens` 记 NULL）；thinking 签名不回传（既有已声明限制）；responses stateful 字段照旧丢弃。

## Requirements

- **R1 路由矩阵扩展**：responses 入站可服务集合增补 anthropic，anthropic 入站增补 responses；偏好序遵循「单跳优先于双跳」——responses `responses > openai > anthropic > custom`，anthropic `anthropic > openai > responses > custom`（chat 与 passthrough 偏好序不变）。
- **R2 三面组合接线**：proxy.ts responses 入站 anthropic 目标分支 + anthropic-proxy.ts responses 目标分支，覆盖非流式、流式（两个 TransformStream 串联）、tool 往返。
- **R3 组合逻辑下沉 services**：组合函数收敛于 format-converter.ts 导出，proxy / anthropic-proxy 薄壳调用，不在路由层另写特判（遵循 channel-routing.md 消费点共用铁律）。
- **R4 测试矩阵**：channel-routing 路由矩阵新增两格断言（responses×anthropic、anthropic×responses 由不合格翻转为可选目标）；两方向 × 非流式/流式 × usage 接缝（`parseUsageFromSse` prompt>0）× error 事件终止行为的集成测试。
- **R5 文档同步**：AGENTS.md §8 路由矩阵两行重写；channel-routing.md §3.1、format-conversion.md 增补 pivot 段（含接缝行为与有损口径声明）。
- **R6 配置面约束（2026-10-27 用户拍板）**：**无配置开关**——不新增 settings 键 / 渠道列 / UI；pivot 行为与既有 6 条转换边同构，偏好序保证其恒为末位兜底；回滚即纯代码 revert，零配置态残留。

## Acceptance Criteria

- [ ] AC1 仅声明 `["responses"]` 的渠道可服务 `/anthropic/v1/messages`（非流式 + 流式），客户端收到合法 anthropic Messages 响应/SSE。
- [ ] AC2 仅声明 `["anthropic"]` 的渠道可服务 `/v1/responses`（非流式 + 流式），客户端收到合法 Responses 协议响应/SSE。
- [ ] AC3 usage 经两跳后 `parseUsageFromSse` 可解析且 promptTokens > 0，usage_logs 落库口径正确。
- [ ] AC4 偏好序锁定：混合声明渠道池中单跳路径优先于 pivot 路径（矩阵测试断言）。
- [ ] AC5 零回归：既有 16 格路由矩阵 14 格行为不变；chat 入站与 passthrough 不受影响；playground 行为不变。
- [ ] AC6 count_tokens 打到 responses-only 候选时保持本地估算行为（恒 200），不透传。
- [ ] AC7 `bun run check && bun run typecheck && bun run test` 全绿。

## Out of Scope

- 直连 responses↔anthropic 转换器（增量收益趋近零，见 Background）。
- thinking 签名跨协议回传、cache_control 跨协议保留（目标协议无等价物）。
- responses stateful 字段（store / previous_response_id / conversation）支持（既有边界不变）。
- 配置开关（全局 settings / 渠道级）——R6 已裁撤。
- 渠道探测 / 冷却 / key 冷却语义变更（与转换域正交，零触碰）。
