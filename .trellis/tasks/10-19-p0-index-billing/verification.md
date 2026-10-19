# 验证记录 — P0 索引补齐与计费原子性

> 2026-10-19 trellis-implement 阶段产出。以下为 implement.md 审查门要求的三步验证原始输出。

## 1. 迁移应用（bun run --filter api-worker db:migrate）

本地 D1 一次补齐 0022–0025（本机此前停在 0021），0025 成功：

```
api-worker db:migrate: Migrations to be applied:
│ 0022_channel_api_formats.sql        │
│ 0023_channel_endpoint_overrides.sql │
│ 0024_usage_cache_tokens.sql         │
│ 0025_hotpath_indexes.sql            │
...
│ 0025_hotpath_indexes.sql            │ ✅     │
api-worker db:migrate: 🚣 6 commands executed successfully.
api-worker db:migrate: Exited with code 0
```

## 2. EXPLAIN QUERY PLAN（bunx wrangler d1 execute DB --local）

三条计划均为 `SEARCH ... USING INDEX`，无 `SCAN`：

```
$ bunx wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN SELECT * FROM tokens WHERE key_hash = 'x'"
"detail": "SEARCH tokens USING INDEX tokens_key_hash (key_hash=?)"

$ bunx wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN SELECT * FROM admin_sessions WHERE token_hash = 'x'"
"detail": "SEARCH admin_sessions USING INDEX admin_sessions_token_hash (token_hash=?)"

$ bunx wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN SELECT * FROM usage_logs WHERE token_id = 1 AND created_at >= '2026-01-01'"
"detail": "SEARCH usage_logs USING INDEX usage_logs_token_created (token_id=? AND created_at>?)"
```

索引终态（`sqlite_master` 查询，确认旧单列索引已 DROP）：

```
admin_sessions_token_hash        (admin_sessions)
tokens_key_hash                  (tokens)
usage_logs_channel_created       (usage_logs)
usage_logs_created_at            (usage_logs)   ← 保留：retention DELETE / 无渠道时间窗
usage_logs_token_created         (usage_logs)
-- usage_logs_channel_id 已不存在
```

## 3. 钳制语义实测（本地 D1，测试行已清理）

```
-- balance=0.5, cost=2 → 0（钳制，不为负）
INSERT INTO users (... balance ...) VALUES ('verify_clamp', ..., 0.5, ...);
UPDATE users SET balance = MAX(0, balance - 2), updated_at = ? WHERE id = 'verify_clamp';
{"after_low_balance_deduct": 0}

-- 再扣 2 → 仍为 0
UPDATE ...; SELECT balance ...;
{"after_zero_deduct": 0}

-- 正常路径 balance=10, cost=2 → 8（与现状一致）
UPDATE users SET balance = 10 ...; UPDATE ... MAX(0, balance - 2) ...;
{"after_normal_deduct": 8}

DELETE FROM users WHERE id = 'verify_clamp';  -- 清理完成（remaining: 0）
```

## 4. batch 原子性实测（wrangler getPlatformProxy，persistent: false 内存 D1，不触真实本地库）

构造「第一条 INSERT usage_logs 形态语句 + 第二条 UNIQUE 冲突语句」的 batch，第二条失败断言第一条回滚：

```
batch rejected as expected: Error: D1_ERROR: UNIQUE constraint failed: t_users.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)
t_usage rows after failed batch: 0 (rolled back — batch is atomic)
```

「记日志未扣费」中间态不存在；验证用临时脚本已删除，不入库。

## 5. 门禁（bun run check && bun run typecheck && bun run test）

```
$ bun run check
Checked 145 files in 189ms. No fixes applied.
Found 23 warnings.        ← 全部为存量文件（styles.css / .pi/extensions / channel-route.ts / models.ts / ModelsView.tsx），本次改动文件零告警；0 error
Found 7 infos.

$ bun run typecheck
$ bunx --bun tsc --noEmit   ← 退出码 0，无输出

$ bun run test
 Test Files  23 passed (23)
      Tests  487 passed (487)   ← 含新增 tests/usage-billing.test.ts（6 用例）
```

## 与 design.md 的偏离

1. `UsageInput.userId` 类型为 `string | null`（design.md 示例写 `number | null`）：`users.id` 为 TEXT 列、`tokenRecord.user_id` 在 tokenAuth.ts 中声明为 `string | null`，按代码现实取 string。
2. `cost` 字段未重复新增：`UsageInput` 已有 `cost?: number | null`（usage_logs INSERT 同值），直接复用，语义与 design 一致。
3. 错误路径的零值 INSERT（proxy.ts / anthropic-proxy.ts 的 `!lastResponse` 分支）调用点保持不动，统一经 recordUsage 走单语句 batch——与单语句 `run()` 语义等价（均原子），且覆盖失败可见性。
