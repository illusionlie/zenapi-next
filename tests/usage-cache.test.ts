import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import dashboardApp from "../apps/worker/src/routes/dashboard";
import { recordUsage } from "../apps/worker/src/services/usage";
import {
	normalizeUsage,
	parseUsageFromSse,
} from "../apps/worker/src/utils/usage";

describe("normalizeUsage - cache field extraction per protocol", () => {
	it("reads prompt_tokens_details.cached_tokens (OpenAI chat) without folding", () => {
		expect(
			normalizeUsage({
				prompt_tokens: 100,
				completion_tokens: 10,
				total_tokens: 110,
				prompt_tokens_details: { cached_tokens: 40 },
			}),
		).toEqual({
			totalTokens: 110,
			promptTokens: 100,
			completionTokens: 10,
			cachedInputTokens: 40,
			cacheCreationTokens: null,
		});
	});

	it("reads input_tokens_details.cached_tokens (Responses) without folding", () => {
		expect(
			normalizeUsage({
				input_tokens: 50,
				output_tokens: 20,
				total_tokens: 70,
				input_tokens_details: { cached_tokens: 25 },
			}),
		).toEqual({
			totalTokens: 70,
			promptTokens: 50,
			completionTokens: 20,
			cachedInputTokens: 25,
			cacheCreationTokens: null,
		});
	});

	it("reads prompt_cache_hit_tokens (DeepSeek) without folding", () => {
		expect(
			normalizeUsage({
				prompt_tokens: 30,
				completion_tokens: 5,
				total_tokens: 35,
				prompt_cache_hit_tokens: 12,
			}),
		).toEqual({
			totalTokens: 35,
			promptTokens: 30,
			completionTokens: 5,
			cachedInputTokens: 12,
			cacheCreationTokens: null,
		});
	});

	it("folds pure-Anthropic shape: prompt = input + cache_read + cache_creation", () => {
		expect(
			normalizeUsage({
				input_tokens: 100,
				output_tokens: 20,
				cache_read_input_tokens: 50,
				cache_creation_input_tokens: 10,
			}),
		).toEqual({
			totalTokens: 180,
			promptTokens: 160,
			completionTokens: 20,
			cachedInputTokens: 50,
			cacheCreationTokens: 10,
		});
	});

	it("folds when prompt comes from the camelCase inputTokens alias", () => {
		expect(
			normalizeUsage({
				inputTokens: 80,
				outputTokens: 10,
				cache_read_input_tokens: 5,
				cache_creation_input_tokens: 5,
			}),
		).toEqual({
			totalTokens: 100,
			promptTokens: 90,
			completionTokens: 10,
			cachedInputTokens: 5,
			cacheCreationTokens: 5,
		});
	});

	it("does not double-fold OpenAI shape even when cache counters are present", () => {
		// 转换产物（format-converter anthropicUsageToChat）：prompt_tokens 已含
		// 缓存口径，prompt_tokens_details.cached_tokens 同时存在——不得二次叠加。
		expect(
			normalizeUsage({
				prompt_tokens: 160,
				completion_tokens: 20,
				total_tokens: 180,
				prompt_tokens_details: { cached_tokens: 50 },
				cache_read_input_tokens: 50,
				cache_creation_input_tokens: 10,
			}),
		).toEqual({
			totalTokens: 180,
			promptTokens: 160,
			completionTokens: 20,
			cachedInputTokens: 50,
			cacheCreationTokens: 10,
		});
	});

	it("does not fold Anthropic shape without cache fields", () => {
		expect(normalizeUsage({ input_tokens: 100, output_tokens: 5 })).toEqual({
			totalTokens: 105,
			promptTokens: 100,
			completionTokens: 5,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});

	it("returns null cache fields when upstream reports no cache data", () => {
		expect(
			normalizeUsage({
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
			}),
		).toEqual({
			totalTokens: 15,
			promptTokens: 10,
			completionTokens: 5,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});

	it("prioritizes details over DeepSeek over cache_read for cached tokens", () => {
		expect(
			normalizeUsage({
				prompt_tokens: 100,
				completion_tokens: 1,
				total_tokens: 101,
				prompt_tokens_details: { cached_tokens: 10 },
				prompt_cache_hit_tokens: 99,
				cache_read_input_tokens: 88,
			})?.cachedInputTokens,
		).toBe(10);
		expect(
			normalizeUsage({
				prompt_tokens: 100,
				completion_tokens: 1,
				total_tokens: 101,
				prompt_cache_hit_tokens: 99,
				cache_read_input_tokens: 88,
			})?.cachedInputTokens,
		).toBe(99);
		expect(
			normalizeUsage({
				prompt_tokens: 100,
				completion_tokens: 1,
				total_tokens: 101,
				cache_read_input_tokens: 88,
			})?.cachedInputTokens,
		).toBe(88);
	});

	it("ignores non-finite cache values (null / strings)", () => {
		expect(
			normalizeUsage({
				input_tokens: 20,
				output_tokens: 5,
				cache_read_input_tokens: "abc",
				cache_creation_input_tokens: null,
			}),
		).toEqual({
			totalTokens: 25,
			promptTokens: 20,
			completionTokens: 5,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});
});

describe("parseUsageFromSse - field-wise usage merge", () => {
	it("keeps Anthropic message_start input/cache fields against later message_delta", async () => {
		const body = [
			'event: message_start',
			'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":50,"cache_creation_input_tokens":10,"output_tokens":1}}}',
			"",
			'event: content_block_delta',
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
			"",
			'event: message_delta',
			'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":45}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");
		const response = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});

		const { usage } = await parseUsageFromSse(response);
		expect(usage).toEqual({
			totalTokens: 205,
			promptTokens: 160,
			completionTokens: 45,
			cachedInputTokens: 50,
			cacheCreationTokens: 10,
		});
	});

	it("merges OpenAI stream chunks without changing the terminal-chunk result", async () => {
		const body = [
			'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
			"",
			'data: {"choices":[{"index":0,"delta":{"content":"He"}}]}',
			"",
			'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10,"prompt_tokens_details":{"cached_tokens":4}}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");
		const response = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});

		const { usage } = await parseUsageFromSse(response);
		expect(usage).toEqual({
			totalTokens: 10,
			promptTokens: 9,
			completionTokens: 1,
			cachedInputTokens: 4,
			cacheCreationTokens: null,
		});
	});

	it("keeps the earlier usage when a later chunk carries none", async () => {
		const body = [
			'data: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1,"cache_read_input_tokens":3}}}',
			"",
			'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");
		const response = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});

		const { usage } = await parseUsageFromSse(response);
		expect(usage).toEqual({
			totalTokens: 11,
			promptTokens: 10,
			completionTokens: 1,
			cachedInputTokens: 3,
			cacheCreationTokens: null,
		});
	});

	it("does not let explicit null fields clobber previously merged values", async () => {
		const body = [
			'data: {"usage":{"input_tokens":7,"cache_read_input_tokens":3,"output_tokens":1}}',
			"",
			'data: {"usage":{"input_tokens":null,"cache_read_input_tokens":null,"output_tokens":9}}',
			"",
			"data: [DONE]",
			"",
		].join("\n");
		const response = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});

		const { usage } = await parseUsageFromSse(response);
		expect(usage).toEqual({
			totalTokens: 19,
			promptTokens: 10,
			completionTokens: 9,
			cachedInputTokens: 3,
			cacheCreationTokens: null,
		});
	});
});

describe("recordUsage - persists cache columns", () => {
	function makeDb() {
		const runs: Array<{ sql: string; args: unknown[] }> = [];
		const db = {
			prepare(sql: string) {
				const stmt = {
					boundArgs: [] as unknown[],
					bind: (...args: unknown[]) => {
						stmt.boundArgs = args;
						return stmt;
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

	it("binds cached_input_tokens / cache_creation_tokens when reported", async () => {
		const { db, runs } = makeDb();
		await recordUsage(db, {
			tokenId: "tok_1",
			model: "claude-sonnet-4",
			totalTokens: 180,
			promptTokens: 160,
			completionTokens: 20,
			cachedInputTokens: 50,
			cacheCreationTokens: 10,
		});
		expect(runs).toHaveLength(2);
		const insert = runs[0];
		expect(insert.sql).toContain("cached_input_tokens");
		expect(insert.sql).toContain("cache_creation_tokens");
		expect(insert.args).toContain(50);
		expect(insert.args).toContain(10);
		// Column order: the two cache values directly follow completion_tokens.
		const completionIdx = insert.args.indexOf(20);
		expect(insert.args[completionIdx + 1]).toBe(50);
		expect(insert.args[completionIdx + 2]).toBe(10);
	});

	it("binds NULL for both cache columns when upstream reports none", async () => {
		const { db, runs } = makeDb();
		await recordUsage(db, {
			tokenId: "tok_1",
			model: "gpt-4o",
			totalTokens: 15,
			promptTokens: 10,
			completionTokens: 5,
		});
		const insert = runs[0];
		const completionIdx = insert.args.indexOf(5);
		expect(insert.args[completionIdx + 1]).toBeNull();
		expect(insert.args[completionIdx + 2]).toBeNull();
	});
});

describe("dashboard route - cache_rate aggregation shape", () => {
	type RequestEnv = Parameters<typeof dashboardApp.request>[2];
	type SummaryRow = Record<string, number> & { cache_prompt_base: number };
	type DayRow = {
		day: string;
		requests: number;
		tokens: number;
		cached_tokens: number;
		cache_prompt_base: number;
	};

	function makeDb(summaryRow: SummaryRow, byDayRows: DayRow[]) {
		const db = {
			prepare(sql: string) {
				const stmt = {
					boundArgs: [] as unknown[],
					bind: (...args: unknown[]) => {
						stmt.boundArgs = args;
						return stmt;
					},
					all: async () => {
						if (sql.includes("GROUP BY day")) {
							return { results: byDayRows };
						}
						return { results: [] };
					},
					first: async () => summaryRow,
					run: async () => ({}),
				};
				return stmt;
			},
		};
		return db as unknown as D1Database;
	}

	async function getBody(db: D1Database) {
		const res = await dashboardApp.request(
			"/",
			{},
			{ DB: db } as unknown as RequestEnv,
		);
		expect(res.status).toBe(200);
		return (await res.json()) as {
			summary: {
				cached_tokens: number;
				cache_creation_tokens: number;
				cache_rate: number | null;
			};
			byDay: Array<{
				cached_tokens: number;
				cache_rate: number | null;
			}>;
		};
	}

	it("returns cache_rate null when no row carries cache data", async () => {
		const body = await getBody(
			makeDb(
				{
					total_requests: 3,
					total_tokens: 100,
					avg_latency: 10,
					total_errors: 0,
					cached_tokens: 0,
					cache_creation_tokens: 0,
					cache_prompt_base: 0,
				},
				[
					{
						day: "2026-10-18",
						requests: 3,
						tokens: 100,
						cached_tokens: 0,
						cache_prompt_base: 0,
					},
				],
			),
		);
		expect(body.summary.cache_rate).toBeNull();
		expect(body.summary.cached_tokens).toBe(0);
		expect(body.byDay[0].cache_rate).toBeNull();
	});

	it("computes cache_rate from rows that report cache data only", async () => {
		const body = await getBody(
			makeDb(
				{
					total_requests: 2,
					total_tokens: 300,
					avg_latency: 10,
					total_errors: 0,
					cached_tokens: 50,
					cache_creation_tokens: 10,
					cache_prompt_base: 200,
				},
				[
					{
						day: "2026-10-18",
						requests: 2,
						tokens: 300,
						cached_tokens: 50,
						cache_prompt_base: 200,
					},
				],
			),
		);
		expect(body.summary.cache_rate).toBeCloseTo(0.25);
		expect(body.summary.cache_creation_tokens).toBe(10);
		expect(body.byDay[0].cached_tokens).toBe(50);
		expect(body.byDay[0].cache_rate).toBeCloseTo(0.25);
	});
});
