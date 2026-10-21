# verification：评审杂项三修复

日期：2026-10-21。实现：trellis-implement 子代理；复核：trellis-check 子代理 + 主会话抽查核心 diff（index.ts 解析路径 / channel-cooldown 衰减）。

## 结论：可提交（三项全过）

- **F1 debug 日志回退**：一次 `raw.text()` + 自行 `JSON.parse`（json() 会消费 body，旧内层 text() 回退是死代码）。非 JSON body → `body_type:"text"` + 真实 `body_size`；JSON body 形态不变（body_size 保持 0）；仅流读失败才 "unreadable"；flag off 零 clone 锚点未破坏。附预期行为变化：空 body 从 "unreadable" 变 "text"+size 0。
- **F2 管理台读缓存**：新增 `loadDebugLogFlagDirect`（readSettingsRawMap + resolveDebugLogFlag，零缓存注册表），GET /api/settings 改用它（与 proxyRetryConfig 同「admin form truth」姿态）；index.ts 热路径缓存的 loadDebugLogFlag 零改动。防退化测试真实有效（预热陈旧缓存 → PUT → 同绑定 GET 立即见新值）。
- **F3 冷却衰减**：`COOLDOWN_STREAK_RESET_MS = 300_000` 导出；`lastFailureAt` 越窗（严格 >）streak 重置为 1。推演确认不可能误清活跃冷却窗（活跃期内失败间隔必 < 60s < 300s）；below-threshold 存活守卫、fail-open、每请求每渠道至多 1 次、成功清零全部未动。
- **确定性**：channel-cooldown + debug-request-log 连跑 3 次 43/43 完全一致；全部注入 now。
- **门禁**：check 0 error（23 warnings 存量）、typecheck exit 0、vitest 31 文件 611 用例全绿。
- **越界**：utils/cache.ts、/v1/models、AGENTS.md、TTL 缓存本体零触碰；既有断言零更新。

## PRD 订正记录

F3 验收第一行原稿「间隔 4 分钟的 3 次失败不触发冷却」与 5 分钟衰减窗公式矛盾（240s < 300s 未越界，仍属同一 streak、应触发）。按公式为准实现，PRD 已于 2026-10-21 加订正注记；对应测试用例（4 分钟间隔照常触发 / 6 分钟越窗重置 / 严格边界不重置）注释中记录了该裁定。

## AGENTS/spec 同步项（父任务 docs(spec) 收口）

- §8 冷却条目：streak 时间衰减语义（5 分钟窗）。
- §8 入口日志条目：text 形态真实可用（不再恒 unreadable）。
- logging-guidelines / settings-config 若提及 debug 日志两态或管理台读取姿态，同步核对。
