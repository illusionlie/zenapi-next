# implement：cron 维护链规模加固与 rollup 自愈

前置：子任务 10-21-splitwindow-subday 已完成并提交（本任务与其同文件，顺序执行）。
`git status --short` 干净后再开工。测试一律 `bunx vitest run`（禁 watch / dev / wrangler 长驻进程）。

## 步骤

1. [x] `services/usage-stats.ts`：
   - 导出 `RETENTION_CHUNK_ROWS = 5000`、`RETENTION_MAX_ROUNDS = 180`；
     `pruneUsageLogsBatched` 改 opts 形参 + `{deleted, complete}` 返回（design.md 签名）。
   - 新增 `rollupRecentMissing(db, now, lookbackDays=7)`（探测-缺补-逐日容错）。
   - `runDailyMaintenance` 第 1 步换成 rollupRecentMissing（含 yesterday）；retention 步
     日志带 `{deleted, complete}`，incomplete 时升级为 console.warn。
   - 新增 `retentionCutoffIso(now, days)`；`rollupMissingDates` 重写为 MIN+DISTINCT 差集。
2. [x] `routes/usage.ts`：prune 端点改用 `retentionCutoffIso` + 有界返回；响应体
   `{ deleted, complete }`；cutoff 本地时区 `setDate` 运算删除。
   （附带：`services/usage.ts pruneUsageLogs` 是 design 未列出的第 3 个调用点，
   同批适配返回形状并把它的 `setDate` 运算换成同一 helper。）
3. [x] `tests/usage-stats.test.ts`：design.md 测试设计 1–7 节用例；既有 number 断言与
   链形态断言更新 → 逐条清单：
   - `pruneUsageLogsBatched > "deletes only old rows..."`：第 3 实参 `3` → `{ chunkSize: 3 }`；
     `expect(deleted).toBe(7)` → `toEqual({deleted: 7, complete: true})`；重跑 `.toBe(0)` →
     `toEqual({deleted: 0, complete: true})`；种子/cutoff 从 `Date.now()` 相对值改为固定
     `now = 2026-10-20T03:17:00.000Z` 派生。
   - `pruneUsageLogsBatched > "deletes everything in one batch..."`：`500` → `{ chunkSize: 500 }`；
     `.toBe(5)` → `toEqual({deleted: 5, complete: true})`；固定时钟同上。
   - `runDailyMaintenance > "rolls up yesterday, ..."`（更名 "backfills yesterday via the
     scan window, ..."）：真实时钟 → 固定 `2026-10-20T03:17:00.000Z`；40 天前旧行改为字面
     `2026-09-10T12:00:00.000Z`；四项状态断言（昨日 rollup 1 行 / logs 剩 1 / sessions 0 /
     -200d rollup 0）保持原值，扫窗语义下仍通过。
   - `runDailyMaintenance > "keeps running the remaining steps when one step fails"`：零改动
     通过（probe 读失败冒泡维持 `"[rollup] daily rollup failed"` 断言）。
   - `dashboard endpoint > "POST /rollup ... backfills when empty"`：`{ rolled: [today] }` →
     `{ rolled: [addUtcDays(today, -1)] }`（rollupMissingDates 新语义：today 排除 +
     [min, yesterday] 区间空洞日入缺集）。
4. [x] grep 验证：`substr(created_at` 在 usage-stats.ts 中零残留——rollupMissingDates 区块
   零命中 ✓；文件余 3 处均为读取端 day/slot 桶分组（loadDashboardDaily raw 段、两处
   slotExpr，范围过滤后聚合、非维护链、无全表扫），不在 R5 范围。
5. [x] 门禁：`bun run check`（0 error）→ `bun run typecheck`（0 error）→
   `bunx vitest run`（31 文件 / 597 用例全绿）。

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
