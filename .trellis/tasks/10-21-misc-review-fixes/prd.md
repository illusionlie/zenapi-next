# 评审杂项：debug 日志回退死代码 / 管理台读缓存 / 冷却衰减

三个互不相关的小修，独立可验，合一个轻量任务。AGENTS.md §8 文档漂移修正不在此处
（由父任务 finish 阶段的 docs(spec) 提交统一做）。

## F1：debug 请求日志 text 回退死代码

**缺陷**：apps/worker/src/index.ts:57-71。`raw.json()` 按 Fetch 规范先 text 后
JSON.parse，parse 失败时 body 已被消费；随后同一 clone 上 `raw.text()` 必抛
`Body is unusable` → 落入内层 catch，`bodyType` 恒为 `"unreadable"`。开关打开后，
非 JSON body（纯文本/表单——恰是排查 bad request 最想看的）永远拿不到 body_size。

**要求**：一次 `raw.text()` 读全量，再自行 `JSON.parse`：成功 → bodyType "json" +
body_keys；失败 → bodyType "text" + body_size = text.length。流本身读失败（极罕见）
才 "unreadable"。默认零解析路径（flag off）不动。

**验收**：非 JSON body + flag on → `body_type: "text"`、`body_size` 正确；JSON body 行为
不变；flag off 零 clone（既有 clone 计数锚点测试保持通过）。

## F2：管理台 GET 读 debug flag 绕 30s 缓存

**缺陷**：routes/settings.ts 的 GET `/api/settings` 里 `debug_request_body_log` 经
30s TTL 缓存读取（loadDebugLogFlag），而同表单的 proxyRetryConfig 用未缓存读取
（"admin form truth" 惯例，proxy-settings-cache.test.ts:120-132 有锚点）。管理员 PUT
开启后同 isolate 立即 GET 会看到 false——「保存失败？」错觉，且同表单两字段陈旧度不一致。

**要求**：管理台 GET 的 debug flag 改走未缓存的原始读（与 retry 配置同姿态）；`/v1`
热路径中间件的 loadDebugLogFlag 缓存路径不动。

**验收**：PUT → 同请求上下文 GET 返回新值（fake db 直读断言，不经缓存注册表）；
proxy-settings-cache.test.ts 中「retry 不缓存」锚点不破坏。

## F3：渠道冷却 streak 时间衰减

**缺陷**：services/channel-cooldown.ts:48-57。`consecutiveFailures` 只被成功清零、
永不过期——「连续 3 次失败」实际是「isolate 生命周期内累计 3 次」：昨天 2 次偶发 429 +
今天 1 次瞬时 502 即触发 60s 冷却，与 AGENTS §8「连续 3 次」字面不符。

**要求**：state 增加 `lastFailureAt`；`recordChannelFailure` 在 `now - lastFailureAt >
COOLDOWN_STREAK_RESET_MS`（新导出常量，默认 5 分钟）时把 streak 重置为 1（视为新 streak）。
衰减窗口独立于 60s 冷却窗。fail-open、每请求每渠道至多记 1 次、成功清零等既有语义不动。

**验收**：注入 now 的确定性单测——间隔 4 分钟的 3 次失败不触发冷却；间隔 6 分钟后第 3 次
失败重新计数；窗口内 3 连败仍正常触发。既有 channel-cooldown 测试全绿。

## 全局验收

- [ ] 三项各自验收全过。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不动 TTL 缓存本体（utils/cache.ts）与 env.DB 同一性假设（评审 W2 另案跟踪，不在本树）。
- 不动 /v1/models 直查（评审 S3，疑似刻意）。
