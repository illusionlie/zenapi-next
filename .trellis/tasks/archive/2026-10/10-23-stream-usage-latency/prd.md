# 流式 usage 延迟语义修复

## Goal

使用日志中流式请求（`stream = 1`）的两个延迟字段语义错位：

- `first_token_latency_ms` 的计时锚点在上游响应头到达**之后**（`utils/usage.ts:220` 的 `start` 在 `parseUsageFromSse` 被调用时才取，而调用点 `proxy.ts:1191` / `anthropic-proxy.ts:647` 都在 fetch resolve 之后），只量到「响应头 → 第一条 data: 行」的 SSE 分帧延迟，通常几毫秒，UI 渲染成 0.00s。
- `latency_ms` 在重试循环退出时取值（`proxy.ts:1072` / `anthropic-proxy.ts:563`），而流式成功路径的 `convertResponse` 只 `pipeThrough` 不消费 body（`proxy.ts:518-528` 等），因此不含流传输时长——是 TTFB 语义而非总用时。

本任务把两个字段修复为字面语义：流式 TTFT = 请求起点 → 首条 SSE data 行（用户体感，含重试/换渠道时间）；流式 `latency_ms` = 请求起点 → 流尾（完整时长）。非流式行为不变。

用户价值：使用日志与监测数据对流式请求可信，首 token 延迟可用于评估真实体感。

## Confirmed Facts（代码证据）

- 非流式 TTFT == 总用时是设计常量：`firstTokenLatencyMs ?? (isStream ? null : latencyMs)`（`proxy.ts:1084`、`proxy.ts:1131`、`anthropic-proxy.ts:576`、`anthropic-proxy.ts:636`）。保持不变。
- usage 记录任务本来就无条件读到流尾抓 usage 尾 chunk（`utils/usage.ts:237-252`），记录时序为响应后 waitUntil——本修复零新增 I/O、零性能代价。
- 生产代码中 `parseUsageFromSse` 调用方仅 `proxy.ts` 与 `anthropic-proxy.ts`；`tests/`（usage-cache / usage-responses / proxy-responses / format-converter-*）以单参数 `(response)` 直调——新参数必须可选，保持既有调用兼容。
- Workers 的 `Date.now()` 只在 I/O 边界前进；流读取是 I/O，流内取时刻可得真实时间差。

## Requirements

- R1 `parseUsageFromSse` 增加可选的请求起点时间戳参数；首个 data 行处的 TTFT 改为相对该起点计算；不传参时保持旧行为（以调用时刻为锚，供既有单测直调兼容）。
- R2 `proxy.ts` / `anthropic-proxy.ts` 流式记录路径传入各自请求起点（`proxy.ts:907` / `anthropic-proxy.ts:218` 的 `start`）。
- R3 `parseUsageFromSse` 返回值增加「起点 → 流尾」的总耗时；流式成功路径的 `latency_ms` 改用它；SSE 解析失败（现有 catch 分支）回退为现值（headers latency），TTFT 仍为 null。
- R4 非流式路径与错误路径行为不变：非流式 TTFT 恒等于 `latencyMs`；流式错误行 TTFT 为 null。
- R5 同步更新 `AGENTS.md` §8「usage 记录」条目，写明流式两字段的锚点与口径（含监控台阶：部署后流式 latency_ms 跳为含流时长，历史 rollup 行保留旧口径）。
- R6 时间锚定测试必须确定性：vitest fake timers（`vi.setSystemTime` 等）控制时钟，不依赖真实 sleep。

## Acceptance Criteria

- [ ] AC1 确定性单测：fake timers 下构造 SSE 流——请求起点 t0、首条 data 行落在 t0+500ms、流尾落在 t0+1200ms，断言 `first_token_latency_ms = 500`、流式记录用 `latency_ms = 1200`（数字由锚点公式直接推导）。
- [ ] AC2 不传起点参数的单参数旧调用：TTFT 以调用时刻为锚，行为与既有测试断言兼容（usage-cache / usage-responses 等既有用例不改断言仍绿）。
- [ ] AC3 SSE 解析失败回退：流式 catch 分支记录的 `latency_ms` 为原 headers latency 值、TTFT null（既有行为不回退）。
- [ ] AC4 非流式与错误路径零 diff：非流式 TTFT == `latencyMs` 恒等式保持。
- [ ] AC5 质量门禁全绿：`bun run check && bun run typecheck && bunx vitest run`（**禁止 watch 模式与 wrangler dev 长驻进程**）。
- [ ] AC6 `AGENTS.md` §8 usage 记录条目含新口径说明。

## Out of Scope

- 强制流式聚合路径（客户端非流式）的网关侧真实 TTFT 透出——非流式 TTFT=总用时维持设计原样（用户裁定 2026-10-23）。
- `usage_stats_daily` rollup / 监测页新旧口径桥接——接受部署日的台阶不连续，随 rollup 180d 老化自然消失。
- 前端 UI 渲染（NULL → "-"、毫秒 → 秒两位小数，均不变）。

## Key Decisions

| 决策 | 内容 | 依据 |
|------|------|------|
| D1 | TTFT 锚定**请求起点**（含重试/换渠道时间），不锚成功 fetch 的发起时刻 | 用户裁定：字段面向用户体感；渠道质量另有监测页独立统计 |
| D2 | 流式 `latency_ms` 在流尾取值；记录时序不变（响应后 waitUntil，任务本就读到流尾） | 零成本前提的确立证据 |
| D3 | 解析失败回退保留旧行为（headers latency + TTFT null） | 防御性路径，不扩大改动面 |
