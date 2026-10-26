# API 令牌过期时间（禁用不删除）

## Goal

tokens 表现无任何过期字段（`db/schema.sql:37-51`）。为令牌增加可选有效期，语义拍板：
**到期禁用（拒绝服务）而非删除，鉴权时惰性判定而非 cron 翻状态**——与现行
`status !== "active"` → 403 `token_disabled`、额度耗尽 → 402 `quota_exceeded` 的
「拒绝但行保留」模式（`middleware/tokenAuth.ts:63-78`）完全同构。

## Requirements

- **R1 迁移**：tokens 加 `expires_at TEXT NULL`（ISO-8601，与 `created_at` 同格式；
  NULL = 永久）。`schema.sql` + 编号迁移文件双写。
- **R2 鉴权惰性判定**：tokenAuth 在 status 检查后追加：`expires_at` 非空且
  `now >= expires_at` → 403 `token_expired`。不翻 status 字段（expired 是计算态、
  disabled 是意图态，语义分离）；不用 cron；`/v1/*` 与 `/anthropic/v1/*` 全域天然生效
  （含 `/v1/models`）。
- **R3 CRUD**：`/api/tokens`（管理台）与 `/api/u` 用户令牌接口支持设置 / 修改 / 清除
  `expires_at`：POST 创建可选带；PATCH 三态（undefined 保留 / null·空串清除为永久 /
  值设置），语义对齐既有额度三态编辑；校验为合法 ISO-8601 且晚于当前时刻，非法 400。
- **R4 UI（管理台 + 用户端）**：令牌列表对过期令牌显示「已过期」状态徽标（惰性计算，
  不落库），未过期的剩余时长（如 `<7d`）；编辑表单提供有效期预设（1 天 / 7 天 / 30 天 /
  自定义日期 / 永久）。已过期令牌可编辑续期（改 `expires_at` 为未来时刻立即恢复，
  验证惰性判定路径）。
- **R5 数据保持**：过期令牌行、quota 字段、usage_logs.token_id 引用全部保留；不自动
  清理、不自动删除。
- **R6 测试**：过期 → 403 `token_expired`；续期后同令牌立即可用；NULL 永久不受影响；
  迁移后存量令牌（NULL）行为零变化；PATCH 三态与非法值 400。

## Acceptance Criteria

- [ ] `expires_at` 过去的令牌请求 `/v1/chat/completions` → 403 `token_expired`，行仍在。
- [ ] 管理台把该令牌 `expires_at` 改到未来 → 立即恢复可用，无需重新创建。
- [ ] 存量令牌（expires_at 为 NULL）行为与迁移前逐字节一致。
- [ ] 两端 UI 状态与编辑路径可用；New API 兼容接口（`/api/token` 域）不受影响或同步
      兼容（以核对结论为准，见 design 备注）。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不做 HMAC 无状态签名临时 key（与计费归属冲突）。
- 不做过期令牌自动清理 cron / 定时任务。
- 不改额度耗尽语义（已是「拒绝 + 行保留」）。
