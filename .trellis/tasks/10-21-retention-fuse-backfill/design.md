# design：cron 维护链规模加固与 rollup 自愈

## API 形态变化

```ts
// 旧：pruneUsageLogsBatched(db, beforeIso, chunkSize = 500): Promise<number>
// 新：
export async function pruneUsageLogsBatched(
	db: D1Database,
	beforeIso: string,
	opts: { chunkSize?: number; maxRounds?: number } = {},
): Promise<{ deleted: number; complete: boolean }>
```

- 默认 `chunkSize = 5000`、`maxRounds = 180`（导出常量 `RETENTION_CHUNK_ROWS` /
  `RETENTION_MAX_ROUNDS` 便于测试注入与日志引用）。
- 循环终止：`changes < chunkSize`（删完，complete=true）或轮数到顶（complete=false）。
- 调用方：runDailyMaintenance（日志带 complete/deleted）、routes/usage.ts prune 端点
  （响应 `{ deleted, complete }`，文档同步「未删完请重跑」）。既有测试中按 number 断言的
  用例同步改。

## cron 链重构（runDailyMaintenance）

步骤顺序不变，第 1 步从「roll 昨天」扩为「自愈扫窗」：

```ts
export async function rollupRecentMissing(
	db: D1Database,
	now: Date,
	lookbackDays = 7,
): Promise<UtcDate[]>  // 返回实际补跑的日期（空数组=无缺）
```

- 日期序列 `[today - lookbackDays, yesterday]`（含端点；today 本身不 roll——读取侧不读
  stat_date = today，次日 cron 会全量重建）。注意与既有语义对齐：rollupDate(today) 并非
  非法，只是无意义写放大，扫窗排除。
- 逐日：`SELECT 1 FROM usage_stats_daily WHERE stat_date = ? LIMIT 1`（走
  `usage_stats_daily_date` 索引）→ 无行才 rollupDate(date)；单日 try/catch，
  `[rollup] backfill failed` 按日打日志，不阻断其余日。
- 链首日志：`[rollup] backfill scan done` { scanned, missing, rolled }。
- 防丢守卫不变：raw 已清且 rollup 存在的日期，probe 命中 → 跳过，天然兼容。

## 查询预算表（Paid 1000 / Free 50 每调用上限）

| 步骤 | 最少 | 最坏（7 天全缺 + retention 满轮） |
|------|------|------|
| backfill 探测 | 7 | 7 |
| backfill rollupDate（COUNT×2 + batch×2） | 0 | 4×7 = 28 |
| retention settings 读取 | 1 | 1 |
| retention DELETE 轮 | ≤180 | 180 |
| sessions DELETE | 2 | 2 |
| rollup 180d DELETE | 1 | 1 |
| **合计** | ~11 | **~219** |

最坏 219 ≪ 1000（Paid），稳态（无缺、retention 正常量）≈ 15–25 条。Free 计划（50 条）
下 maxRounds 仍超限——**接受**：Free 计划本不适合大流量生产，超限时步骤级 try/catch 兜住，
次日重入继续（与现状同姿态，但能力上限从 2.1 万行/日提到 24 万行/日：45 轮 × 5000）。

## cutoff 统一

```ts
// services/usage-stats.ts 导出
export function retentionCutoffIso(now: Date, retentionDays: number): string {
	return new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
}
```

- routes/usage.ts 的 `setDate` 本地时区运算删除，改调此 helper；getRetentionDays 读取
  不动（settings 三级回退链语义保持）。

## rollupMissingDates 重写

```sql
SELECT MIN(created_at) AS m FROM usage_logs;                       -- 索引探底 1 行
SELECT DISTINCT stat_date FROM usage_stats_daily;                  -- 小表 ≤180 行
```

JS 侧：raw 有行时枚举 `[utcDateOf(min), yesterday]` 日期序列，减去 DISTINCT 集，得缺集。
raw 空表 → 返回 []。`rollupBackfill`（手动全量回填端点用）继续消费此函数，行为不变、
代价从全表扫降为 O(days)。

## 测试设计（全部注入 now / 注入 opts）

1. 保险丝：chunk=10、maxRounds=2、35 行残留 → {deleted:20, complete:false}；chunk=10、
   maxRounds=5、35 行 → {deleted:35, complete:true}。
2. 自愈扫窗：7 天序列中 2 天无 rollup 行 → 恰好 rollupDate 两次；有行日期零写调用
   （fake db 断言 batch 未被调用）。
3. 单日失败容错：第 1 缺日 rollupDate 抛错 → 第 2 缺日仍执行，错误日志按日。
4. 端点：prune 响应含 complete；incomplete 时不抛 500。
5. cutoff helper：now 固定、retentionDays=30 → 断言输出 ISO（与本地时区无关——测试机
   TZ 变化不影响，直接断言字符串）。
6. rollupMissingDates：min=3 天前、rollup 缺中间 1 天 → 恰好返回该日；raw 空 → []。
7. 回归：runDailyMaintenance 集成用例（既有）更新为新城建形态（backfill 扫描日志、
   {deleted, complete} 返回）。

## 风险与回滚

- chunk 5000 的单语句时长：DELETE ... rowid IN (子查询 LIMIT 5000) 有界，索引扫描 +
  5000 行删除远低于 30s；若真实环境仍慢，opts 可注入调小，无需改代码。
- 返回值形状变化是破坏性内部 API 变更：调用点仅 2 处（cron + prune 端点）+ 测试，一次改齐。
- 回滚 = revert 单 feat commit；无迁移。
