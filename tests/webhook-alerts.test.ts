import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	D1Database,
	ExecutionContext,
	ScheduledEvent,
} from "@cloudflare/workers-types";
import type { Bindings } from "../apps/worker/src/env";
import {
	evaluateAlerts,
	maybeSendDailyReport,
} from "../apps/worker/src/services/alerts";
import {
	DEFAULT_ALERT_FAILURE_RATE_PCT,
	DEFAULT_ALERT_MIN_SAMPLES,
	DEFAULT_ALERT_SILENCE_MINUTES,
	DEFAULT_ALERT_WINDOW_MINUTES,
	ALERT_FAILURE_RATE_PCT_KEY,
	ALERT_MIN_SAMPLES_KEY,
	ALERT_SILENCE_MINUTES_KEY,
	ALERT_WINDOW_MINUTES_KEY,
	DAILY_REPORT_ENABLED_KEY,
	resolveAlertConfig,
	resolveDailyReportFlag,
} from "../apps/worker/src/services/settings";
import {
	formatMessage,
	type AlertMessage,
	sendWebhook,
	WEBHOOK_TYPES,
} from "../apps/worker/src/services/webhook-senders";

const sampleMessage: AlertMessage = {
	title: "[ZenAPI] 渠道故障报警",
	lines: ["渠道: primary", "失败率: 80.0%（4/5 次请求失败）"],
	severity: "warning",
	ts: "2026-10-26T08:00:00.000Z",
};

type RecordedRequest = { url: string; init: RequestInit };

/** Captures every global fetch call; each test gets a fresh recorder. */
function stubFetch(response: Response | Error) {
	const calls: RecordedRequest[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			if (response instanceof Error) {
				throw response;
			}
			return response;
		}),
	);
	return calls;
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("webhook senders", () => {
	it("exposes exactly the five platform types", () => {
		expect([...WEBHOOK_TYPES]).toEqual([
			"feishu",
			"wecom",
			"dingtalk",
			"slack",
			"generic",
		]);
	});

	it("renders title + lines + timestamp footer", () => {
		const text = formatMessage(sampleMessage);
		expect(text).toBe(
			"[ZenAPI] 渠道故障报警\n渠道: primary\n失败率: 80.0%（4/5 次请求失败）\n时间: 2026-10-26T08:00:00.000Z",
		);
	});

	it("feishu: msg_type/content text payload", async () => {
		const calls = stubFetch(new Response("{}", { status: 200 }));
		const result = await sendWebhook(
			"feishu",
			"https://open.feishu.cn/open-apis/bot/v2/hook/x",
			sampleMessage,
		);
		expect(result).toEqual({ ok: true, status: 200 });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/x");
		expect(calls[0].init.method).toBe("POST");
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.msg_type).toBe("text");
		expect(body.content.text).toContain("[ZenAPI] 渠道故障报警");
		expect(body.content.text).toContain("渠道: primary");
		expect(body.content.text).toContain("时间: 2026-10-26T08:00:00.000Z");
	});

	it("wecom: msgtype/text payload", async () => {
		const calls = stubFetch(new Response("{}", { status: 200 }));
		const result = await sendWebhook(
			"wecom",
			"https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x",
			sampleMessage,
		);
		expect(result.ok).toBe(true);
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.msgtype).toBe("text");
		expect(body.text.content).toContain("失败率: 80.0%");
	});

	it("dingtalk: msgtype/text payload", async () => {
		const calls = stubFetch(new Response("{}", { status: 200 }));
		await sendWebhook(
			"dingtalk",
			"https://oapi.dingtalk.com/robot/send?access_token=x",
			sampleMessage,
		);
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.msgtype).toBe("text");
		expect(body.text.content).toContain("[ZenAPI] 渠道故障报警");
	});

	it("slack: { text } payload", async () => {
		const calls = stubFetch(new Response("{}", { status: 200 }));
		await sendWebhook("slack", "https://hooks.slack.com/services/x", sampleMessage);
		const body = JSON.parse(String(calls[0].init.body));
		expect(Object.keys(body)).toEqual(["text"]);
		expect(body.text).toContain("渠道: primary");
	});

	it("generic: structured message object passthrough", async () => {
		const calls = stubFetch(new Response("{}", { status: 200 }));
		await sendWebhook("generic", "https://example.com/hook", sampleMessage);
		const body = JSON.parse(String(calls[0].init.body));
		expect(body).toEqual(sampleMessage);
	});

	it("unknown type fails open: nothing sent, ok=false, warn logged", async () => {
		const calls = stubFetch(new Response("{}", { status: 200 }));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await sendWebhook(
			"telegram",
			"https://example.com/hook",
			sampleMessage,
		);
		expect(result).toEqual({ ok: false });
		expect(calls).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it("non-2xx response reports ok=false with status", async () => {
		stubFetch(new Response("err", { status: 500 }));
		const result = await sendWebhook("slack", "https://x", sampleMessage);
		expect(result).toEqual({ ok: false, status: 500 });
	});

	it("network error is caught, not thrown", async () => {
		stubFetch(new Error("dns fail"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = await sendWebhook("slack", "https://x", sampleMessage);
		expect(result).toEqual({ ok: false });
		warnSpy.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// Settings: the four numeric alert keys (two-level born-in-settings shape) +
// the strict-boolean daily report flag
// ---------------------------------------------------------------------------

describe("alert settings parsing", () => {
	const defaults = {
		failureRatePct: DEFAULT_ALERT_FAILURE_RATE_PCT,
		minSamples: DEFAULT_ALERT_MIN_SAMPLES,
		silenceMinutes: DEFAULT_ALERT_SILENCE_MINUTES,
		windowMinutes: DEFAULT_ALERT_WINDOW_MINUTES,
	};

	it("falls back to defaults when every key is missing", () => {
		expect(resolveAlertConfig({})).toEqual(defaults);
	});

	it("degrades non-integer / blank / dirty values to the key default", () => {
		expect(
			resolveAlertConfig({
				[ALERT_FAILURE_RATE_PCT_KEY]: "2.5",
				[ALERT_MIN_SAMPLES_KEY]: "nope",
				[ALERT_SILENCE_MINUTES_KEY]: "",
				[ALERT_WINDOW_MINUTES_KEY]: "abc",
			}),
		).toEqual(defaults);
	});

	it("clamps out-of-range integers into [min, max] per key", () => {
		const config = resolveAlertConfig({
			[ALERT_FAILURE_RATE_PCT_KEY]: "150",
			[ALERT_MIN_SAMPLES_KEY]: "99999",
			[ALERT_SILENCE_MINUTES_KEY]: "5000",
			[ALERT_WINDOW_MINUTES_KEY]: "1",
		});
		expect(config).toEqual({
			failureRatePct: 100,
			minSamples: 10000,
			silenceMinutes: 1440,
			windowMinutes: 5,
		});
	});

	it("treats 0 as a legal value, not dirt (rate 0 = alerting off)", () => {
		const config = resolveAlertConfig({
			[ALERT_FAILURE_RATE_PCT_KEY]: "0",
			[ALERT_MIN_SAMPLES_KEY]: "0",
		});
		expect(config.failureRatePct).toBe(0);
		expect(config.minSamples).toBe(0);
		// negative integers clamp to the range floor instead
		expect(
			resolveAlertConfig({ [ALERT_SILENCE_MINUTES_KEY]: "-5" })
				.silenceMinutes,
		).toBe(1);
	});

	it("parses the daily report flag strictly (only \"true\" enables)", () => {
		expect(resolveDailyReportFlag({ [DAILY_REPORT_ENABLED_KEY]: "true" })).toBe(
			true,
		);
		expect(
			resolveDailyReportFlag({ [DAILY_REPORT_ENABLED_KEY]: "false" }),
		).toBe(false);
		expect(resolveDailyReportFlag({ [DAILY_REPORT_ENABLED_KEY]: "1" })).toBe(
			false,
		);
		expect(resolveDailyReportFlag({ [DAILY_REPORT_ENABLED_KEY]: "TRUE" })).toBe(
			false,
		);
		expect(resolveDailyReportFlag({})).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Evaluator (design §2): aggregate → breach/silence/recovery → allSettled
// broadcast → alert_state settings write
// ---------------------------------------------------------------------------

type FakeUsageRow = {
	channel_id: string;
	channel_name: string | null;
	total: number;
	errors: number;
};

type FakeWebhookRow = {
	id: string;
	name: string;
	type: string;
	url: string;
	enabled: number;
};

/**
 * SQL-text-routed fake D1 for evaluateAlerts / maybeSendDailyReport: records
 * every query (sql + bound args), serves webhooks / settings-IN / usage
 * aggregate / rollup report rows from canned data, and captures settings
 * upserts + the alert-state purge.
 */
function makeEvaluatorDb(opts: {
	webhooks?: FakeWebhookRow[];
	settings?: Record<string, string>;
	states?: Record<string, string>;
	usageRows?: FakeUsageRow[];
	reportTotals?: Record<string, number>;
	reportChannels?: Array<Record<string, unknown>>;
	reportModels?: Array<Record<string, unknown>>;
}) {
	const pool: Record<string, string> = { ...opts.settings, ...opts.states };
	const queries: Array<{ sql: string; args: unknown[] }> = [];
	const upserts: Array<{ key: string; value: string }> = [];
	let statePurged = false;
	const raw = {
		prepare(sql: string) {
			const stmt = {
				args: [] as unknown[],
				bind(...args: unknown[]) {
					stmt.args = args;
					return stmt;
				},
				async all() {
					queries.push({ sql, args: stmt.args });
					if (sql.includes("FROM webhooks")) {
						return { results: opts.webhooks ?? [] };
					}
					if (sql.includes("FROM settings WHERE key IN")) {
						const results = stmt.args
							.map((key) => [String(key), pool[String(key)] ?? null])
							.filter((pair) => pair[1] !== null)
							.map(([key, value]) => ({ key, value }));
						return { results };
					}
					if (sql.includes("FROM usage_logs")) {
						return { results: opts.usageRows ?? [] };
					}
					if (sql.includes("usage_stats_daily") && sql.includes("channel_name")) {
						return { results: opts.reportChannels ?? [] };
					}
					if (sql.includes("AS model")) {
						return { results: opts.reportModels ?? [] };
					}
					return { results: [] };
				},
				async first() {
					queries.push({ sql, args: stmt.args });
					if (sql.includes("usage_stats_daily")) {
						return opts.reportTotals ?? null;
					}
					return null;
				},
				async run() {
					queries.push({ sql, args: stmt.args });
					if (sql.includes("DELETE FROM settings WHERE key LIKE")) {
						statePurged = true;
					}
					if (sql.includes("ON CONFLICT(key) DO UPDATE")) {
						upserts.push({
							key: String(stmt.args[0]),
							value: String(stmt.args[1]),
						});
					}
					return { meta: { changes: 1 } };
				},
			};
			return stmt;
		},
	};
	return {
		db: raw as unknown as D1Database,
		queries,
		upserts,
		statePurged: () => statePurged,
	};
}

/** Captures webhook POSTs for evaluator tests (default: 200 OK). */
function stubEvaluatorFetch() {
	const bodies: Array<{ url: string; body: string }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			bodies.push({ url: String(url), body: String(init?.body ?? "") });
			return new Response("{}", { status: 200 });
		}),
	);
	return bodies;
}

const EVAL_NOW = new Date("2026-10-26T08:00:00.000Z");

const oneWebhook: FakeWebhookRow[] = [
	{ id: "w1", name: "ops", type: "generic", url: "https://hooks.example/w1", enabled: 1 },
];

describe("evaluateAlerts", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("alerts on breach, fans out to all webhooks, records state and window binding", async () => {
		const bodies = stubEvaluatorFetch();
		const five = ["feishu", "wecom", "dingtalk", "slack", "generic"].map(
			(type, index) => ({
				id: `w${index}`,
				name: type,
				type,
				url: `https://hooks.example/${type}`,
				enabled: 1,
			}),
		);
		const { db, queries, upserts } = makeEvaluatorDb({
			webhooks: five,
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 10, errors: 6 },
			],
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(5);
		const generic = bodies.find((call) => call.url.endsWith("generic"));
		const payload = JSON.parse(generic?.body ?? "{}") as AlertMessage;
		expect(payload.title).toBe("[ZenAPI] 渠道故障报警");
		expect(payload.lines.join("\n")).toContain("渠道: Primary");
		expect(payload.lines.join("\n")).toContain("失败率: 60.0%（6/10 次请求失败）");
		// window lower bound = now − 15 min (default), bound to the aggregate
		const agg = queries.find((query) => query.sql.includes("FROM usage_logs"));
		expect(agg?.args).toEqual(["2026-10-26T07:45:00.000Z"]);
		// state blob written with the alert timestamp
		expect(upserts).toHaveLength(1);
		expect(upserts[0].key).toBe("alert_state:ch1");
		const state = JSON.parse(upserts[0].value) as {
			lastAlertAt: string | null;
			lastRecoverAt: string | null;
		};
		expect(state.lastAlertAt).toBe("2026-10-26T08:00:00.000Z");
		expect(state.lastRecoverAt).toBeNull();
	});

	it("silences a repeat alert inside the silence window (no send, no write)", async () => {
		const bodies = stubEvaluatorFetch();
		const tenMinutesAgo = new Date(
			EVAL_NOW.getTime() - 10 * 60_000,
		).toISOString();
		const { db, upserts } = makeEvaluatorDb({
			webhooks: oneWebhook,
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 10, errors: 8 },
			],
			states: {
				"alert_state:ch1": JSON.stringify({
					lastAlertAt: tenMinutesAgo,
					lastRecoverAt: null,
				}),
			},
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		expect(upserts).toHaveLength(0);
	});

	it("re-alerts once the silence window has elapsed", async () => {
		const bodies = stubEvaluatorFetch();
		const oneHourAgo = new Date(
			EVAL_NOW.getTime() - 60 * 60_000,
		).toISOString();
		const { db, upserts } = makeEvaluatorDb({
			webhooks: oneWebhook,
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 10, errors: 8 },
			],
			states: {
				"alert_state:ch1": JSON.stringify({
					lastAlertAt: oneHourAgo,
					lastRecoverAt: null,
				}),
			},
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(1);
		expect(upserts).toHaveLength(1);
		expect(
			(JSON.parse(upserts[0].value) as { lastAlertAt: string }).lastAlertAt,
		).toBe("2026-10-26T08:00:00.000Z");
	});

	it("sends recovery below threshold/2 and clears lastAlertAt", async () => {
		const bodies = stubEvaluatorFetch();
		const oneHourAgo = new Date(
			EVAL_NOW.getTime() - 60 * 60_000,
		).toISOString();
		const { db, upserts } = makeEvaluatorDb({
			webhooks: oneWebhook,
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 10, errors: 1 },
			],
			states: {
				"alert_state:ch1": JSON.stringify({
					lastAlertAt: oneHourAgo,
					lastRecoverAt: null,
				}),
			},
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(1);
		const payload = JSON.parse(bodies[0].body) as AlertMessage;
		expect(payload.title).toBe("[ZenAPI] 渠道故障恢复");
		expect(payload.lines.join("\n")).toContain("失败率: 10.0%");
		const state = JSON.parse(upserts[0].value) as {
			lastAlertAt: string | null;
			lastRecoverAt: string | null;
		};
		expect(state.lastAlertAt).toBeNull();
		expect(state.lastRecoverAt).toBe("2026-10-26T08:00:00.000Z");
	});

	it("holds inside the hysteresis band (threshold/2 ≤ rate < threshold)", async () => {
		const bodies = stubEvaluatorFetch();
		const oneHourAgo = new Date(
			EVAL_NOW.getTime() - 60 * 60_000,
		).toISOString();
		const { db, upserts } = makeEvaluatorDb({
			webhooks: oneWebhook,
			// 30% ≥ 25 (threshold/2) and < 50 (threshold) → neither alert nor recovery
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 10, errors: 3 },
			],
			states: {
				"alert_state:ch1": JSON.stringify({
					lastAlertAt: oneHourAgo,
					lastRecoverAt: null,
				}),
			},
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		expect(upserts).toHaveLength(0);
	});

	it("never alerts when the sample floor is not met", async () => {
		const bodies = stubEvaluatorFetch();
		const { db, upserts } = makeEvaluatorDb({
			webhooks: oneWebhook,
			// 100% failure but 3 < 5 default samples
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 3, errors: 3 },
			],
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		expect(upserts).toHaveLength(0);
	});

	it("threshold=0 (alerting off) purges state and sends nothing", async () => {
		const bodies = stubEvaluatorFetch();
		const { db, upserts, statePurged } = makeEvaluatorDb({
			webhooks: oneWebhook,
			settings: { alert_failure_rate_pct: "0" },
			states: {
				"alert_state:ch1": JSON.stringify({
					lastAlertAt: "2026-10-26T07:00:00.000Z",
					lastRecoverAt: null,
				}),
			},
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 10, errors: 9 },
			],
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		expect(upserts).toHaveLength(0);
		expect(statePurged()).toBe(true);
	});

	it("returns after the very first query when no webhook is enabled (zero behavior)", async () => {
		const bodies = stubEvaluatorFetch();
		const { db, queries } = makeEvaluatorDb({
			webhooks: [],
			usageRows: [
				{ channel_id: "ch1", channel_name: "Primary", total: 10, errors: 9 },
			],
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		// exactly one query: the enabled-webhooks SELECT; no settings read, no
		// usage aggregate — the empty-webhook default deployment does zero work
		expect(queries).toHaveLength(1);
		expect(queries[0].sql).toContain("FROM webhooks");
	});

	it("skips everything when the window has no traffic", async () => {
		const bodies = stubEvaluatorFetch();
		const { db, upserts } = makeEvaluatorDb({
			webhooks: oneWebhook,
			usageRows: [],
		});

		await evaluateAlerts(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		expect(upserts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Daily report (design §4): strict flag → yesterday rollup digest → broadcast
// ---------------------------------------------------------------------------

describe("maybeSendDailyReport", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is a single settings read when the flag is off (zero overhead)", async () => {
		const bodies = stubEvaluatorFetch();
		const { db, queries } = makeEvaluatorDb({ webhooks: oneWebhook });

		await maybeSendDailyReport(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		expect(queries).toHaveLength(1);
		expect(queries[0].sql).toContain("FROM settings");
	});

	it("sends the yesterday rollup digest when enabled", async () => {
		const bodies = stubEvaluatorFetch();
		const { db, queries } = makeEvaluatorDb({
			webhooks: oneWebhook,
			settings: { daily_report_enabled: "true" },
			reportTotals: { requests: 100, errors: 4, tokens: 12345, cost: 0.42 },
			reportChannels: [
				{
					channel_name: "Primary",
					channel_id: "ch1",
					requests: 60,
					tokens: 7000,
					cost: 0.3,
				},
			],
			reportModels: [
				{ model: "gpt-4o", requests: 80, tokens: 9000, cost: 0.35 },
			],
		});

		await maybeSendDailyReport(db, EVAL_NOW);

		expect(bodies).toHaveLength(1);
		const payload = JSON.parse(bodies[0].body) as AlertMessage;
		expect(payload.title).toBe("[ZenAPI] 用量日报");
		const text = payload.lines.join("\n");
		expect(text).toContain("统计日期: 2026-10-25（UTC）");
		expect(text).toContain("错误率 4.0%");
		expect(text).toContain("Primary");
		expect(text).toContain("gpt-4o");
		// all three rollup queries bound to yesterday's stat_date
		const boundDates = queries
			.filter((query) => query.sql.includes("usage_stats_daily"))
			.map((query) => query.args[0]);
		expect(boundDates).toEqual([
			"2026-10-25",
			"2026-10-25",
			"2026-10-25",
		]);
	});

	it("stops after the flag + webhook reads when no webhook is enabled", async () => {
		const bodies = stubEvaluatorFetch();
		const { db, queries } = makeEvaluatorDb({
			settings: { daily_report_enabled: "true" },
		});

		await maybeSendDailyReport(db, EVAL_NOW);

		expect(bodies).toHaveLength(0);
		expect(queries).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Cron dispatch (design §5): the every-5-minutes entry → evaluateAlerts,
// every other entry → runDailyMaintenance. Mocked via vi.doMock + dynamic
// import so the evaluator/report tests above keep the real implementations.
// ---------------------------------------------------------------------------

describe("cron dispatch", () => {
	const makeEvent = (cron: string) => ({ cron }) as ScheduledEvent;
	const env = { DB: { marker: "db" } } as unknown as Bindings;
	const dbRef = env.DB;
	const ctx = {} as ExecutionContext;

	// Each test re-imports the worker entry with its own mocks — clear the
	// module registry so the cached (previously mocked) index never leaks
	// between tests.
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("../apps/worker/src/services/alerts");
		vi.doUnmock("../apps/worker/src/services/usage-stats");
	});

	it("routes the every-5-minutes entry to the alert evaluator only", async () => {
		const evaluateAlerts = vi.fn();
		const runDailyMaintenance = vi.fn();
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
		expect(evaluateAlerts).toHaveBeenCalledWith(dbRef);
		expect(runDailyMaintenance).not.toHaveBeenCalled();
	});

	it("keeps the 03:17 entry on runDailyMaintenance unchanged", async () => {
		const evaluateAlerts = vi.fn();
		const runDailyMaintenance = vi.fn();
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
		expect(runDailyMaintenance).toHaveBeenCalledWith(dbRef);
		expect(evaluateAlerts).not.toHaveBeenCalled();
	});
});
