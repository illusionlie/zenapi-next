# usage_stats_daily 统计保留期可配置（stats_retention_days）

## Goal / 用户价值

管理台可配置统计聚合表 `usage_stats_daily` 的保留期。当前 rollup 保留期硬编码 180 天，与 `log_retention_days`（原始明细日志清理）完全独立，站长无从感知——生产实例（retention=10）出现"明细已删、仪表盘仍显示 10-15 起的幽灵统计"的双轨陷阱。本任务把 rollup 保留期变成可见可控的设置项，站长设小即让统计随数据一起消失（复刻 `46e3d8c` 大改前行为）。

## Background（诊断证据，2026-11-06）

- 生产实锤（只读查询）：`settings.log_retention_days = 10`；`usage_logs` 最早行 2026-10-27（= 今日−10，**原始日志清理正常**）；`usage_stats_daily` 最早行 **2026-10-15**（82 行）——仪表盘看到的正是这张表。
- rollup 保留期硬编码：`apps/worker/src/services/usage-stats.ts:19` `ROLLUP_RETENTION_DAYS = 180`；`pruneRollup`（`:433`）由每日 cron `runDailyMaintenance` 调用（`:502-504`），cutoff 与 `log_retention_days` 零关联；migration 0026 注释明写"保留期独立 180 天"。
- 仪表盘无参全史窗口：`apps/ui/src/AdminApp.tsx:200` 调 `/api/dashboard` 不带参数 → `splitWindow(null, null)`（`usage-stats.ts:88-139`）得 `rollupFrom=""` 匹配全表；按日表截最近 30 行（`:697`）。用户端 `/api/u/dashboard` 同构。
- 行为分界点：`46e3d8c`（2026-10-20）usage_stats_daily 预聚合大改。大改前仪表盘直查 `usage_logs`，窗口天然被保留天数截住。
- 用户拍板（2026-11-06）：选方案"新增 `stats_retention_days` 设置"（数据真删、语义诚实）；否决"仅 clamp 展示窗口"（库里与展示不一致，模型广场 30d 等其他 rollup 消费端点仍会显示旧统计）与"保持现状"。

## Requirements

### R1 settings 键 `stats_retention_days`（数值天数）

- 默认 **180**：未设置/脏值回退默认，不设置该键时全系统行为与现状逐字节一致。
- getter `getStatsRetentionDays(db)` 置于 `services/settings.ts`，镜像 `getRetentionDays`（`settings.ts:81-96`）模式。
- GET `/api/settings` 直读暴露表单真值（`routes/settings.ts` GET 段，邻接 `log_retention_days` 的 `:92`/`:130`）。
- PUT 严格校验：正整数 **1–365**，非法（非整数 / 越界）→ 400 `invalid_stats_retention_days`，镜像 `:181-188` 的 `invalid_log_retention_days` 分支写法。

### R2 每日 cron 清理跟随设置

- `runDailyMaintenance` 中 rollup 清理 cutoff 由 `addUtcDays(todayUtc, -ROLLUP_RETENTION_DAYS)`（`usage-stats.ts:502-504`）改为读取 `getStatsRetentionDays` 的返回值。
- cron 冷路径直读 settings，**不**入 `PROXY_SETTING_KEYS` 缓存（与同函数内 `getRetentionDays` 既有读法一致）。
- `pruneRollup(db, cutoffDate)` 保持纯函数签名，cutoff 由调用方计算。

### R3 UI（SettingsView）

- 「日志保留天数」（`apps/ui/src/features/SettingsView.tsx:263-277`）旁新增「统计保留天数」字段，同一表单提交。
- 帮助文案点明：该值管理仪表盘历史统计的存活天数，缩短会同步截短监测页长窗口（如 30d）的历史曲线。

### R4 备份

- `BACKUP_SETTINGS_EXPORT_KEYS`（`routes/backup.ts:44`）加入 `stats_retention_days`；导出/导入 round-trip 自动保真。

### R5 测试

- cron rollup 清理按设置值删行；未设置 = 180 行为不变。
- PUT 校验矩阵（非整数 / `0` / `366` / `"abc"` → 400；`10` 成功且 GET 回显）。
- 备份导出含新键；`backup-restore.test.ts` 既有导出形状断言同步更新，**不降断言强度**。

## Acceptance Criteria

- [ ] AC1 设置 `stats_retention_days=10` 后，次日 03:17 UTC cron 删除 `stat_date < today−10` 的 rollup 行；仪表盘按日表不再出现保留期外日期。
- [ ] AC2 不设置该键时，一切行为与当前线上逐字节一致（默认 180）。
- [ ] AC3 `PUT /api/settings` 传 `"abc"` / `0` / `366` / `1.5` → 400 `invalid_stats_retention_days`；传 `10` 成功且 GET 回显 10。
- [ ] AC4 备份导出 JSON 含 `stats_retention_days`；导入后该键保留原值。
- [ ] AC5 `bun run check && bun run typecheck && bun run test` 全绿。

## Out of Scope

- 不动 `log_retention_days` 语义与原始日志清理链。
- 不动 dashboard / user dashboard 查询窗口（不加 clamp、不改 `splitWindow`）。
- 不改 monitoring / 模型广场逻辑（它们随 rollup 数据存活自然变化，无强制下限 floor）。
- 无迁移文件（settings 运行时键，与 `probe_interval_minutes` 同模式）。

## Technical Notes

- 实现模式整体照抄 `probe_interval_minutes` / `log_retention_days` 全链路，遵守 spec `settings-config.md`（读宽写严、clamp 一致）。
- `ROLLUP_RETENTION_DAYS` 常量语义收窄为"默认值"；实现时 grep 其全部引用（含 tests import）决定保名、改名或挪至 `settings.ts` 作 `DEFAULT_STATS_RETENTION_DAYS`。
