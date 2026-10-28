import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import backupApp from "../apps/worker/src/routes/backup";
import modelsApp from "../apps/worker/src/routes/models";
import settingsApp from "../apps/worker/src/routes/settings";
import {
	extractModelPricings,
	modelsToJson,
} from "../apps/worker/src/services/channel-models";
import {
	calculateCost,
	getModelPrice,
	type ModelPriceInfo,
} from "../apps/worker/src/services/pricing";
import {
	CACHE_READ_RATIO_KEY,
	CACHE_WRITE_RATIO_KEY,
	loadCacheRatioConfigDirect,
	MAX_CACHE_RATIO,
	PROXY_SETTING_KEYS,
	resolveCacheRatioConfig,
	type SettingsRawMap,
} from "../apps/worker/src/services/settings";

/**
 * 缓存 token 折价计费（task 10-28-cache-token-billing）：
 * ① calculateCost 公式矩阵（仅读 / 仅写 / 读写混合 / NULL 短路 / 倍率覆盖 /
 *    每模型绝对价覆盖 / 负余量钳制 / totalTokens 回退）；
 * ② 零回归对照：cache 双零 + 倍率缺省时与改造前公式逐值相等（toBe 严格
 *    浮点相等，含 totalTokens-only 均值价回退路径）；
 * ③ settings 两键 clamp / 脏值降 1 / GET 直读 / PUT 严格校验；
 * ④ PUT /api/models/prices cache 字段三态（保留 / 清除 / 设置）；
 * ⑤ 含 cache 字段 models_json 的备份导出/导入 round-trip（字节保真）。
 */

const BASE_PRICE: ModelPriceInfo = { input_price: 2, output_price: 8 };

/** 改造前公式逐字节参照（旧 calculateCost 原样，锚定零回归）。 */
function legacyCost(
	price: ModelPriceInfo,
	promptTokens: number,
	completionTokens: number,
	totalTokens?: number,
): number {
	if (
		promptTokens === 0 &&
		completionTokens === 0 &&
		totalTokens &&
		totalTokens > 0
	) {
		const avgPrice = (price.input_price + price.output_price) / 2;
		return (totalTokens / 1_000_000) * avgPrice;
	}
	const inputCost = (promptTokens / 1_000_000) * price.input_price;
	const outputCost = (completionTokens / 1_000_000) * price.output_price;
	return inputCost + outputCost;
}

describe("calculateCost — 公式矩阵", () => {
	it("read-only cache: nonCached remainder pays input price, cache pays ratio price", () => {
		// prompt=1200（含缓存总输入口径）读 1000 → 非缓存 200
		const cost = calculateCost(BASE_PRICE, 1200, 500, 1700, 1000, null, {
			readRatio: 1,
			writeRatio: 1,
		});
		expect(cost).toBe(
			(200 / 1_000_000) * 2 +
				(1000 / 1_000_000) * 2 +
				0 +
				(500 / 1_000_000) * 8,
		);
	});

	it("write-only cache: write ratio 1.25 prices above input price", () => {
		const cost = calculateCost(BASE_PRICE, 1200, 500, 1700, null, 200, {
			readRatio: 1,
			writeRatio: 1.25,
		});
		expect(cost).toBe(
			(1000 / 1_000_000) * 2 +
				(0 / 1_000_000) * 2 +
				(200 / 1_000_000) * 2.5 +
				(500 / 1_000_000) * 8,
		);
	});

	it("mixed read+write with per-model absolute prices overriding wrong ratios", () => {
		// Anthropic Sonnet 形态：读 0.1×、写 1.25× 用绝对价表达；倍率故意
		// 设成 0.1/10 证明绝对价优先于全局倍率
		const price: ModelPriceInfo = {
			input_price: 3,
			output_price: 15,
			cache_read_price: 0.3,
			cache_write_price: 3.75,
		};
		const cost = calculateCost(price, 1200, 500, 1700, 1000, 200, {
			readRatio: 0.1,
			writeRatio: 10,
		});
		expect(cost).toBe(
			(0 / 1_000_000) * 3 +
				(1000 / 1_000_000) * 0.3 +
				(200 / 1_000_000) * 3.75 +
				(500 / 1_000_000) * 15,
		);
	});

	it("ratio override applies when the model has no cache price fields", () => {
		const cost = calculateCost(BASE_PRICE, 1000, 200, 1300, 600, 100, {
			readRatio: 0.5,
			writeRatio: 2,
		});
		expect(cost).toBe(
			(300 / 1_000_000) * 2 +
				(600 / 1_000_000) * 1 +
				(100 / 1_000_000) * 4 +
				(200 / 1_000_000) * 8,
		);
	});

	it("null cache fields short-circuit into the legacy formula verbatim", () => {
		// 倍率故意非默认：NULL 字段必须走短路守卫，倍率不得参与
		const cost = calculateCost(BASE_PRICE, 1200, 500, 1700, null, null, {
			readRatio: 0.1,
			writeRatio: 1.25,
		});
		expect(cost).toBe(legacyCost(BASE_PRICE, 1200, 500, 1700));
	});

	it("negative remainder clamps to zero when cache tokens exceed prompt", () => {
		// 异常上游兜底：cached ⊆ prompt 口径被破坏时不产生负输入计费
		const cost = calculateCost(BASE_PRICE, 1200, 500, 1700, 800, 800, {
			readRatio: 1,
			writeRatio: 1,
		});
		expect(cost).toBe(
			(0 / 1_000_000) * 2 +
				(800 / 1_000_000) * 2 +
				(800 / 1_000_000) * 2 +
				(500 / 1_000_000) * 8,
		);
	});

	it("totalTokens-only fallback ignores cache args (average price, no split)", () => {
		const cost = calculateCost(BASE_PRICE, 0, 0, 1000, 500, 0, {
			readRatio: 0.1,
			writeRatio: 1.25,
		});
		expect(cost).toBe(legacyCost(BASE_PRICE, 0, 0, 1000));
		expect(cost).toBe((1000 / 1_000_000) * 5);
	});

	it("omitted ratios default to 1 (full input price)", () => {
		const cost = calculateCost(BASE_PRICE, 1200, 500, 1700, 1000, 200);
		expect(cost).toBe(
			(0 / 1_000_000) * 2 +
				(1000 / 1_000_000) * 2 +
				(200 / 1_000_000) * 2 +
				(500 / 1_000_000) * 8,
		);
	});
});

describe("calculateCost — 零回归对照", () => {
	const priceMatrix: ModelPriceInfo[] = [
		BASE_PRICE,
		{ input_price: 0.5, output_price: 2 },
		{ input_price: 3, output_price: 15, cache_read_price: 0.3 },
	];
	const comboMatrix: Array<[number, number, number | undefined]> = [
		[0, 0, undefined],
		[0, 0, 1000],
		[1200, 500, undefined],
		[1200, 500, 1700],
		[1, 1, 2],
		[999999, 12345, 1012344],
	];

	it("matches the legacy formula value-for-value (args omitted)", () => {
		for (const price of priceMatrix) {
			for (const [p, c, total] of comboMatrix) {
				expect(calculateCost(price, p, c, total)).toBe(
					legacyCost(price, p, c, total),
				);
			}
		}
	});

	it("matches the legacy formula with explicit null cache args and default ratios", () => {
		for (const price of priceMatrix) {
			for (const [p, c, total] of comboMatrix) {
				expect(
					calculateCost(price, p, c, total, null, null, {
						readRatio: 1,
						writeRatio: 1,
					}),
				).toBe(legacyCost(price, p, c, total));
			}
		}
	});

	it("zero cache args with zeroed prompt/completion and no total stays at 0", () => {
		expect(calculateCost(BASE_PRICE, 0, 0, undefined, 0, 0)).toBe(0);
	});
});

describe("getModelPrice — cache 字段透传与无定价判定", () => {
	const modelsJson = JSON.stringify([
		{
			id: "claude-sonnet",
			input_price: 3,
			output_price: 15,
			cache_read_price: 0.3,
			cache_write_price: 3.75,
		},
		{ id: "gpt-4o", input_price: 2, output_price: 8 },
		{ id: "cache-only", cache_read_price: 0.3 },
	]);

	it("carries per-model cache prices through", () => {
		const price = getModelPrice(modelsJson, "claude-sonnet");
		expect(price).not.toBeNull();
		expect(price?.input_price).toBe(3);
		expect(price?.output_price).toBe(15);
		expect(price?.cache_read_price).toBe(0.3);
		expect(price?.cache_write_price).toBe(3.75);
	});

	it("omits cache fields when the entry has none", () => {
		const price = getModelPrice(modelsJson, "gpt-4o");
		expect(price).not.toBeNull();
		expect(price?.cache_read_price).toBeUndefined();
		expect(price?.cache_write_price).toBeUndefined();
	});

	it("treats a cache-price-only entry as unpriced (input/output null semantics kept)", () => {
		expect(getModelPrice(modelsJson, "cache-only")).toBeNull();
	});
});

describe("resolveCacheRatioConfig — clamp [0,100] 与脏值降 1", () => {
	it("covers the read-wide matrix", () => {
		// 缺失 → 默认 1（全价 = 现行为）
		expect(resolveCacheRatioConfig({})).toEqual({
			readRatio: 1,
			writeRatio: 1,
		});
		const matrix: Array<[string, string | null, number]> = [
			[CACHE_READ_RATIO_KEY, "1", 1],
			[CACHE_READ_RATIO_KEY, "0", 0],
			[CACHE_READ_RATIO_KEY, "1.25", 1.25],
			[CACHE_READ_RATIO_KEY, "100", 100],
			[CACHE_READ_RATIO_KEY, "150", 100],
			[CACHE_READ_RATIO_KEY, "0.1", 0.1],
			// 脏值一律降 1（非 0 回退——负值不允许被解释成「免费」）
			[CACHE_READ_RATIO_KEY, "-5", 1],
			[CACHE_READ_RATIO_KEY, "abc", 1],
			[CACHE_READ_RATIO_KEY, "", 1],
			[CACHE_READ_RATIO_KEY, null, 1],
			[CACHE_WRITE_RATIO_KEY, "1.25", 1.25],
			[CACHE_WRITE_RATIO_KEY, "200", 100],
			[CACHE_WRITE_RATIO_KEY, "-1", 1],
			[CACHE_WRITE_RATIO_KEY, "banana", 1],
		];
		for (const [key, value, expected] of matrix) {
			const raw: SettingsRawMap = { [key]: value };
			const config = resolveCacheRatioConfig(raw);
			const expectedConfig =
				key === CACHE_READ_RATIO_KEY
					? { readRatio: expected, writeRatio: 1 }
					: { readRatio: 1, writeRatio: expected };
			expect(config).toEqual(expectedConfig);
		}
	});

	it("non-finite numbers degrade to the default (Infinity protection)", () => {
		expect(resolveCacheRatioConfig({ [CACHE_READ_RATIO_KEY]: "Infinity" }))
			.toEqual({ readRatio: 1, writeRatio: 1 });
	});

	it("both keys are in PROXY_SETTING_KEYS (shared single query)", () => {
		expect(PROXY_SETTING_KEYS).toContain(CACHE_READ_RATIO_KEY);
		expect(PROXY_SETTING_KEYS).toContain(CACHE_WRITE_RATIO_KEY);
		expect(PROXY_SETTING_KEYS).toHaveLength(9);
	});
});

type SettingRow = { key: string; value: string | null };

/** settings 读（key-IN all() + 单键 first()）+ run() 捕获的最小 D1 mock。 */
function makeSettingsDb(rows: SettingRow[] = []) {
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

describe("loadCacheRatioConfigDirect — GET 表单真相（直读不走缓存）", () => {
	it("returns clamped values and defaults for missing keys", async () => {
		const { db } = makeSettingsDb([
			{ key: CACHE_READ_RATIO_KEY, value: "150" },
			{ key: CACHE_WRITE_RATIO_KEY, value: "0.5" },
		]);
		expect(await loadCacheRatioConfigDirect(db)).toEqual({
			readRatio: 100,
			writeRatio: 0.5,
		});
		expect(await loadCacheRatioConfigDirect(makeSettingsDb([]).db)).toEqual({
			readRatio: 1,
			writeRatio: 1,
		});
	});

	it("reads strictly from the db on every call (no memoization)", async () => {
		const rows: SettingRow[] = [{ key: CACHE_READ_RATIO_KEY, value: "1" }];
		const { db, prepareCount } = makeSettingsDb(rows);
		expect(await loadCacheRatioConfigDirect(db)).toEqual({
			readRatio: 1,
			writeRatio: 1,
		});
		rows[0].value = "0.1";
		expect(await loadCacheRatioConfigDirect(db)).toEqual({
			readRatio: 0.1,
			writeRatio: 1,
		});
		expect(prepareCount()).toBe(2);
	});

	it("binds both keys in a single key-IN query", async () => {
		const captured: Array<{ sql: string; args: unknown[] }> = [];
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
							captured.push({ sql, args: stmt.boundArgs });
						}
						return { results: [] };
					},
				};
				return stmt;
			},
		};
		await loadCacheRatioConfigDirect(db as unknown as D1Database);
		expect(captured).toHaveLength(1);
		expect(captured[0].sql).toContain("key IN (?, ?)");
		expect(captured[0].args).toEqual([
			CACHE_READ_RATIO_KEY,
			CACHE_WRITE_RATIO_KEY,
		]);
	});
});

describe("settings 路由 — cache_read_ratio / cache_write_ratio GET 与 PUT 校验", () => {
	type RequestEnv = Parameters<typeof settingsApp.request>[2];

	function makeRouteEnv(rows: SettingRow[] = []): {
		env: RequestEnv;
		runs: Array<{ sql: string; args: unknown[] }>;
	} {
		const { db, runs } = makeSettingsDb(rows);
		return { env: { DB: db } as unknown as RequestEnv, runs };
	}

	it("GET returns clamped effective values (admin form truth)", async () => {
		const { env } = makeRouteEnv([
			{ key: CACHE_READ_RATIO_KEY, value: "150" },
			{ key: CACHE_WRITE_RATIO_KEY, value: "0" },
		]);
		const res = await settingsApp.request("/", { method: "GET" }, env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.cache_read_ratio).toBe(MAX_CACHE_RATIO);
		expect(body.cache_write_ratio).toBe(0);
	});

	it("GET returns the default 1 when both keys are missing", async () => {
		const { env } = makeRouteEnv();
		const res = await settingsApp.request("/", { method: "GET" }, env);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.cache_read_ratio).toBe(1);
		expect(body.cache_write_ratio).toBe(1);
	});

	it("PUT accepts 0 / fractions / 100 and stores the stringified value", async () => {
		const { env, runs } = makeRouteEnv();
		for (const [key, value, stored] of [
			[CACHE_READ_RATIO_KEY, 0, "0"],
			[CACHE_READ_RATIO_KEY, 1.25, "1.25"],
			[CACHE_WRITE_RATIO_KEY, 100, "100"],
		] as const) {
			const res = await settingsApp.request(
				"/",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ [key]: value }),
				},
				env,
			);
			expect(res.status).toBe(200);
		}
		const upserts = runs.filter((r) => r.sql.includes("INSERT INTO settings"));
		expect(upserts.map((r) => [r.args[0], r.args[1]])).toEqual([
			[CACHE_READ_RATIO_KEY, "0"],
			[CACHE_READ_RATIO_KEY, "1.25"],
			[CACHE_WRITE_RATIO_KEY, "100"],
		]);
	});

	it("PUT rejects negative / out-of-range / non-numeric values with 400", async () => {
		const { env, runs } = makeRouteEnv();
		for (const [key, invalid] of [
			["cache_read_ratio", -1],
			["cache_read_ratio", 101],
			["cache_read_ratio", "abc"],
			["cache_write_ratio", -0.5],
			["cache_write_ratio", 10000],
			["cache_write_ratio", "1.5x"],
		] as const) {
			const res = await settingsApp.request(
				"/",
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ [key]: invalid }),
				},
				env,
			);
			expect(res.status).toBe(400);
			const body = (await res.json()) as Record<string, unknown>;
			expect(body.code).toBe(`invalid_${key}`);
		}
		expect(runs).toHaveLength(0);
	});
});

/** models 路由 mock：SELECT models_json first() + batch 捕获。 */
function makeModelsDb(modelsJson: string) {
	const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
	const db = {
		prepare(sql: string) {
			const stmt = {
				sql,
				boundArgs: [] as unknown[],
				bind: (...args: unknown[]) => {
					stmt.boundArgs = args;
					return stmt;
				},
				first: async () => {
					if (sql.includes("SELECT models_json FROM channels")) {
						return { models_json: modelsJson };
					}
					return null;
				},
				run: async () => ({}),
			};
			return stmt;
		},
		batch: async (
			stmts: Array<{ sql: string; boundArgs: unknown[] }>,
		): Promise<unknown[]> => {
			batches.push(
				stmts.map((s) => ({ sql: s.sql, args: s.boundArgs ?? [] })),
			);
			return [];
		},
	};
	return {
		db: db as unknown as D1Database,
		batches,
	};
}

describe("PUT /api/models/prices — cache 字段三态", () => {
	type RequestEnv = Parameters<typeof modelsApp.request>[2];

	function putPrices(
		env: RequestEnv,
		prices: Record<string, unknown>[],
	): Promise<Response> {
		return modelsApp.request(
			"/prices/m",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prices }),
			},
			env,
		);
	}

	function updatedJson(
		batches: Array<Array<{ sql: string; args: unknown[] }>>,
	): Record<string, unknown> {
		const update = batches[0].find((s) =>
			s.sql.startsWith("UPDATE channels"),
		);
		expect(update).toBeDefined();
		return JSON.parse(String(update?.args[0])) as Record<string, unknown>;
	}

	const CHANNEL_JSON = JSON.stringify([
		{
			id: "m",
			input_price: 2,
			output_price: 8,
			cache_read_price: 0.5,
			cache_write_price: 3,
		},
	]);

	it("undefined cache fields keep the stored values (保留态)", async () => {
		const { db, batches } = makeModelsDb(CHANNEL_JSON);
		const res = await putPrices(
			{ DB: db } as unknown as RequestEnv,
			[{ channel_id: "ch1", input_price: 2, output_price: 8 }],
		);
		expect(res.status).toBe(200);
		const entry = updatedJson(batches)[0] as Record<string, unknown>;
		expect(entry.cache_read_price).toBe(0.5);
		expect(entry.cache_write_price).toBe(3);
	});

	it("null cache fields clear to fall back to the global ratio (清除态)", async () => {
		const { db, batches } = makeModelsDb(CHANNEL_JSON);
		const res = await putPrices(
			{ DB: db } as unknown as RequestEnv,
			[
				{
					channel_id: "ch1",
					input_price: 2,
					output_price: 8,
					cache_read_price: null,
				},
			],
		);
		expect(res.status).toBe(200);
		const entry = updatedJson(batches)[0] as Record<string, unknown>;
		expect(entry.cache_read_price).toBeUndefined();
		expect(entry.cache_write_price).toBe(3);
		// 清除后 re-parse 不再有该字段（回落全局倍率路径）
		const parsed = extractModelPricings({
			models_json: JSON.stringify([entry]),
		});
		expect(parsed[0]?.cache_read_price).toBeUndefined();
		expect(parsed[0]?.cache_write_price).toBe(3);
	});

	it("numbers set the absolute override (设置态)", async () => {
		const { db, batches } = makeModelsDb(CHANNEL_JSON);
		const res = await putPrices(
			{ DB: db } as unknown as RequestEnv,
			[
				{
					channel_id: "ch1",
					input_price: 2,
					output_price: 8,
					cache_read_price: 1.5,
					cache_write_price: null,
				},
			],
		);
		expect(res.status).toBe(200);
		const entry = updatedJson(batches)[0] as Record<string, unknown>;
		expect(entry.cache_read_price).toBe(1.5);
		expect(entry.cache_write_price).toBeUndefined();
	});

	it("modelsToJson round-trips parsed cache prices (序列化 != null 才写出)", () => {
		const pricings = extractModelPricings({
			models_json: CHANNEL_JSON,
		});
		expect(modelsToJson(pricings)).toBe(CHANNEL_JSON);
	});
});

/** 备份路由 mock：渠道 all() + batch 捕获（同 backup-restore.test.ts 形态）。 */
function makeBackupDb(channels: Record<string, unknown>[]) {
	const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
	const db = {
		prepare(sql: string) {
			const stmt = {
				sql,
				boundArgs: [] as unknown[],
				bind: (...args: unknown[]) => {
					stmt.boundArgs = args;
					return stmt;
				},
				all: async () => {
					if (sql.includes("FROM channels")) {
						return { results: channels };
					}
					return { results: [] };
				},
				first: async () => null,
				run: async () => ({}),
			};
			return stmt;
		},
		batch: async (
			stmts: Array<{ sql: string; boundArgs: unknown[] }>,
		): Promise<unknown[]> => {
			batches.push(
				stmts.map((s) => ({ sql: s.sql, args: s.boundArgs ?? [] })),
			);
			return [];
		},
	};
	return {
		db: db as unknown as D1Database,
		batches,
	};
}

describe("备份 round-trip — 含 cache 字段的 models_json", () => {
	type RequestEnv = Parameters<typeof backupApp.request>[2];

	const CACHE_MODELS_JSON = JSON.stringify([
		{
			id: "claude-sonnet",
			input_price: 3,
			output_price: 15,
			cache_read_price: 0.3,
			cache_write_price: 3.75,
		},
		{ id: "gpt-4o", input_price: 2, output_price: 8 },
	]);

	function makeCacheChannel(): Record<string, unknown> {
		return {
			id: "ch_cache",
			name: "cache-channel",
			base_url: "https://cache.example.com/v1",
			api_key: "sk-cache-secret",
			weight: 1,
			status: "active",
			rate_limit: null,
			models_json: CACHE_MODELS_JSON,
			type: 1,
			group_name: null,
			priority: 0,
			metadata_json: null,
			test_time: null,
			response_time_ms: null,
			api_format: "openai",
			api_formats: '["openai"]',
			endpoint_overrides: null,
			custom_headers_json: null,
			disguise_headers_json: null,
			disguise_system_prompt: null,
			disguise_preset: null,
			stream_only: 0,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
		};
	}

	async function roundTrip() {
		const exportDb = makeBackupDb([makeCacheChannel()]);
		const exportRes = await backupApp.request(
			"/export",
			{ method: "GET" },
			{ DB: exportDb.db } as unknown as RequestEnv,
		);
		expect(exportRes.status).toBe(200);
		const payload = (await exportRes.json()) as Record<string, unknown>;

		const importDb = makeBackupDb([]);
		const importRes = await backupApp.request(
			"/import",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			},
			{ DB: importDb.db } as unknown as RequestEnv,
		);
		expect(importRes.status).toBe(200);
		return { payload, importBatches: importDb.batches };
	}

	it("export keeps models_json verbatim (cache fields inside the string)", async () => {
		const { payload } = await roundTrip();
		const channels = payload.channels as Record<string, unknown>[];
		expect(channels[0].models_json).toBe(CACHE_MODELS_JSON);
	});

	it("import re-binds the identical string and the parsed prices serve billing", async () => {
		const { importBatches } = await roundTrip();
		const insert = importBatches[0].find((s) =>
			s.sql.startsWith("INSERT INTO channels"),
		);
		expect(insert).toBeDefined();
		const modelsJson = String(insert?.args[7]);
		expect(modelsJson).toBe(CACHE_MODELS_JSON);
		// 恢复后的定价行直接可被 getModelPrice 消费（计费链可用）
		const price = getModelPrice(modelsJson, "claude-sonnet");
		expect(price).toEqual({
			input_price: 3,
			output_price: 15,
			cache_read_price: 0.3,
			cache_write_price: 3.75,
		});
	});

	it("an old backup without cache fields still imports (missing = ratio fallback)", async () => {
		const legacyJson = '[{"id":"gpt-4o","input_price":2,"output_price":8}]';
		const importDb = makeBackupDb([]);
		const res = await backupApp.request(
			"/import",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					version: 1,
					channels: [{ ...makeCacheChannel(), models_json: legacyJson }],
					model_aliases: [],
					channel_model_aliases: [],
					settings: {},
				}),
			},
			{ DB: importDb.db } as unknown as RequestEnv,
		);
		expect(res.status).toBe(200);
		const insert = importDb.batches[0].find((s) =>
			s.sql.startsWith("INSERT INTO channels"),
		);
		expect(insert?.args[7]).toBe(legacyJson);
		const parsed = extractModelPricings({
			models_json: String(insert?.args[7]),
		});
		expect(parsed[0]?.cache_read_price).toBeUndefined();
	});
});
