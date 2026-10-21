import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { recordUsage } from "../apps/worker/src/services/usage";

type RecordedStmt = { sql: string; args: unknown[] };

/**
 * Fake D1: the first `rejectFirst` batch calls reject with `rejectReason`
 * (default 0 → every call succeeds); later calls succeed. Deterministic —
 * tests pass `retryDelayMs: 0` so no real timer is ever awaited.
 */
function makeDb(
	opts: { rejectFirst?: number; rejectReason?: unknown } = {},
) {
	const batchCalls: RecordedStmt[][] = [];
	let rejectedCount = 0;
	const db = {
		prepare(sql: string) {
			const stmt = {
				sql,
				boundArgs: [] as unknown[],
				bind: (...args: unknown[]) => {
					stmt.boundArgs = args;
					return stmt;
				},
				run: async () => ({}),
			};
			return stmt;
		},
		batch: async (stmts: Array<{ sql: string; boundArgs: unknown[] }>) => {
			const callNo = batchCalls.length + rejectedCount + 1;
			if (callNo <= (opts.rejectFirst ?? 0)) {
				rejectedCount += 1;
				throw opts.rejectReason ?? new Error("d1 batch boom");
			}
			batchCalls.push(stmts.map((s) => ({ sql: s.sql, args: s.boundArgs })));
			return stmts.map(() => ({}));
		},
	};
	return {
		db: db as unknown as D1Database,
		batchCalls,
		batchAttemptCount: () => batchCalls.length + rejectedCount,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("recordUsage - billing batch assembly", () => {
	it("batches INSERT + quota UPDATE + balance UPDATE with clamp SQL and bindings", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { db, batchCalls } = makeDb();
		await recordUsage(db, {
			tokenId: "tok_1",
			userId: "user_1",
			model: "gpt-4o",
			totalTokens: 100,
			promptTokens: 80,
			completionTokens: 20,
			cost: 0.5,
		});

		// Success path must stay silent (failure visibility is for failures only).
		expect(errSpy).not.toHaveBeenCalled();

		// R3 不变式：成功路径恰一次 batch 调用（重试不预支延迟，也不多发请求）。
		expect(batchCalls).toHaveLength(1);
		const stmts = batchCalls[0];
		expect(stmts).toHaveLength(3);

		const [insert, quota, balance] = stmts;

		// usage-accounting.md 契约锚点：19 列 INSERT 不变，cost 同值落 usage_logs。
		expect(insert.sql).toContain("INSERT INTO usage_logs");
		expect(insert.sql.match(/\?/g)).toHaveLength(19);
		expect(insert.args).toContain(0.5);

		expect(quota.sql).toContain(
			"UPDATE tokens SET quota_used = quota_used + ?",
		);
		expect(quota.args).toHaveLength(3);
		expect(quota.args[0]).toBe(100);
		expect(quota.args[2]).toBe("tok_1");

		// 余额 SQL 必须是 SQL 层钳制：balance 永不为负（2026-10-19 决策）。
		expect(balance.sql).toBe(
			"UPDATE users SET balance = MAX(0, balance - ?), updated_at = ? WHERE id = ?",
		);
		expect(balance.args).toHaveLength(3);
		expect(balance.args[0]).toBe(0.5);
		expect(balance.args[2]).toBe("user_1");
		// quota 与 balance 的 updated_at 复用同一 createdAt 时间戳。
		expect(quota.args[1]).toBe(balance.args[1]);
	});

	it("omits the quota statement when there is no tokenId", async () => {
		const { db, batchCalls } = makeDb();
		await recordUsage(db, {
			userId: "user_1",
			totalTokens: 100,
			cost: 2,
		});
		expect(batchCalls[0]).toHaveLength(2);
		expect(batchCalls[0][0].sql).toContain("INSERT INTO usage_logs");
		expect(batchCalls[0][1].sql).toContain("UPDATE users SET balance");
	});

	it("omits the quota statement when totalTokens is 0", async () => {
		const { db, batchCalls } = makeDb();
		await recordUsage(db, {
			tokenId: "tok_1",
			userId: "user_1",
			totalTokens: 0,
			cost: 2,
		});
		expect(batchCalls[0]).toHaveLength(2);
		expect(batchCalls[0][1].sql).toContain("UPDATE users SET balance");
	});

	it("omits the balance statement when cost is 0", async () => {
		const { db, batchCalls } = makeDb();
		await recordUsage(db, {
			tokenId: "tok_1",
			userId: "user_1",
			totalTokens: 10,
			cost: 0,
		});
		expect(batchCalls[0]).toHaveLength(2);
		expect(batchCalls[0][1].sql).toContain("UPDATE tokens SET quota_used");
	});

	it("omits the balance statement when there is no userId", async () => {
		const { db, batchCalls } = makeDb();
		await recordUsage(db, {
			tokenId: "tok_1",
			totalTokens: 10,
			cost: 2,
		});
		expect(batchCalls[0]).toHaveLength(2);
		expect(batchCalls[0][1].sql).toContain("UPDATE tokens SET quota_used");
	});

	it("absorbs a transient batch failure via the single delayed retry", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { db, batchCalls, batchAttemptCount } = makeDb({
			rejectFirst: 1,
		});

		await expect(
			recordUsage(
				db,
				{
					tokenId: "tok_1",
					userId: "user_1",
					totalTokens: 5,
					cost: 1,
				},
				{ retryDelayMs: 0 },
			),
		).resolves.toBeUndefined();

		// 瞬时抖动被重试吃掉：无失败日志。
		expect(errSpy).not.toHaveBeenCalled();
		// 首次失败 + 重放成功 = 恰两次 batch 尝试。
		expect(batchAttemptCount()).toBe(2);
		expect(batchCalls).toHaveLength(1);
		// 重放的是同一 statements：三写（INSERT + quota + balance）完整落账。
		const stmts = batchCalls[0];
		expect(stmts).toHaveLength(3);
		expect(stmts[0].sql).toContain("INSERT INTO usage_logs");
		expect(stmts[1].sql).toContain("UPDATE tokens SET quota_used");
		expect(stmts[2].sql).toContain("UPDATE users SET balance");
	});

	it("logs with [usage] context and resolves (no throw) when both attempts fail", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const { db, batchCalls, batchAttemptCount } = makeDb({
			rejectFirst: 2,
		});

		// 计费收尾失败不 rethrow：上游响应已成功，调用方 promise 正常 resolve。
		await expect(
			recordUsage(
				db,
				{
					tokenId: "tok_1",
					userId: "user_1",
					channelId: "ch_7",
					model: "gpt-4o",
					requestPath: "/v1/chat/completions",
					totalTokens: 120,
					promptTokens: 100,
					completionTokens: 20,
					cost: 1,
					status: "ok",
				},
				{ retryDelayMs: 0 },
			),
		).resolves.toBeUndefined();

		expect(errSpy).toHaveBeenCalledTimes(1);
		const [label, payload] = errSpy.mock.calls[0] as [string, unknown];
		// tag 字面是告警签名锚点，不得变动。
		expect(label).toBe("[usage] billing batch failed");
		// R2 可对账载荷：仅凭该行即可离线重建 usage_logs 统计行。
		expect(payload).toMatchObject({
			tokenId: "tok_1",
			userId: "user_1",
			cost: 1,
			model: "gpt-4o",
			channelId: "ch_7",
			requestPath: "/v1/chat/completions",
			promptTokens: 100,
			completionTokens: 20,
			totalTokens: 120,
			status: "ok",
			attempts: 2,
		});
		expect(String((payload as { error: unknown }).error)).toContain(
			"d1 batch boom",
		);
		// 两次尝试都发生在 batch 内部，模拟的提交从未成功落账。
		expect(batchAttemptCount()).toBe(2);
		expect(batchCalls).toHaveLength(0);
	});
});
