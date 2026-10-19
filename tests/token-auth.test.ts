import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { tokenAuth } from "../apps/worker/src/middleware/tokenAuth";

/**
 * JOIN 三态等价（design.md）：tokenAuth 现为单条 tokens LEFT JOIN users 查询。
 * 断言锚点：
 * - 鉴权全程只打一次 prepare（2 RTT → 1 RTT 的核心验收）。
 * - 无 user_id / 正常绑定 / 悬空 user_id 三态行为与改造前两次串行查询逐字段等价
 *   （旧行为锚点：user 行缺失时 `user?.status !== "active"` → 403 user_disabled）。
 *
 * 注：中间件以 mock Context 直接调用（hono 是 apps/worker workspace 依赖，
 * 根目录 tests/ 无法解析运行时包；类型经 Parameters<typeof tokenAuth> 提取，
 * 不触发运行时解析）。
 */

type AuthCtx = Parameters<typeof tokenAuth>[0];
type Next = Parameters<typeof tokenAuth>[1];

function joinRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "tok_1",
		name: "test-token",
		quota_total: null,
		quota_used: 0,
		status: "active",
		allowed_channels: null,
		allowed_models: null,
		user_id: null,
		user_balance: null,
		user_status: null,
		user_allowed_models_raw: null,
		...overrides,
	};
}

function makeDb(row: Record<string, unknown> | null) {
	const prepareCalls: string[] = [];
	const db = {
		prepare(sql: string) {
			prepareCalls.push(sql);
			const stmt = {
				bind: () => stmt,
				first: async () => row,
			};
			return stmt;
		},
	};
	return { db: db as unknown as D1Database, prepareCalls };
}

function makeCtx(db: D1Database): AuthCtx {
	const store = new Map<string, unknown>();
	const ctx = {
		env: { DB: db },
		req: {
			header: (name: string) => {
				if (name.toLowerCase() === "authorization") {
					return "Bearer test-token-secret";
				}
				return undefined;
			},
		},
		set: (key: string, value: unknown) => {
			store.set(key, value);
		},
		get: (key: string) => store.get(key),
		json: (body: unknown, status: number) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
	};
	return ctx as AuthCtx;
}

/** Runs the middleware; returns the error Response (or null when next() ran). */
async function runAuth(handle: {
	db: D1Database;
	prepareCalls: string[];
}): Promise<{
	res: Response | null;
	tokenRecord: Record<string, unknown> | null;
	prepareCalls: string[];
}> {
	const ctx = makeCtx(handle.db);
	let nextCalled = false;
	const next: Next = async () => {
		nextCalled = true;
	};
	const res = await tokenAuth(ctx, next);
	return {
		res: nextCalled ? null : (res as Response),
		tokenRecord: nextCalled
			? (ctx.get("tokenRecord") as Record<string, unknown>)
			: null,
		prepareCalls: handle.prepareCalls,
	};
}

describe("tokenAuth - single JOIN query", () => {
	it("authenticates with exactly one prepare call (2 RTT → 1 RTT)", async () => {
		const { res, tokenRecord, prepareCalls } = await runAuth(
			makeDb(joinRow()),
		);

		expect(res).toBeNull(); // next() ran = authed
		expect(tokenRecord?.id).toBe("tok_1");
		expect(prepareCalls).toHaveLength(1);
	});

	it("JOIN SQL selects user columns via explicit user_* aliases, never bare", async () => {
		const { prepareCalls } = await runAuth(makeDb(joinRow()));

		const sql = prepareCalls[0];
		expect(sql).toContain("FROM tokens t");
		expect(sql).toContain("LEFT JOIN users u ON u.id = t.user_id");
		expect(sql).toContain("u.balance AS user_balance");
		expect(sql).toContain("u.status AS user_status");
		expect(sql).toContain("u.allowed_models AS user_allowed_models_raw");
		// Same-name columns must stay table-qualified (status / allowed_models
		// exist on both sides of the join).
		expect(sql).toContain("t.status");
		expect(sql).toContain("t.allowed_models");
		expect(sql).not.toContain("SELECT *");
		expect(sql).toContain("WHERE t.key_hash = ?");
	});
});

describe("tokenAuth - three-state equivalence", () => {
	it("token without user_id: passes with null user fields, no user gates", async () => {
		const { res, tokenRecord } = await runAuth(
			makeDb(
				joinRow({
					user_id: null,
					user_balance: null,
					user_status: null,
					user_allowed_models_raw: null,
				}),
			),
		);

		expect(res).toBeNull();
		expect(tokenRecord?.id).toBe("tok_1");
		expect(tokenRecord?.user_id).toBeNull();
		expect(tokenRecord?.user_status).toBeNull();
		expect(tokenRecord?.user_balance).toBeNull();
		// null allowlists = unrestricted
		expect(tokenRecord?.user_allowed_models).toBeNull();
		expect(tokenRecord?.token_allowed_models).toBeNull();
	});

	it("token with bound active user: user gates pass, allowlists parse per side", async () => {
		const { res, tokenRecord } = await runAuth(
			makeDb(
				joinRow({
					user_id: "u_1",
					user_balance: 10,
					user_status: "active",
					user_allowed_models_raw: '["m1"]',
					allowed_models: '["m1","m2"]',
				}),
			),
		);

		expect(res).toBeNull();
		expect(tokenRecord?.user_id).toBe("u_1");
		expect(tokenRecord?.user_allowed_models).toEqual(["m1"]);
		expect(tokenRecord?.token_allowed_models).toEqual(["m1", "m2"]);
	});

	it("token with dangling user_id: joined user columns are null → 403 user_disabled", async () => {
		// 旧两查询行为锚点：user 行缺失 → `user?.status !== "active"` → user_disabled。
		const { res, prepareCalls } = await runAuth(
			makeDb(
				joinRow({
					user_id: "u_missing",
					user_balance: null,
					user_status: null,
					user_allowed_models_raw: null,
				}),
			),
		);

		expect(res?.status).toBe(403);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"user_disabled",
		);
		// Still a single round trip — rejection never issues a second query.
		expect(prepareCalls).toHaveLength(1);
	});

	it("bound but disabled user → 403 user_disabled", async () => {
		const { res } = await runAuth(
			makeDb(
				joinRow({
					user_id: "u_1",
					user_balance: 10,
					user_status: "disabled",
				}),
			),
		);
		expect(res?.status).toBe(403);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"user_disabled",
		);
	});

	it("bound user with zero balance → 402 insufficient_balance", async () => {
		const { res } = await runAuth(
			makeDb(
				joinRow({
					user_id: "u_1",
					user_balance: 0,
					user_status: "active",
				}),
			),
		);
		expect(res?.status).toBe(402);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"insufficient_balance",
		);
	});
});

describe("tokenAuth - unchanged gates", () => {
	it("unknown token hash → 401 invalid_token", async () => {
		const { res } = await runAuth(makeDb(null));
		expect(res?.status).toBe(401);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"invalid_token",
		);
	});

	it("disabled token → 403 token_disabled before any user check", async () => {
		const { res } = await runAuth(
			makeDb(
				joinRow({
					status: "disabled",
					user_id: "u_1",
					user_status: "disabled",
				}),
			),
		);
		expect(res?.status).toBe(403);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"token_disabled",
		);
	});

	it("exhausted quota → 402 quota_exceeded", async () => {
		const { res } = await runAuth(
			makeDb(
				joinRow({
					quota_total: 5,
					quota_used: 5,
				}),
			),
		);
		expect(res?.status).toBe(402);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"quota_exceeded",
		);
	});
});
