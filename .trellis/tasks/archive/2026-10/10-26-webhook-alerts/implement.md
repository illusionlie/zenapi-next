# Implement：Webhook 出站通知与故障报警

> 顺序执行；设计依据 design.md（§0 两处裁定先读——冷却事件开关裁撤、静默用
> settings 时间戳）。

## Step 1：迁移 + 适配器 + 单测

- [ ] `migrations/0031_webhooks.sql` + schema.sql（design §1）；bun:sqlite 验证迁移
- [ ] `services/webhook-senders.ts`（design §3 五适配器 + formatMessage + 10s 超时）
- [ ] `tests/webhook-alerts.test.ts`：适配器形状 ×5 + fail-open
- 验证：`bunx vitest run tests/webhook-alerts.test.ts`

## Step 2：settings 五键 + 解析单测

- [ ] `services/settings.ts`：四数值键（两级形态 clamp，照 token_rpm_default 模式）
      + `daily_report_enabled` 严格布尔（照 normalize_developer_role 模式）；
      键常量导出；`PROXY_SETTING_KEYS` **不**加（评估器走直读，非请求热路径；
      若你裁定进缓存链需先论证读侧一致性——默认直读）
- [ ] 解析单测（clamp/脏值降默认/严格布尔）
- 验证：`bunx vitest run`（既有 settings 测试回归）

## Step 3：评估器 + 状态机测试

- [ ] `services/alerts.ts` evaluateAlerts（design §2 全语义：聚合查询/判定/静默/
      恢复滞后带/allSettled/状态键读写）
- [ ] 评估器测试（design §7 清单）
- 验证：`bunx vitest run tests/webhook-alerts.test.ts`

## Step 4：CRUD + cron 接线

- [ ] `routes/webhooks.ts` 五端点 + `index.ts` 挂载（不进放行清单）+ settings.ts
      路由 GET/PUT 增五键（GET 直读表单真相 / PUT 严格校验，照 token_rpm_default
      模式）
- [ ] wrangler.toml crons 增 `*/5 * * * *`；index.ts scheduled 按 event.cron 分发；
      runDailyMaintenance 尾部挂 maybeSendDailyReport（fault-isolated）
- [ ] cron 分发 + 日报测试
- 验证：`bunx vitest run`；`bun run typecheck`

## Step 5：UI

- [ ] `SettingsView.tsx`「通知与报警」卡片（design §6）+ `AdminApp.tsx` 接线 +
      `core/types.ts` 类型
- 验证：`bun run typecheck`

## Step 6：门禁 + 文档

- [ ] `bun run check && bun run typecheck && bunx vitest run` 三绿
- [ ] AGENTS.md：§6 路由表加 `/api/webhooks`；§8 新增「Webhook 通知与故障报警」
      bullet（评估周期/静默一致性方案/恢复滞后带/日报链尾/零 webhook 零行为）；
      §10 表清单加 webhooks
- 验证：`bun run check`

## 回滚点

Step 1-3 纯新增；Step 4 后回退 = 还原 wrangler.toml crons + scheduled 分发
（表与 settings 键留存无害）。
