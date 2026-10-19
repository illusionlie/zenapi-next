# 技术设计 — P0 索引补齐与计费原子性

## 数据层（迁移 0025）

`apps/worker/migrations/0025_hotpath_indexes.sql`（命名沿用仓库「表_列」惯例，无 idx_ 前缀）：

```sql
CREATE INDEX IF NOT EXISTS tokens_key_hash ON tokens(key_hash);
CREATE INDEX IF NOT EXISTS admin_sessions_token_hash ON admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS usage_logs_token_created ON usage_logs(token_id, created_at);
DROP INDEX IF EXISTS usage_logs_channel_id;
CREATE INDEX IF NOT EXISTS usage_logs_channel_created ON usage_logs(channel_id, created_at);
```

- `apps/worker/src/db/schema.sql` 同步：三条 CREATE INDEX 加到对应表定义之后；usage_logs 处删除旧单列 `usage_logs_channel_id` 行。
- 非 UNIQUE 理由：避免脏数据（理论不应存在的重复 key_hash / token_hash）导致迁移失败；UNIQUE 化需先做数据审计，收益仅边际（查询计划同等）。
- DROP 单列 channel_id 索引：`usage_logs_channel_created` 最左前缀完整覆盖 `channel_id = ?` 与 `channel_id = ? AND created_at >= ?` 两类查询，双份索引只增维护写放大。
- `usage_logs_created_at` 单列索引保留：retention DELETE、无渠道条件的时间窗查询仍需要。

## 计费原子化（services/usage.ts 为唯一改动核心）

现状：INSERT 与 quota UPDATE 在 services/usage.ts（recordUsage，usage.ts:45-79），balance UPDATE 散在 proxy.ts:897-904 / anthropic-proxy.ts:483-490 的 recordUsage 闭包里，三者独立执行。

改造：

```ts
// services/usage.ts — UsageInput 平铺扩展（与仓库字段直通习惯一致）
type UsageInput = {
	// ...既有 19 列字段不变
	userId?: number | null; // 计费主体
	cost?: number;          // 本次成本（usage_logs.cost 同值）
};
```

recordUsage 内组装 statements：

```ts
const stmts: D1PreparedStatement[] = [insertUsageStmt];
if (input.tokenId && totalTokens > 0) stmts.push(updateQuotaStmt); // 现状条件照搬
if (input.userId && (input.cost ?? 0) > 0) {
	stmts.push(
		db.prepare(
			"UPDATE users SET balance = MAX(0, balance - ?), updated_at = ? WHERE id = ?",
		).bind(input.cost, now, input.userId),
	);
}
try {
	await env.DB.batch(stmts);
} catch (e) {
	console.error("[usage] billing batch failed", {
		tokenId: input.tokenId, userId: input.userId, cost: input.cost, error: String(e),
	}); // 不 rethrow：计费收尾失败不影响已成功的上游响应
}
```

- 调用点收缩：proxy.ts / anthropic-proxy.ts 的 recordUsage 闭包删除独立 balance UPDATE，cost 算好后以 `userId` / `cost` 传入；流式 waitUntil 包装结构不变（proxy.ts:947-977），其外层 .catch（proxy.ts:964-972）保留作兜底日志。
- 错误路径的零值 INSERT（proxy.ts:823-836、anthropic-proxy.ts:411-424）无计费联动，**保持现状 run()，不强行 batch**（单语句已原子，无原子性诉求）。
- 语义注意：usage_logs.cost 记真实成本；钳制导致的少扣仅体现于 users.balance，差额 = cost − Δbalance，可对账审计。

## 兼容与回滚

- 迁移幂等（IF NOT EXISTS / DROP IF EXISTS），重跑安全；回滚代码不回滚索引（多出的索引无害）。
- recordUsage 调用方全量 grep 核对：routes/proxy.ts、routes/anthropic-proxy.ts（playground 不记录用量，无关）。
- D1 batch 事务语义依赖官方承诺（batched statements 在单一事务执行）；check 阶段本地实测一次部分失败回滚。

## 权衡记录

- quota 不做条件更新：并发上浮有界（在途数 × 单次增量），为最小化 P0 语义变更不引入 `WHERE quota_used + ? <= limit`；AGENTS §8 文档化。
- MAX(0,…) 在 SQL 层而非 JS 层钳制：原子、无读改写窗口。
- 索引非 UNIQUE：迁移对脏数据鲁棒优先于约束强度。
