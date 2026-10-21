# verification：cron 维护链规模加固与 rollup 自愈

日期：2026-10-21。实现：trellis-implement 子代理；复核：trellis-check 子代理 + 主会话抽查核心 diff（rollupRecentMissing / prune 端点 / pruneUsageLogs）。

## 结论：可提交（7 项检查全过）

- **AC 全过**：保险丝（chunk=10/maxRounds=2/35 行 → {deleted:20, complete:false}）；7 天窗缺 2 天恰补 2 天、在场日零写（marker 行幸存断言）；单日失败容错（10-15 注入失败 → 10-18 仍补）；prune 端点 {deleted, complete}；rollupMissingDates 区块零 substr(created_at)；查询预算静态核算 219 ≤ 250；门禁全绿。
- **确定性**：`bunx vitest run tests/usage-stats.test.ts` 连跑 3 次 46/46 完全一致；新增用例全部固定 now=2026-10-20T03:17:00.000Z。
- **门禁**：check 0 error（23 warnings + 7 infos 存量）、typecheck exit 0、vitest 31 文件 597 用例全绿。
- **零改动红线守住**：rollupDate 防丢守卫与 DELETE+INSERT 幂等零触碰；getRetentionDays 三级回退零触碰；splitWindow/parseUtcIsoMs（975b3e2）零 hunk 命中；schema/migrations 无变更。

## 实现偏离（5 条，均经复核确认成立）

1. **第 3 个调用点** services/usage.ts `pruneUsageLogs`（design 称调用点仅 2 处）：同批适配 + cutoff 统一；调用方仅 GET /api/usage（返回值被忽略）。行为严格改善：该路径从 chunk=500 无界循环（可在 HTTP 请求内烧穿配额）变为 180 轮封顶。
2. `rollupMissingDates` 增加可注入 now（确定性测试要求，与文件内惯例一致）。
3. probe 读失败冒泡（表级故障不逐日重试烧查询）、写失败按日容错——分层自洽，存量容错断言零改动通过。
4. `chunkSize/maxRounds ≤ 0` → {deleted:0, complete:false}（诚实语义，测试注入触达）。
5. `substr(created_at` 残留 3 处为读取端桶分组（范围过滤后小结果集），非维护链全表扫。

## 遗留观察（非阻断，后续可选）

- GET /api/usage 列表请求仍内联跑有界 retention 删（≤182 查询）——Free 计划（50 上限）可能超限；可后续把读路径内联 prune 摘除（cron 已覆盖）。
- 自愈窗 7 天，>7 天缺口依赖手动 POST /api/dashboard/rollup 全量回填（design 明示分工）。

## AGENTS/spec 同步项（父任务 docs(spec) 收口）

- §8 预聚合条目：chunk 5000 + 180 轮保险丝 + 近 7 天自愈补漏 + prune 端点 complete 语义。
