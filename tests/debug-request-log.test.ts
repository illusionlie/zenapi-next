import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import worker from "../apps/worker/src/index";
import settingsApp from "../apps/worker/src/routes/settings";
import {
	DEBUG_REQUEST_BODY_LOG_KEY,
	loadDebugLogFlag,
	loadDebugLogFlagDirect,
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

	it("non-JSON text bodies report body_type text with a real size (dead fallback revived)", async () => {
		// 回归（F1）：raw.json() 按 Fetch 规范先消费 body 再 parse，旧代码在
		// 同一 clone 上回退 raw.text() 必抛 Body is unusable → 非 JSON body
		// 恒为 unreadable 且拿不到 body_size
		const { env } = makeWorkerEnv(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }),
		);
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});

		const res = await worker.fetch(
			new Request(PROBE_PATH, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "not json at all",
			}),
			env,
		);

		expect(res.status).toBe(404);
		const logs = countRequestLogs(logSpy);
		expect(logs).toHaveLength(1);
		expect(logs[0].body_type).toBe("text");
		expect(logs[0].body_size).toBe("not json at all".length);
		expect(logs[0].body_keys).toEqual([]);
	});

	it("form-urlencoded bodies also report text with a real size", async () => {
		const { env } = makeWorkerEnv(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }),
		);
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});

		await worker.fetch(
			new Request(PROBE_PATH, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "grant_type=client_credentials&scope=read",
			}),
			env,
		);

		const logs = countRequestLogs(logSpy);
		expect(logs).toHaveLength(1);
		expect(logs[0].body_type).toBe("text");
		expect(logs[0].body_size).toBe(
			"grant_type=client_credentials&scope=read".length,
		);
	});

	it("JSON bodies keep the legacy shape (json + body_keys, size stays 0)", async () => {
		const { env } = makeWorkerEnv(
			settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "true" }),
		);
		const logSpy = vi
			.spyOn(console, "log")
			.mockImplementation(() => {});

		await worker.fetch(
			new Request(PROBE_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "gpt-x", stream: true }),
			}),
			env,
		);

		const logs = countRequestLogs(logSpy);
		expect(logs).toHaveLength(1);
		expect(logs[0].body_type).toBe("json");
		expect(logs[0].body_keys).toEqual(["model", "stream"]);
		expect(logs[0].body_size).toBe(0);
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

	it("loadDebugLogFlagDirect re-reads on every call (admin form truth, no memoization)", async () => {
		// makeDb 闭包按引用捕获 rows，原地改值即生效
		const rows = settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "false" });
		const { db, prepareCount } = makeDb(rows);

		expect(await loadDebugLogFlagDirect(db)).toBe(false);
		rows[0].value = "true";
		expect(await loadDebugLogFlagDirect(db)).toBe(true);
		expect(prepareCount()).toBe(2); // 每次调用都打 DB，不经 TTL 缓存
	});

	it("loadDebugLogFlagDirect keeps the same fallback-chain semantics", async () => {
		expect(
			await loadDebugLogFlagDirect(
				makeDb(settingRows({ [DEBUG_REQUEST_BODY_LOG_KEY]: "false" })).db,
				{ debugRequestLog: "1" },
			),
		).toBe(false); // settings 优先于 env
		expect(
			await loadDebugLogFlagDirect(makeDb([]).db, { debugRequestLog: "yes" }),
		).toBe(true); // 缺失 → env 回退
		expect(await loadDebugLogFlagDirect(makeDb([]).db)).toBe(false); // 双缺 → 默认
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

	/** 可变 settings mock：run() 对 INSERT INTO settings 真实 upsert 进 rows。 */
	function makeMutableSettingsDb(rows: SettingRow[] = []) {
		const db = {
			prepare(sql: string) {
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
								results: keys
									.map((key) => rows.find((r) => r.key === key))
									.filter((row): row is SettingRow => Boolean(row))
									.map((row) => ({ key: row.key, value: row.value })),
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
						if (sql.includes("INSERT INTO settings")) {
							const [key, value] = stmt.boundArgs as [string, string];
							const existing = rows.find((r) => r.key === key);
							if (existing) {
								existing.value = value;
							} else {
								rows.push({ key, value });
							}
						}
						return {};
					},
				};
				return stmt;
			},
		};
		return db as unknown as D1Database;
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

	it("GET reads uncached (admin form truth): PUT then same-binding GET sees the new value immediately", async () => {
		// 回归（F2）：GET 旧走 30s TTL 缓存的 loadDebugLogFlag，PUT 后同
		// isolate 立即 GET 会看到陈旧 false。先用缓存路径预热同一 db 绑定的
		// 缓存条目（false 快照），若 GET 仍走缓存必拿陈旧值
		const rows: SettingRow[] = [];
		const db = makeMutableSettingsDb(rows);
		const env = { DB: db } as unknown as RequestEnv;

		await loadDebugLogFlag(db); // 预热缓存：raw = {} → false

		const before = await settingsApp.request("/", { method: "GET" }, env);
		expect(
			((await before.json()) as Record<string, unknown>)
				.debug_request_body_log,
		).toBe(false);

		const put = await settingsApp.request(
			"/",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ debug_request_body_log: true }),
			},
			env,
		);
		expect(put.status).toBe(200);

		const after = await settingsApp.request("/", { method: "GET" }, env);
		expect(after.status).toBe(200);
		expect(
			((await after.json()) as Record<string, unknown>)
				.debug_request_body_log,
		).toBe(true);
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
