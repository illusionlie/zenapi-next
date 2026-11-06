# Implement — stats_retention_days

> 轻量任务（PRD + 本清单，无 design.md）：单一 settings 键全链路，照抄既有模式，无架构决策。

## 顺序清单

1. `apps/worker/src/services/settings.ts`：新增 `STATS_RETENTION_KEY = "stats_retention_days"`、默认值常量 180、`getStatsRetentionDays`（镜像 `getRetentionDays` :81-96：`readSetting` + 数值解析回退默认）。
2. `apps/worker/src/services/usage-stats.ts`：
   - `runDailyMaintenance` rollup 清理段（:495-509）cutoff 改用 `await getStatsRetentionDays(db)`；
   - `ROLLUP_RETENTION_DAYS`（:19）处置：先 `grep -rn "ROLLUP_RETENTION_DAYS"`（含 tests），无外部引用则改名 `DEFAULT_STATS_RETENTION_DAYS` 挪至 settings.ts；有引用则原地保名并注释"默认值语义"。
3. `apps/worker/src/routes/settings.ts`：
   - GET（:92-156 段）直读新键并入响应（邻接 `log_retention_days`）；
   - PUT 新增分支（镜像 :181-188）：整数 1–365 校验，非法 400 `invalid_stats_retention_days`。
4. `apps/worker/src/routes/backup.ts`：`BACKUP_SETTINGS_EXPORT_KEYS`（:44）加入 `stats_retention_days`（注意须在 GET 暴露之后导出才非空）。
5. UI `apps/ui/src/features/SettingsView.tsx`：「统计保留天数」字段 + 帮助文案（邻接 :263-277 日志保留天数）；settings 表单类型/默认值随现有 `log_retention_days` 字段模式补齐（含 `apps/ui/src/core/` 下类型定义如有）。
6. 测试（`tests/`）：
   - `usage-stats.test.ts`：新增"runDailyMaintenance rollup 清理读设置值 / 未设置默认 180"用例（对照既有 retention 用例的 mock db 形态）；
   - settings PUT 校验用例（对照 `developer-role-setting.test.ts` / `proxy-retry-settings.test.ts` 的请求形态）；
   - `backup-restore.test.ts`：导出形状断言加新键（23→24），不降既有断言。
7. 文档（Phase 3 spec update 阶段做）：AGENTS.md §8「用量预聚合与维护」rollup 180d 表述、§10 settings 表键清单同步。

## 验证命令

```bash
bun run check
bun run typecheck
bun run test
```

## 风险点与回滚

- 全部触点为增量（新键 / 新分支 / 新字段），不改任何既有行为路径 → 回滚 = revert 单提交。
- 新键**不**入 `PROXY_SETTING_KEYS`（cron 冷路径，无缓存需求）；勿顺手加进 `loadProxySettingsCached` 缓存链。
- `backup-restore.test.ts` / `proxy-settings-cache.test.ts` 等既有断言若被新键波及，更新断言而非删除检查。
