# P0：索引补齐与计费原子性

## Goal

补齐鉴权与统计热路径缺失的索引，把计费三写合并为单批原子操作并落实「余额钳制不为负」策略，消除「每请求全表扫描」与「并发扣费漂移/静默漏计费」两类缺陷。本子任务是高并发加固树（父：10-19-high-concurrency-hardening）的地基：P1 的读路径优化与 P2 的统计改造都建立在索引齐备、写路径 batch 化之上。

## 背景（已核实的事实）

- 全库 28 个 CREATE INDEX 中没有 `tokens(key_hash)` 与 `admin_sessions(token_hash)`：`tokenAuth.ts:34-38` 每个代理请求 `WHERE key_hash = ?` 全表扫描；`adminAuth.ts:17-21` 每个管理请求全表扫描 admin_sessions，且该表惰性清理、单调增长。
- `usage_logs` 仅有 created_at / channel_id 两个单列索引（schema.sql:71-72）：`routes/usage.ts:33-36` 按 token_id 过滤、`routes/user-api.ts:404-414, 480-523` per-user JOIN 聚合、dashboard byToken 均无索引可用。
- 计费三写相互独立、无事务：INSERT usage_logs（services/usage.ts:45-70）→ UPDATE tokens.quota_used（usage.ts:72-79）→ UPDATE users.balance（proxy.ts:899-904、anthropic-proxy.ts:483-490，位于 recordUsage 闭包内）。中途失败 → 记了日志没扣费（或反之）；流式路径整个记录任务失败被 .catch 吞掉（proxy.ts:964-972）→ 静默漏计费。
- 扣费无守卫：`UPDATE users SET balance = balance - ? WHERE id = ?`；闸门检查读的是请求开始时的旧值（tokenAuth.ts:76-77），N 个并发请求全部过检后各自足额扣费，可扣出深度负数。
- `db.batch` 已有仓库先例（services/model-aliases.ts:167 等）；D1 batch 官方语义为在单一事务内执行 batched statements。
- 契约边界：usage-accounting.md 规定 recordUsage INSERT 19 列、NULL 直通；`tests/usage-cache.test.ts` 已锚定 recordUsage 列绑定断言，batch 化不得破坏。cache-rate-stats 的 0024 迁移落地后，本任务迁移编号为 0025。

## Requirements

- **R1 索引迁移 0025 + schema.sql 同步**：
  - `tokens(key_hash)`、`admin_sessions(token_hash)` 单列索引；
  - `usage_logs(token_id, created_at)` 复合索引（覆盖 token 过滤与 token+时间窗）；
  - `usage_logs(channel_id, created_at)` 复合索引并 DROP 旧 `usage_logs_channel_id` 单列索引（最左前缀覆盖其全部查询，避免同列双索引写放大）；
  - 全部 IF NOT EXISTS / IF EXISTS 幂等；非 UNIQUE（key_hash 理论唯一，但避免潜在脏数据致迁移失败；UNIQUE 化留待数据审计后另议）。
- **R2 计费原子化**：三写合并为一次 `db.batch`——recordUsage（services/usage.ts）接口扩展承接 `userId` + `cost`，语句组装为 [INSERT usage（恒有）+ UPDATE tokens.quota_used（tokenId 且有用量时）+ UPDATE users.balance（cost>0 且有 userId 时）]；proxy.ts / anthropic-proxy.ts 的 recordUsage 闭包收缩为「算 cost → 调 recordUsage」，删除闭包内独立 balance UPDATE。usage-accounting.md 的 19 列 INSERT 与 NULL 直通语义不变。
- **R3 余额钳制不为负**（用户 2026-10-19 决策）：扣费 SQL 改 `UPDATE users SET balance = MAX(0, balance - ?), updated_at = ? WHERE id = ?`；usage_logs.cost 仍记真实成本，差额（cost − 实扣）仅发生在余额不足边缘场景，可由 usage_logs 与 users.balance 对账审计。正常路径（余额充足）行为与现状完全一致。
- **R4 失败可见性**：batch 失败不再静默——console.error 按 logging-guidelines 前缀标签惯例（`[usage]`）输出失败上下文（token_id / user_id / cost / 错误摘要），不向客户端报错（计费收尾失败不影响已成功的上游响应）；流式路径 waitUntil 外层 .catch（proxy.ts:964-972）保留作兜底。
- **R5 测试**：batch 语句组装断言（三语句形态、条件省略规则、钳制 SQL 绑定参数）、余额不足场景的钳制语义、batch 失败路径日志与客户端无感；既有 usage-cache / format-converter 断言零回归。

## 非目标

- 不改 quota 语义（预检 + 无条件累加保持现状；并发上浮有界 = 在途数 × 单次增量，AGENTS §8 文档化即可，条件更新留待需求出现）。
- 不做请求级预扣冻结（预扣-退款已否决，未来如需另立任务）。
- 不做 monitoring 的 substr 查询重写（归 P2 rollup 的窗口拼装设计）。
- 不动重试/冷却逻辑（P2 cooldown）。

## Acceptance Criteria

- [ ] `wrangler d1 execute --local` 跑 EXPLAIN QUERY PLAN：tokens 按 key_hash、admin_sessions 按 token_hash、usage_logs 按 token_id+时间窗的查询计划均出现 `SEARCH ... USING INDEX`，无 `SCAN`。
- [ ] batch 原子性：构造 balance 语句失败场景，INSERT usage_logs 同批回滚，无「记日志未扣费」中间态（D1 mock 断言调用形态 + 本地实测一次）。
- [ ] 钳制语义：balance=0.5、cost=2 → 扣费后 balance=0 且 usage_logs.cost=2；balance=10、cost=2 → balance=8（正常路径不变）。
- [ ] batch 失败路径有 `[usage]` console.error 输出，且客户端收到正常上游响应。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 开放问题

（无——余额策略已于 2026-10-19 经用户决策定为钳制不为负。）
