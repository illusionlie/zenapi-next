import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import anthropicApp from "../apps/worker/src/routes/anthropic-proxy";
import { resetChannelCooldownsForTest } from "../apps/worker/src/services/channel-cooldown";
import type { ChannelRecord } from "../apps/worker/src/services/channels";

function makeChannel(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
	return {
		id: "ch1",
		name: "test-channel",
		base_url: "https://upstream.example/v1",
		api_key: "sk-channel",
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
	user_id: null,
};

/**
 * Minimal D1 mock covering the queries the count_tokens handler hits:
 * tokens (tokenAuth), channels, channel_model_aliases, settings, plus
 * run()/batch() capture for the zero-cost assertion (no usage/quota writes).
 */
function makeDb(
	options: {
		channels?: unknown[];
		token?: Record<string, unknown> | null;
		channelAliasHits?: Array<Record<string, unknown>>;
	} = {},
) {
	const channels = options.channels ?? [];
	const token = options.token === undefined ? tokenRow : options.token;
	const channelAliasHits = options.channelAliasHits ?? [];
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
					if (sql.includes("FROM channel_model_aliases")) {
						// loadChannelAliasesByAlias (alias = ?) vs alias-only map
						if (sql.includes("WHERE alias = ?")) {
							return { results: channelAliasHits };
						}
						return { results: [] };
					}
					if (sql.includes("FROM channels")) {
						return { results: channels };
					}
					// settings / others: empty
					return { results: [] };
				},
				first: async () => {
					if (sql.includes("FROM tokens")) {
						return token;
					}
					return null;
				},
				run: async () => {
					runs.push({ sql, args: stmt.boundArgs });
					return {};
				},
				batch: async (stmts: Array<{ sql: string; boundArgs: unknown[] }>) => {
					for (const s of stmts) runs.push({ sql: s.sql, args: s.boundArgs });
					return stmts.map(() => ({}));
				},
			};
			return stmt;
		},
	};
	return { db, runs };
}

type RequestEnv = Parameters<typeof anthropicApp.request>[2];

function makeEnv(
	channels: unknown[],
	options: {
		token?: Record<string, unknown> | null;
		channelAliasHits?: Array<Record<string, unknown>>;
	} = {},
): { env: RequestEnv; runs: Array<{ sql: string; args: unknown[] }> } {
	const { db, runs } = makeDb({
		channels,
		token: options.token,
		channelAliasHits: options.channelAliasHits,
	});
	return { env: { DB: db } as unknown as RequestEnv, runs };
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function countTokensBody(model: string): string {
	return JSON.stringify({
		model,
		messages: [{ role: "user", content: "hi" }],
	});
}

async function postCountTokens(
	env: RequestEnv,
	body: string,
	headers: Record<string, string> = {},
): Promise<Response> {
	return anthropicApp.request("/messages/count_tokens", {
		method: "POST",
		headers: {
			authorization: "Bearer test-token",
			"content-type": "application/json",
			...headers,
		},
		body,
	}, env);
}

describe("POST /anthropic/v1/messages/count_tokens", () => {
	beforeEach(() => {
		resetChannelCooldownsForTest();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("401 without a bearer token", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const res = await anthropicApp.request("/messages/count_tokens", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: countTokensBody("test-model"),
		}, env);
		expect(res.status).toBe(401);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.code).toBe("token_required");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("403 model_not_allowed when the model is outside the token allowlist", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })], {
			token: { ...tokenRow, allowed_models: JSON.stringify(["gpt-4o"]) },
		});
		const res = await postCountTokens(env, countTokensBody("claude-sonnet-4-6"));
		expect(res.status).toBe(403);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.code).toBe("model_not_allowed");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("404 model_not_found when no channel serves the model", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const res = await postCountTokens(env, countTokensBody("unknown-model"));
		expect(res.status).toBe(404);
		const body = (await res.json()) as Record<string, unknown>;
		// Wire shape mirrors /messages: message slot carries the code string
		expect(body.error).toBe("model_not_found");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("responses-only channel: local estimate 200, zero upstream fetches (AC6 — non-anthropic target never probes)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel({ api_format: "responses" })]);
		const body = countTokensBody("test-model");
		const res = await postCountTokens(env, body);
		expect(res.status).toBe(200);
		const parsed = (await res.json()) as { input_tokens: number };
		expect(parsed.input_tokens).toBe(
			Math.max(1, Math.ceil(body.length / 4)),
		);
		// The routing matrix now selects "responses" as the target format, but
		// count_tokens only probes anthropic-target channels — this candidate
		// falls out of the probe pool and degrades to the local estimate.
		expect(fetchMock).not.toHaveBeenCalled();
		// Zero-cost discipline: no usage INSERT, no quota/balance UPDATE
		expect(runs).toEqual([]);
	});

	it("anthropic channel: passes through to {base}/v1/messages/count_tokens and returns the upstream count untouched", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ input_tokens: 123 }));
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const body = countTokensBody("test-model");
		const res = await postCountTokens(env, body);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ input_tokens: 123 });

		// Single deterministic attempt (exactly one anthropic-target channel in
		// the pool — weighted shuffle cannot change the outcome).
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		// normalizeBaseUrl strips the stored /v1 suffix, endpoint path appends
		expect(target).toBe("https://upstream.example/v1/messages/count_tokens");
		const headers = init.headers as Headers;
		expect(headers.get("x-api-key")).toBe("sk-channel");
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		// Request body forwarded byte-for-byte (no conversion, no rewrite)
		expect(init.body).toBe(body);

		// Zero-cost discipline: no usage INSERT, no quota/balance UPDATE
		expect(runs).toEqual([]);
	});

	it("forwards caller anthropic-version override and anthropic-beta header", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ input_tokens: 5 }));
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const res = await postCountTokens(env, countTokensBody("test-model"), {
			"anthropic-version": "2023-01-01",
			"anthropic-beta": "context-1m-2025-08-07",
		});
		expect(res.status).toBe(200);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("anthropic-version")).toBe("2023-01-01");
		expect(headers.get("anthropic-beta")).toBe("context-1m-2025-08-07");
	});

	it("upstream 5xx: degrades to the local estimate, exactly one attempt, still 200", async () => {
		const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const body = countTokensBody("test-model");
		const res = await postCountTokens(env, body);
		expect(res.status).toBe(200);
		const parsed = (await res.json()) as { input_tokens: number };
		expect(parsed.input_tokens).toBe(Math.max(1, Math.ceil(body.length / 4)));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("upstream network error: degrades to the local estimate, still 200", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const body = countTokensBody("test-model");
		const res = await postCountTokens(env, body);
		expect(res.status).toBe(200);
		const parsed = (await res.json()) as { input_tokens: number };
		expect(parsed.input_tokens).toBe(Math.max(1, Math.ceil(body.length / 4)));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("openai channel: no upstream request, 200 with the coarse local estimate", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel({ api_format: "openai" })]);
		const body = countTokensBody("test-model");
		const res = await postCountTokens(env, body);
		expect(res.status).toBe(200);
		const parsed = (await res.json()) as { input_tokens: number };
		expect(Number.isInteger(parsed.input_tokens)).toBe(true);
		expect(parsed.input_tokens).toBeGreaterThan(0);
		expect(parsed.input_tokens).toBe(Math.max(1, Math.ceil(body.length / 4)));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(runs).toEqual([]);
	});

	it("mixed pool (openai + anthropic): probes only the anthropic-target channel", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ input_tokens: 9 }));
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({ id: "ch-openai", name: "openai-channel" }),
			makeChannel({
				id: "ch-anthropic",
				name: "anthropic-channel",
				base_url: "https://anthropic-upstream.example",
				api_format: "anthropic",
			}),
		]);
		const res = await postCountTokens(env, countTokensBody("test-model"));
		expect(res.status).toBe(200);
		// Exactly one anthropic-target candidate → deterministic single probe
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe(
			"https://anthropic-upstream.example/v1/messages/count_tokens",
		);
	});

	it("per-channel alias: candidate inclusion and forwarded model use the alias-resolved id", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ input_tokens: 7 }));
		vi.stubGlobal("fetch", fetchMock);
		// models_json only holds the real id — the requested alias must drive
		// channel inclusion via channel_model_aliases, not native support.
		const { env } = makeEnv(
			[
				makeChannel({
					api_format: "anthropic",
					models_json: JSON.stringify([{ id: "claude-opus-4-6" }]),
				}),
			],
			{
				channelAliasHits: [
					{ channel_id: "ch1", model_id: "claude-opus-4-6", alias_only: 0 },
				],
			},
		);
		const res = await postCountTokens(env, countTokensBody("claude-opus-4.6"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ input_tokens: 7 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("claude-opus-4-6");
	});

	it("channel/model routing syntax: forwarded body carries the stripped model name", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ input_tokens: 3 }));
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const res = await postCountTokens(
			env,
			countTokensBody("test-channel/test-model"),
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
	});
});
