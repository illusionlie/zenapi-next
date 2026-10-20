import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import anthropicApp from "../apps/worker/src/routes/anthropic-proxy";
import proxyApp from "../apps/worker/src/routes/proxy";
import type { ChannelRecord } from "../apps/worker/src/services/channels";
import { resetChannelCooldownsForTest } from "../apps/worker/src/services/channel-cooldown";

/**
 * 冷却器在双代理候选装配点的接线集成测试（P2 design.md §接线）：
 * 持续 5xx 的渠道 3 次请求后进入冷却 → 后续请求候选池不再包含它；
 * 全部候选冷却时 fail-open 仍正常路由；任何成功响应即清除冷却状态。
 * rounds=2（见 makeEnv）：同请求内第二轮重试不得把失败翻转为成功，
 * 每渠道每请求仍只记 1 次失败。冷却 Map 是模块级状态，beforeEach 重置；
 * 每用例新建 mock db（无缓存串扰）。
 */

function makeChannel(
	id: string,
	host: string,
	overrides: Partial<ChannelRecord> = {},
): ChannelRecord {
	return {
		id,
		name: `channel-${id}`,
		base_url: `https://${host}/v1`,
		api_key: `sk-${id}`,
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
	user_id: null,
};

function makeDb(channels: unknown[]) {
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
					if (sql.includes("FROM channels")) {
						return { results: channels };
					}
					// channel_model_aliases / settings 等：空
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
	return db;
}

type RequestEnv = Parameters<typeof proxyApp.request>[2];

function makeEnv(channels: unknown[]): RequestEnv {
	return {
		DB: makeDb(channels),
		// rounds=2 on purpose: round 2 revisits every channel within one
		// request, so the per-channel-once failure guard (and the fact that a
		// retried failure must NOT be flipped into a success) is exercised —
		// a channel must still cool down after 3 requests despite 6 attempts.
		PROXY_RETRY_ROUNDS: "2",
		PROXY_RETRY_DELAY_MS: "0",
	} as unknown as RequestEnv;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function errorResponse(status: number): Response {
	return new Response(
		JSON.stringify({ error: { message: "upstream down" } }),
		{ status, headers: { "content-type": "application/json" } },
	);
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

const ANTHROPIC_REQUEST_BODY = JSON.stringify({
	model: "test-model",
	max_tokens: 16,
	messages: [
		{ role: "user", content: [{ type: "text", text: "hi" }] },
	],
});

function stubUpstream(
	upstreamCalls: string[],
	isDown: (url: string) => boolean,
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			upstreamCalls.push(url);
			if (isDown(url)) {
				return errorResponse(500);
			}
			return jsonResponse(CHAT_UPSTREAM_BODY);
		}),
	);
}

beforeEach(() => {
	resetChannelCooldownsForTest();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("proxy candidate assembly — channel cooldown", () => {
	it("cools a persistently-5xx channel out of the pool and fail-opens while all are cooling", async () => {
		const channels = [
			makeChannel("chA", "a.example"),
			makeChannel("chB", "b.example"),
		];
		const env = makeEnv(channels);
		const upstreamCalls: string[] = [];
		let chBHealthy = false;
		stubUpstream(upstreamCalls, (url) => {
			if (url.includes("a.example")) {
				return true;
			}
			return !chBHealthy;
		});

		const postInit = {
			method: "POST" as const,
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-token",
			},
			body: CHAT_REQUEST_BODY,
		};

		// 3 次全失败请求：两渠道各累计 3 次可重试失败 → 双双进入冷却
		for (let i = 0; i < 3; i++) {
			const res = await proxyApp.request("/v1/chat/completions", postInit, env);
			expect(res.status).toBe(500);
		}
		const callsInFailingRequests = upstreamCalls.filter(
			(u) => u.includes("a.example"),
		).length;
		expect(callsInFailingRequests).toBeGreaterThanOrEqual(3);

		// 第 4 次：全部候选都在冷却 → fail-open 保持全池，chB 恢复健康并成功
		chBHealthy = true;
		const callsBeforeRecovery = upstreamCalls.length;
		const okRes = await proxyApp.request("/v1/chat/completions", postInit, env);
		expect(okRes.status).toBe(200);
		// fail-open 锁定：冷却没有把候选池清空（否则不会发出任何上游调用）
		expect(upstreamCalls.length).toBeGreaterThan(callsBeforeRecovery);

		// 第 5 次：chA 冷却中被过滤出候选池 —— 只有 b.example 被调用
		const callsBeforeClean = upstreamCalls.length;
		const cleanRes = await proxyApp.request(
			"/v1/chat/completions",
			postInit,
			env,
		);
		expect(cleanRes.status).toBe(200);
		const cleanCalls = upstreamCalls.slice(callsBeforeClean);
		expect(cleanCalls.length).toBeGreaterThan(0);
		expect(cleanCalls.every((u) => u.includes("b.example"))).toBe(true);
	});

	it("non-retryable 4xx responses count as success — the channel never cools", async () => {
		const channels = [makeChannel("ch400", "polite.example")];
		const env = makeEnv(channels);
		const upstreamCalls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.href
							: input.url;
				upstreamCalls.push(url);
				return errorResponse(400);
			}),
		);
		const postInit = {
			method: "POST" as const,
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-token",
			},
			body: CHAT_REQUEST_BODY,
		};

		for (let i = 0; i < 5; i++) {
			const res = await proxyApp.request("/v1/chat/completions", postInit, env);
			expect(res.status).toBe(400);
		}
		// 每次请求上游仍被调用：400 证明上游活着，冷却永不触发
		expect(upstreamCalls).toHaveLength(5);
	});
});

describe("anthropic-proxy candidate assembly — channel cooldown", () => {
	it("cools a persistently-5xx channel out of the pool (symmetric wiring)", async () => {
		const channels = [
			makeChannel("chA", "a.example"),
			makeChannel("chB", "b.example"),
		];
		const env = makeEnv(channels);
		const upstreamCalls: string[] = [];
		let chBHealthy = false;
		stubUpstream(upstreamCalls, (url) => {
			if (url.includes("a.example")) {
				return true;
			}
			return !chBHealthy;
		});

		const postInit = {
			method: "POST" as const,
			headers: {
				"content-type": "application/json",
				authorization: "Bearer test-token",
			},
			body: ANTHROPIC_REQUEST_BODY,
		};

		for (let i = 0; i < 3; i++) {
			const res = await anthropicApp.request("/messages", postInit, env);
			expect(res.status).toBe(500);
		}

		chBHealthy = true;
		const okRes = await anthropicApp.request("/messages", postInit, env);
		expect(okRes.status).toBe(200);

		const callsBeforeClean = upstreamCalls.length;
		const cleanRes = await anthropicApp.request("/messages", postInit, env);
		expect(cleanRes.status).toBe(200);
		const cleanCalls = upstreamCalls.slice(callsBeforeClean);
		expect(cleanCalls.length).toBeGreaterThan(0);
		expect(cleanCalls.every((u) => u.includes("b.example"))).toBe(true);
	});
});
