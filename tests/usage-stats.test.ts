import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import dashboardRoutes from "../apps/worker/src/routes/dashboard";
import modelsRoutes from "../apps/worker/src/routes/models";
import monitoringRoutes from "../apps/worker/src/routes/monitoring";
import usageRoutes from "../apps/worker/src/routes/usage";
import {
	addUtcDays,
	loadDashboardDaily,
	loadDashboardSummary,
	loadModelDailyUsage,
	loadModelUsageTotals,
	loadUserDailyUsage,
	loadUserUsageTotals,
	loadWindowTotals,
	pruneExpiredSessions,
	pruneRollup,
	pruneUsageLogsBatched,
	retentionCutoffIso,
	rollupDate,
	rollupMissingDates,
	rollupRecentMissing,
	runDailyMaintenance,
	splitWindow,
	utcDateOf,
} from "../apps/worker/src/services/usage-stats";

// ---------------------------------------------------------------------------
// In-memory SQLite D1 adapter (same shape D1 exposes: prepare/bind/run/all/
// first/batch). Real SQL engine, no workerd — deterministic and sandbox-safe.
// ---------------------------------------------------------------------------

function createSqlite(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(
		readFileSync(
			new URL("../apps/worker/src/db/schema.sql", import.meta.url),
			"utf8",
		),
	);
	db.exec(
		readFileSync(
			new URL("../apps/worker/migrations/0026_usage_stats_daily.sql", import.meta.url),
			"utf8",
		),
	);
	return db;
}

function makeD1(db: DatabaseSync): D1Database {
	const makeStmt = (sql: string) => {
		let bound: unknown[] = [];
		const stmt = {
			sql,
			bind(...args: unknown[]) {
				bound = args;
				return stmt;
			},
			async run() {
				const res = db.prepare(sql).run(...(bound as never[]));
				return {
					success: true,
					results: [],
					meta: { changes: Number(res.changes) },
				};
			},
			async all() {
				const rows = db.prepare(sql).all(...(bound as never[]));
				return { results: rows as Array<Record<string, unknown>> };
			},
			async first() {
				const row = db.prepare(sql).get(...(bound as never[]));
				return (row ?? null) as unknown;
			},
		};
		return stmt;
	};
	const d1 = {
		prepare: (sql: string) => makeStmt(sql),
		async batch(statements: Array<{ run(): Promise<unknown> }>) {
			db.exec("BEGIN");
			try {
				const results: unknown[] = [];
				for (const statement of statements) {
					results.push(await statement.run());
				}
				db.exec("COMMIT");
				return results;
			} catch (e) {
				db.exec("ROLLBACK");
				throw e;
			}
		},
	};
	return d1 as unknown as D1Database;
}

type BatchRecord = { sqls: string[]; bound: unknown[][] };

/**
 * Wraps a D1 adapter with observation/injection hooks for the
 * maintenance-chain tests: records every db.batch (statement sqls + bound
 * params) and every prepare, can inject a batch failure (predicate on the
 * record), and can fake the reported `changes` of chosen statements — the
 * statement still executes for real, only the reported count lies (e.g.
 * make the retention DELETE report a full chunk every round to trip the
 * round fuse deterministically while the rows really do get deleted).
 */
function wrapD1(
	real: D1Database,
	hooks: {
		onBatch?: (rec: BatchRecord) => void;
		onPrepare?: (sql: string) => void;
		failBatchIf?: (rec: BatchRecord) => boolean;
		fakeChangesIf?: (sql: string) => number | undefined;
	} = {},
): D1Database {
	const wrapStmt = (sql: string) => {
		let bound: unknown[] = [];
		const stmt = {
			sql,
			bind(...args: unknown[]) {
				bound = args;
				return stmt;
			},
			async run() {
				const result = await real
					.prepare(sql)
					.bind(...(bound as never[]))
					.run();
				const fake = hooks.fakeChangesIf?.(sql);
				if (fake !== undefined) {
					return { ...result, meta: { ...result?.meta, changes: fake } };
				}
				return result;
			},
			async all() {
				return real.prepare(sql).bind(...(bound as never[])).all();
			},
			async first() {
				return real.prepare(sql).bind(...(bound as never[])).first();
			},
			boundParams: () => bound,
		};
		return stmt;
	};
	const wrapped = {
		prepare(sql: string) {
			hooks.onPrepare?.(sql);
			return wrapStmt(sql);
		},
		async batch(statements: Array<{ run(): Promise<unknown> }>) {
			const recordable = statements as Array<{
				sql: string;
				boundParams(): unknown[];
			}>;
			const rec: BatchRecord = {
				sqls: recordable.map((s) => s.sql),
				bound: recordable.map((s) => s.boundParams()),
			};
			hooks.onBatch?.(rec);
			if (hooks.failBatchIf?.(rec)) {
				throw new Error("injected batch failure");
			}
			return real.batch(statements);
		},
	};
	return wrapped as unknown as D1Database;
}

let seq = 0;

type LogOverrides = {
	token_id?: string | null;
	channel_id?: string | null;
	model?: string | null;
	total_tokens?: number | null;
	prompt_tokens?: number | null;
	completion_tokens?: number | null;
	cached_input_tokens?: number | null;
	cache_creation_tokens?: number | null;
	cost?: number | null;
	latency_ms?: number | null;
	status?: string | null;
	created_at?: string;
};

function insertLog(db: DatabaseSync, o: LogOverrides = {}): void {
	db.prepare(
		"INSERT INTO usage_logs (id, token_id, channel_id, model, request_path, total_tokens, prompt_tokens, completion_tokens, cached_input_tokens, cache_creation_tokens, cost, latency_ms, first_token_latency_ms, stream, reasoning_effort, status, error_code, error_message, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NULL, ?, NULL, NULL, ?)",
	).run(
		`log_${++seq}`,
		o.token_id ?? null,
		o.channel_id ?? null,
		o.model ?? null,
		o.total_tokens ?? 0,
		o.prompt_tokens ?? 0,
		o.completion_tokens ?? 0,
		o.cached_input_tokens ?? null,
		o.cache_creation_tokens ?? null,
		o.cost ?? 0,
		o.latency_ms ?? 0,
		o.status ?? "ok",
		o.created_at!,
	);
}

function insertToken(
	db: DatabaseSync,
	id: string,
	userId: string | null,
): void {
	db.prepare(
		"INSERT INTO tokens (id, name, key_hash, key_prefix, quota_total, quota_used, status, created_at, updated_at, user_id) VALUES (?, ?, 'h', 'p', NULL, 0, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)",
	).run(id, id, userId);
}

function insertChannel(db: DatabaseSync, id: string, name: string): void {
	db.prepare(
		"INSERT INTO channels (id, name, base_url, api_key, type, status, api_format, models_json, created_at, updated_at) VALUES (?, ?, 'https://up', 'k', 1, 'active', 'openai', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
	).run(id, name, JSON.stringify([{ id: "m1", input_price: 1, output_price: 2 }]));
}

function insertRollupRow(db: DatabaseSync, statDate: string): void {
	db.prepare(
		"INSERT INTO usage_stats_daily (id, stat_date, model, requests) VALUES (?, ?, 'm1', 1)",
	).run(`r_${++seq}`, statDate);
}

function countRows(db: DatabaseSync, sql: string): number {
	return Number(db.prepare(sql).get().c);
}

// Legacy raw summary query (the pre-migration dashboard SQL shape) — the
// consistency anchor the rollup merge must reproduce.
function rawSummaryTotals(
	db: DatabaseSync,
	fromIso: string,
): {
	total_requests: number;
	total_tokens: number;
	cached_tokens: number;
	cache_prompt_base: number;
	total_errors: number;
} {
	const row = db
		.prepare(
			`SELECT COUNT(*) AS total_requests, COALESCE(SUM(total_tokens), 0) AS total_tokens,
			COALESCE(SUM(cached_input_tokens), 0) AS cached_tokens,
			COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END), 0) AS cache_prompt_base,
			COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS total_errors
			FROM usage_logs WHERE created_at >= ?`,
		)
		.get(fromIso) as Record<string, number>;
	return {
		total_requests: Number(row.total_requests),
		total_tokens: Number(row.total_tokens),
		cached_tokens: Number(row.cached_tokens),
		cache_prompt_base: Number(row.cache_prompt_base),
		total_errors: Number(row.total_errors),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// splitWindow
// ---------------------------------------------------------------------------

describe("splitWindow", () => {
	const now = new Date("2026-10-19T08:15:00.000Z");

	it("serves pure current-day windows from raw alone", async () => {
		const split = splitWindow("2026-10-19T05:00:00.000Z", null, now);
		expect(split.rollupFrom).toBeNull();
		expect(split.rawFrom).toBe("2026-10-19T05:00:00.000Z");
		expect(split.rawTo).toBeNull();
	});

	it("splits spanning windows into complete past days + today raw", async () => {
		const split = splitWindow("2026-10-15T23:00:00.000Z", null, now);
		expect(split.rollupFrom).toBe("2026-10-15");
		expect(split.rollupTo).toBe("2026-10-18");
		expect(split.rawFrom).toBe("2026-10-19T00:00:00.000Z");
		expect(split.rawTo).toBeNull();
	});

	it("drops the raw segment when the window ends before today", async () => {
		const split = splitWindow(
			"2026-10-01T00:00:00.000Z",
			"2026-10-05T12:00:00.000Z",
			now,
		);
		expect(split.rollupFrom).toBe("2026-10-01");
		expect(split.rollupTo).toBe("2026-10-05");
		expect(split.rawFrom).toBeNull();
		expect(split.rawTo).toBe("2026-10-05T12:00:00.000Z");
	});

	it("treats an absent from as unbounded rollup coverage", async () => {
		const split = splitWindow(null, null, now);
		expect(split.rollupFrom).toBe("");
		expect(split.rollupTo).toBe("2026-10-18");
		expect(split.rawFrom).toBe("2026-10-19T00:00:00.000Z");
	});

	it("clamps the rollup upper bound at the to bound (crossing month edges)", async () => {
		const split = splitWindow(
			"2026-02-27T10:00:00.000Z",
			"2026-03-01T12:00:00.000Z",
			new Date("2026-03-05T00:00:00.000Z"),
		);
		expect(split.rollupFrom).toBe("2026-02-27");
		expect(split.rollupTo).toBe("2026-03-01");
		expect(split.rawFrom).toBeNull();
		expect(addUtcDays("2026-02-28", 1)).toBe("2026-03-01");
		expect(addUtcDays("2025-12-31", 1)).toBe("2026-01-01");
	});

	it("produces no segment at all for a same-day date-only range (legacy quirk)", async () => {
		const split = splitWindow("2026-10-19", "2026-10-19", now);
		expect(split.rollupFrom).toBeNull();
		expect(split.rawFrom).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// splitWindow sub-day short-circuit (span ≤ 1 day → raw-only, exact bounds)
// ---------------------------------------------------------------------------

describe("splitWindow sub-day short-circuit", () => {
	// Monitoring call shape: since = toISOString().slice(0, 19) of the
	// lookback start (floored to seconds, no Z) while `now` keeps its
	// milliseconds — exactly what routes/monitoring.ts and user-api.ts pass.
	const rollingSince = (now: Date, ms: number): string =>
		new Date(now.getTime() - ms).toISOString().slice(0, 19);

	it("serves a rolling 24h window from raw alone even when it starts yesterday", () => {
		// 23:00 UTC: the 24h window spans yesterday entirely — the old
		// whole-day approximation reported ~47h here (~2x inflation).
		const now = new Date("2026-10-19T23:00:00.750Z");
		const since = rollingSince(now, 86_400_000); // "2026-10-18T23:00:00"
		const split = splitWindow(since, null, now);
		expect(split.rollupFrom).toBeNull();
		expect(split.rollupTo).toBe("");
		expect(split.rawFrom).toBe(since);
		expect(split.rawTo).toBeNull();
	});

	it("serves the 24h window from raw alone right after UTC midnight too", () => {
		const now = new Date("2026-10-20T00:30:00.000Z");
		const since = rollingSince(now, 86_400_000); // "2026-10-19T00:30:00"
		const split = splitWindow(since, null, now);
		expect(split.rollupFrom).toBeNull();
		expect(split.rawFrom).toBe(since);
		expect(split.rawTo).toBeNull();
	});

	it("serves a 15m window crossing UTC midnight from raw alone", () => {
		const now = new Date("2026-10-20T00:07:00.000Z");
		const since = rollingSince(now, 15 * 60_000); // "2026-10-19T23:52:00"
		const split = splitWindow(since, null, now);
		expect(split.rollupFrom).toBeNull();
		expect(split.rawFrom).toBe(since);
		expect(split.rawTo).toBeNull();
	});

	it("serves a historical same-day sub-day window from raw alone with exact bounds", () => {
		const split = splitWindow(
			"2026-10-15T10:00:00",
			"2026-10-15T11:00:00",
			new Date("2026-10-19T08:15:00.000Z"),
		);
		expect(split.rollupFrom).toBeNull();
		expect(split.rollupTo).toBe("");
		expect(split.rawFrom).toBe("2026-10-15T10:00:00");
		expect(split.rawTo).toBe("2026-10-15T11:00:00");
	});

	it("keeps the rollup path for a 7d rolling window (regression anchor)", () => {
		const now = new Date("2026-10-19T08:15:30.500Z");
		const since = rollingSince(now, 7 * 86_400_000); // "2026-10-12T08:15:30"
		const split = splitWindow(since, null, now);
		expect(split.rollupFrom).toBe("2026-10-12");
		expect(split.rollupTo).toBe("2026-10-18");
		expect(split.rawFrom).toBe("2026-10-19T00:00:00.000Z");
		expect(split.rawTo).toBeNull();
	});

	it("reads truncated no-Z inputs as UTC, not host-local time (east-host probe)", () => {
		// Parsed as local time east of UTC, `from` would land earlier and the
		// span would exceed a day → rollup path. The exact-24h span also pins
		// the second-granularity `<=` rule (raw ms delta here is DAY_MS+750).
		const now = new Date("2026-10-19T09:15:00.750Z");
		const split = splitWindow("2026-10-18T09:15:00", null, now);
		expect(split.rollupFrom).toBeNull();
		expect(split.rawFrom).toBe("2026-10-18T09:15:00");
	});

	it("reads truncated no-Z inputs as UTC, not host-local time (west-host probe)", () => {
		// Parsed as local time west of UTC, `from` would land later and this
		// 25h window would shrink under a day → wrongly raw-only.
		const now = new Date("2026-10-19T10:20:00.000Z");
		const split = splitWindow("2026-10-18T09:15:00", null, now);
		expect(split.rollupFrom).toBe("2026-10-18");
		expect(split.rawFrom).toBe("2026-10-19T00:00:00.000Z");
	});

	it("does not short-circuit when from is absent (unbounded window)", () => {
		const split = splitWindow(null, null, new Date("2026-10-19T08:15:00.000Z"));
		expect(split.rollupFrom).toBe("");
		expect(split.rollupTo).toBe("2026-10-18");
		expect(split.rawFrom).toBe("2026-10-19T00:00:00.000Z");
	});
});

// ---------------------------------------------------------------------------
// rollupDate: idempotency, attribution, day boundaries, NULL≠0 denominator
// ---------------------------------------------------------------------------

describe("rollupDate", () => {
	it("is idempotent on re-run and preserves attribution and NULL-model groups", async () => {
		const sqlite = createSqlite();
		insertToken(sqlite, "t1", "u1");
		insertToken(sqlite, "t2", null);
		insertChannel(sqlite, "c1", "Chan");
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 100,
			prompt_tokens: 60,
			completion_tokens: 40,
			cached_input_tokens: 50,
			cache_creation_tokens: 10,
			cost: 0.2,
			latency_ms: 120,
			created_at: "2026-10-15T10:00:00.000Z",
		});
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 50,
			prompt_tokens: 200,
			status: "error",
			cost: 0.1,
			latency_ms: 80,
			created_at: "2026-10-15T11:00:00.000Z",
		});
		insertLog(sqlite, {
			token_id: "t2",
			model: null,
			total_tokens: 60,
			prompt_tokens: 50,
			completion_tokens: 10,
			cached_input_tokens: 30,
			created_at: "2026-10-15T23:59:59.999Z",
		});

		await rollupDate(makeD1(sqlite), "2026-10-15");
		await rollupDate(makeD1(sqlite), "2026-10-15");

		const rows = sqlite
			.prepare(
				"SELECT * FROM usage_stats_daily WHERE stat_date = '2026-10-15' ORDER BY model",
			)
			.all() as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(2);

		const m1 = rows.find((r) => r.model === "m1")!;
		const nullModel = rows.find((r) => r.model === null)!;
		expect(m1).toMatchObject({
			stat_date: "2026-10-15",
			model: "m1",
			channel_id: "c1",
			token_id: "t1",
			user_id: "u1",
			requests: 2,
			error_count: 1,
			prompt_tokens: 260,
			completion_tokens: 40,
			total_tokens: 150,
			cached_input_tokens: 50,
			cache_creation_tokens: 10,
			// NULL≠0: only the row WITH cache data feeds the denominator.
			cache_prompt_base: 60,
			cost: expect.closeTo(0.3, 10),
			latency_ms_sum: 200,
			last_seen_at: "2026-10-15T11:00:00.000Z",
		});
		// NULL model keeps its own group (NOT NULL was deliberately dropped).
		expect(nullModel).toMatchObject({
			model: null,
			channel_id: null,
			token_id: "t2",
			user_id: null,
			requests: 1,
			error_count: 0,
			prompt_tokens: 50,
			cached_input_tokens: 30,
			cache_prompt_base: 50,
		});
	});

	it("attributes 23:59:59.999 and 00:00:00.000 to the correct UTC days", async () => {
		const sqlite = createSqlite();
		insertLog(sqlite, { created_at: "2026-10-15T23:59:59.999Z" });
		insertLog(sqlite, { created_at: "2026-10-16T00:00:00.000Z" });

		await rollupDate(makeD1(sqlite), "2026-10-15");
		await rollupDate(makeD1(sqlite), "2026-10-16");

		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '2026-10-15'",
			),
		).toBe(1);
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '2026-10-16'",
			),
		).toBe(1);
	});

	it("keeps the existing rollup when the raw logs of the date are gone (anti-loss guard)", async () => {
		const sqlite = createSqlite();
		// Rollup exists, raw logs already pruned by retention (no usage_logs rows).
		sqlite
			.prepare(
				"INSERT INTO usage_stats_daily (id, stat_date, model, requests) VALUES ('keep_1', '2026-10-15', 'm1', 7)",
			)
			.run();

		await rollupDate(makeD1(sqlite), "2026-10-15");

		const rows = sqlite
			.prepare(
				"SELECT * FROM usage_stats_daily WHERE stat_date = '2026-10-15'",
			)
			.all() as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ model: "m1", requests: 7 });
	});

	it("writes nothing (without loss) when the raw set is empty and no rollup exists", async () => {
		const sqlite = createSqlite();
		await rollupDate(makeD1(sqlite), "2026-10-15");
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '2026-10-15'",
			),
		).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Two-segment loaders: rollup+raw union must equal the raw-only query
// ---------------------------------------------------------------------------

describe("rollup + raw union consistency", () => {
	function seedMixedUsage(sqlite: DatabaseSync, day: string): string {
		insertToken(sqlite, "t1", "u1");
		insertChannel(sqlite, "c1", "Chan");
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 100,
			prompt_tokens: 60,
			completion_tokens: 40,
			cached_input_tokens: 50,
			cache_creation_tokens: 10,
			cost: 0.2,
			latency_ms: 120,
			created_at: `${day}T10:00:00.000Z`,
		});
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 50,
			prompt_tokens: 200,
			status: "error",
			cost: 0.1,
			latency_ms: 80,
			created_at: `${day}T11:00:00.000Z`,
		});
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m2",
			total_tokens: 60,
			prompt_tokens: 50,
			completion_tokens: 10,
			cached_input_tokens: 30,
			cost: 0.3,
			latency_ms: 100,
			created_at: `${day}T23:59:59.999Z`,
		});
		return `${day}T00:00:00.000Z`;
	}

	it("summary union equals the raw-only query (NULL≠0 anchor included)", async () => {
		const sqlite = createSqlite();
		const day = addUtcDays(utcDateOf(new Date().toISOString()), -3);
		const fromIso = seedMixedUsage(sqlite, day);
		// Today's extra traffic lands in the raw segment.
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 10,
			prompt_tokens: 10,
			latency_ms: 40,
			created_at: new Date().toISOString(),
		});

		await rollupDate(makeD1(sqlite), day);

		const now = new Date();
		const split = splitWindow(fromIso, null, now);
		const summary = await loadDashboardSummary(makeD1(sqlite), split);
		const legacy = rawSummaryTotals(sqlite, fromIso);

		expect(summary.total_requests).toBe(legacy.total_requests);
		expect(summary.total_tokens).toBe(legacy.total_tokens);
		expect(summary.cached_tokens).toBe(legacy.cached_tokens);
		expect(summary.cache_prompt_base).toBe(legacy.cache_prompt_base);
		expect(summary.total_errors).toBe(legacy.total_errors);
		// Rollup-only values too: cached 80 = 50 + 30; base 60 + 50 (NULL row excluded).
		expect(summary.cached_tokens).toBe(80);
		expect(summary.cache_prompt_base).toBe(110);
		// latency avg from merged sums (120+80+100 + today 40 = 340 / 4).
		expect(summary.latency_sum / summary.total_requests).toBeCloseTo(85, 6);
	});

	it("daily rows merge both segments without overlap", async () => {
		const sqlite = createSqlite();
		const day = addUtcDays(utcDateOf(new Date().toISOString()), -3);
		seedMixedUsage(sqlite, day);
		insertLog(sqlite, {
			model: "m1",
			total_tokens: 10,
			created_at: new Date().toISOString(),
		});
		await rollupDate(makeD1(sqlite), day);

		const split = splitWindow(`${day}T00:00:00.000Z`, null, new Date());
		const rows = await loadDashboardDaily(makeD1(sqlite), split);
		expect(rows.map((r) => r.day)).toEqual([
			utcDateOf(new Date().toISOString()),
			day,
		]);
		expect(rows[1]).toMatchObject({ requests: 3, tokens: 210 });
		expect(rows[0]).toMatchObject({ requests: 1, tokens: 10 });
	});

	it("model usage totals merge rollup and raw per model", async () => {
		const sqlite = createSqlite();
		const day = addUtcDays(utcDateOf(new Date().toISOString()), -3);
		seedMixedUsage(sqlite, day);
		await rollupDate(makeD1(sqlite), day);
		const split = splitWindow(`${day}T00:00:00.000Z`, null, new Date());
		const totals = await loadModelDailyUsageCacheSafe(sqlite, split);
		expect(totals.get("m1")).toMatchObject({
			total_requests: 2,
			total_tokens: 150,
			total_cost: expect.closeTo(0.3, 10),
		});
		expect(totals.get("m2")).toMatchObject({
			total_requests: 1,
			total_tokens: 60,
			total_cost: expect.closeTo(0.3, 10),
		});
	});

	// helper kept local: merges loadModelUsageTotals rows into a map
	async function loadModelDailyUsageCacheSafe(
		sqlite: DatabaseSync,
		split: ReturnType<typeof splitWindow>,
	) {
		const rows = await loadModelUsageTotals(makeD1(sqlite), split);
		return new Map(rows.map((r) => [r.model, r]));
	}
});

// ---------------------------------------------------------------------------
// Sub-day equivalence: the split assembly must equal the raw-only precise
// query on a fixed dataset (rolled-up boundary day present, so a wrongly
// rollup-including assembly would inflate every number).
// ---------------------------------------------------------------------------

describe("sub-day window equivalence (split == raw-only)", () => {
	it("24h rolling window totals equal the raw-only precise query", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		insertToken(sqlite, "t1", "u1");
		insertChannel(sqlite, "c1", "Chan");
		// Fixed dataset: yesterday rows (one before the window start, two
		// inside), today rows inside. Yesterday is rolled up.
		const rows = [
			{ at: "2026-10-18T10:00:00.000Z", tokens: 111, latency: 10, status: "ok" },
			{ at: "2026-10-18T23:30:00.000Z", tokens: 100, latency: 120, status: "ok" },
			{ at: "2026-10-18T23:59:59.999Z", tokens: 50, latency: 80, status: "error" },
			{ at: "2026-10-19T00:00:00.000Z", tokens: 60, latency: 100, status: "ok" },
			{ at: "2026-10-19T12:00:00.000Z", tokens: 70, latency: 30, status: "ok" },
		] as const;
		for (const r of rows) {
			insertLog(sqlite, {
				token_id: "t1",
				channel_id: "c1",
				model: "m1",
				total_tokens: r.tokens,
				prompt_tokens: r.tokens,
				latency_ms: r.latency,
				status: r.status,
				created_at: r.at,
			});
		}
		await rollupDate(db, "2026-10-18");

		const now = new Date("2026-10-19T22:00:00.000Z");
		const since = new Date(now.getTime() - 86_400_000)
			.toISOString()
			.slice(0, 19); // "2026-10-18T22:00:00"
		const split = splitWindow(since, null, now);
		expect(split.rollupFrom).toBeNull(); // guard: must be the raw-only shape

		const totals = await loadWindowTotals(db, split);
		const direct = sqlite
			.prepare(
				`SELECT COUNT(*) AS total_requests,
				COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS total_errors,
				COALESCE(SUM(latency_ms), 0) AS latency_sum
				FROM usage_logs WHERE created_at >= ? AND created_at <= ?`,
			)
			.get(since, now.toISOString()) as Record<string, number>;
		expect(totals.total_requests).toBe(Number(direct.total_requests));
		expect(totals.total_errors).toBe(Number(direct.total_errors));
		expect(totals.latency_sum).toBe(Number(direct.latency_sum));
		// Deterministic anchors: the pre-window row (10:00) is excluded, the
		// rolled-up yesterday does NOT leak in → 4 requests, 1 error, 330 ms.
		expect(totals).toEqual({
			total_requests: 4,
			total_errors: 1,
			latency_sum: 330,
		});
	});

	it("historical sub-day window summary equals the raw-only precise query", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		insertToken(sqlite, "t1", "u1");
		insertChannel(sqlite, "c1", "Chan");
		// One-hour window [10:00:00, 11:00:00) on 2026-10-15 (truncated upper
		// bound compares by prefix, so the 11:00:00.000 row falls outside).
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 111,
			prompt_tokens: 111,
			created_at: "2026-10-15T09:59:59.999Z",
		});
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 100,
			prompt_tokens: 100,
			cached_input_tokens: 40,
			created_at: "2026-10-15T10:00:00.000Z",
		});
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 50,
			prompt_tokens: 50,
			created_at: "2026-10-15T10:30:00.000Z",
		});
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 999,
			prompt_tokens: 999,
			created_at: "2026-10-15T11:00:00.000Z",
		});
		await rollupDate(db, "2026-10-15");

		const split = splitWindow(
			"2026-10-15T10:00:00",
			"2026-10-15T11:00:00",
			new Date("2026-10-19T08:15:00.000Z"),
		);
		expect(split.rollupFrom).toBeNull();

		const summary = await loadDashboardSummary(db, split);
		const direct = sqlite
			.prepare(
				`SELECT COUNT(*) AS total_requests,
				COALESCE(SUM(total_tokens), 0) AS total_tokens,
				COALESCE(SUM(cached_input_tokens), 0) AS cached_tokens,
				COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END), 0) AS cache_prompt_base
				FROM usage_logs WHERE created_at >= ? AND created_at <= ?`,
			)
			.get("2026-10-15T10:00:00", "2026-10-15T11:00:00") as Record<
			string,
			number
		>;
		expect(summary.total_requests).toBe(Number(direct.total_requests));
		expect(summary.total_tokens).toBe(Number(direct.total_tokens));
		expect(summary.cached_tokens).toBe(Number(direct.cached_tokens));
		expect(summary.cache_prompt_base).toBe(Number(direct.cache_prompt_base));
		// Anchors: only the 10:00 and 10:30 rows qualify; the whole-day rollup
		// of 2026-10-15 (4 requests) must not leak into the one-hour window.
		expect(summary).toEqual({
			total_requests: 2,
			total_tokens: 150,
			latency_sum: 0,
			total_errors: 0,
			cached_tokens: 40,
			cache_creation_tokens: 0,
			cache_prompt_base: 100,
		});
	});
});

// ---------------------------------------------------------------------------
// Prunes
// ---------------------------------------------------------------------------

describe("pruneUsageLogsBatched", () => {
	// Fixed clock: every seed timestamp and cutoff derives from this instant.
	const now = new Date("2026-10-20T03:17:00.000Z");
	const cutoff30 = retentionCutoffIso(now, 30);

	function seedLogs(sqlite: DatabaseSync, oldCount: number, newCount: number) {
		const oldIso = retentionCutoffIso(now, 40); // well past the cutoff
		for (let i = 0; i < oldCount; i++) {
			insertLog(sqlite, { created_at: oldIso });
		}
		const freshIso = retentionCutoffIso(now, -1); // safely after the cutoff
		for (let i = 0; i < newCount; i++) {
			insertLog(sqlite, { created_at: freshIso });
		}
	}

	it("deletes only old rows across chunked batches and is re-entrant", async () => {
		const sqlite = createSqlite();
		seedLogs(sqlite, 7, 3);
		const db = makeD1(sqlite);

		const first = await pruneUsageLogsBatched(db, cutoff30, { chunkSize: 3 });
		expect(first).toEqual({ deleted: 7, complete: true });
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_logs"),
		).toBe(3);

		// Re-running is a no-op (termination + idempotency).
		expect(
			await pruneUsageLogsBatched(db, cutoff30, { chunkSize: 3 }),
		).toEqual({ deleted: 0, complete: true });
	});

	it("deletes everything in one batch when the chunk exceeds the table", async () => {
		const sqlite = createSqlite();
		seedLogs(sqlite, 5, 0);
		const result = await pruneUsageLogsBatched(makeD1(sqlite), cutoff30, {
			chunkSize: 500,
		});
		expect(result).toEqual({ deleted: 5, complete: true });
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_logs"),
		).toBe(0);
	});

	it("trips the round fuse and reports incomplete (35 rows, chunk 10, 2 rounds)", async () => {
		const sqlite = createSqlite();
		seedLogs(sqlite, 35, 0);
		const result = await pruneUsageLogsBatched(makeD1(sqlite), cutoff30, {
			chunkSize: 10,
			maxRounds: 2,
		});
		expect(result).toEqual({ deleted: 20, complete: false });
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_logs"),
		).toBe(15);
	});

	it("completes when the rows run out inside the allowed rounds (35 rows, chunk 10, 5 rounds)", async () => {
		const sqlite = createSqlite();
		seedLogs(sqlite, 35, 0);
		const result = await pruneUsageLogsBatched(makeD1(sqlite), cutoff30, {
			chunkSize: 10,
			maxRounds: 5,
		});
		expect(result).toEqual({ deleted: 35, complete: true });
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_logs"),
		).toBe(0);
	});
});

describe("retentionCutoffIso", () => {
	it("derives the cutoff by pure UTC millisecond arithmetic (host timezone cannot leak in)", () => {
		// toISOString() is always UTC: a local-timezone calendar subtraction
		// (setDate) would shift the string on non-UTC hosts. Fixed strings.
		const now = new Date("2026-10-20T03:17:00.000Z");
		expect(retentionCutoffIso(now, 30)).toBe("2026-09-20T03:17:00.000Z");
		expect(retentionCutoffIso(now, 0)).toBe("2026-10-20T03:17:00.000Z");
		// Crosses a month and a year boundary.
		expect(retentionCutoffIso(new Date("2027-01-05T00:00:00.000Z"), 30)).toBe(
			"2026-12-06T00:00:00.000Z",
		);
	});
});

describe("rollupRecentMissing", () => {
	const now = new Date("2026-10-20T03:17:00.000Z");
	// Scan window: [2026-10-13, 2026-10-19] — today (10-20) excluded.

	it("rolls only the missing days and never writes the present ones", async () => {
		const sqlite = createSqlite();
		const real = makeD1(sqlite);
		const batches: BatchRecord[] = [];
		const db = wrapD1(real, { onBatch: (rec) => batches.push(rec) });

		const window = [
			"2026-10-13",
			"2026-10-14",
			"2026-10-15",
			"2026-10-16",
			"2026-10-17",
			"2026-10-18",
			"2026-10-19",
		];
		for (const date of window) {
			insertLog(sqlite, { created_at: `${date}T12:00:00.000Z` });
		}
		// Five days already rolled. Marker value 99: a wrongful re-roll would
		// rewrite the row from raw (requests = 1) and destroy the marker.
		for (const date of [
			"2026-10-13",
			"2026-10-14",
			"2026-10-16",
			"2026-10-17",
			"2026-10-19",
		]) {
			sqlite
				.prepare(
					"INSERT INTO usage_stats_daily (id, stat_date, model, requests) VALUES (?, ?, 'm1', 99)",
				)
				.run(`r_${++seq}`, date);
		}
		// Today's raw rows exist but stay out of the scan window.
		insertLog(sqlite, { created_at: "2026-10-20T01:00:00.000Z" });

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const rolled = await rollupRecentMissing(db, now);

		expect(rolled).toEqual(["2026-10-15", "2026-10-18"]);
		// Exactly one write batch per missing day — present days are pure
		// probe hits with zero write calls.
		expect(batches).toHaveLength(2);
		expect(batches.every((b) => b.bound[0][0] !== "2026-10-13")).toBe(true);
		// The two missing days got real rollup rows from their raw logs.
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date IN ('2026-10-15', '2026-10-18') AND requests = 1",
			),
		).toBe(2);
		// Present days untouched: all five 99 markers survive.
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE requests = 99",
			),
		).toBe(5);
		// Today never gets a rollup row from the scan.
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '2026-10-20'",
			),
		).toBe(0);
		const scanLog = logSpy.mock.calls.find(
			(c) => c[0] === "[rollup] backfill scan done",
		);
		expect(scanLog?.[1]).toEqual({ scanned: 7, missing: 2, rolled: 2 });
	});

	it("skips days whose raw logs are gone but whose rollup survives (probe short-circuit)", async () => {
		const sqlite = createSqlite();
		const real = makeD1(sqlite);
		const batches: BatchRecord[] = [];
		const prepares: string[] = [];
		const db = wrapD1(real, {
			onBatch: (rec) => batches.push(rec),
			onPrepare: (sql) => prepares.push(sql),
		});

		// No raw logs at all — every window day carries a surviving rollup row
		// (the retention-pruned state the anti-loss guard protects).
		for (const date of [
			"2026-10-13",
			"2026-10-14",
			"2026-10-15",
			"2026-10-16",
			"2026-10-17",
			"2026-10-18",
			"2026-10-19",
		]) {
			insertRollupRow(sqlite, date);
		}

		const rolled = await rollupRecentMissing(db, now);
		expect(rolled).toEqual([]);
		// Probe hits must short-circuit before rollupDate: zero guard COUNT
		// queries and zero write batches.
		expect(batches).toHaveLength(0);
		expect(
			prepares.filter((sql) => sql.includes("COUNT(*)")),
		).toHaveLength(0);
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_stats_daily"),
		).toBe(7);
	});

	it("keeps scanning after a single day fails and logs the failure per date", async () => {
		const sqlite = createSqlite();
		const real = makeD1(sqlite);
		insertLog(sqlite, { created_at: "2026-10-15T12:00:00.000Z" });
		insertLog(sqlite, { created_at: "2026-10-18T12:00:00.000Z" });
		// Present days carry rollup rows; only 10-15 and 10-18 are missing.
		for (const date of [
			"2026-10-13",
			"2026-10-14",
			"2026-10-16",
			"2026-10-17",
			"2026-10-19",
		]) {
			insertRollupRow(sqlite, date);
		}
		// Fail the rollup batch of the earlier missing day only; the probe of
		// every other day must still succeed.
		const db = wrapD1(real, {
			failBatchIf: (rec) =>
				rec.sqls[0].includes("DELETE FROM usage_stats_daily") &&
				rec.bound[0][0] === "2026-10-15",
		});

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const rolled = await rollupRecentMissing(db, now);

		// The second missing day still rolled.
		expect(rolled).toEqual(["2026-10-18"]);
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '2026-10-18'",
			),
		).toBe(1);
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '2026-10-15'",
			),
		).toBe(0);
		// Failure logged with the per-date payload.
		const failure = errSpy.mock.calls.find(
			(c) => c[0] === "[rollup] backfill failed",
		);
		expect(failure?.[1]).toMatchObject({ date: "2026-10-15" });
		const scanLog = logSpy.mock.calls.find(
			(c) => c[0] === "[rollup] backfill scan done",
		);
		expect(scanLog?.[1]).toEqual({ scanned: 7, missing: 2, rolled: 1 });
	});
});

describe("rollupMissingDates", () => {
	const now = new Date("2026-10-20T03:17:00.000Z");

	it("returns exactly the unrolled days between the raw floor and yesterday", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		for (const date of ["2026-10-17", "2026-10-18", "2026-10-19"]) {
			insertLog(sqlite, { created_at: `${date}T12:00:00.000Z` });
		}
		// Today's raw row never joins the enumeration window.
		insertLog(sqlite, { created_at: "2026-10-20T09:00:00.000Z" });
		insertRollupRow(sqlite, "2026-10-17");
		insertRollupRow(sqlite, "2026-10-19");

		expect(await rollupMissingDates(db, now)).toEqual(["2026-10-18"]);
	});

	it("returns an empty list when the raw table is empty", async () => {
		const sqlite = createSqlite();
		insertRollupRow(sqlite, "2026-10-18");
		expect(await rollupMissingDates(makeD1(sqlite), now)).toEqual([]);
	});
});

describe("pruneExpiredSessions", () => {
	it("deletes expired sessions and keeps active ones", async () => {
		const sqlite = createSqlite();
		const nowIso = new Date().toISOString();
		const expired = "2026-01-01T00:00:00.000Z";
		for (const [table, expires] of [
			["admin_sessions", expired],
			["admin_sessions", nowIso],
			["user_sessions", expired],
			["user_sessions", nowIso],
		] as const) {
			sqlite
				.prepare(
					`INSERT INTO ${table} (id, ${table === "admin_sessions" ? "token_hash" : "user_id, token_hash"}, expires_at, created_at) VALUES (?, ${table === "admin_sessions" ? "?" : "?, ?"}, ?, '2026-01-01T00:00:00.000Z')`,
				)
				.run(
					`s_${++seq}`,
					...(table === "user_sessions" ? ["u1"] : []),
					"hash",
					expires,
				);
		}

		const result = await pruneExpiredSessions(makeD1(sqlite), nowIso);
		expect(result).toEqual({ adminDeleted: 1, userDeleted: 1 });
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM admin_sessions"),
		).toBe(1);
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM user_sessions"),
		).toBe(1);
	});
});

describe("pruneRollup", () => {
	it("deletes rollup rows older than the cutoff date", async () => {
		const sqlite = createSqlite();
		const today = utcDateOf(new Date().toISOString());
		insertRollupRow(sqlite, addUtcDays(today, -200));
		insertRollupRow(sqlite, addUtcDays(today, -1));
		const pruned = await pruneRollup(makeD1(sqlite), addUtcDays(today, -180));
		expect(pruned).toBe(1);
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_stats_daily"),
		).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// runDailyMaintenance (cron chain)
// ---------------------------------------------------------------------------

describe("runDailyMaintenance", () => {
	const now = new Date("2026-10-20T03:17:00.000Z");

	it("backfills yesterday via the scan window, prunes expired logs/sessions/rollups", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		const today = utcDateOf(now.toISOString());
		const yesterday = addUtcDays(today, -1);

		insertLog(sqlite, {
			total_tokens: 5,
			created_at: `${yesterday}T12:00:00.000Z`,
		});
		// 40 days old → past the 30d default retention cutoff (09-20).
		insertLog(sqlite, {
			total_tokens: 5,
			created_at: "2026-09-10T12:00:00.000Z",
		});
		insertRollupRow(sqlite, addUtcDays(today, -200));
		sqlite
			.prepare(
				"INSERT INTO admin_sessions (id, token_hash, expires_at, created_at) VALUES ('s_old', 'h', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
			)
			.run();

		await runDailyMaintenance(db, now);

		// Yesterday rolled up, old raw log pruned, old session + old rollup gone.
		expect(
			countRows(
				sqlite,
				`SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '${yesterday}'`,
			),
		).toBe(1);
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_logs"),
		).toBe(1);
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM admin_sessions"),
		).toBe(0);
		expect(
			countRows(
				sqlite,
				`SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '${addUtcDays(today, -200)}'`,
			),
		).toBe(0);
	});

	it("backfills two missing days and warns (not errors) on an incomplete retention prune", async () => {
		const sqlite = createSqlite();
		const real = makeD1(sqlite);
		// Retention DELETEs execute for real but always report a full chunk,
		// so the round fuse trips deterministically (180 × 5000).
		const db = wrapD1(real, {
			fakeChangesIf: (sql) =>
				sql.includes("DELETE FROM usage_logs WHERE rowid IN")
					? 5000
					: undefined,
		});
		// Two window days missing rollup rows (with raw), five present
		// (marker 99), plus one 40d-old raw row for the retention step.
		insertLog(sqlite, {
			total_tokens: 5,
			created_at: "2026-10-15T12:00:00.000Z",
		});
		insertLog(sqlite, {
			total_tokens: 5,
			created_at: "2026-10-18T12:00:00.000Z",
		});
		insertLog(sqlite, {
			total_tokens: 5,
			created_at: "2026-09-10T12:00:00.000Z",
		});
		for (const date of [
			"2026-10-13",
			"2026-10-14",
			"2026-10-16",
			"2026-10-17",
			"2026-10-19",
		]) {
			sqlite
				.prepare(
					"INSERT INTO usage_stats_daily (id, stat_date, model, requests) VALUES (?, ?, 'm1', 99)",
				)
				.run(`r_${++seq}`, date);
		}

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runDailyMaintenance(db, now);

		// Both missing days backfilled from raw; the five present untouched.
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date IN ('2026-10-15', '2026-10-18') AND requests = 1",
			),
		).toBe(2);
		expect(
			countRows(
				sqlite,
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE requests = 99",
			),
		).toBe(5);
		// Fuse tripped → warn with complete=false; the chain continued and the
		// old raw row was really deleted across the fake-full rounds.
		const warn = warnSpy.mock.calls.find(
			(c) => c[0] === "[retention] usage_logs pruned",
		);
		expect(warn?.[1]).toMatchObject({ retentionDays: 30, complete: false });
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_logs"),
		).toBe(2);
		const scanLog = logSpy.mock.calls.find(
			(c) => c[0] === "[rollup] backfill scan done",
		);
		expect(scanLog?.[1]).toEqual({ scanned: 7, missing: 2, rolled: 2 });
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("keeps running the remaining steps when one step fails", async () => {
		const sqlite = createSqlite();
		const real = makeD1(sqlite);
		const executed: string[] = [];
		const failing = {
			prepare(sql: string) {
				if (sql.includes("usage_stats_daily")) {
					throw new Error("rollup boom");
				}
				executed.push(sql);
				return real.prepare(sql);
			},
			batch(statements: Array<{ run(): Promise<unknown> }>) {
				return real.batch(statements);
			},
		} as unknown as D1Database;

		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runDailyMaintenance(failing);

		// Steps 2–3 still executed after the rollup failure.
		expect(
			executed.some((sql) => sql.includes("DELETE FROM usage_logs")),
		).toBe(true);
		expect(
			executed.some((sql) => sql.includes("DELETE FROM admin_sessions")),
		).toBe(true);
		expect(
			executed.some((sql) => sql.includes("DELETE FROM user_sessions")),
		).toBe(true);
		const errorLabels = errSpy.mock.calls.map((c) => c[0]);
		expect(errorLabels).toContain("[rollup] daily rollup failed");
		expect(errorLabels).toContain("[retention] rollup prune failed");
		expect(logSpy).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Endpoint unions (Hono apps against the sqlite adapter)
// ---------------------------------------------------------------------------

describe("usage prune endpoint (POST /prune)", () => {
	it("responds { deleted, complete } and prunes past the shared cutoff", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		// The endpoint derives its cutoff from the live clock (now − 30d
		// default retention): 40d-old rows are unconditionally past it and
		// fresh rows unconditionally safe, so the assertions stay fixed.
		for (let i = 0; i < 3; i++) {
			insertLog(sqlite, {
				created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
			});
		}
		for (let i = 0; i < 2; i++) {
			insertLog(sqlite, { created_at: new Date().toISOString() });
		}

		const res = await usageRoutes.request(
			"/prune",
			{ method: "POST" },
			{ DB: db },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: 3, complete: true });
		expect(
			countRows(sqlite, "SELECT COUNT(*) AS c FROM usage_logs"),
		).toBe(2);
	});

	it("reports incomplete without failing when the round fuse trips", async () => {
		const sqlite = createSqlite();
		const real = makeD1(sqlite);
		// Every retention round reports a full chunk → the fuse runs out
		// (180 rounds × 5000 rows) and the endpoint must still answer 200.
		const db = wrapD1(real, {
			fakeChangesIf: (sql) =>
				sql.includes("DELETE FROM usage_logs WHERE rowid IN")
					? 5000
					: undefined,
		});
		insertLog(sqlite, {
			created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
		});

		const res = await usageRoutes.request(
			"/prune",
			{ method: "POST" },
			{ DB: db },
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ deleted: 900_000, complete: false });
	});
});

describe("dashboard endpoint (rollup + raw union)", () => {
	it("returns the same numbers as the raw-only query after rollup", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		const today = utcDateOf(new Date().toISOString());
		const day = addUtcDays(today, -3);
		insertToken(sqlite, "t1", "u1");
		insertChannel(sqlite, "c1", "Chan");
		for (const [model, tokens, latency] of [
			["m1", 100, 120],
			["m1", 50, 80],
			["m2", 60, 100],
		] as const) {
			insertLog(sqlite, {
				token_id: "t1",
				channel_id: "c1",
				model,
				total_tokens: tokens,
				prompt_tokens: tokens,
				cached_input_tokens: model === "m1" ? 20 : null,
				latency_ms: latency,
				created_at: `${day}T10:00:00.000Z`,
			});
		}
		insertLog(sqlite, {
			token_id: "t1",
			channel_id: "c1",
			model: "m1",
			total_tokens: 10,
			prompt_tokens: 10,
			latency_ms: 40,
			created_at: new Date().toISOString(),
		});

		await rollupDate(db, day);

		const res = await dashboardRoutes.request(
			`/?from=${day}T00%3A00%3A00.000Z`,
			undefined,
			{ DB: db },
		);
		expect(res.status).toBe(200);
		const payload = (await res.json()) as {
			summary: Record<string, number | null>;
			byDay: Array<Record<string, unknown>>;
			byModel: Array<{ model: string; requests: number }>;
		};

		const legacy = rawSummaryTotals(sqlite, `${day}T00:00:00.000Z`);
		expect(payload.summary.total_requests).toBe(legacy.total_requests);
		expect(payload.summary.total_tokens).toBe(legacy.total_tokens);
		expect(payload.summary.total_errors).toBe(legacy.total_errors);
		expect(payload.summary.cached_tokens).toBe(legacy.cached_tokens);
		expect(payload.summary.cache_rate).toBeCloseTo(
			legacy.cached_tokens / legacy.cache_prompt_base,
			10,
		);
		expect(payload.summary.avg_latency).toBeCloseTo(340 / 4, 10);

		expect(payload.byDay).toHaveLength(2);
		expect(payload.byDay[0].day).toBe(today);
		expect(payload.byDay[1].day).toBe(day);
		expect(payload.byDay[1].requests).toBe(3);
		const m1 = payload.byModel.find((r) => r.model === "m1");
		expect(m1?.requests).toBe(3);
	});

	it("POST /rollup rolls one date, validates input, and backfills when empty", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		const today = utcDateOf(new Date().toISOString());
		const day = addUtcDays(today, -2);
		insertLog(sqlite, { created_at: `${day}T10:00:00.000Z` });

		const bad = await dashboardRoutes.request(
			"/rollup",
			{ method: "POST", body: JSON.stringify({ date: "10-15" }) },
			{ DB: db },
		);
		expect(bad.status).toBe(400);

		const single = await dashboardRoutes.request(
			"/rollup",
			{ method: "POST", body: JSON.stringify({ date: day }) },
			{ DB: db },
		);
		expect(await single.json()).toEqual({ rolled: [day] });
		expect(
			countRows(
				sqlite,
				`SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = '${day}'`,
			),
		).toBe(1);

		// Backfill enumerates [min raw day, yesterday] minus the rolled set:
		// today's fresh raw row stays out (readers never read stat_date =
		// today — the next cron scan rebuilds it), and hole days inside the
		// range (yesterday here, no raw rows) join the missing set.
		insertLog(sqlite, { created_at: new Date().toISOString() });
		const backfill = await dashboardRoutes.request(
			"/rollup",
			{ method: "POST", body: JSON.stringify({}) },
			{ DB: db },
		);
		expect(await backfill.json()).toEqual({
			rolled: [addUtcDays(today, -1)],
		});
	});
});

describe("models endpoint (30d/7d rollup unions)", () => {
	it("merges rollup and raw for usage totals, daily series, and channel latency", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		const today = utcDateOf(new Date().toISOString());
		const day = addUtcDays(today, -5);
		insertChannel(sqlite, "c1", "Chan");
		insertLog(sqlite, {
			channel_id: "c1",
			model: "m1",
			total_tokens: 100,
			prompt_tokens: 100,
			cost: 0.5,
			latency_ms: 200,
			created_at: `${day}T10:00:00.000Z`,
		});
		insertLog(sqlite, {
			channel_id: "c1",
			model: "m1",
			total_tokens: 30,
			prompt_tokens: 30,
			cost: 0.1,
			latency_ms: 60,
			created_at: new Date().toISOString(),
		});

		await rollupDate(db, day);

		const res = await modelsRoutes.request("/", undefined, { DB: db });
		expect(res.status).toBe(200);
		const payload = (await res.json()) as {
			models: Array<{
				id: string;
				total_requests: number;
				total_tokens: number;
				total_cost: number;
				avg_latency_ms: number | null;
				channels: Array<{ id: string; avg_latency_ms: number | null }>;
				daily: Array<{ day: string; requests: number }>;
			}>;
		};
		const m1 = payload.models.find((m) => m.id === "m1")!;
		expect(m1.total_requests).toBe(2);
		expect(m1.total_tokens).toBe(130);
		expect(m1.total_cost).toBeCloseTo(0.6, 10);
		expect(m1.avg_latency_ms).toBe(130);
		expect(m1.channels[0]).toMatchObject({ id: "c1", avg_latency_ms: 130 });
		expect(m1.daily.map((d) => d.day)).toEqual([day, today]);
	});
});

describe("monitoring endpoint (channel health over rollup + raw)", () => {
	it("merges channel totals, daily trends, and global summary", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		const now = new Date();
		const today = utcDateOf(now.toISOString());
		const d2 = addUtcDays(today, -2);
		const d1 = addUtcDays(today, -1);
		insertChannel(sqlite, "c1", "Chan");
		insertChannel(sqlite, "c2", "Idle");
		for (const day of [d2, d1]) {
			insertLog(sqlite, {
				channel_id: "c1",
				model: "m1",
				total_tokens: 10,
				latency_ms: 100,
				created_at: `${day}T10:00:00.000Z`,
			});
			insertLog(sqlite, {
				channel_id: "c1",
				model: "m1",
				status: "error",
				latency_ms: 50,
				created_at: `${day}T11:00:00.000Z`,
			});
		}
		insertLog(sqlite, {
			channel_id: "c1",
			model: "m1",
			latency_ms: 40,
			created_at: new Date(now.getTime() - 60_000).toISOString(),
		});

		await rollupDate(db, d2);
		await rollupDate(db, d1);

		const res = await monitoringRoutes.request("/?range=30d", undefined, {
			DB: db,
		});
		expect(res.status).toBe(200);
		const payload = (await res.json()) as {
			summary: Record<string, number>;
			channels: Array<Record<string, unknown>>;
			dailyTrends: Array<{ channel_id: string; day: string; requests: number }>;
		};
		expect(payload.summary.total_requests).toBe(5);
		expect(payload.summary.total_errors).toBe(2);
		expect(payload.summary.active_channels).toBe(1);
		const c1 = payload.channels.find((ch) => ch.channel_id === "c1")!;
		expect(c1.total_requests).toBe(5);
		expect(c1.success_count).toBe(3);
		expect(c1.avg_latency_ms).toBe(68); // (100+50+100+50+40)/5
		expect(String(c1.last_seen)).toContain(today);
		const c2 = payload.channels.find((ch) => ch.channel_id === "c2")!;
		expect(c2.total_requests).toBe(0);
		// Day slots served from the rollup: one bucket per past day + today.
		expect(payload.dailyTrends.filter((t) => t.day === d2)).toHaveLength(1);
		expect(payload.dailyTrends.filter((t) => t.day === d1)).toHaveLength(1);
		expect(
			payload.dailyTrends.reduce((sum, t) => sum + t.requests, 0),
		).toBe(5);
	});
});

describe("user loaders (redundant user_id attribution)", () => {
	it("totals and daily series come from rollup without the tokens JOIN", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		const today = utcDateOf(new Date().toISOString());
		const day = addUtcDays(today, -3);
		insertToken(sqlite, "t1", "u1");
		insertLog(sqlite, {
			token_id: "t1",
			model: "m1",
			total_tokens: 100,
			prompt_tokens: 100,
			cost: 0.5,
			cached_input_tokens: 25,
			created_at: `${day}T10:00:00.000Z`,
		});
		insertLog(sqlite, {
			token_id: "t1",
			model: "m1",
			total_tokens: 20,
			prompt_tokens: 20,
			cost: 0.1,
			created_at: new Date().toISOString(),
		});

		await rollupDate(db, day);
		const split = splitWindow(null, null, new Date());
		const totals = await loadUserUsageTotals(db, "u1", split);
		expect(totals.total_requests).toBe(2);
		expect(totals.total_tokens).toBe(120);
		expect(totals.total_cost).toBeCloseTo(0.6, 10);
		expect(totals.cached_tokens).toBe(25);
		expect(totals.cache_prompt_base).toBe(100);

		const daily = await loadUserDailyUsage(db, "u1", split);
		expect(daily.map((d) => d.day)).toEqual([today, day]);
		expect(daily[1]).toMatchObject({ requests: 1, cost: 0.5 });
	});

	it("keeps rollup-attributed usage visible after the token is deleted", async () => {
		const sqlite = createSqlite();
		const db = makeD1(sqlite);
		const today = utcDateOf(new Date().toISOString());
		const day = addUtcDays(today, -3);
		insertToken(sqlite, "t1", "u1");
		insertLog(sqlite, {
			token_id: "t1",
			total_tokens: 100,
			created_at: `${day}T10:00:00.000Z`,
		});

		await rollupDate(db, day);
		sqlite.prepare("DELETE FROM tokens WHERE id = 't1'").run();

		const split = splitWindow(null, null, new Date());
		const totals = await loadUserUsageTotals(db, "u1", split);
		// Raw JOIN-to-tokens would now return 0; the rollup keeps the history.
		expect(totals.total_requests).toBe(1);
		expect(totals.total_tokens).toBe(100);
	});
});
