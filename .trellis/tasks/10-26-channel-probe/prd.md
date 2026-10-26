# 渠道主动健康探测（默认关）

## Goal

监测页现为纯被动（真实流量统计），冷渠道挂了要等第一个用户撞上。补**主动**探测：
定时对开启探测的渠道发零成本连通性请求，历史留痕供管理员预判。维护者明确约束：
**渠道级开关默认关**（公益站 / 中转站禁测活，定时同特征流量敏感），探测仅
`GET /models`（无 prompt、零 token 消耗），**结果只展示、不参与路由裁决**。

复杂任务：`task.py start` 前需补 `design.md` + `implement.md`。

## Requirements

- **R1 渠道开关**：`channels.probe_enabled INTEGER NOT NULL DEFAULT 0`（迁移 +
  schema.sql）；渠道表单（管理台）加开关，默认关。
- **R2 调度**：wrangler.toml 增加 cron 项（如 `*/10`，与既有条目错峰共存）；每次
  取「probe_enabled=1 且到期」的渠道（`last_probe_at + interval + 抖动`，interval
  为 settings 全局值，默认 30 分钟；抖动 ±数分钟随机——降低定时特征）；复用既有
  连通性探针逻辑（`GET {resolved endpoint}/models`，逐声明格式，语义与渠道测试
  一致）。
- **R3 历史表**：新表 `channel_probes`（channel_id, checked_at, status, latency_ms,
  detail；status ∈ {healthy, degraded, down}，分类规则对齐渠道连通性测试语义，
  design 定稿）；保留清理并入既有 03:17 cron 保留链（建议 7 天）。
- **R4 展示**：监测页渠道行显示最近探测状态与近期历史（简单色条即可）；渠道详情
  可看逐次明细。
- **R5 路由隔离**：探测结果**不**进渠道候选过滤、不触发 / 退出渠道冷却、不影响
  权重——路由裁决完全留给现行被动机制（探测误杀防护，PRD 级硬约束）。
- **R6 测试**：默认全关时 cron 零网络请求零写入；开启渠道到期才探测（last_probe_at
  判定）；探针失败不触发渠道冷却（断言）；历史 7 天清理生效；多格式渠道逐格式探测
  结果合并语义与连通性测试一致。

## Acceptance Criteria

- [ ] 未开启任何渠道探测时，部署后行为与现状零差异（含 cron 日志）。
- [ ] 开启探测的渠道按 interval + 抖动出探测记录，监测页可见状态与历史。
- [ ] 人为断掉某渠道上游（测试 mock）→ 探测 down 且**渠道仍参与正常路由**。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不做对话式探测（发真实 prompt——维护者明确拒绝，公益站特征明显）。
- 不做探测结果联动路由 / 冷却（R5 硬约束）。
- 不做 per-channel 自定义 interval（全局一份 + 抖动，v1 从简）。
