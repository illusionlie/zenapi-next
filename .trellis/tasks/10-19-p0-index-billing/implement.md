# 执行计划 — P0 索引补齐与计费原子性

前置：`10-18-cache-rate-stats` 已提交（工作树干净、迁移 0024 已占用）。按序执行，每步可独立提交回退。

## Checklist

1. [ ] **迁移 + schema**
   - 新建 `apps/worker/migrations/0025_hotpath_indexes.sql`（SQL 见 design.md）。
   - `apps/worker/src/db/schema.sql` 同步（tokens / admin_sessions / usage_logs 三处，删旧单列索引行）。
   - `bun run --filter api-worker db:migrate` 本地迁移。
   - EXPLAIN 验证（输出贴回任务记录）：
     ```bash
     bunx wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN SELECT * FROM tokens WHERE key_hash = 'x'"
     bunx wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN SELECT * FROM admin_sessions WHERE token_hash = 'x'"
     bunx wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN SELECT * FROM usage_logs WHERE token_id = 1 AND created_at >= '2026-01-01'"
     ```
     三条计划均须 `SEARCH ... USING INDEX`，无 `SCAN`。
2. [ ] **services/usage.ts batch 改造**
   - `UsageInput` 增 `userId?: number | null`、`cost?: number`。
   - recordUsage 组装语句数组 `db.batch`；余额 SQL 用 `MAX(0, balance - ?)` 钳制；try/catch 失败 `console.error("[usage] ...")` 不 rethrow。
3. [ ] **调用点收缩**
   - `routes/proxy.ts`：recordUsage 闭包删除独立 balance UPDATE（约 :897-904），userId/cost 传入 recordUsage。
   - `routes/anthropic-proxy.ts`：同构（约 :483-490）。
   - grep `recordUsage(` 核对无遗漏调用方。
4. [ ] **测试**
   - 新增 `tests/usage-billing.test.ts`（D1 mock 仿 `tests/usage-cache.test.ts` 的 recordUsage 断言）：
     - 三语句 batch 组装形态与绑定参数（含 MAX(0,…) SQL 文本断言）；
     - 条件省略：无 tokenId → 无 quota 语句；cost=0 / 无 userId → 无 balance 语句；
     - batch reject → console.error 被调用、不 throw、调用方 promise 正常 resolve。
   - 回归：`tests/usage-cache.test.ts`、`tests/format-converter-*.test.ts` 断言不改（仅类型签名扩展引起的必要适配）。
5. [ ] **文档（Phase 3.3 一并）**
   - AGENTS.md §8 计费 bullet：batch 原子化、余额钳制不为负、差额对账口径、quota 并发上浮有界说明。
   - spec usage-accounting.md 增补「recordUsage batch 契约」节（trellis-update-spec）。

## 验证命令

```bash
bun run check && bun run typecheck && bun run test
```

## 审查门

- 步骤 1 后：EXPLAIN 三条计划无 SCAN（输出贴任务记录）。
- 步骤 2 后：本地实测 batch 原子性（构造 balance 语句失败，断言 INSERT 未生效）。
- 步骤 3 后：确认流式 waitUntil 包装仍成立、playground 路径未受影响。

## 回滚点

- 迁移独立成文件：回滚代码保留索引无害。
- batch 化为单一 commit：revert 即回到三写独立现状。
