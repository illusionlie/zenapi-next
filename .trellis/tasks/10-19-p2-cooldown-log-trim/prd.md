# P2：渠道冷却与请求日志减负

> 状态：PRD 已定稿；design.md / implement.md / jsonl 在本任务激活前补齐（复杂任务门槛）。
> 前置：P1（10-19-p1-hotpath-cache）归档后启动（日志开关经其缓存读取 settings）。

## Goal

给渠道选择加 isolate 级失败冷却：故障渠道在冷却窗口内不再被加权随机选中，上游故障期间不再让每个并发请求烧完 rounds×channels×keys 的失败矩阵。同时把入口日志中间件的请求体全量解析降为默认关闭（settings 开关），削掉每个请求的 CPU/内存税。

## 背景（已核实的事实）

- 无任何冷却/熔断：全库无 cooldown / circuit / 失败计数逻辑；渠道 status 仅由管理端或主动测试改写（channel-testing.ts:306-307）。坏渠道每请求以同权重参与 createWeightedOrder（services/channels.ts:11-30）。
- 重试矩阵：rounds（默认 2，上限 10）× 候选渠道 × 每渠道全部 Key 循环 + 每轮 sleep（默认 200ms，proxy.ts:815-818）——上游单渠道故障时所有并发请求重复同样失败矩阵，延迟尾巴与上游压力同时放大。
- 入口中间件对每个 POST/PUT/PATCH/DELETE clone 请求体并 await raw.json() + Object.keys + console.log（index.ts:34-61）；长对话体数百 KB，请求体被双重完整解析 + 双份内存驻留（isolate 内存上限 128MB）；叠加 hono logger（index.ts:68）。
- settings-config.md 已有新增配置项标准链路（settings→env→默认三级回退 + clamp）；P1 之后代理路径读 settings 走 30s TTL 缓存，开关读取零额外 D1 成本。

## Requirements

- **R1 渠道冷却器**（新 services/channel-cooldown.ts）：isolate 内存 `Map<channelId, { consecutiveFailures, cooldownUntil }>`；连续 3 次可重试失败（5xx / 429 / 网络错误，与 utils/retry.ts 的可重试判定同源）→ 冷却 60s；任一成功即清零该渠道计数。常量集中定义。
- **R2 接线**：重试循环的失败/成功处标记（proxy.ts、anthropic-proxy.ts；playground 可选）；渠道候选过滤在加权随机排序前剔除冷却中渠道；**fail-open**：全部候选都在冷却中时不过滤（宁可试错，不可无渠道可用）。
- **R3 边界文档化**：冷却为 isolate 本地视图（多 isolate 不共享、不精确但方向正确）；AGENTS.md §8 注记。
- **R4 入口日志开关**：body 解析与 body_keys 记录默认关闭；settings `debug_request_body_log`（布尔，标准链路）开启才解析；method/path 日志保留。开关值经 P1 的 settings 缓存读取。
- **R5 测试**：冷却计数 / 60s 过期 / 成功清零 / fail-open 单测；日志开关两态行为单测。

## 非目标

- 不做跨 isolate 一致冷却（DO/KV）、不做半开探测（half-open）与指数退避——固定 3 连败 60s 起步。
- 不改重试轮数/延迟语义本身。
- 不动 observability 采样配置（部署侧自调）。

## Acceptance Criteria

- [ ] 模拟单渠道持续 5xx：触发冷却后后续请求候选池不再含该渠道；60s 后自动回到候选池。
- [ ] fail-open：全部渠道冷却时请求仍正常路由（不提前 503）。
- [ ] 默认配置下入口中间件不再解析请求体（日志仅 method/path）；开关开启后恢复现状行为。
- [ ] 渠道成功一次即清除冷却状态（恢复渠道无需等 60s）。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 开放问题（激活 design 前定稿，不阻塞本 PRD）

- 冷却过滤的实现层级：进 `createWeightedOrder` 之前过滤候选数组，还是在排序函数内联动 → design 决。
- `debug_request_body_log` 的写入入口：直接 settings CRUD 还是管理台系统设置页加项 → design 决。
