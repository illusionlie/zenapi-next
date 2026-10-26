import { beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { tokenAuth } from "../apps/worker/src/middleware/tokenAuth";
import {
	noteTokenRpmArrival,
	recordIpAuthFailure,
	resetRateLimiterState,
} from "../apps/worker/src/services/rate-limiter";

/**
 * JOIN 三态等价（design.md）：tokenAuth 现为单条 tokens LEFT JOIN users 查询。
 * 断言锚点：
 * - 鉴权全程只打一次 prepare（2 RTT → 1 RTT 的核心验收）。
 * - 无 user_id / 正常绑定 / 悬挂 user_id 三态行为与改造前两次串行查询逐字段等价
 *   （旧行为锚点：user 行缺失时 `user?.status !== "active"` → 403 user_disabled）。
 *
 * 注：中间件以 mock Context 直接调用（hono 是 apps/worker workspace 依赖，
 * 根目录 tests/ 无法解析运行时包；类型经 Parameters<typeof tokenAuth> 提取，
 * 不触发运行时解析）。
 *
 * 客户端限流（10-26-rate-limiting）：tokenAuth 挂载 isolate 内存限流状态，
 * 文件级 beforeEach 重置保证用例间隔离（先例 channel-cooldown 测试）。
 */

type AuthCtx = Parameters<typeof tokenAuth>[0];
type Next = Parameters<typeof tokenAuth>[1];

beforeEach(() => {
	resetRateLimiterState();
});

function joinRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "tok_1",
		name: "test-token",
		quota_total: null,
		quota_used: 0,
		status: "active",
		allowed_channels: null,
		allowed_models: null,
		expires_at: null,
		rpm_limit: null,
		user_id: null,
		user_balance: null,
		user_status: null,
		user_allowed_models_raw: null,
		...overrides,
	};
}

function makeDb(
	row: Record<string, unknown> | null,
	settings: Record<string, string> = {},
) {
	const prepareCalls: string[] = [];
	const db = {
		prepare(sql: string) {
			prepareCalls.push(sql);
			const stmt = {
				bind: () => stmt,
				first: async () => row,
				// settings key IN 读（loadProxySettingsCached 缓存未命中时）
				all: async () => ({
					results: Object.entries(settings).map(([key, value]) => ({
						key,
						value,
					})),
				}),
			};
			return stmt;
		},
	};
	return { db: db as unknown as D1Database, prepareCalls };
}

function makeCtx(db: D1Database, headers: Record<string, string> = {}) {
	const store = new Map<string, unknown>();
	const setHeaders: Record<string, string> = {};
	const ctx = {
		env: { DB: db },
		req: {
			header: (name: string) => {
				const key = name.toLowerCase();
				if (key === "authorization") {
					// 显式空串可表达「无凭据」；缺省给默认 Bearer
					return headers.authorization ?? "Bearer test-token-secret";
				}
				return headers[key];
			},
		},
		header: (name: string, value: string) => {
			setHeaders[name] = value;
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
	return { ctx: ctx as AuthCtx, setHeaders };
}

/** Runs the middleware; returns the error Response (or null when next() ran). */
async function runAuth(
	handle: {
		db: D1Database;
		prepareCalls: string[];
	},
	headers: Record<string, string> = {},
): Promise<{
	res: Response | null;
	tokenRecord: Record<string, unknown> | null;
	prepareCalls: string[];
	setHeaders: Record<string, string>;
}> {
	const { ctx, setHeaders } = makeCtx(handle.db, headers);
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
		setHeaders,
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
		// Expiry column is part of the single round trip (no lazy second query)
		expect(sql).toContain("t.expires_at");
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

describe("tokenAuth - lazy expiry gate (10-26-token-expiry)", () => {
	// 相对真实 now 构造的 ISO,1h 余量远离执行耗时敏感边界
	const pastIso = () => new Date(Date.now() - 3600_000).toISOString();
	const futureIso = () => new Date(Date.now() + 3600_000).toISOString();

	it("expired token (past expires_at) → 403 token_expired, row untouched", async () => {
		const { res, prepareCalls } = await runAuth(
			makeDb(joinRow({ expires_at: pastIso() })),
		);
		expect(res?.status).toBe(403);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"token_expired",
		);
		// 惰性判定:拒绝仍是单次查询,无任何状态翻写语句
		expect(prepareCalls).toHaveLength(1);
	});

	it("future expires_at → passes and flows into tokenRecord", async () => {
		const expiresAt = futureIso();
		const { res, tokenRecord } = await runAuth(
			makeDb(joinRow({ expires_at: expiresAt })),
		);
		expect(res).toBeNull();
		expect(tokenRecord?.expires_at).toBe(expiresAt);
	});

	it("NULL expires_at (legacy rows) → passes unchanged", async () => {
		const { res, tokenRecord } = await runAuth(makeDb(joinRow()));
		expect(res).toBeNull();
		expect(tokenRecord?.expires_at).toBeNull();
	});

	it("unparseable stored expires_at → fail-open (treated as permanent)", async () => {
		const { res } = await runAuth(
			makeDb(joinRow({ expires_at: "not-a-timestamp" })),
		);
		expect(res).toBeNull();
	});

	it("expiry gate sits between status and quota: expired + exhausted quota → token_expired", async () => {
		const { res } = await runAuth(
			makeDb(
				joinRow({
					expires_at: pastIso(),
					quota_total: 5,
					quota_used: 5,
				}),
			),
		);
		expect(res?.status).toBe(403);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"token_expired",
		);
	});

	it("disabled status still wins over expiry (intent state first)", async () => {
		const { res } = await runAuth(
			makeDb(
				joinRow({
					status: "disabled",
					expires_at: pastIso(),
				}),
			),
		);
		expect(res?.status).toBe(403);
		expect(((await res?.json()) as Record<string, unknown>).code).toBe(
			"token_disabled",
		);
	});

	it("renewal path: a formerly expired value in the future passes (PATCH 续期分段)", async () => {
		// 分段锁定「PATCH 把 expires_at 改到未来 → 同令牌立即可用」的鉴权半段:
		// 同一列值从 pastIso 换成 futureIso 后网关放行
		const expiredRun = await runAuth(makeDb(joinRow({ expires_at: pastIso() })));
		expect(expiredRun.res?.status).toBe(403);

		const renewedRun = await runAuth(
			makeDb(joinRow({ expires_at: futureIso() })),
		);
		expect(renewedRun.res).toBeNull();
		expect(renewedRun.tokenRecord?.id).toBe("tok_1");
	});
});

describe("tokenAuth - client rate limiting: token RPM gate (10-26-rate-limiting)", () => {
	it("rpm_limit=5 token: 6th in-window request → 429 rate_limit_exceeded + Retry-After", async () => {
		const handle = makeDb(joinRow({ rpm_limit: 5 }));
		for (let i = 0; i < 5; i++) {
			const run = await runAuth(handle);
			expect(run.res).toBeNull();
		}
		const denied = await runAuth(handle);
		expect(denied.res?.status).toBe(429);
		expect(((await denied.res?.json()) as Record<string, unknown>).code).toBe(
			"rate_limit_exceeded",
		);
		// 六次请求毫秒级完成 → 剩余整窗,Retry-After = 60
		expect(denied.setHeaders["Retry-After"]).toBe("60");
		// 超限拒绝在鉴权层拦截:每请求恰一次 token 查询,零 settings 读
		// (显式正整数限值不查全局默认)
		expect(denied.prepareCalls).toHaveLength(6);
	});

	it("NULL rpm_limit follows the global default (token_rpm_default=60)", async () => {
		const handle = makeDb(joinRow({ rpm_limit: null }), {
			token_rpm_default: "60",
		});
		for (let i = 0; i < 60; i++) {
			const run = await runAuth(handle);
			expect(run.res).toBeNull();
		}
		const denied = await runAuth(handle);
		expect(denied.res?.status).toBe(429);
		expect(((await denied.res?.json()) as Record<string, unknown>).code).toBe(
			"rate_limit_exceeded",
		);
	});

	it("explicit rpm_limit=0 is exempt even with a global default active", async () => {
		const handle = makeDb(joinRow({ rpm_limit: 0 }), {
			token_rpm_default: "3",
		});
		for (let i = 0; i < 10; i++) {
			const run = await runAuth(handle);
			expect(run.res).toBeNull();
		}
	});

	it("token rpm_limit overrides the global default", async () => {
		const handle = makeDb(joinRow({ rpm_limit: 2 }), {
			token_rpm_default: "100",
		});
		expect((await runAuth(handle)).res).toBeNull();
		expect((await runAuth(handle)).res).toBeNull();
		const denied = await runAuth(handle);
		expect(denied.res?.status).toBe(429);
	});

	it("RPM window slides: arrivals older than 60s free a slot", async () => {
		// 直接注入过期时间戳锚点(禁依赖执行耗时):窗口内已有一条 61s 前的到达
		noteTokenRpmArrival("tok_1", Date.now() - 61_000);
		const handle = makeDb(joinRow({ rpm_limit: 1 }), {
			token_rpm_default: "1",
		});
		// 过期到达已出窗 → limit 1 下仍放行
		expect((await runAuth(handle)).res).toBeNull();
	});
});

describe("tokenAuth - client rate limiting: IP auth-failure throttle", () => {
	const ipHeaders = { "cf-connecting-ip": "203.0.113.7" };

	it("reaches the limit → 429 auth_throttled with zero further D1 queries", async () => {
		const handle = makeDb(null, { ip_auth_fail_limit: "3" });
		// 三次失败入窗(每次都过了 IP 门:进入时计数 0/1/2 < 3)
		for (let i = 0; i < 3; i++) {
			const run = await runAuth(handle, ipHeaders);
			expect(run.res?.status).toBe(401);
		}
		// 基线:3 次 token 查询 + 1 次 settings 读(第 2 次起 IP 门需读阈值)
		const baseline = handle.prepareCalls.length;
		// 第 4 次起:IP 门直接 429,prepare 数冻结
		const throttled = await runAuth(handle, ipHeaders);
		expect(throttled.res?.status).toBe(429);
		expect(((await throttled.res?.json()) as Record<string, unknown>).code).toBe(
			"auth_throttled",
		);
		expect(throttled.setHeaders["Retry-After"]).toBe("60");
		expect(throttled.prepareCalls).toHaveLength(baseline);
		const throttled2 = await runAuth(handle, ipHeaders);
		expect(throttled2.res?.status).toBe(429);
		expect(throttled2.prepareCalls).toHaveLength(baseline);
	});

	it("402 quota/balance rejections never advance the failure count", async () => {
		const handle = makeDb(
			joinRow({ quota_total: 5, quota_used: 5 }),
			{ ip_auth_fail_limit: "2" },
		);
		for (let i = 0; i < 5; i++) {
			const run = await runAuth(handle, ipHeaders);
			expect(run.res?.status).toBe(402);
		}
	});

	it("each of the four failure exits counts (token_required / invalid_token / token_disabled / token_expired)", async () => {
		const pastIso = new Date(Date.now() - 3600_000).toISOString();
		// 同一 IP 依次触发四个失败出口(各自独立 db,共享限流模块状态)
		const exits: Array<{
			headers: Record<string, string>;
			row: Record<string, unknown> | null;
			status: number;
			code: string;
		}> = [
			{
				headers: { ...ipHeaders, authorization: "" },
				row: joinRow(),
				status: 401,
				code: "token_required",
			},
			{ headers: ipHeaders, row: null, status: 401, code: "invalid_token" },
			{
				headers: ipHeaders,
				row: joinRow({ status: "disabled" }),
				status: 403,
				code: "token_disabled",
			},
			{
				headers: ipHeaders,
				row: joinRow({ expires_at: pastIso }),
				status: 403,
				code: "token_expired",
			},
		];
		for (const exit of exits) {
			const run = await runAuth(
				makeDb(exit.row, { ip_auth_fail_limit: "4" }),
				exit.headers,
			);
			expect(run.res?.status).toBe(exit.status);
			expect(((await run.res?.json()) as Record<string, unknown>).code).toBe(
				exit.code,
			);
		}
		// 第 5 次(任意失败形态)→ IP 门 429,不再查 D1
		const throttled = await runAuth(
			makeDb(null, { ip_auth_fail_limit: "4" }),
			ipHeaders,
		);
		expect(throttled.res?.status).toBe(429);
		expect(((await throttled.res?.json()) as Record<string, unknown>).code).toBe(
			"auth_throttled",
		);
	});

	it("successful auth does not advance the failure count", async () => {
		const handle = makeDb(joinRow(), { ip_auth_fail_limit: "1" });
		for (let i = 0; i < 3; i++) {
			const run = await runAuth(handle, ipHeaders);
			expect(run.res).toBeNull();
		}
		// 成功三次后计数仍为 0 → 后续失败照常走 D1(而非 429)
		const failed = await runAuth(makeDb(null, { ip_auth_fail_limit: "1" }), ipHeaders);
		expect(failed.res?.status).toBe(401);
	});

	it("window slides: failures older than 60s no longer throttle", async () => {
		// 注入 61s 前的三条失败(相对真实 now 构造,不依赖执行耗时)
		for (let i = 0; i < 3; i++) {
			recordIpAuthFailure("203.0.113.7", Date.now() - 61_000);
		}
		const handle = makeDb(null, { ip_auth_fail_limit: "3" });
		const run = await runAuth(handle, ipHeaders);
		// 窗口已空 → IP 门不触发,照常查库得到 401
		expect(run.res?.status).toBe(401);
	});

	it("falls back to the first x-forwarded-for hop when cf-connecting-ip is absent", async () => {
		for (let i = 0; i < 2; i++) {
			recordIpAuthFailure("198.51.100.9");
		}
		const handle = makeDb(null, { ip_auth_fail_limit: "2" });
		const run = await runAuth(handle, {
			"x-forwarded-for": "198.51.100.9, 10.0.0.1",
		});
		expect(run.res?.status).toBe(429);
		expect(((await run.res?.json()) as Record<string, unknown>).code).toBe(
			"auth_throttled",
		);
	});

	it("no IP headers at all → both gates skipped (legacy behavior)", async () => {
		// 既有测试全程无 IP 头即此形态;这里显式锁定:无头时 401 正常返回
		const handle = makeDb(null);
		const run = await runAuth(handle);
		expect(run.res?.status).toBe(401);
	});
});
