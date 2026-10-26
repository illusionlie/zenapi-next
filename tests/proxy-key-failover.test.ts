import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import anthropicApp from "../apps/worker/src/routes/anthropic-proxy";
import proxyApp from "../apps/worker/src/routes/proxy";
import {
	isChannelCoolingDown,
	resetChannelCooldownsForTest,
} from "../apps/worker/src/services/channel-cooldown";
import {
	isKeyCoolingDown,
	keyFingerprint,
	resetKeyCooldownsForTest,
} from "../apps/worker/src/services/key-cooldown";
import type { ChannelRecord } from "../apps/worker/src/services/channels";

/**
 * Proxy key-loop integration tests (design.md §2/§6): key-level cooldown,
 * 401/403 failover (the intentional client-visible behavior change) and
 * usage_logs.key_tag attribution.
 *
 * Determinism: shuffleArray and createWeightedOrder both draw from
 * Math.random — stubbing it to 0 makes the 2-key shuffle deterministic
 * ([k1, k2] → [k2, k1]) AND the single-channel weighted order a no-op, so
 * exact call sequences are assertable. Every mock fetch distinguishes keys
 * by the `x-api-key` header (buildChannelRequest sets it for openai targets);
 * assertions never depend on un-stubbed order. All cooldown state is module
 * memory — both trackers reset in beforeEach.
 */

function makeChannel(
	id: string,
	apiKey: string,
	overrides: Partial<ChannelRecord> = {},
): ChannelRecord {
	return {
		id,
		name: `channel-${id}`,
		base_url: "https://upstream.example/v1",
		api_key: apiKey,
		weight: 1,
		status: "active",
		api_format: "openai",
		models_json: JSON.stringify([{ id: "test-model" }]),
		...overrides,
	};
}

const tokenRow = {
	id: "tok1",
	name: "test-token",
	quota_total: null,
	quota_used: 0,
	status: "active",
	allowed_channels: null,
	allowed_models: null,
	// No user_id: keeps the tokenAuth user gate out of scope here (same as
	// channel-cooldown-routing.test.ts) — key attribution is independent of it.
	user_id: null,
};

function makeDb(channels: unknown[]) {
	const runs: Array<{ sql: string; args: unknown[] }> = [];
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
					// channel_model_aliases / settings / others: empty
					return { results: [] };
				},
				first: async () => {
					if (sql.includes("FROM tokens")) {
						return tokenRow;
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
		batch: async (stmts: Array<{ sql: string; boundArgs: unknown[] }>) => {
			for (const s of stmts) runs.push({ sql: s.sql, args: s.boundArgs });
			return stmts.map(() => ({}));
		},
	};
	return { db, runs };
}

type RequestEnv = Parameters<typeof proxyApp.request>[2];
type RequestCtx = Parameters<typeof proxyApp.request>[3];

function makeMockCtx(): {
	ctx: RequestCtx;
	awaitTasks: () => Promise<void>;
} {
	const tasks: Promise<unknown>[] = [];
	return {
		ctx: {
			waitUntil: (p: Promise<unknown>) => {
				tasks.push(p);
			},
			passThroughOnException: () => {},
		} as RequestCtx,
		awaitTasks: async () => {
			await Promise.allSettled(tasks);
		},
	};
}

function makeEnv(
	channels: unknown[],
	rounds = "1",
): { env: RequestEnv; runs: Array<{ sql: string; args: unknown[] }> } {
	const { db, runs } = makeDb(channels);
	return {
		env: {
			DB: db,
			PROXY_RETRY_ROUNDS: rounds,
			PROXY_RETRY_DELAY_MS: "0",
		} as unknown as RequestEnv,
		runs,
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function upstreamStatus(status: number): Response {
	return new Response(JSON.stringify({ error: { message: `upstream ${status}` } }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const CHAT_UPSTREAM_BODY = {
	id: "chatcmpl-1",
	object: "chat.completion",
	created: 1730000000,
	model: "test-model",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "Hello!" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

const CHAT_REQUEST_BODY = JSON.stringify({
	model: "test-model",
	messages: [{ role: "user", content: "hi" }],
});

const postInit = {
	method: "POST" as const,
	headers: {
		"content-type": "application/json",
		authorization: "Bearer test-token",
	},
	body: CHAT_REQUEST_BODY,
};

/** Stubbed fetch keyed by the outbound x-api-key header; logs every key. */
function stubUpstreamByKeys(
	respond: (key: string) => Response,
): { calls: string[] } {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const key = new Headers(init?.headers).get("x-api-key") ?? "";
			calls.push(key);
			return respond(key);
		}),
	);
	return { calls };
}

const usageInserts = (runs: Array<{ sql: string }>) =>
	runs.filter((r) => r.sql.includes("INSERT INTO usage_logs"));

beforeEach(() => {
	resetChannelCooldownsForTest();
	resetKeyCooldownsForTest();
	// Deterministic shuffle ([k1, k2] → [k2, k1]) and weighted order.
	vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("proxy key failover (401/403 continue)", () => {
	it("fails over to the next key on 401 and serves the request (behavior change)", async () => {
		// api_key rows [live, stale] shuffle (rnd=0 swaps positions) to attempt
		// order [stale→401, live→200].
		const { env, runs } = makeEnv([makeChannel("ch1", "sk-live\nsk-stale")]);
		const { calls } = stubUpstreamByKeys((key) =>
			key === "sk-stale" ? upstreamStatus(401) : jsonResponse(CHAT_UPSTREAM_BODY),
		);
		const { ctx, awaitTasks } = makeMockCtx();

		const res = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
		expect(body.choices[0].message.content).toBe("Hello!");

		// Both keys went out, in the stubbed deterministic order: the stale key
		// was tried, cooled, and the live key served.
		expect(calls).toEqual(["sk-stale", "sk-live"]);
		expect(isKeyCoolingDown("ch1", "sk-stale")).toBe(true);
		expect(isKeyCoolingDown("ch1", "sk-live")).toBe(false);

		// Attribution split (R2): the live upstream answered 401 → channel is
		// alive; its cooldown streak must be untouched.
		expect(isChannelCoolingDown("ch1")).toBe(false);

		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts).toHaveLength(1);
		// Success row: key_tag = the SERVING key's fingerprint (R3).
		expect(inserts[0].args[18]).toBe(keyFingerprint("sk-live"));
		expect(inserts[0].args[15]).toBe("ok");
	});

	it("all keys 401 → client 401, error row tagged with the last attempted key, channel never cools", async () => {
		const { env, runs } = makeEnv([makeChannel("ch1", "sk-a\nsk-b")]);
		const { calls } = stubUpstreamByKeys(() => upstreamStatus(401));
		const { ctx, awaitTasks } = makeMockCtx();

		const res = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(res.status).toBe(401);

		// Attempt order is [sk-b, sk-a]: both tried (no early break), last
		// attempted = sk-a → the error row's key_tag.
		expect(calls).toEqual(["sk-b", "sk-a"]);
		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].args[15]).toBe("error");
		expect(inserts[0].args[16]).toBe(401);
		expect(inserts[0].args[18]).toBe(keyFingerprint("sk-a"));

		// Both keys entered the 10-minute auth cooldown.
		expect(isKeyCoolingDown("ch1", "sk-a")).toBe(true);
		expect(isKeyCoolingDown("ch1", "sk-b")).toBe(true);
		// …while the channel stays clean: 401 is upstream alive-proof (R2),
		// repeated requests must never stack a channel cooldown streak.
		for (let i = 0; i < 2; i++) {
			const next = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
			expect(next.status).toBe(401);
		}
		expect(isChannelCoolingDown("ch1")).toBe(false);
	});

	it("fail-open: after every key cooled down, a recovered key still serves (no early 503)", async () => {
		const { env, runs } = makeEnv([makeChannel("ch1", "sk-a\nsk-b")]);
		let bHealthy = false;
		const { calls } = stubUpstreamByKeys((key) =>
			key === "sk-b" && bHealthy
				? jsonResponse(CHAT_UPSTREAM_BODY)
				: upstreamStatus(401),
		);
		const { ctx, awaitTasks } = makeMockCtx();

		// Request 1: everything 401s → both keys cooling.
		const first = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(first.status).toBe(401);
		expect(isKeyCoolingDown("ch1", "sk-a")).toBe(true);
		expect(isKeyCoolingDown("ch1", "sk-b")).toBe(true);

		// Request 2: every key is cooling → fail-open keeps the full rotation;
		// the recovered key serves. A fail-closed filter would have sent zero
		// upstream calls and returned 502 instead.
		bHealthy = true;
		const callsBefore = calls.length;
		const second = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(second.status).toBe(200);
		expect(calls.length).toBeGreaterThan(callsBefore);

		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts).toHaveLength(2);
		// Success row tagged with the serving key (deterministic: sk-b is the
		// only key that ever returns 200).
		expect(inserts[1].args[18]).toBe(keyFingerprint("sk-b"));
		expect(inserts[1].args[15]).toBe("ok");
	});
});

describe("proxy key cooldown — retryable failures", () => {
	it("429 cools the keys for the short window; channel retryable semantics unchanged", async () => {
		const { env, runs } = makeEnv([makeChannel("ch1", "sk-a\nsk-b")], "2");
		const { calls } = stubUpstreamByKeys(() => upstreamStatus(429));
		const { ctx, awaitTasks } = makeMockCtx();

		const res = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(res.status).toBe(429);
		// Channel retryable semantics unchanged (R2): round 2 retried the same
		// channel — 2 keys × 2 rounds = exactly 4 upstream calls.
		expect(calls).toEqual(["sk-b", "sk-a", "sk-b", "sk-a"]);

		// Both keys carry the short retryable cooldown.
		expect(isKeyCoolingDown("ch1", "sk-a")).toBe(true);
		expect(isKeyCoolingDown("ch1", "sk-b")).toBe(true);

		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].args[16]).toBe(429);
		expect(inserts[0].args[18]).toBe(keyFingerprint("sk-a"));

		// 429 照旧计入渠道级判定: one failure per request → three requests
		// reach the channel cooldown threshold (existing channel-cooldown law).
		await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(isChannelCoolingDown("ch1")).toBe(false);
		await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(isChannelCoolingDown("ch1")).toBe(true);
	});

	it("network errors cool the key; upstream_unavailable row tagged with the last attempted key", async () => {
		const { env, runs } = makeEnv([makeChannel("ch1", "sk-a\nsk-b")], "2");
		const { calls } = stubUpstreamByKeys(() => {
			throw new Error("connect ECONNREFUSED");
		});
		const { ctx, awaitTasks } = makeMockCtx();

		const res = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(res.status).toBe(502);
		// Both keys attempted in both rounds (fail-open keeps the rotation).
		expect(calls).toEqual(["sk-b", "sk-a", "sk-b", "sk-a"]);
		expect(isKeyCoolingDown("ch1", "sk-a")).toBe(true);
		expect(isKeyCoolingDown("ch1", "sk-b")).toBe(true);

		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].args[17]).toBe("upstream_unavailable");
		expect(inserts[0].args[18]).toBe(keyFingerprint("sk-a"));
	});
});

describe("proxy key loop — unchanged branches", () => {
	it("other non-retryable 4xx: no key cooldown, no second key attempt", async () => {
		const { env, runs } = makeEnv([makeChannel("ch1", "sk-a\nsk-b")]);
		const { calls } = stubUpstreamByKeys(() => upstreamStatus(400));
		const { ctx, awaitTasks } = makeMockCtx();

		const res = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(res.status).toBe(400);
		// Attempt order [sk-b, sk-a]: 400 breaks the key loop after one try.
		expect(calls).toEqual(["sk-b"]);
		// Request-level errors never cool a key.
		expect(isKeyCoolingDown("ch1", "sk-a")).toBe(false);
		expect(isKeyCoolingDown("ch1", "sk-b")).toBe(false);

		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts[0].args[18]).toBe(keyFingerprint("sk-b"));
	});
});

describe("single-key channel regression (R5)", () => {
	it("single key 401 still passes through and the key fail-opens on the next request", async () => {
		const { env, runs } = makeEnv([makeChannel("ch1", "sk-solo")]);
		const { calls } = stubUpstreamByKeys(() => upstreamStatus(401));
		const { ctx, awaitTasks } = makeMockCtx();

		const first = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(first.status).toBe(401);
		expect(calls).toEqual(["sk-solo"]);
		expect(isKeyCoolingDown("ch1", "sk-solo")).toBe(true);
		// No double-kill: the channel itself never enters cooldown.
		expect(isChannelCoolingDown("ch1")).toBe(false);

		// Next request: fail-open (the only key is cooling) → still attempted,
		// client semantics identical to pre-task behavior (401 passthrough).
		const second = await proxyApp.request("/v1/chat/completions", postInit, env, ctx);
		expect(second.status).toBe(401);
		expect(calls).toEqual(["sk-solo", "sk-solo"]);

		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts).toHaveLength(2);
		expect(inserts[1].args[18]).toBe(keyFingerprint("sk-solo"));
	});
});

describe("anthropic-proxy key failover (symmetric wiring)", () => {
	const anthropicPostInit = {
		method: "POST" as const,
		headers: {
			"content-type": "application/json",
			authorization: "Bearer test-token",
		},
		body: JSON.stringify({
			model: "test-model",
			max_tokens: 16,
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		}),
	};

	it("401 on the first key fails over to the next key and serves (anthropic target)", async () => {
		// Anthropic-target channel: the key rides the x-api-key header only.
		const { env, runs } = makeEnv([
			makeChannel("ch1", "sk-live\nsk-stale", { api_format: "anthropic" }),
		]);
		const { calls } = stubUpstreamByKeys((key) =>
			key === "sk-stale"
				? upstreamStatus(401)
				: jsonResponse({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "Hello!" }],
						stop_reason: "end_turn",
						usage: { input_tokens: 5, output_tokens: 3 },
					}),
		);
		const { ctx, awaitTasks } = makeMockCtx();

		const res = await anthropicApp.request("/messages", anthropicPostInit, env, ctx);
		expect(res.status).toBe(200);

		// Attempt order [stale, live]: stale 401 → cooled → live served.
		expect(calls).toEqual(["sk-stale", "sk-live"]);
		expect(isKeyCoolingDown("ch1", "sk-stale")).toBe(true);
		expect(isKeyCoolingDown("ch1", "sk-live")).toBe(false);
		// Attribution split: 401 never advances the channel streak.
		expect(isChannelCoolingDown("ch1")).toBe(false);

		await awaitTasks();
		const inserts = usageInserts(runs);
		expect(inserts).toHaveLength(1);
		expect(inserts[0].args[15]).toBe("ok");
		expect(inserts[0].args[18]).toBe(keyFingerprint("sk-live"));
	});

	it("single key 401 passes through (anthropic target, R5)", async () => {
		const { env } = makeEnv([
			makeChannel("ch1", "sk-solo", { api_format: "anthropic" }),
		]);
		const { calls } = stubUpstreamByKeys(() => upstreamStatus(401));
		const { ctx } = makeMockCtx();

		const res = await anthropicApp.request("/messages", anthropicPostInit, env, ctx);
		expect(res.status).toBe(401);
		expect(calls).toEqual(["sk-solo"]);
		expect(isKeyCoolingDown("ch1", "sk-solo")).toBe(true);
		expect(isChannelCoolingDown("ch1")).toBe(false);
	});
});
