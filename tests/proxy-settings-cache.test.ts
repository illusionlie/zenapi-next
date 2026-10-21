import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
	DEFAULT_PROXY_RETRY_DELAY_MS,
	DEFAULT_PROXY_RETRY_ROUNDS,
	DEVELOPER_NORMALIZE_ROLE_KEY,
	MAX_PROXY_RETRY_ROUNDS,
	PROXY_RETRY_DELAY_MS_KEY,
	PROXY_RETRY_ROUNDS_KEY,
	loadProxyRetryConfig,
	loadProxySettingsCached,
	resolveProxyRetryConfig,
} from "../apps/worker/src/services/settings";
import {
	PROXY_EXTRA_HEADERS_KEY,
	PROXY_REMOVE_HEADERS_KEY,
	parseHeaderPolicyFromRaw,
} from "../apps/worker/src/utils/proxy-headers";

/**
 * loadProxySettingsCached 契约（design.md）：只缓存 settings 表的 raw 读
 * （30s TTL）；三级回退链 / clamp / fail-open 解析保持纯函数，每次调用照常
 * 执行——既有 proxy-retry-settings / proxy-headers 测试零改动通过是硬验收。
 */

function makeSettingsDb(rows: Array<{ key: string; value: string | null }>) {
	let prepareCount = 0;
	const db = {
		prepare(sql: string) {
			prepareCount += 1;
			expect(sql).toContain("SELECT key, value FROM settings WHERE key IN");
			const stmt = {
				bind: (...keys: string[]) => ({
					all: async () => ({
						results: rows.filter((r) => keys.includes(r.key)),
					}),
				}),
			};
			return stmt;
		},
	};
	return { db: db as unknown as D1Database, prepareCount: () => prepareCount };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("loadProxySettingsCached", () => {
	it("serves the second read from cache without touching the DB", async () => {
		const { db, prepareCount } = makeSettingsDb([
			{ key: PROXY_RETRY_ROUNDS_KEY, value: "3" },
		]);

		const first = await loadProxySettingsCached(db);
		const second = await loadProxySettingsCached(db);

		expect(first[PROXY_RETRY_ROUNDS_KEY]).toBe("3");
		expect(second).toBe(first); // identical snapshot reference
		expect(prepareCount()).toBe(1); // hit path: zero D1 reads
	});

	it("re-reads after the 30s TTL expires (fake timers)", async () => {
		vi.useFakeTimers();
		const { db, prepareCount } = makeSettingsDb([]);

		await loadProxySettingsCached(db);
		expect(prepareCount()).toBe(1);

		vi.advanceTimersByTime(29_999);
		await loadProxySettingsCached(db);
		expect(prepareCount()).toBe(1); // still fresh

		vi.advanceTimersByTime(1);
		await loadProxySettingsCached(db);
		expect(prepareCount()).toBe(2); // expired → re-read
	});

	it("keeps caches per db binding (no cross-holder leakage)", async () => {
		const a = makeSettingsDb([{ key: PROXY_RETRY_ROUNDS_KEY, value: "1" }]);
		const b = makeSettingsDb([{ key: PROXY_RETRY_ROUNDS_KEY, value: "9" }]);

		const [fromA, fromB] = await Promise.all([
			loadProxySettingsCached(a.db),
			loadProxySettingsCached(b.db),
		]);

		expect(fromA[PROXY_RETRY_ROUNDS_KEY]).toBe("1");
		expect(fromB[PROXY_RETRY_ROUNDS_KEY]).toBe("9");
		expect(a.prepareCount()).toBe(1);
		expect(b.prepareCount()).toBe(1);
	});

	it("reads all five proxy keys in a single query", async () => {
		let boundKeys: string[] = [];
		const db = {
			prepare: (sql: string) => {
				expect(sql).toContain("WHERE key IN");
				return {
					bind: (...keys: string[]) => {
						boundKeys = keys;
						return {
							all: async () => ({ results: [] as unknown[] }),
						};
					},
				};
			},
		} as unknown as D1Database;

		await loadProxySettingsCached(db);
		expect(boundKeys).toEqual([
			PROXY_EXTRA_HEADERS_KEY,
			PROXY_REMOVE_HEADERS_KEY,
			PROXY_RETRY_ROUNDS_KEY,
			PROXY_RETRY_DELAY_MS_KEY,
			DEVELOPER_NORMALIZE_ROLE_KEY,
		]);
	});
});

describe("fallback chain stays uncached + pure resolver semantics", () => {
	it("loadProxyRetryConfig still hits the DB on every call (admin form truth)", async () => {
		const { db, prepareCount } = makeSettingsDb([
			{ key: PROXY_RETRY_ROUNDS_KEY, value: "5" },
			{ key: PROXY_RETRY_DELAY_MS_KEY, value: "100" },
		]);

		const first = await loadProxyRetryConfig(db);
		const second = await loadProxyRetryConfig(db);

		expect(first).toEqual({ rounds: 5, delayMs: 100 });
		expect(second).toEqual({ rounds: 5, delayMs: 100 });
		expect(prepareCount()).toBe(2); // NOT cached
	});

	it("resolveProxyRetryConfig walks settings → env → default with clamp", () => {
		// settings 优先于 env
		expect(
			resolveProxyRetryConfig(
				{ [PROXY_RETRY_ROUNDS_KEY]: "5", [PROXY_RETRY_DELAY_MS_KEY]: "100" },
				{ rounds: "9", delayMs: "900" },
			),
		).toEqual({ rounds: 5, delayMs: 100 });
		// settings 缺失 → env 回退
		expect(
			resolveProxyRetryConfig({}, { rounds: "7", delayMs: "250" }),
		).toEqual({ rounds: 7, delayMs: 250 });
		// 双缺 → 内置默认
		expect(resolveProxyRetryConfig({})).toEqual({
			rounds: DEFAULT_PROXY_RETRY_ROUNDS,
			delayMs: DEFAULT_PROXY_RETRY_DELAY_MS,
		});
		// 越界脏值 clamp（不抛错）
		expect(
			resolveProxyRetryConfig({
				[PROXY_RETRY_ROUNDS_KEY]: String(MAX_PROXY_RETRY_ROUNDS + 10),
			}),
		).toEqual({ rounds: MAX_PROXY_RETRY_ROUNDS, delayMs: DEFAULT_PROXY_RETRY_DELAY_MS });
		// 非整数字符串视为缺失 → 回退链下一级
		expect(
			resolveProxyRetryConfig({ [PROXY_RETRY_ROUNDS_KEY]: "2.5" }, { rounds: "4" }),
		).toEqual({ rounds: 4, delayMs: DEFAULT_PROXY_RETRY_DELAY_MS });
	});
});

describe("parseHeaderPolicyFromRaw", () => {
	it("parses extra + remove from the raw map", () => {
		const policy = parseHeaderPolicyFromRaw({
			[PROXY_EXTRA_HEADERS_KEY]: '{"X-Track":"zenapi"}',
			[PROXY_REMOVE_HEADERS_KEY]: '["x-internal"]',
		});
		expect(policy).toEqual({
			extraHeaders: { "X-Track": "zenapi" },
			removeHeaders: ["x-internal"],
		});
	});

	it("missing keys degrade to empty config (fail-open)", () => {
		expect(parseHeaderPolicyFromRaw({})).toEqual({
			extraHeaders: {},
			removeHeaders: [],
		});
	});

	it("malformed stored JSON degrades to empty config instead of failing", () => {
		const policy = parseHeaderPolicyFromRaw({
			[PROXY_EXTRA_HEADERS_KEY]: "{not json",
			[PROXY_REMOVE_HEADERS_KEY]: '"scalar"',
		});
		expect(policy).toEqual({ extraHeaders: {}, removeHeaders: [] });
	});
});
