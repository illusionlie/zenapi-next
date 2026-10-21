import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import settingsApp from "../apps/worker/src/routes/settings";
import {
	DEVELOPER_NORMALIZE_ROLE_KEY,
	loadDeveloperNormalizeFlagDirect,
	loadProxySettingsCached,
	resolveDeveloperNormalizeFlag,
	setDeveloperNormalizeFlag,
} from "../apps/worker/src/services/settings";

/**
 * normalize_developer_role 设置管道（design.md D1/D5、AC6/AC7）：两级读取链
 * （settings 严格布尔 → 缺失/脏值默认 false，无 env 回退）、GET 直读表单
 * 真相（绕 30s TTL 缓存）、PUT 严格布尔校验（非法 400）。样板镜像
 * debug-request-log.test.ts。
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

describe("resolveDeveloperNormalizeFlag — pure resolver matrix (two-level chain, no env tier)", () => {
	it("covers the read-wide matrix", () => {
		expect(
			resolveDeveloperNormalizeFlag({ [DEVELOPER_NORMALIZE_ROLE_KEY]: "true" }),
		).toBe(true);
		expect(
			resolveDeveloperNormalizeFlag({
				[DEVELOPER_NORMALIZE_ROLE_KEY]: "false",
			}),
		).toBe(false);
		// 缺失 → 默认 false
		expect(resolveDeveloperNormalizeFlag({})).toBe(false);
		// 脏值（含看似真值的字符串 / null）→ 一律降级 false，无 env 可回退
		expect(
			resolveDeveloperNormalizeFlag({ [DEVELOPER_NORMALIZE_ROLE_KEY]: "1" }),
		).toBe(false);
		expect(
			resolveDeveloperNormalizeFlag({
				[DEVELOPER_NORMALIZE_ROLE_KEY]: "banana",
			}),
		).toBe(false);
		expect(
			resolveDeveloperNormalizeFlag({ [DEVELOPER_NORMALIZE_ROLE_KEY]: null }),
		).toBe(false);
	});
});

describe("loadDeveloperNormalizeFlagDirect / setDeveloperNormalizeFlag", () => {
	it("reads strictly from the db and returns false when missing", async () => {
		expect(
			await loadDeveloperNormalizeFlagDirect(makeDb([]).db),
		).toBe(false);
		expect(
			await loadDeveloperNormalizeFlagDirect(
				makeDb(settingRows({ [DEVELOPER_NORMALIZE_ROLE_KEY]: "true" })).db,
			),
		).toBe(true);
		expect(
			await loadDeveloperNormalizeFlagDirect(
				makeDb(settingRows({ [DEVELOPER_NORMALIZE_ROLE_KEY]: "nope" })).db,
			),
		).toBe(false);
	});

	it("re-reads on every call (admin form truth, no memoization)", async () => {
		// makeDb 闭包按引用捕获 rows，原地改值即生效
		const rows = settingRows({ [DEVELOPER_NORMALIZE_ROLE_KEY]: "false" });
		const { db, prepareCount } = makeDb(rows);

		expect(await loadDeveloperNormalizeFlagDirect(db)).toBe(false);
		rows[0].value = "true";
		expect(await loadDeveloperNormalizeFlagDirect(db)).toBe(true);
		expect(prepareCount()).toBe(2); // 每次调用都打 DB，不经 TTL 缓存
	});

	it("service setter stores strict boolean strings", async () => {
		const { db, runs } = makeDb([]);
		await setDeveloperNormalizeFlag(db, true);
		await setDeveloperNormalizeFlag(db, false);
		expect(runs.map((r) => r.args[1])).toEqual(["true", "false"]);
		expect(runs.map((r) => r.args[0])).toEqual([
			DEVELOPER_NORMALIZE_ROLE_KEY,
			DEVELOPER_NORMALIZE_ROLE_KEY,
		]);
	});
});

describe("settings route — normalize_developer_role CRUD", () => {
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
		expect(body.normalize_developer_role).toBe(false);
	});

	it("GET returns the stored value", async () => {
		const { env } = makeRouteEnv(
			settingRows({ [DEVELOPER_NORMALIZE_ROLE_KEY]: "true" }),
		);
		const res = await settingsApp.request("/", { method: "GET" }, env);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.normalize_developer_role).toBe(true);
	});

	it("GET reads uncached (admin form truth): PUT then same-binding GET sees the new value immediately", async () => {
		// 预热 loadProxySettingsCached 的 30s TTL 快照（false）；GET 若走缓存
		// 必拿陈旧值——直读契约要求 PUT 后立即可见
		const rows: SettingRow[] = [];
		const db = makeMutableSettingsDb(rows);
		const env = { DB: db } as unknown as RequestEnv;

		await loadProxySettingsCached(db); // 预热缓存：raw 不含该键 → false

		const before = await settingsApp.request("/", { method: "GET" }, env);
		expect(
			((await before.json()) as Record<string, unknown>)
				.normalize_developer_role,
		).toBe(false);

		const put = await settingsApp.request(
			"/",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ normalize_developer_role: true }),
			},
			env,
		);
		expect(put.status).toBe(200);

		const after = await settingsApp.request("/", { method: "GET" }, env);
		expect(after.status).toBe(200);
		expect(
			((await after.json()) as Record<string, unknown>)
				.normalize_developer_role,
		).toBe(true);
	});

	it("PUT accepts strict booleans and stores the normalized string", async () => {
		const { env, runs } = makeRouteEnv();
		const res = await settingsApp.request(
			"/",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ normalize_developer_role: true }),
			},
			env,
		);
		expect(res.status).toBe(200);
		const upsert = runs.find((r) => r.sql.includes("INSERT INTO settings"));
		expect(upsert?.args[0]).toBe(DEVELOPER_NORMALIZE_ROLE_KEY);
		expect(upsert?.args[1]).toBe("true");

		const off = await settingsApp.request(
			"/",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ normalize_developer_role: "false" }),
			},
			env,
		);
		expect(off.status).toBe(200);
		const offUpsert = runs
			.filter((r) => r.sql.includes("INSERT INTO settings"))
			.at(-1);
		expect(offUpsert?.args[1]).toBe("false");
	});

	it("PUT rejects 0/1 and any non-boolean value with 400 invalid_normalize_developer_role", async () => {
		const { env, runs } = makeRouteEnv();
		for (const invalid of [0, 1, "0", "1", "yes", "TRUE", null, { a: 1 }]) {
			const res = await settingsApp.request(
				"/",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ normalize_developer_role: invalid }),
				},
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.code).toBe("invalid_normalize_developer_role");
		}
		expect(runs).toHaveLength(0);
	});
});
