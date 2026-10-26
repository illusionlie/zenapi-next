# Implement：渠道主动健康探测（默认关）

> 顺序执行；设计依据 design.md（§3 路由隔离是硬约束——探测链零耦合冷却/路由）。

## Step 1：迁移 + 调度服务 + 单测

- [ ] `migrations/0032_channel_probe.sql` + schema.sql（design §1）；bun:sqlite 验证
- [ ] `services/settings.ts`：`probe_interval_minutes` 键常量 + 解析（两级形态，
      0 = 总闸）+ setter；`routes/settings.ts` GET/PUT 接线
- [ ] `services/channel-probe.ts`（design §2 全语义：总闸/空渠道早退/抖动到期/
      并发上限 5 分批/分类/写入；复用 `fetchChannelModels`，**不 import 任何
      cooldown 模块**）
- [ ] `tests/channel-probe.test.ts`：design §6 前五条
- 验证：`bunx vitest run tests/channel-probe.test.ts`

## Step 2：cron 接线 + 保留清理

- [ ] wrangler.toml crons 增 `*/10 * * * *`；index.ts scheduled 加分支（常量模式
      照 ALERT_EVALUATION_CRON）；runDailyMaintenance 链尾加 7 天清理
      （fault-isolated）
- [ ] 测试：cron 分发 + 清理 + **路由隔离断言**（design §3/§6）
- 验证：`bunx vitest run`；`bun run typecheck`

## Step 3：渠道 CRUD 接线

- [ ] `routes/channels.ts` POST/PATCH 接 probe_enabled（严格布尔 → 0/1，缺省
      保留）；核对 channel-repo INSERT/UPDATE 列清单
- [ ] 渠道 CRUD 测试补 probe_enabled 用例
- 验证：`bunx vitest run`（渠道 CRUD 回归）

## Step 4：监测 + UI

- [ ] `routes/monitoring.ts` GET 增 probes 段（design §5 单查询 + 内存分组）；
      `MonitoringView.tsx` 色条 + tooltip；`ChannelsView.tsx` 表单开关；三个
      文件的 `core/types.ts` 类型同步
- 验证：`bun run typecheck`

## Step 5：门禁 + 文档

- [ ] `bun run check && bun run typecheck && bunx vitest run` 三绿
- [ ] AGENTS.md：§8 新增「渠道主动健康探测」bullet（默认关/总闸/抖动/分类/
      路由隔离硬约束/保留期）；§10 channels 与新表描述；§6 渠道行提探测开关
- 验证：`bun run check`

## 回滚点

Step 1-2 纯新增（回退 = 还原 crons + scheduled 分支，列/表留存无害）；
Step 3-4 独立可弃。
