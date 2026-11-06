import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import settingsApp from "../apps/worker/src/routes/settings";
import {
	DEFAULT_STATS_RETENTION_DAYS,
	getStatsRetentionDays,
	MAX_STATS_RETENTION_DAYS,
	MIN_STATS_RETENTION_DAYS,
	setStatsRetentionDays,
	STATS_RETENTION_KEY,
} from "../apps/worker/src/services/settings";
import { runDailyMaintenance } from "../apps/worker/src/services/usage-stats";

/**
 * stats_retention_days 设置管道（任务 11-06-stats-retention-days，prd R1/R2/AC2/AC3）：
 * getter 两级读取链（settings → 缺失/脏值默认 180，越界整数 clamp [1,365]，无 env
 * 回退）、GET 直读表单真相、PUT 严格整数 1–365 校验（非法 400
 * invalid_stats_retention_days）。样板镜像 developer-role-setting.test.ts。
 */

type SettingRow = { key: string; value: string | null };

/** settings 读（key-IN all() + 单键 first()）+ run() 捕获的最小 D1 mock。 */
function makeDb(rows: SettingRow[] = []) {
	const runs: Array<{ sql: string; args: unknown[] }> = [];
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
	return { db: db as unknown as D1Database, runs };
}

function settingRows(entries: Record<string, string>): SettingRow[] {
	return Object.entries(entries).map(([key, value]) => ({ key, value }));
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

describe("getStatsRetentionDays — read-side matrix (default 180, clamp [1,365])", () => {
	it("falls back to the 180-day default when the key is missing or dirty", async () => {
		// 缺失 → 180（不设置该键 = 既有 180d 行为逐字节一致，prd AC2）
		expect(await getStatsRetentionDays(makeDb([]).db)).toBe(180);
		// 脏值（非数字 / 非整数 / null 值列）→ 默认 180，不抛错
		expect(
			await getStatsRetentionDays(
				makeDb(settingRows({ [STATS_RETENTION_KEY]: "banana" })).db,
			),
		).toBe(DEFAULT_STATS_RETENTION_DAYS);
		expect(
			await getStatsRetentionDays(
				makeDb(settingRows({ [STATS_RETENTION_KEY]: "1.5" })).db,
			),
		).toBe(DEFAULT_STATS_RETENTION_DAYS);
		expect(
			await getStatsRetentionDays(
				makeDb([{ key: STATS_RETENTION_KEY, value: null }]).db,
			),
		).toBe(DEFAULT_STATS_RETENTION_DAYS);
	});

	it("returns the stored value and clamps hand-edited out-of-range rows", async () => {
		expect(
			await getStatsRetentionDays(
				makeDb(settingRows({ [STATS_RETENTION_KEY]: "10" })).db,
			),
		).toBe(10);
		// 手工改库的越界整数 → clamp 到 [1,365]（读宽写严的读侧体现）
		expect(
			await getStatsRetentionDays(
				makeDb(settingRows({ [STATS_RETENTION_KEY]: "0" })).db,
			),
		).toBe(MIN_STATS_RETENTION_DAYS);
		expect(
			await getStatsRetentionDays(
				makeDb(settingRows({ [STATS_RETENTION_KEY]: "400" })).db,
			),
		).toBe(MAX_STATS_RETENTION_DAYS);
	});
});

describe("settings route — stats_retention_days CRUD", () => {
	type RequestEnv = Parameters<typeof settingsApp.request>[2];

	function makeRouteEnv(rows: SettingRow[] = []): {
		env: RequestEnv;
		runs: Array<{ sql: string; args: unknown[] }>;
	} {
		const { db, runs } = makeDb(rows);
		return { env: { DB: db } as unknown as RequestEnv, runs };
	}

	it("GET returns the 180 default when unset", async () => {
		const { env } = makeRouteEnv();
		const res = await settingsApp.request("/", { method: "GET" }, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.stats_retention_days).toBe(180);
	});

	it("GET returns the clamped effective value (admin form truth)", async () => {
		const { env } = makeRouteEnv(
			settingRows({ [STATS_RETENTION_KEY]: "400" }),
		);
		const res = await settingsApp.request("/", { method: "GET" }, env);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.stats_retention_days).toBe(365);
	});

	it("PUT accepts integers in [1,365] and stores the stringified value", async () => {
		const { env, runs } = makeRouteEnv();
		for (const valid of [1, 180, 365, "10"]) {
			const res = await settingsApp.request(
				"/",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ stats_retention_days: valid }),
				},
				env,
			);
			expect(res.status).toBe(200);
		}
		const upserts = runs.filter((r) =>
			r.sql.includes("INSERT INTO settings"),
		);
		expect(upserts.map((r) => r.args[0])).toEqual([
			STATS_RETENTION_KEY,
			STATS_RETENTION_KEY,
			STATS_RETENTION_KEY,
			STATS_RETENTION_KEY,
		]);
		expect(upserts.map((r) => r.args[1])).toEqual(["1", "180", "365", "10"]);
	});

	it("PUT rejects non-integers and out-of-range values with 400 invalid_stats_retention_days, writing nothing", async () => {
		const { env, runs } = makeRouteEnv();
		// prd AC3 矩阵："abc" / 0 / 366 / 1.5（+ null / 对象）
		for (const invalid of ["abc", 0, 366, 1.5, null, { a: 1 }]) {
			const res = await settingsApp.request(
				"/",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ stats_retention_days: invalid }),
				},
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.code).toBe("invalid_stats_retention_days");
		}
		expect(runs).toHaveLength(0);
	});

	it("PUT 10 then GET echoes 10 immediately (uncached same-binding read)", async () => {
		const rows: SettingRow[] = [];
		const db = makeMutableSettingsDb(rows);
		const env = { DB: db } as unknown as RequestEnv;

		const before = await settingsApp.request("/", { method: "GET" }, env);
		expect(
			((await before.json()) as Record<string, unknown>)
				.stats_retention_days,
		).toBe(180);

		const put = await settingsApp.request(
			"/",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ stats_retention_days: 10 }),
			},
			env,
		);
		expect(put.status).toBe(200);

		const after = await settingsApp.request("/", { method: "GET" }, env);
		expect(
			((await after.json()) as Record<string, unknown>)
				.stats_retention_days,
		).toBe(10);
	});
});

describe("setStatsRetentionDays — write side", () => {
	it("upserts the stringified integer under the stats key", async () => {
		const { db, runs } = makeDb([]);
		await setStatsRetentionDays(db, 10);
		expect(runs).toHaveLength(1);
		expect(runs[0].args[0]).toBe(STATS_RETENTION_KEY);
		expect(runs[0].args[1]).toBe("10");
	});
});

describe("runDailyMaintenance — rollup prune consumes the setting", () => {
	it("reads stats_retention_days once per run (single-key direct read, cron cold path)", async () => {
		// 每次维护链恰一次对该键的读查询：prepare 计数锚定读侧形态，
		// 防止将来被误接进 loadProxySettingsCached 缓存链外的重复查询
		const rows = settingRows({ [STATS_RETENTION_KEY]: "10" });
		let reads = 0;
		const db = {
			prepare(sql: string) {
				const stmt = {
					boundArgs: [] as unknown[],
					bind: (...args: unknown[]) => {
						stmt.boundArgs = args;
						return stmt;
					},
					all: async () => {
						if (
							sql.includes("FROM settings") &&
							stmt.boundArgs[0] === STATS_RETENTION_KEY
						) {
							reads += 1;
						}
						return { results: [] };
					},
					first: async () => {
						if (
							sql.includes("FROM settings") &&
							stmt.boundArgs[0] === STATS_RETENTION_KEY
						) {
							reads += 1;
							return rows[0];
						}
						return null;
					},
					run: async () => ({}),
				};
				return stmt;
			},
			async batch(
				statements: Array<{ run(): Promise<unknown> }>,
			): Promise<unknown[]> {
				return Promise.all(statements.map((s) => s.run()));
			},
		} as unknown as D1Database;

		const errSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await runDailyMaintenance(db, new Date("2026-10-20T03:17:00.000Z"));
		} finally {
			errSpy.mockRestore();
			warnSpy.mockRestore();
			logSpy.mockRestore();
		}
		expect(reads).toBe(1);
	});
});
