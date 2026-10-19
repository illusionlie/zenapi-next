# 验证记录 — P2 用量预聚合与保留策略 cron 化

> 2026-10-19 trellis-implement 阶段产出。门禁、迁移、查询计划、数值一致性说明、偏离记录如下。

## 1. 门禁（bun run check && bun run typecheck && bunx vitest run）

```
$ bun run check
Checked 148 files in 204ms. Fixed 8 files.   ← 自动修复为 import 排序/格式，全在本次改动文件
Found 23 warnings.   ← 与 P0 基线完全同集（styles.css / .pi/extensions / channel-route.ts / models.ts / ModelsView.tsx 存量告警），0 error

$ bun run typecheck
$ bunx --bun tsc --noEmit    ← 退出码 0

$ bunx vitest run
 Test Files  28 passed (28)
      Tests  543 passed (543)   ← 基线 518 + 新增 tests/usage-stats.test.ts 25 用例（含 check 复核后补的 2 条防丢守卫用例）
```

## 2. 迁移应用（bun run --filter api-worker db:migrate）

本地 D1 应用 0026 成功（4 commands = 1 表 + 2 索引 + d1_migrations 登记）：

```
│ 0026_usage_stats_daily.sql │ ✅ │
api-worker db:migrate: 🚣 4 commands executed successfully.
```

## 3. EXPLAIN QUERY PLAN（bunx wrangler d1 execute DB --local，两种 rollup 读形态）

```
-- 管理端/监测端 stat_date 范围聚合：
"SEARCH usage_stats_daily USING INDEX usage_stats_daily_date (stat_date>? AND stat_date<?)"

-- 用户端 per-user 聚合（冗余 user_id 列，无 JOIN tokens）：
"SEARCH usage_stats_daily USING INDEX usage_stats_daily_user_date (user_id=? AND stat_date>? AND stat_date<?)"
```

均 SEARCH 走索引、无 SCAN；raw 段只扫当日（复用 P0 的 `usage_logs_created_at` 索引）。30d 大窗口聚合不再全表扫 usage_logs 原始行（代码审查：四处端点的 past-day 查询全部走 `usage_stats_daily`，原始行查询仅剩当日段与 15 分钟实时段）。

## 4. 测试基建说明（偏离 dispatch 预案 B，而非 getPlatformProxy）

未尝试 workerd/getPlatformProxy，直接采用 **node:sqlite（Node 24 内建、真 SQLite 引擎）+ 手写 D1 适配器**（prepare/bind/run/all/first/batch + BEGIN/COMMIT 事务，`meta.changes` 直通）。覆盖了全部关键语义：rollup 的 GROUP BY / LEFT JOIN / COALESCE / `lower(hex(randomblob(16)))`、DELETE-INSERT 幂等、batch 原子性、prune 的 `rowid IN ... LIMIT` 循环终止、`changes < chunkSize` 判定。比「组装 SQL 断言」更强，比 workerd 稳定。splitWindow 用注入 `now` 参数（`splitWindow(from, to, now?)`）替代 fake timers，纯函数直接断言。

## 5. 聚合端点切换前后数值一致性（核心验收说明）

**分段不相交是等价性的基础**：rollup 段只含 `stat_date <= yesterday` 的完整日，raw 段只含 `created_at >= 今日零点`，并集无重叠、无遗漏。

- **日对齐窗口精确相等**（测试锚点，`tests/usage-stats.test.ts`）：同一批数据 rollup 后，`loadDashboardSummary` 两段并集与 raw 直查 legacy SQL 的 total_requests / total_tokens / cached_tokens / cache_prompt_base / total_errors 逐项相等；dashboard 路由端到端（经 `dashboardRoutes.request`）同样锚定。byDay / byModel / byToken / byChannel 两段按键合并后与 raw GROUP BY 语义一致（LIMIT 30/20 在 JS 合并后截断，等价旧 SQL LIMIT）。
- **NULL≠0 分母（usage-accounting §3.4）两段成立**：rollup 行新增 `cache_prompt_base` 列承载 `SUM(CASE WHEN cached IS NOT NULL THEN prompt ELSE 0)`，混合 NULL 行数据下 rollup 段 summary 的 cached/base 与 raw 直查相等（测试断言 80/110 精确值），`cache_rate` 合并前后一致。
- **滚动窗口的已记录近似**（design 定稿「阈值就是日切」的直接推论）：monitoring 15m/1h/1d/7d 的滚动起点落在往日时，起点日按**整天**从 rollup 计入（legacy 按起点时刻部分计入）；当日部分仍精确。无重复计数。hour/minute 槽位的 trends 查询物理上无法从日粒度 rollup 还原，保持 raw 直查（≤7d，P0 索引覆盖，即切表前状态）。30d（唯一 acceptance 要求的窗口）trends 与全部无槽聚合均走 rollup。
- **avg_latency 口径**：legacy `AVG(latency_ms)` = SUM/COUNT(latency_ms)；`recordUsage` 恒写非 NULL latency（`?? 0`），故 COUNT(latency_ms)=COUNT(*)，新口径 `SUM(latency_ms_sum)/SUM(requests)` 等价（行数即分母）。dashboard summary 不取整保持原样，monitoring/models 的 `Math.round` 保持原样。
- **user /dashboard**：rollup 段用冗余 `user_id` 直接过滤（不再 JOIN tokens）；token 删除后历史归属**保留**（legacy JOIN 丢行）——行为改进，测试锚定。
- **usage-cache.test.ts 的 mock 定向调整**：该存量测试的 mock DB 对任意 SQL 的 `first()` 恒返同一行，两段化后 rollup/raw 各取一次导致数值翻倍。mock 改为按 SQL 是否含 `usage_stats_daily` 定向（fixture 行喂 rollup 段、raw 段返空），**断言值一字未动**（cache_rate 0.25 = 50/200 锚点保持）。

## 6. Checklist 状态（implement.md）

1. [x] 迁移 0026 + schema.sql 同步 + 本地 db:migrate 应用
2. [x] services/usage-stats.ts（rollupDate / rollupRange / rollupBackfill / pruneUsageLogsBatched / pruneExpiredSessions / pruneRollup / splitWindow / runDailyMaintenance / 10 个两段聚合 loader）；services/usage.ts 顺带清理改调 batched
3. [x] index.ts 导出 scheduled（fetch 不动，默认导出 `{ fetch: app.fetch, scheduled }`）+ wrangler.toml `[triggers] crons = ["17 3 * * *"]`
4. [x] 四处端点切换：dashboard / monitoring / models / user-api（monitoring+dashboard），两段输出列在 loader 的共享行类型上对齐（TS 结构约束）
5. [x] 手动端点：POST /api/dashboard/rollup（{date} 单日 / 空体全量缺失回填 → {rolled}）、POST /api/usage/prune（→ {deleted}），既有路由文件内追加，默认 adminAuth
6. [x] 测试 23 用例：rollup 幂等、日切边界（23:59:59.999 / 00:00:00.000）、NULL≠0、splitWindow 三分支+跨月、prune 终止/可重入、runDailyMaintenance 全链路 + 单步容错、路由并集一致性（dashboard/models/monitoring）、user 归属（含 token 删除后可追溯）
7. [ ] 文档（AGENTS §8/§10、database-guidelines、usage-accounting）— implement.md 注明 Phase 3.3 一并、本次不做

审查门自查：rollupDate 重跑无重复行（测试锚定）；四处端点输出列两段对齐（loader 行类型单点定义）；cache_rate 分母口径不变（§3.4 测试锚定）。

## 7. 与 design.md 的偏离

1. **DDL 四处（迁移 0026 头注释已写明）**：
   - `model TEXT` 可空（design 写 NOT NULL）：usage_logs.model 可空（recordUsage `model ?? null`），NOT NULL 会让含 NULL model 的 INSERT SELECT 直接违约；可空镜像列使 dashboard byModel 的 null 分组与 models.ts 的 `model IS NOT NULL` 过滤语义逐字节保持。
   - `latency_ms_sum` 替代 design 的 `first_token_latency_sum`：全部被切换端点聚合的是 `AVG(latency_ms)`；first_token_latency_ms 无任何聚合消费点（grep 证实，仅落库与行级展示），照 design 原列名实现则所有端点的 avg_latency 无法还原。
   - 增补 `cache_prompt_base`：§3.4 NULL≠0 分母是 dispatch 明示的硬验收，design DDL 缺承载列（正文称"天然成立"但列集不足以还原分母）。
   - 增补 `last_seen_at`（MAX(created_at)）：monitoring/用户监测的 last_seen 需从 rollup 还原，否则切表后历史窗口 last_seen 丢失。
2. **聚合查询下沉 services**（design 说"各端点把原单条聚合 SQL 改为两段"，未规定层次）：按「routes 薄壳 + services 下沉」规范把 10 个两段 loader 放入 services/usage-stats.ts，路由只做映射；附带收益是 loader 可脱离 Hono/鉴权直接单测（user-api 路由含 userAuth 中间件，路由级测试不可行）。
3. **pruneUsageLogs 改调 batched**（design 给了两选项，选「原函数内替换实现」）：签名 (db, retentionDays) 不变，返回值 void → number（routes/usage.ts 不消费返回值，GET 顺带清理自动获得分批语义，零调用方改动）。
4. **rollupBackfill 取代「rollupRange 全量」**：手动端点无 date 时按「有原始日志但缺 rollup 行的日期」回填（rollupMissingDates），不会重滚已回填日期，避免「retention 缩短后 cron 清掉原始日志、手动回填误删对应 rollup」的数据丢失路径；rollupRange 保留供显式区间使用。
5. **监测端点 15m/1h/1d/7d 的 hour/minute 槽 trends 保持 raw**：day 粒度 rollup 物理上无法服务细槽位，属 design「按各端点输出形态择简」的必然解；无槽聚合（渠道表/模型表/全局汇总）在这些 range 下仍走 rollup+raw。

## 8. Check 复核修复（报告 #1，Medium：rollup 防丢守卫）

`rollupDate` 的 DELETE-INSERT 在「该日原始 usage_logs 已被 retention 清空、而 usage_stats_daily 仍有该日 rollup 行」时会把统计永久删空（INSERT SELECT 无源可重建）。修复：`rollupDate` 开头加守卫——该日原始行数为 0 且已有 rollup 行时直接 no-op 返回；原始行数为 0 且无既有行则照常走 batch（写空集，行为不变）；有原始行照常重滚（幂等语义不变）。守卫对 cron / 手动单日 / 回填三条路径统一生效（回填本就只挑缺失日期，不触此守卫的破坏面）。

新增 2 条用例锁定：① 旧日期无原始行 + 有 rollup 行 → 重跑后 rollup 行仍在且数值不变；② 空 raw 且无既有行 → 照常写、不产生行。`bunx vitest run` 543/543 全绿，typecheck / biome 干净。

## 9. 遗留 / deferred to user

- **cron 运行时手验**：`bunx wrangler dev --test-scheduled`（或部署后 `wrangler triggers deploy`）触发 `__scheduled?cron=17+3+*+*+*`，观察 `[rollup]` / `[retention]` 日志四步齐发、单步失败不阻断。
- **上线顺序注记**：部署后先 `POST /api/dashboard/rollup`（空体全量回填，幂等可重跑），再等 cron 接管；缩短 `log_retention_days` 不会丢统计历史（rollup 独立保留 180d）。
- **管理台数值对比**：切表前后 dashboard/monitoring 各窗口数值对照（本地已用等价性测试锚定，生产建议抽样复核一次）。
- 已知近似（design 定稿接受）：滚动窗口跨日切时起点日按整天计入（见 §5）；同日 date-only `from=to` 参数在旧实现即返回空集，本实现保持同语义。
