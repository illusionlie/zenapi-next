import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import worker from "../apps/worker/src/index";
import settingsApp from "../apps/worker/src/routes/settings";
import {
	DEBUG_REQUEST_BODY_LOG_KEY,
	loadDebugLogFlag,
	resolveDebugLogFlag,
	setDebugRequestBodyLog,
} from "../apps/worker/src/services/settings";

/**
 * debug_request_body_log（P2）：入口 [request] 中间件两态 + settings 键
 * 标准链路。硬验收：默认路径 raw.clone() 零调用（计数锁死）。
 */

type SettingRow = { key: string; value: string | null };

/** settings 读（key-IN all() + 单键 first()）+ run() 捕获的最小 D1 mock。 */
function makeDb(rows: SettingRow[] = []) {
	let prepareCount = 0;
	const runs: Array<{ sql: string; args: unknown[] }> = [];
	const db = {
		prepare(sql: string) {
			prepareCount += 1;
			const stmt = {
				boundArgs: [] as unknown[],
				bind: (...args: unknown[]) => {
					stmt.boundArgs = args;
					return stmt;
				},
				all: async () => {
					if (sql.includes("FROM settings")) {
						const keys = stmt.boundArgs as string[];
						return {
							results: keys.length
								? rows.filter((r) => keys.includes(r.key))
								: rows,
						};
					}
					return { results: [] };
				},
				first: async () => {
					if (sql.includes("FROM settings")) {
						const key = stmt.boundArgs[0];
						const row = rows.find((r) => r.key === key);
						return row ? { value: row.value } : null;
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
	return {
		db: db as unknown as D1Database,
		prepareCount: () => prepareCount,
		runs,
	};
}

function settingRows(entries: Record<string, string>): SettingRow[] {
	return Object.entries(entries).map(([key, value]) => ({ key, value }));
}

/** 请求打到一个无路由路径：仅入口中间件 + 404 回退运行，不触达任何路由逻辑。 */
const PROBE_PATH = "http://localhost/debug-probe/unmatched";

type FetchEnv = Parameters<typeof worker.fetch>[1];

function makeWorkerEnv(
	rows: SettingRow[] = [],
	envVars: Record<string, string> = {},
): { env: FetchEnv; prepareCount: () => number } {
	const { db, prepareCount } = makeDb(rows);
	return {
		env: { DB: db, ...envVars } as unknown as FetchEnv,
		prepareCount,
	};
}

function countRequestLogs(
	logSpy: { mock: { calls: unknown[][] } },
): Array<Record<string, unknown>> {
	return logSpy.mock.calls
		.filter((call) => call[0] === "[request]")
		.map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("[request] middleware — debug flag off (default)", () => {
	it("never clones the request body and logs method/path only", async () => {
		const { env } = makeWorkerEnv();
		const cloneSpy = vi.spyOn(Request.prototype, "clone");
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});

		const res = await worker.fetch(
			new Request(PROBE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-x", messages: [] }),
			}),
			env,
		);

		expect(res.status).toBe(404);
		expect(cloneSpy).not.toHaveBeenCalled();
		const logs = countRequestLogs(logSpy);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toEqual({ method: "POST", path: "/debug-probe/unmatched" });
		expect(logs[0]).not.toHaveProperty("body_keys");
	});

	it("GET requests skip the flag read entirely (no DB round trip)", async () => {
		const { env, prepareCount } = makeWorkerEnv();
		const cloneSpy = vi.spyOn(Request.prototype, "clone");
		vi.spyOn(console, "log").mockImplementation(() => {});

		const res = await worker.fetch(new Request(PROBE_PATH), env);

		expect(res.status).toBe(404);
		expect(cloneSpy).not.toHaveBeenCalled();
		expect(prepareCount()).toBe(0);
	});

	it("dirty stored values degrade to the cheap default (no clone)", async () => {
		const { env } = makeWorkerEnv(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "banana" }),
		);
		const cloneSpy = vi.spyOn(Request.prototype, "clone");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await worker.fetch(
			new Request(PROBE_PATH, {
				method: "POST",
				body: JSON.stringify({ a: 1 }),
			}),
			env,
		);

		expect(cloneSpy).not.toHaveBeenCalled();
	});
});

describe("[request] middleware — debug flag on", () => {
	it("restores the legacy full form (clone + body_keys)", async () => {
		const { env } = makeWorkerEnv(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }),
		);
		const cloneSpy = vi.spyOn(Request.prototype, "clone");
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});

		const res = await worker.fetch(
			new Request(PROBE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user" }] }),
			}),
			env,
		);

		expect(res.status).toBe(404);
		expect(cloneSpy).toHaveBeenCalledTimes(1);
		const logs = countRequestLogs(logSpy);
		expect(logs).toHaveLength(1);
		expect(logs[0].method).toBe("POST");
		expect(logs[0].path).toBe("/debug-probe/unmatched");
		expect(logs[0].body_type).toBe("json");
		expect(logs[0].body_keys).toEqual(["model", "messages"]);
	});

	it("env DEBUG_REQUEST_BODY_LOG truthy restores the full form without settings", async () => {
		const { env } = makeWorkerEnv([], { DEBUG_REQUEST_BODY_LOG: "1" });
		const cloneSpy = vi.spyOn(Request.prototype, "clone");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await worker.fetch(
			new Request(PROBE_PATH, {
				method: "PUT",
				body: JSON.stringify({ a: 1 }),
			}),
			env,
		);

		expect(cloneSpy).toHaveBeenCalledTimes(1);
	});

	it("env fallback stays off for non-truthy values", async () => {
		const { env } = makeWorkerEnv([], { DEBUG_REQUEST_BODY_LOG: "0" });
		const cloneSpy = vi.spyOn(Request.prototype, "clone");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await worker.fetch(
			new Request(PROBE_PATH, {
				method: "POST",
				body: JSON.stringify({ a: 1 }),
			}),
			env,
		);

		expect(cloneSpy).not.toHaveBeenCalled();
	});

	it("GET requests stay body-log free even when the flag is on", async () => {
		const { env } = makeWorkerEnv(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }),
		);
		const cloneSpy = vi.spyOn(Request.prototype, "clone");
		vi.spyOn(console, "log").mockImplementation(() => {});

		await worker.fetch(new Request(PROBE_PATH), env);

		expect(cloneSpy).not.toHaveBeenCalled();
	});
});

describe("loadDebugLogFlag — fallback chain + TTL cache", () => {
	it("walks settings → env → false and reads strictly", async () => {
		const onDb = makeDb(settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }));
		expect(await loadDebugLogFlag(onDb.db)).toBe(true);

		const offDb = makeDb(settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "false" }));
		expect(await loadDebugLogFlag(offDb.db)).toBe(false);

		const emptyDb = makeDb([]);
		expect(
			await loadDebugLogFlag(emptyDb.db, { debugRequestLog: "YES" }),
		).toBe(true);
		expect(await loadDebugLogFlag(emptyDb.db)).toBe(false);

		const dirtyDb = makeDb(settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "1" }));
		expect(await loadDebugLogFlag(dirtyDb.db)).toBe(false);
	});

	it("memoizes the raw settings read per db binding (30s TTL window)", async () => {
		const { db, prepareCount } = makeDb(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }),
		);

		expect(await loadDebugLogFlag(db)).toBe(true);
		expect(await loadDebugLogFlag(db)).toBe(true);
		expect(prepareCount()).toBe(1);
	});
});

describe("resolveDebugLogFlag — pure resolver matrix", () => {
	it("covers the read-wide matrix", () => {
		expect(resolveDebugLogFlag({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" })).toBe(
			true,
		);
		expect(
			resolveDebugLogFlag({ [DEBUG_REQUEST_BODY_LOG_KEY]: "false" }),
		).toBe(false);
		// settings 优先于 env
		expect(
			resolveDebugLogFlag(
				{ [DEBUG_REQUEST_BODY_LOG_KEY]: "false" },
				{ debugRequestLog: "1" },
			),
		).toBe(false);
		// 脏存储值按回退链降级
		expect(
			resolveDebugLogFlag(
				{ [DEBUG_REQUEST_BODY_LOG_KEY]: "banana" },
				{ debugRequestLog: "true" },
			),
		).toBe(true);
		expect(resolveDebugLogFlag({})).toBe(false);
		expect(
			resolveDebugLogFlag({}, { debugRequestLog: "  True  " }),
		).toBe(true);
		expect(resolveDebugLogFlag({}, { debugRequestLog: "no" })).toBe(false);
	});
});

describe("settings route — debug_request_body_log CRUD", () => {
	type RequestEnv = Parameters<typeof settingsApp.request>[2];

	function makeRouteEnv(rows: SettingRow[] = []): {
		env: RequestEnv;
		runs: Array<{ sql: string; args: unknown[] }>;
	} {
		const { db, runs } = makeDb(rows);
		return { env: { DB: db } as unknown as RequestEnv, runs };
	}

	it("GET returns the key (default false)", async () => {
		const { env } = makeRouteEnv();
		const res = await settingsApp.request("/", { method: "GET" }, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.debug_request_body_log).toBe(false);
	});

	it("GET returns the stored value", async () => {
		const { env } = makeRouteEnv(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }),
		);
		const res = await settingsApp.request("/", { method: "GET" }, env);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.debug_request_body_log).toBe(true);
	});

	it("PUT accepts strict booleans and stores the normalized string", async () => {
		const { env, runs } = makeRouteEnv();
		const res = await settingsApp.request(
			"/",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ debug_request_body_log: true }),
			},
			env,
		);
		expect(res.status).toBe(200);
		const upsert = runs.find((r) => r.sql.includes("INSERT INTO settings"));
		expect(upsert?.args[0]).toBe(DEBUG_REQUEST_BODY_LOG_KEY);
		expect(upsert?.args[1]).toBe("true");

		const off = await settingsApp.request(
			"/",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ debug_request_body_log: "false" }),
			},
			env,
		);
		expect(off.status).toBe(200);
		const offUpsert = runs
			.filter((r) => r.sql.includes("INSERT INTO settings"))
			.at(-1);
		expect(offUpsert?.args[1]).toBe("false");
	});

	it("PUT rejects 0/1 and any non-boolean value with 400 invalid_debug_request_body_log", async () => {
		const { env, runs } = makeRouteEnv();
		for (const invalid of [0, 1, "0", "1", "yes", null, { a: 1 }]) {
			const res = await settingsApp.request(
				"/",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ debug_request_body_log: invalid }),
				},
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.code).toBe("invalid_debug_request_body_log");
		}
		expect(runs).toHaveLength(0);
	});

	it("service setter stores strict boolean strings", async () => {
		const { db, runs } = makeDb([]);
		await setDebugRequestBodyLog(db, true);
		await setDebugRequestBodyLog(db, false);
		expect(runs.map((r) => r.args[1])).toEqual(["true", "false"]);
	});
});
