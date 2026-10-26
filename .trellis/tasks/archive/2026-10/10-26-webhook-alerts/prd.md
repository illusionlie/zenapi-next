# Webhook 出站通知与故障报警

## Goal

ZenAPI 零出站通知：渠道挂了只能等用户撞上来或管理员刷监测页。本任务建立 Webhook
通知通道，**以故障报警为主**（报警延迟 ≤ 数分钟），用量日报为可选开关。参照
ai-relay 的适配器形态，但避开它的坑（sender 未接线 / 无去重静默）。

复杂任务：`task.py start` 前需补 `design.md` + `implement.md`。

## Requirements

- **R1 存储**：新表 `webhooks`（id, name, type, url, enabled, created_at, …），
  `type ∈ {feishu, wecom, dingtalk, slack, generic}`；迁移 + schema.sql；告警阈值
  与开关存 settings（design 定键名清单）。
- **R2 适配器**：五类型 `send()` 纯函数（飞书自定义机器人 / 企微群机器人 / 钉钉
  机器人 / Slack incoming webhook / generic 原样 POST JSON）；统一消息结构
  `{title, lines[], severity, ts}` 各适配器自行排版；管理台「测试」按钮构造样例
  消息真实发送并回报结果。
- **R3 故障报警（核心）**：
  - 评估周期 ≤ 数分钟：wrangler.toml `[triggers]` 增加 cron 项（如 `*/5`，与既有
    `03:17` 维护错峰共存），评估器算近期窗口（如 15 分钟）各渠道**失败率**（数据源
    design 定：近期 usage_logs 聚合 vs 监测口径复用）；
  - 触发条件（settings 可配）：渠道失败率 ≥ 阈值（默认 50%，样本量下限防误报，
  如 ≥5 请求）；渠道进入冷却事件可选开关；
  - **去重 / 静默窗口**：同渠道同类型报警在静默期（默认 30 分钟，可配）内不重复
    发（isolate 内存 + settings 时间戳兜底，design 定一致性方案）；
  - 恢复通知可选（渠道失败率回落 + 冷静期后发「已恢复」）；
  - 发送 `Promise.allSettled` 并发，单个失败只记日志，无重试队列。
- **R4 用量日报（可选开关）**：并入既有 03:17 cron——聚合昨日 rollup（全站与
  top 渠道 / 模型的请求量、tokens、消费额、错误率）推送；默认关。
- **R5 UI（管理台）**：webhooks CRUD + 测试按钮 + 阈值 / 静默期 / 日报开关设置。
- **R6 测试**：适配器各类型 payload 形状（fetch mock 断言 URL / body）；失败率
  达阈值触发且静默期内去重；样本量不足不触发；cron 多条目与 03:17 维护链不互扰。

## Acceptance Criteria

- [ ] 渠道失败率超阈值 → 所有 enabled webhook 收到含渠道名 / 指标 / 时间的报警；
      静默期内同渠道不重复。
- [ ] 测试按钮真实送达（本地飞书 / 企微 webhook 验证）。
- [ ] 新增 cron 不影响既有 03:17 维护链（rollup / retention 不回归）。
- [ ] 默认配置（无 webhook）下零行为变化。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不做 request 级事件推送（每次失败推送一类）。
- 不做重试 / 死信队列 / 消息积压。
- 不做用户端（余额 / 额度）通知。
