# implement：cron 维护链规模加固与 rollup 自愈

前置：子任务 10-21-splitwindow-subday 已完成并提交（本任务与其同文件，顺序执行）。
`git status --short` 干净后再开工。测试一律 `bunx vitest run`（禁 watch / dev / wrangler 长驻进程）。

## 步骤

1. [ ] `services/usage-stats.ts`：
   - 导出 `RETENTION_CHUNK_ROWS = 5000`、`RETENTION_MAX_ROUNDS = 180`；
     `pruneUsageLogsBatched` 改 opts 形参 + `{deleted, complete}` 返回（design.md 签名）。
   - 新增 `rollupRecentMissing(db, now, lookbackDays=7)`（探测-缺补-逐日容错）。
   - `runDailyMaintenance` 第 1 步换成 rollupRecentMissing（含 yesterday）；retention 步
     日志带 `{deleted, complete}`，incomplete 时升级为 console.warn。
   - 新增 `retentionCutoffIso(now, days)`；`rollupMissingDates` 重写为 MIN+DISTINCT 差集。
2. [ ] `routes/usage.ts`：prune 端点改用 `retentionCutoffIso` + 有界返回；响应体
   `{ deleted, complete }`；cutoff 本地时区 `setDate` 运算删除。
3. [ ] `tests/usage-stats.test.ts`：design.md 测试设计 1–7 节用例；既有 number 断言与
   链形态断言更新 → **在此逐条列出**：
   - (实现时填写)
4. [ ] grep 验证：`substr(created_at` 在 usage-stats.ts 中零残留。
5. [ ] 门禁：`bun run check` → `bun run typecheck` → `bunx vitest run`。

## 验证命令

```bash
bunx vitest run tests/usage-stats.test.ts
bun run check && bun run typecheck && bunx vitest run
```

## 完成判据

- prd.md Acceptance Criteria 全勾（含查询预算表静态核算）。
- runDailyMaintenance 集成测试覆盖「缺 2 天补 2 天 + retention incomplete」复合场景。

## 回滚点

- 单 feat commit revert；无迁移无数据变化。
