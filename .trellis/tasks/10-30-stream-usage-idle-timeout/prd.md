# 流式 usage 解析闲置超时兜底（修复 waitUntil 取消丢行）

## 背景（Goal）

2026-10-26 起线上（10-26 批次部署后）出现系统性 usage 丢行：

- CF Workers Logs 对成功流式 `/v1/chat/completions` 请求打 warn：
  `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled`
- D1 `usage_logs` 对应日期行数骤减（10-28 零行、10-30 用户测试请求几乎全丢），
  `[usage] billing batch failed` 零命中 —— 计费 batch 从未执行，不是 D1 失败。
- CF dashboard 错误率 0（主请求全部成功返回），429 限流未触发（token_rpm_default=50
  但流量远低于阈值）—— 丢的全是成功流式请求的记录行。

根因：流式 usage 记录任务链 `parseUsageFromSse(lastResponse.clone())` → `recordFn`
→ D1 batch 整体跑在 `ctx.waitUntil` 域（10-20 `50f4ad6` 热路径优化引入，TTFB 动机）；
`parseUsageFromSse`（`apps/worker/src/utils/usage.ts`）主循环
`while (true) { await reader.read() }` **无任何超时保护**。客户端渲染完主动断开后，
clone 分支的 `read()` 在部分断开路径上永远 pending → 任务链卡在第一步 →
waitUntil 窗口（~30s）耗尽被 CF 取消 → warn + 该行 usage 静默丢失。

该机制自 10-20 就存在，10-26 批次部署后才系统性爆发；触发器（CF 平台流生命周期
行为变化 / 401 换 key 改变上游分布）无法从代码侧钉死，不影响修复方案。

## 需求（Requirements）

给 `parseUsageFromSse` 的流读取加两层有界保护，使记录任务永远在 waitUntil 窗口内
自行结束：

1. **终止事件提前返回**：读到 OpenAI 形态的 `data: [DONE]` 行后立即结束解析并返回
   （OpenAI SSE 语义 [DONE] 之后无数据；不依赖上游是否规范关闭连接）。
   Anthropic 形态无 [DONE]，自然落到第 2 层。
2. **闲置超时（idle timeout）**：单次 `reader.read()` 无新数据超过 **20s** 视为流
   终止，break 出循环，按已收到的数据正常返回。20s 的依据：waitUntil 窗口 ~30s，
   须为后续 D1 batch 留出时间；read 到数据即重置计时（是闲置超时，非总时长超时）。

### 明确的行为口径

- 正常完成的流零行为变化：正常流 read 间隔远小于 20s；[DONE] 后本就无数据。
- 长思考模型（思考期 >20s 无任何 SSE 数据的极端慢流）：记录侧解析提前终止，
  usage 记录可能不完整（行仍落库，调用方既有 fallback 兜底）—— 与现状「流中途
  断则整行丢失」相比是严格改善，可接受，如实声明不掩盖。
- TTFT / elapsedMs 口径不变：elapsed 仍为「锚点 → 实际读到的流尾」。
- 两个调用方（`proxy.ts` / `anthropic-proxy.ts`）零改动即受益，不新增分支。

## 非目标

- `stream-aggregate.ts`（伪装预设强制流聚合，响应侧）的同类上游挂起风险不在本
  任务 —— 那是客户端可见行为域，另案评估。
- 不退回同步 await 计费（会牺牲全体请求 TTFB）。
- 不引入 request-signal abort 快速路径（Workers 响应返回后的 abort 语义需单独
  实测验证，超出「一处修复」范围）。

## 验收标准（Acceptance Criteria）

- [ ] `parseUsageFromSse` 收到 `[DONE]` 行后立即返回，不等流关闭（测试：ReadableStream
  发 [DONE] 后永不关闭，解析即时完成且 usage 正确）。
- [ ] 流永不发数据/发一半后挂死时，闲置超时后返回已收数据（测试用可注入的短超时，
  不真等 20s）。
- [ ] 现有全部测试绿（`bun run test`），`bun run check`、`bun run typecheck` 通过。
- [ ] 超时值集中为常量，两调用方共享默认值，无需各自配置。
- [ ] AGENTS.md §8 usage 记录条目同步一句口径（闲置超时兜底 + [DONE] 提前返回）。

## 实现锚点（Notes）

- `apps/worker/src/utils/usage.ts` — `parseUsageFromSse`（唯一改动函数）+ 常量
- `apps/worker/src/routes/proxy.ts:1325` / `anthropic-proxy.ts:931` — 仅验证零改动
- 测试：`tests/` 下既有 usage 解析测试就近补用例，无则新建
  `tests/stream-usage-idle-timeout.test.ts`；超时参数建议加可选 opts 入参
  （缺省 20s 常量），既保两调用方零改动，又让测试可控。
