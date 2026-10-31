import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	D1Database,
	ExecutionContext,
	ScheduledEvent,
} from "@cloudflare/workers-types";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Bindings } from "../apps/worker/src/env";
import {
	resetChannelCooldownsForTest,
	isChannelCoolingDown,
} from "../apps/worker/src/services/channel-cooldown";
import channelsApp from "../apps/worker/src/routes/channels";
import {
	classifyChannelProbe,
	isChannelProbeDue,
	pruneChannelProbes,
	PROBE_MAX_JITTER_MINUTES,
	PROBE_RETENTION_DAYS,
	runChannelProbes,
} from "../apps/worker/src/services/channel-probe";
import {
	type ChannelApiFormat,
	type ChannelFormatProbe,
} from "../apps/worker/src/services/channel-testing";
import {
	DEFAULT_PROBE_INTERVAL_MINUTES,
	MAX_PROBE_INTERVAL_MINUTES,
	MIN_PROBE_INTERVAL_MINUTES,
	PROBE_INTERVAL_MINUTES_KEY,
	resolveProbeIntervalMinutes,
} from "../apps/worker/src/services/settings";
import {
	retentionCutoffIso,
	runDailyMaintenance,
} from "../apps/worker/src/services/usage-stats";

// ---------------------------------------------------------------------------
// SQL-text-routed fake D1: serves settings / channels pools, records every
// query and every write (batch statements flattened into `writes`).
// ---------------------------------------------------------------------------

type FakeChannelRow = {
	id: string;
	base_url: string;
	api_key: string;
	api_format: string;
	api_formats: string;
	endpoint_overrides: string | null;
	custom_headers_json: string | null;
	disguise_headers_json: string | null;
	last_probe_at: string | null;
};

function makeChannel(overrides: Partial<FakeChannelRow> = {}): FakeChannelRow {
	return {
		id: "ch1",
		base_url: "https://upx.example/v1",
		api_key: "sk-test",
		api_format: "openai",
		api_formats: '["openai"]',
		endpoint_overrides: null,
		custom_headers_json: null,
		disguise_headers_json: null,
		last_probe_at: null,
		...overrides,
	};
}

function makeProbeDb(
	opts: {
		settings?: Record<string, string>;
		channels?: FakeChannelRow[];
	} = {},
) {
	const queries: Array<{ sql: string; args: unknown[] }> = [];
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
	const raw = {
		prepare(sql: string) {
			const stmt = {
				sql,
				args: [] as unknown[],
				bind(...args: unknown[]) {
					stmt.args = args;
					return stmt;
				},
				async all() {
					queries.push({ sql, args: stmt.args });
					if (sql.includes("FROM channels")) {
						return { results: opts.channels ?? [] };
					}
					if (sql.includes("FROM settings")) {
						const results = stmt.args
							.map((key) => [String(key), opts.settings?.[String(key)] ?? null])
							.filter((pair) => pair[1] !== null)
							.map(([key, value]) => ({ key, value }));
						return { results };
					}
					return { results: [] };
				},
				async first() {
					queries.push({ sql, args: stmt.args });
					return null;
				},
				async run() {
					writes.push({ sql, args: stmt.args });
					return { meta: { changes: 1 } };
				},
			};
			return stmt;
		},
		async batch(statements: Array<{ sql: string; args: unknown[] }>) {
			const entries = statements.map((s) => ({ sql: s.sql, args: s.args }));
			batches.push(entries);
			writes.push(...entries);
			return entries.map(() => ({ meta: { changes: 1 } }));
		},
	};
	return {
		db: raw as unknown as D1Database,
		queries,
		writes,
		batches,
	};
}

/** Captures probe fetches; the handler decides per-URL success/failure. */
function stubProbeFetch(
	handler: (url: string) => Promise<Response> | Response,
) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request) => {
			calls.push(String(url));
			return handler(String(url));
		}),
	);
	return calls;
}

const OK_MODELS = new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
	status: 200,
});

const PROBE_NOW = new Date("2026-10-26T08:00:00.000Z");
const minutesAgoIso = (minutes: number) =>
	new Date(PROBE_NOW.getTime() - minutes * 60_000).toISOString();

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => OK_MODELS.clone()));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Settings resolver (two-level born-in-settings shape)
// ---------------------------------------------------------------------------

describe("resolveProbeIntervalMinutes", () => {
	it("falls back to the 30-minute default when the key is missing or dirty", () => {
		expect(resolveProbeIntervalMinutes({})).toBe(
			DEFAULT_PROBE_INTERVAL_MINUTES,
		);
		expect(resolveProbeIntervalMinutes({ [PROBE_INTERVAL_MINUTES_KEY]: "" }))
			.toBe(DEFAULT_PROBE_INTERVAL_MINUTES);
		expect(resolveProbeIntervalMinutes({ [PROBE_INTERVAL_MINUTES_KEY]: "2.5" }))
			.toBe(DEFAULT_PROBE_INTERVAL_MINUTES);
		expect(resolveProbeIntervalMinutes({ [PROBE_INTERVAL_MINUTES_KEY]: "abc" }))
			.toBe(DEFAULT_PROBE_INTERVAL_MINUTES);
	});

	it("clamps out-of-range integers; 0 is a legal value (global gate off)", () => {
		expect(resolveProbeIntervalMinutes({ [PROBE_INTERVAL_MINUTES_KEY]: "0" }))
			.toBe(0);
		expect(
			resolveProbeIntervalMinutes({
				[PROBE_INTERVAL_MINUTES_KEY]: "-10",
			}),
		).toBe(MIN_PROBE_INTERVAL_MINUTES);
		expect(
			resolveProbeIntervalMinutes({
				[PROBE_INTERVAL_MINUTES_KEY]: "99999",
			}),
		).toBe(MAX_PROBE_INTERVAL_MINUTES);
	});
});

// ---------------------------------------------------------------------------
// Default zero behavior (design §6.1): with every channel switch off a tick
// costs 1–2 read-only queries, zero writes, zero fetches.
// ---------------------------------------------------------------------------

describe("runChannelProbes — default zero behavior", () => {
	it("settings missing (default 30): exactly 2 read-only queries, no writes, no fetch", async () => {
		const calls = stubProbeFetch(() => OK_MODELS.clone());
		const { db, queries, writes, batches } = makeProbeDb({ channels: [] });

		await runChannelProbes(db, PROBE_NOW);

		expect(calls).toHaveLength(0);
		expect(batches).toHaveLength(0);
		expect(writes).toHaveLength(0);
		expect(queries).toHaveLength(2);
		expect(queries[0].sql).toContain("FROM settings");
		expect(queries[1].sql).toContain("FROM channels");
		expect(queries[1].sql).toContain("probe_enabled = 1");
	});

	it("interval=0 total gate: returns after the single settings read — the channels table is never queried even with enabled channels", async () => {
		const calls = stubProbeFetch(() => OK_MODELS.clone());
		const { db, queries, writes } = makeProbeDb({
			settings: { [PROBE_INTERVAL_MINUTES_KEY]: "0" },
			channels: [makeChannel()],
		});

		await runChannelProbes(db, PROBE_NOW);

		expect(calls).toHaveLength(0);
		expect(writes).toHaveLength(0);
		expect(queries).toHaveLength(1);
		expect(queries[0].sql).toContain("FROM settings");
	});
});

// ---------------------------------------------------------------------------
// Due check + jitter (design §6.3): rand injected so assertions pin window
// edges instead of concrete timestamps.
// ---------------------------------------------------------------------------

describe("isChannelProbeDue — jitter window", () => {
	const interval = 30;
	const rand0 = () => 0; // jitter 0 → threshold = now − interval (latest possible due)
	const rand1 = () => 1; // jitter max → threshold = now − (interval − window)
	const nowMs = PROBE_NOW.getTime();

	it("NULL or unparseable last_probe_at is immediately due", () => {
		expect(isChannelProbeDue(null, interval, nowMs, rand0)).toBe(true);
		expect(isChannelProbeDue(undefined, interval, nowMs, rand1)).toBe(true);
		expect(isChannelProbeDue("not-a-date", interval, nowMs, rand0)).toBe(true);
	});

	it("probed (interval − window − 2min) ago is never due; over a full interval ago is always due", () => {
		const window = Math.min(PROBE_MAX_JITTER_MINUTES, interval / 4); // 5 for interval 30
		// 30 − 5 − 2 = 23 minutes ago: below even the max-jitter threshold
		expect(isChannelProbeDue(minutesAgoIso(23), interval, nowMs, rand0)).toBe(
			false,
		);
		expect(isChannelProbeDue(minutesAgoIso(23), interval, nowMs, rand1)).toBe(
			false,
		);
		// 31 minutes ago: past the full interval, due under zero jitter
		expect(isChannelProbeDue(minutesAgoIso(31), interval, nowMs, rand0)).toBe(
			true,
		);
		expect(isChannelProbeDue(minutesAgoIso(31), interval, nowMs, rand1)).toBe(
			true,
		);
		// Sanity: the jitter window stays within its documented cap
		expect(window).toBeLessThanOrEqual(PROBE_MAX_JITTER_MINUTES);
	});

	it("a channel inside the jitter window is due at max jitter and not due at zero jitter", () => {
		// 26 minutes ago sits between (interval − window) = 25 and interval = 30
		expect(isChannelProbeDue(minutesAgoIso(26), interval, nowMs, rand1)).toBe(
			true,
		);
		expect(isChannelProbeDue(minutesAgoIso(26), interval, nowMs, rand0)).toBe(
			false,
		);
	});

	it("end to end: probed 26min ago is probed at max jitter and skipped at zero jitter; last_probe_at is refreshed to the tick timestamp", async () => {
		const calls = stubProbeFetch(() => OK_MODELS.clone());
		const { db, batches } = makeProbeDb({
			channels: [makeChannel({ id: "ch-due", last_probe_at: minutesAgoIso(26) })],
		});

		await runChannelProbes(db, PROBE_NOW, () => 1);

		expect(calls).toEqual(["https://upx.example/v1/models"]);
		expect(batches).toHaveLength(1);
		const [insert, update] = batches[0];
		expect(insert.sql).toContain("INSERT INTO channel_probes");
		expect(update.sql).toContain("UPDATE channels SET last_probe_at");
		expect(update.args).toEqual(["2026-10-26T08:00:00.000Z", "ch-due"]);

		const skipped = makeProbeDb({
			channels: [makeChannel({ id: "ch-due", last_probe_at: minutesAgoIso(26) })],
		});
		const skippedCalls = stubProbeFetch(() => OK_MODELS.clone());
		await runChannelProbes(skipped.db, PROBE_NOW, () => 0);
		expect(skippedCalls).toHaveLength(0);
		expect(skipped.batches).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Classification + detail shape (design §6.4, fetch mock)
// ---------------------------------------------------------------------------

describe("runChannelProbes — classification and detail", () => {
	it("all formats reachable → healthy, detail {format: ok}, latency recorded", async () => {
		const calls = stubProbeFetch(() => OK_MODELS.clone());
		const { db, batches } = makeProbeDb({ channels: [makeChannel()] });

		await runChannelProbes(db, PROBE_NOW);

		expect(calls).toEqual(["https://upx.example/v1/models"]);
		expect(batches).toHaveLength(1);
		const [insert] = batches[0];
		expect(insert.args[0]).toBe("ch1");
		expect(insert.args[1]).toBe("2026-10-26T08:00:00.000Z");
		expect(insert.args[2]).toBe("healthy");
		expect(insert.args[3]).toBeTypeOf("number");
		expect(JSON.parse(String(insert.args[4]))).toEqual({ openai: "ok" });
	});

	it("every format unreachable (fetch rejects) → down, detail carries the truncated error", async () => {
		stubProbeFetch(() => {
			throw new Error("network down");
		});
		const { db, batches } = makeProbeDb({ channels: [makeChannel()] });

		await runChannelProbes(db, PROBE_NOW);

		expect(batches).toHaveLength(1);
		const [insert] = batches[0];
		expect(insert.args[2]).toBe("down");
		expect(JSON.parse(String(insert.args[4]))).toEqual({
			openai: "err: network down",
		});
	});

	it("partial formats reachable → degraded, detail maps each declared format", async () => {
		stubProbeFetch((url) => {
			if (url.includes("/v1/models")) {
				// anthropic resolution: normalizeBaseUrl strips /v1 then appends /v1/models
				throw new Error("anthropic down");
			}
			return OK_MODELS.clone();
		});
		const { db, batches } = makeProbeDb({
			channels: [
				makeChannel({
					base_url: "https://upx.example",
					api_formats: '["openai","anthropic"]',
				}),
			],
		});

		await runChannelProbes(db, PROBE_NOW);

		expect(batches).toHaveLength(1);
		const [insert] = batches[0];
		expect(insert.args[2]).toBe("degraded");
		expect(JSON.parse(String(insert.args[4]))).toEqual({
			openai: "ok",
			anthropic: "err: anthropic down",
		});
	});

	it("all formats reachable but slower than the degraded threshold classifies degraded (pure branch, no real wait)", () => {
		const ok = (format: ChannelApiFormat): ChannelFormatProbe => ({
			api_format: format,
			ok: true,
			model_count: 1,
		});
		expect(classifyChannelProbe([ok("openai")], 4999)).toBe("healthy");
		expect(classifyChannelProbe([ok("openai")], 5000)).toBe("degraded");
		expect(
			classifyChannelProbe([ok("openai"), ok("anthropic")], 9000),
		).toBe("degraded");
		expect(
			classifyChannelProbe([
				ok("openai"),
				{ api_format: "anthropic", ok: false, model_count: 0, error: "x" },
			], 10),
		).toBe("degraded");
		expect(
			classifyChannelProbe(
				[{ api_format: "openai", ok: false, model_count: 0, error: "x" }],
				10,
			),
		).toBe("down");
	});
});

// ---------------------------------------------------------------------------
// Routing isolation (design §3 / PRD R5, hard constraint): a probe marking a
// channel down must leave the cooldown tracker untouched, and the probe
// module must not even import the cooldown machinery.
// ---------------------------------------------------------------------------

describe("routing isolation", () => {
	beforeEach(() => {
		resetChannelCooldownsForTest();
	});

	it("a probe that classifies down never puts the channel into cooldown", async () => {
		stubProbeFetch(() => {
			throw new Error("network down");
		});
		const { db } = makeProbeDb({ channels: [makeChannel()] });

		await runChannelProbes(db, PROBE_NOW);

		expect(isChannelCoolingDown("ch1")).toBe(false);
		// And a request-level failure right before still proves the probe itself
		// recorded nothing (fresh reset + probe-only run): tracker stays empty.
		resetChannelCooldownsForTest();
		expect(isChannelCoolingDown("ch1")).toBe(false);
	});

	it("the probe module does not import channel-cooldown / key-cooldown (import-specifier scan)", () => {
		const source = readFileSync(
			fileURLToPath(
				new URL("../apps/worker/src/services/channel-probe.ts", import.meta.url),
			),
			"utf8",
		);
		// The contract bans imports, not prose — scan module specifiers only so
		// the header comment documenting the isolation itself cannot trip it.
		expect(source).not.toMatch(/from\s+"[^"]*(channel|key)-cooldown"/);
	});
});

// ---------------------------------------------------------------------------
// Retention prune (design §6.6): 7-day cutoff, wired into the daily chain.
// ---------------------------------------------------------------------------

describe("channel probe retention", () => {
	it("pruneChannelProbes deletes rows with checked_at below the cutoff", async () => {
		const writes: Array<{ sql: string; args: unknown[] }> = [];
		const db = {
			prepare(sql: string) {
				const stmt = {
					args: [] as unknown[],
					bind(...args: unknown[]) {
						stmt.args = args;
						return stmt;
					},
					async run() {
						writes.push({ sql, args: stmt.args });
						return { meta: { changes: 3 } };
					},
				};
				return stmt;
			},
		} as unknown as D1Database;

		const deleted = await pruneChannelProbes(db, "2026-10-19T00:00:00.000Z");

		expect(deleted).toBe(3);
		expect(writes).toHaveLength(1);
		expect(writes[0].sql).toBe(
			"DELETE FROM channel_probes WHERE checked_at < ?",
		);
		expect(writes[0].args).toEqual(["2026-10-19T00:00:00.000Z"]);
	});

	it("runDailyMaintenance prunes channel_probes with the 7-day retention cutoff", async () => {
		const writes: Array<{ sql: string; args: unknown[] }> = [];
		const raw = {
			prepare(sql: string) {
				const stmt = {
					args: [] as unknown[],
					bind(...args: unknown[]) {
						stmt.args = args;
						return stmt;
					},
					async all() {
						return { results: [] };
					},
					async first() {
						// rollup self-heal probe: every date already rolled → skipped
						if (sql.includes("FROM usage_stats_daily")) {
							return { hit: 1 };
						}
						return null;
					},
					async run() {
						writes.push({ sql, args: stmt.args });
						return { meta: { changes: 0 } };
					},
				};
				return stmt;
			},
			async batch(statements: Array<{ sql: string }>) {
				return statements.map(() => ({ meta: { changes: 0 } }));
			},
		} as unknown as D1Database;

		await runDailyMaintenance(raw, PROBE_NOW);

		const probePrune = writes.find((w) =>
			w.sql.includes("DELETE FROM channel_probes"),
		);
		expect(probePrune).toBeDefined();
		expect(probePrune?.args).toEqual([
			retentionCutoffIso(PROBE_NOW, PROBE_RETENTION_DAYS),
		]);
	});
});

// ---------------------------------------------------------------------------
// Cron dispatch (design §4): the */5 entry runs the alert evaluator first,
// then the probe scheduler (probe cron merged into the */5 tick, triggers
// 3 → 2); the 03:17 entry keeps its existing semantics (existing
// webhook-alerts tests remain the anchor). Mocked via vi.doMock + dynamic
// import so the tests above keep the real implementations.
// ---------------------------------------------------------------------------

describe("cron dispatch — */5 tick piggyback", () => {
	const makeEvent = (cron: string) => ({ cron }) as ScheduledEvent;
	const env = { DB: { marker: "db" } } as unknown as Bindings;
	const ctx = {} as ExecutionContext;

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("../apps/worker/src/services/channel-probe");
		vi.doUnmock("../apps/worker/src/services/alerts");
		vi.doUnmock("../apps/worker/src/services/usage-stats");
	});

	it("routes the */5 entry to alerts first, then the probe scheduler", async () => {
		const runChannelProbes = vi.fn();
		const evaluateAlerts = vi.fn(async () => {});
		const runDailyMaintenance = vi.fn();
		vi.doMock("../apps/worker/src/services/channel-probe", () => ({
			runChannelProbes,
			pruneChannelProbes: vi.fn(),
		}));
		vi.doMock("../apps/worker/src/services/alerts", () => ({
			evaluateAlerts,
			maybeSendDailyReport: vi.fn(),
		}));
		vi.doMock(
			"../apps/worker/src/services/usage-stats",
			async (importOriginal) => {
				const actual =
					await importOriginal<
						typeof import("../apps/worker/src/services/usage-stats")
					>();
				return { ...actual, runDailyMaintenance };
			},
		);
		const { scheduled } = await import("../apps/worker/src/index");

		await scheduled(makeEvent("*/5 * * * *"), env, ctx);

		expect(evaluateAlerts).toHaveBeenCalledTimes(1);
		expect(evaluateAlerts).toHaveBeenCalledWith(env.DB);
		expect(runChannelProbes).toHaveBeenCalledTimes(1);
		expect(runChannelProbes).toHaveBeenCalledWith(env.DB);
		// fixed order: probes start only after the alert evaluator completed
		expect(evaluateAlerts.mock.invocationCallOrder[0]).toBeLessThan(
			runChannelProbes.mock.invocationCallOrder[0],
		);
		expect(runDailyMaintenance).not.toHaveBeenCalled();
	});

	it("keeps the 03:17 entry on daily maintenance without probing", async () => {
		const runChannelProbes = vi.fn();
		const evaluateAlerts = vi.fn(async () => {});
		const runDailyMaintenance = vi.fn();
		vi.doMock("../apps/worker/src/services/channel-probe", () => ({
			runChannelProbes,
			pruneChannelProbes: vi.fn(),
		}));
		vi.doMock("../apps/worker/src/services/alerts", () => ({
			evaluateAlerts,
			maybeSendDailyReport: vi.fn(),
		}));
		vi.doMock(
			"../apps/worker/src/services/usage-stats",
			async (importOriginal) => {
				const actual =
					await importOriginal<
						typeof import("../apps/worker/src/services/usage-stats")
					>();
				return { ...actual, runDailyMaintenance };
			},
		);
		const { scheduled } = await import("../apps/worker/src/index");

		await scheduled(makeEvent("17 3 * * *"), env, ctx);
		expect(runDailyMaintenance).toHaveBeenCalledTimes(1);
		expect(runDailyMaintenance).toHaveBeenCalledWith(env.DB);
		expect(runChannelProbes).not.toHaveBeenCalled();
		expect(evaluateAlerts).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// channels CRUD probe_enabled (design §6.7): strict-boolean normalization to
// 0/1, absent = keep current (non-three-state, same family as status).
// Binding indexes follow the channel-repo column order: INSERT probe_enabled
// = 19 (after disguise_preset 18), UPDATE probe_enabled = 18 (id = 20).
// ---------------------------------------------------------------------------

function makeCrudDb(options: { channelRow?: Record<string, unknown> | null } = {}) {
	const runs: Array<{ sql: string; args: unknown[] }> = [];
	const db = {
		prepare(sql: string) {
			const stmt = {
				boundArgs: [] as unknown[],
				bind(...args: unknown[]) {
					stmt.boundArgs = args;
					return stmt;
				},
				all: async () => ({ results: [] }),
				first: async () => {
					if (sql.includes("SELECT * FROM channels")) {
						return options.channelRow ?? null;
					}
					if (sql.includes("SELECT id FROM channels")) {
						return options.channelRow
							? { id: (options.channelRow as { id?: string }).id }
							: null;
					}
					return null;
				},
				run: async () => {
					runs.push({ sql, args: stmt.boundArgs });
					return {};
				},
			};
			return stmt;
		},
	};
	return { db: db as unknown as D1Database, runs };
}

type RequestEnv = Parameters<typeof channelsApp.request>[2];

function makeCrudEnv(options: { channelRow?: Record<string, unknown> } = {}) {
	const { db, runs } = makeCrudDb({ channelRow: options.channelRow ?? null });
	return { env: { DB: db } as unknown as RequestEnv, runs };
}

const postInit = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

const patchInit = (body: unknown): RequestInit => ({
	method: "PATCH",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

const insertRun = (runs: Array<{ sql: string }>) =>
	runs.find((r) => r.sql.includes("INSERT INTO channels"));
const updateRun = (runs: Array<{ sql: string }>) =>
	runs.find((r) => r.sql.includes("UPDATE channels SET"));

/** INSERT / UPDATE 语句中 probe_enabled 的绑定下标（disguise_preset 后一位）。 */
const INSERT_PROBE_INDEX = 19;
const UPDATE_PROBE_INDEX = 18;

describe("channels CRUD probe_enabled", () => {
	it("POST absent stores 0 (default off)", async () => {
		const { env, runs } = makeCrudEnv();
		const res = await channelsApp.request(
			"/",
			postInit({ name: "c", base_url: "https://x.com/v1" }),
			env,
		);
		expect(res.status).toBe(200);
		expect(insertRun(runs)?.args[INSERT_PROBE_INDEX]).toBe(0);
	});

	it("POST accepts the strict boolean pair as 1/0", async () => {
		const on = makeCrudEnv();
		await channelsApp.request(
			"/",
			postInit({ name: "c", base_url: "https://x.com/v1", probe_enabled: true }),
			on.env,
		);
		expect(insertRun(on.runs)?.args[INSERT_PROBE_INDEX]).toBe(1);

		const off = makeCrudEnv();
		await channelsApp.request(
			"/",
			postInit({
				name: "c",
				base_url: "https://x.com/v1",
				probe_enabled: "false",
			}),
			off.env,
		);
		expect(insertRun(off.runs)?.args[INSERT_PROBE_INDEX]).toBe(0);
	});

	it("POST rejects non-strict-boolean values with 400 invalid_probe_enabled (no insert)", async () => {
		for (const bad of [1, 0, "yes", "TRUE", null]) {
			const { env, runs } = makeCrudEnv();
			const res = await channelsApp.request(
				"/",
				postInit({ name: "c", base_url: "https://x.com/v1", probe_enabled: bad }),
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.code).toBe("invalid_probe_enabled");
			expect(insertRun(runs)).toBeUndefined();
		}
	});

	it("PATCH absent keeps the current value", async () => {
		const { env, runs } = makeCrudEnv({
			channelRow: { id: "ch1", probe_enabled: 1 },
		});
		const res = await channelsApp.request("/ch1", patchInit({}), env);
		expect(res.status).toBe(200);
		expect(updateRun(runs)?.args[UPDATE_PROBE_INDEX]).toBe(1);
	});

	it("PATCH normalizes strict booleans and keeps last_probe_at out of the statement", async () => {
		const { env, runs } = makeCrudEnv({
			channelRow: { id: "ch1", probe_enabled: 0 },
		});
		const res = await channelsApp.request(
			"/ch1",
			patchInit({ probe_enabled: "true" }),
			env,
		);
		expect(res.status).toBe(200);
		const update = updateRun(runs);
		expect(update?.args[UPDATE_PROBE_INDEX]).toBe(1);
		expect(update?.sql).not.toContain("last_probe_at");
	});

	it("PATCH rejects non-strict-boolean values with 400 and writes nothing", async () => {
		const { env, runs } = makeCrudEnv({
			channelRow: { id: "ch1", probe_enabled: 1 },
		});
		const res = await channelsApp.request(
			"/ch1",
			patchInit({ probe_enabled: 1 }),
			env,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.code).toBe("invalid_probe_enabled");
		expect(updateRun(runs)).toBeUndefined();
	});
});
