# 技术设计 — responses↔anthropic 经 chat 枢纽互转

> 前置证据与有损声明见 prd.md Background；本文件只写技术决策与契约形态。

## 1. 架构与边界

组合式 pivot（hub-and-spoke）：**不新增任何单跳转换器**，两条斜边由既有 8 原语组合而成。改动面收敛于三层：

| 层 | 文件 | 改动 |
|---|---|---|
| 路由 | `services/channel-routing.ts` | 可服务集合 + 偏好序常量扩展（唯一行为开关，无配置项）|
| 转换 | `services/format-converter.ts` | 新增 4 个组合函数（纯函数导出）；流式不设组合 helper |
| 接线 | `routes/proxy.ts` / `routes/anthropic-proxy.ts` | 各增一个目标格式 case，薄壳调用 |

**零触碰**：playground（`playground.ts:93` chat 入站硬编码，chat 入站本就全格式）、count_tokens（非 anthropic 目标本地估算恒 200，天然覆盖新目标）、探测 / 冷却 / key 冷却 / 计费（与转换域正交）、DB schema、settings、UI。

## 2. 数据流（两方向 × 三面）

### 2.1 responses 入站 → anthropic 目标（proxy.ts）

- 请求：`responsesToOpenaiRequest` → `openaiToAnthropicRequest`（`reasoning.effort` 全程贯通 → thinking budget）
- 非流式响应：`anthropicToOpenaiResponse` → `openaiToResponsesResponse`
- 流式：上游 anthropic SSE → `createAnthropicToOpenaiStreamTransform()` → `createOpenaiToResponsesStreamTransform()` → 客户端（接线点 `.pipeThrough(t1).pipeThrough(t2)` 串联，中间 chat 流不落线）

### 2.2 anthropic 入站 → responses 目标（anthropic-proxy.ts）

- 请求：`anthropicToOpenaiRequest` → `openaiToResponsesRequest`
- 非流式响应：`responsesToChatResponse` → `openaiToAnthropicResponse`
- 流式：`createResponsesToChatStreamTransform()` → `createOpenaiToAnthropicStreamTransform(...)`（参数形态镜像 `anthropic-proxy.ts:547` 现有调用）

### 2.3 周边机制自动成立（零接线，设计验证结论）

- 头策略 / 伪装预设 / custom 头 / `endpoint_overrides`：全部由浅拷贝 `api_format` 驱动，anthropic 目标自动走既有 anthropic 分支。
- 伪装预设 body 合规守卫检查**出站体**（anthropic 形状含 `messages` 数组 ✓）。
- `stream_options.include_usage` 预注入条件「最终上游体为 chat completions 形状」对 anthropic 目标天然不命中（anthropic 流 `message_delta` 自带 usage）——正确行为，非遗漏。
- 强制流式聚合：`aggregateUpstreamStream(protocolForTargetFormat("anthropic"))` → anthropic JSON → 组合响应转换，机制复用零改动。
- usage 落库解析：`parseUsageFromSse` 解析**客户端面**流，组合流末端恰为 `response.completed` 单事件三值，符合解析契约。

## 3. 偏好序与路由矩阵（决策 D1）

| Inbound | 偏好序（高→低） | 变更 |
|---|---|---|
| chat | openai > responses > anthropic > custom | 不变 |
| responses | responses > openai > **anthropic** > custom | anthropic 增第 3 位 |
| anthropic | anthropic > openai > **responses** > custom | responses 增第 3 位 |
| passthrough | openai > responses > custom | 不变 |

规则「**单跳优先于双跳**」：跳数越少失真越小、CPU 越省；openai(chat) 是最成熟的单跳兜底，恒排在 pivot 前；pivot 恒为末位兜底（custom 仅防御）。`selectTargetFormat` 无需逻辑改动——扩展可服务数组即自动放行资格，两条斜边互斥表达从 null 返回改为正常选中。

## 4. 接缝契约与已知流式行为（决策 D4）

两跳接缝的纸面保障来自既有契约（format-conversion.md），组合**不产生新契约**：

- §3.1 usage「单末 chunk、完整三值」——中间 chat 流是双方共同遵守的生产契约，这是组合可行的根基。
- §3.5 anthropic→chat `[DONE]` 恰一次；§3.6 chat→responses 将 `[DONE]` 仅作终止信号消费、绝不外泄——首尾相接语义闭合。
- thinking 链：`thinking_delta` → `delta.reasoning_content` → `response.reasoning_summary_text.delta`，三段各有既有映射。

**已知接缝语义（测试锁定，属预期行为非缺陷）**：anthropic 上游流内 `error` 事件 → chat 终止 chunk（`finish_reason:"stop"`）→ responses 侧以 `response.completed` 健康收尾（内容截断）——遵循「流已 200 无法改状态码，显式终止优于悬挂，不上报假失败」哲学。反向（responses 上游 error → anthropic 客户端）的终止形态实现阶段核对并同款锁定。

## 5. usage 有损口径（决策 D6，如实声明）

- anthropic 上游服务 responses 客户端：`input + cache_read + cache_creation` 折入 chat `prompt_tokens` 总量 → responses `input_tokens`；cache_read 经 `prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens` 存活；**cache_creation 折入总量后不再单独可分**（此路径 `usage_logs.cache_creation_tokens` = NULL，客户端可见口径为总量）。
- responses 上游服务 anthropic 客户端：继承「openai→anthropic 无法精确拆分，不做」既有惯例，无新增口径。
- 测试锚：`parseUsageFromSse` prompt > 0（AC3）。

## 6. 兼容性与行为变更面（决策 D8）

- 16 格路由矩阵仅 2 格变化（responses×anthropic、anthropic×responses：不合格 → 可选目标），14 格逐字节不变（测试锁定）。
- 客户端可见变更：原 503 `no_available_channels` 的请求组合现在成功但降级（有损转换）——**用户拍板接受（2026-10-27，无开关，见 prd R6）**。
- 回滚形态：纯代码 revert 路由常量即恢复旧行为（503），零配置态 / 数据面残留——无开关方案在此维度上是三选一中最干净的。

## 7. 权衡记录

- **D2 无开关 vs settings 开关 vs 渠道级开关**：与既有 6 条转换边同构、少一条 settings 全链路、回滚最干净——用户拍板（2026-10-27）。
- **D3 组合函数归属 format-converter.ts vs 独立 format-pivot.ts**：转换知识集中是该文件既有惯例（spec format-conversion.md 的消费契约按文件组织），少一层 import；独立模块收益（小文件易测）被纯函数直调测试模式覆盖，不成立。流式不设组合 helper——pipeThrough 串联在接线点表达更直白，且现有 transform 接线就是调用点内联形态。
- **直连转换器**：明确不做——重叠概念 chat 全有等价物，有损字段目标协议本无承载（prd Background 已论证），增量收益趋近零。
