import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicApp from "../apps/worker/src/routes/anthropic-proxy";
import proxyApp, {
	buildChannelRequest,
	convertResponse,
} from "../apps/worker/src/routes/proxy";
import type { ChannelRecord } from "../apps/worker/src/services/channels";
import { parseUsageFromSse } from "../apps/worker/src/utils/usage";

function makeChannel(
	overrides: Partial<ChannelRecord> = {},
): ChannelRecord {
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
 * Minimal D1 mock covering the queries the proxy handlers hit:
 * tokens (tokenAuth), channels, channel_model_aliases, settings,
 * plus run() capture for usage INSERTs.
 */
function makeDb(
	options: {
		channels?: unknown[];
		token?: Record<string, unknown> | null;
	} = {},
) {
	const channels = options.channels ?? [];
	const token =
		options.token === undefined ? tokenRow : options.token;
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
						return token;
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
		// recordUsage settles via db.batch; forward each statement's sql/args
		// into the same `runs` log so the existing assertions stay valid.
		batch: async (stmts: Array<{ sql: string; boundArgs: unknown[] }>) => {
			for (const s of stmts) runs.push({ sql: s.sql, args: s.boundArgs });
			return stmts.map(() => ({}));
		},
	};
	return { db, runs };
}

type RequestEnv = Parameters<typeof proxyApp.request>[2];
type RequestCtx = Parameters<typeof proxyApp.request>[3];

/**
 * Mock Workers ExecutionContext: captures waitUntil tasks so tests can
 * deterministically await background usage recording.
 */
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

function makeEnv(channels: unknown[]): { env: RequestEnv; runs: Array<{ sql: string; args: unknown[] }> } {
	const { db, runs } = makeDb({ channels });
	return {
		env: {
			DB: db,
			PROXY_RETRY_ROUNDS: "1",
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

const RESPONSES_UPSTREAM_BODY = {
	id: "resp_123",
	object: "response",
	created_at: 1730000000,
	status: "completed",
	model: "gpt-4o",
	output: [
		{
			type: "message",
			content: [{ type: "output_text", text: "Hello!" }],
		},
	],
	usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 },
};

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

/** Parses `data: {...}` payloads out of an SSE stream, skipping [DONE]. */
function parseSseEvents(text: string): Array<Record<string, unknown>> {
	return text
		.split("\n\n")
		.filter((block) => block.startsWith("data: "))
		.map((block) => block.slice(6))
		.filter((payload) => payload !== "[DONE]")
		.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

// Routing matrix unit coverage moved to tests/channel-routing.test.ts
// (selectTargetFormat: 4 formats × 4 protocols behaviour-preservation grid +
// multi-format preference). The integration suites below lock the proxy-level
// outcomes: 503 exclusions, native passthrough and converted calls.

describe("buildChannelRequest responses branch", () => {
	const channel = makeChannel({ api_format: "responses" });

	it("/v1/responses inbound: targets {base}/responses and passes the body through untouched", () => {
		const requestText = JSON.stringify({
			model: "test-model",
			input: "hi",
			store: true,
		});
		const result = buildChannelRequest(
			channel,
			"/v1/responses",
			"",
			new Headers(),
			requestText,
			null,
			false,
			"sk-call",
		);
		expect(result.target).toBe("https://upstream.example/v1/responses");
		expect(result.body).toBe(requestText);
	});

	it("/v1/responses inbound: matches path case-insensitively and keeps query suffix", () => {
		const result = buildChannelRequest(
			channel,
			"/V1/Responses",
			"?api-version=1",
			new Headers(),
			"{}",
			null,
			false,
			"sk-call",
		);
		expect(result.target).toBe(
			"https://upstream.example/v1/responses?api-version=1",
		);
	});

	it("chat inbound: converts the body via openaiToResponsesRequest", () => {
		const parsedBody = {
			model: "test-model",
			stream: false,
			max_tokens: 100,
			messages: [
				{ role: "system", content: "Be nice" },
				{ role: "user", content: "hi" },
			],
			stream_options: { include_usage: true },
		};
		const result = buildChannelRequest(
			channel,
			"/v1/chat/completions",
			"",
			new Headers(),
			JSON.stringify(parsedBody),
			parsedBody,
			false,
			"sk-call",
		);
		expect(result.target).toBe("https://upstream.example/v1/responses");
		const body = JSON.parse(result.body ?? "{}") as Record<string, unknown>;
		expect(body.model).toBe("test-model");
		expect(body.instructions).toBe("Be nice");
		expect(body.max_output_tokens).toBe(100);
		expect(body.stream).toBe(false);
		expect(body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		]);
		expect(body.messages).toBeUndefined();
		expect(body.stream_options).toBeUndefined();
	});

	it("chat inbound: propagates stream=true", () => {
		const parsedBody = {
			model: "test-model",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		};
		const result = buildChannelRequest(
			channel,
			"/v1/chat/completions",
			"",
			new Headers(),
			JSON.stringify(parsedBody),
			parsedBody,
			true,
			"sk-call",
		);
		const body = JSON.parse(result.body ?? "{}") as Record<string, unknown>;
		expect(body.stream).toBe(true);
	});

	it("chat inbound: falls back to an empty Responses body when parsed body is null", () => {
		const result = buildChannelRequest(
			channel,
			"/v1/chat/completions",
			"",
			new Headers(),
			"not-json",
			null,
			false,
			"sk-call",
		);
		expect(result.body).toBe("{}");
	});

	it("non-chat passthrough paths follow the openai rules (base_url + subPath + query)", () => {
		const result = buildChannelRequest(
			channel,
			"/v1/embeddings",
			"?a=b",
			new Headers(),
			'{"input":"x"}',
			null,
			false,
			"sk-call",
		);
		expect(result.target).toBe("https://upstream.example/v1/embeddings?a=b");
		expect(result.body).toBe('{"input":"x"}');
	});

	it("sets Bearer + x-api-key and strips host/content-length from client headers", () => {
		const incoming = new Headers({
			host: "gateway.example",
			"content-length": "123",
		});
		const result = buildChannelRequest(
			channel,
			"/v1/chat/completions",
			"",
			incoming,
			"{}",
			{ messages: [] },
			false,
			"sk-call",
		);
		expect(result.headers.get("authorization")).toBe("Bearer sk-call");
		expect(result.headers.get("x-api-key")).toBe("sk-call");
		expect(result.headers.get("host")).toBeNull();
		expect(result.headers.get("content-length")).toBeNull();
	});

	it("applies the header policy (remove → global inject → channel-level)", () => {
		const policyChannel = makeChannel({
			api_format: "responses",
			custom_headers_json: '{"X-Trace-Id":"channel","X-Channel":"1"}',
		});
		const incoming = new Headers({ "user-agent": "client" });
		const result = buildChannelRequest(
			policyChannel,
			"/v1/chat/completions",
			"",
			incoming,
			"{}",
			{ messages: [] },
			false,
			"sk-call",
			{
				extraHeaders: { "X-Trace-Id": "global" },
				removeHeaders: ["user-agent"],
			},
		);
		expect(result.headers.get("user-agent")).toBeNull();
		expect(result.headers.get("x-trace-id")).toBe("channel");
		expect(result.headers.get("x-channel")).toBe("1");
	});
});

describe("convertResponse responses wiring", () => {
	const channel = makeChannel({ api_format: "responses" });

	it("chat inbound non-stream: converts a Responses body into a chat completion", async () => {
		const upstream = jsonResponse(RESPONSES_UPSTREAM_BODY);
		const out = await convertResponse(
			channel,
			upstream,
			false,
			"/v1/chat/completions",
		);
		expect(out.headers.get("content-type")).toBe("application/json");
		const body = (await out.json()) as Record<string, unknown>;
		expect(body.object).toBe("chat.completion");
		const choices = body.choices as Array<Record<string, unknown>>;
		expect(choices[0].finish_reason).toBe("stop");
		const message = choices[0].message as Record<string, unknown>;
		expect(message.content).toBe("Hello!");
		expect(body.usage).toEqual({
			prompt_tokens: 4,
			completion_tokens: 6,
			total_tokens: 10,
		});
	});

	it("chat inbound stream: pipes Responses SSE into chat SSE ending with [DONE]", async () => {
		const events = [
			{ type: "response.created", response: { id: "resp_1", model: "gpt-4o" } },
			{ type: "response.output_text.delta", delta: "Hel" },
			{ type: "response.output_text.delta", delta: "lo" },
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					model: "gpt-4o",
					status: "completed",
					usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
				},
			},
		];
		const sse = events
			.map((e) => `data: ${JSON.stringify(e)}\n\n`)
			.join("");
		const upstream = new Response(sse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const out = await convertResponse(
			channel,
			upstream,
			true,
			"/v1/chat/completions",
		);
		expect(out.headers.get("content-type")).toBe("text/event-stream");
		const text = await out.text();
		const payloads = text
			.split("\n\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice(6));
		expect(payloads).toHaveLength(5);
		const chunks = payloads.slice(0, 4).map(
			(p) => JSON.parse(p) as Record<string, unknown>,
		);
		expect(
			(chunks[0].choices as Array<Record<string, unknown>>)[0].delta,
		).toEqual({ role: "assistant" });
		const delta1 = (chunks[1].choices as Array<Record<string, unknown>>)[0]
			.delta as Record<string, unknown>;
		expect(delta1.content).toBe("Hel");
		const delta2 = (chunks[2].choices as Array<Record<string, unknown>>)[0]
			.delta as Record<string, unknown>;
		expect(delta2.content).toBe("lo");
		const terminal = chunks[3].choices as Array<Record<string, unknown>>;
		expect(terminal[0].finish_reason).toBe("stop");
		expect(terminal[0].delta).toEqual({});
		expect(chunks[3].usage).toEqual({
			prompt_tokens: 3,
			completion_tokens: 5,
			total_tokens: 8,
		});
		expect(payloads[4]).toBe("[DONE]");
	});

	it("/v1/responses inbound: returns the upstream response untouched", async () => {
		const upstream = jsonResponse(RESPONSES_UPSTREAM_BODY);
		const out = await convertResponse(
			channel,
			upstream,
			false,
			"/v1/responses",
		);
		expect(out).toBe(upstream);
	});

	it("non-chat passthrough inbound: returns the upstream response untouched", async () => {
		const upstream = jsonResponse({ embedding: [1, 2, 3] });
		const out = await convertResponse(
			channel,
			upstream,
			false,
			"/v1/embeddings",
		);
		expect(out).toBe(upstream);
	});

	it("anthropic channels still convert on chat paths (regression)", async () => {
		const anthropicChannel = makeChannel({ api_format: "anthropic" });
		const upstream = jsonResponse({
			id: "msg_1",
			model: "claude-3",
			role: "assistant",
			content: [{ type: "text", text: "Hi" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 2 },
		});
		const out = await convertResponse(
			anthropicChannel,
			upstream,
			false,
			"/v1/chat/completions",
		);
		const body = (await out.json()) as Record<string, unknown>;
		const choices = body.choices as Array<Record<string, unknown>>;
		const message = choices[0].message as Record<string, unknown>;
		expect(message.content).toBe("Hi");
		expect(choices[0].finish_reason).toBe("stop");
	});
});

describe("OpenAI proxy handler routing matrix (integration)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("responses inbound + only anthropic channel: 503 no_available_channels, zero upstream fetches", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const res = await proxyApp.request(
			"/v1/responses",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: "test-model", input: "hi" }),
			},
			env,
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.code).toBe("no_available_channels");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("non-chat passthrough + only anthropic channel: 503, zero fetches (regression)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "anthropic" })]);
		const res = await proxyApp.request(
			"/v1/embeddings",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: "test-model", input: "hi" }),
			},
			env,
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.code).toBe("no_available_channels");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("chat inbound + only responses channel: fetches {base}/responses with converted body and returns a chat completion", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(RESPONSES_UPSTREAM_BODY));
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel({ api_format: "responses" })]);
		const res = await proxyApp.request(
			"/v1/chat/completions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					messages: [
						{ role: "system", content: "Be nice" },
						{ role: "user", content: "hi" },
					],
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [target, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(target).toBe("https://upstream.example/v1/responses");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
		expect(upstreamBody.instructions).toBe("Be nice");
		expect(upstreamBody.messages).toBeUndefined();
		expect(upstreamBody.stream_options).toBeUndefined();
		expect(upstreamBody.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		]);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.object).toBe("chat.completion");
		const choices = body.choices as Array<Record<string, unknown>>;
		const message = choices[0].message as Record<string, unknown>;
		expect(message.content).toBe("Hello!");
		expect(choices[0].finish_reason).toBe("stop");
		expect(body.usage).toEqual({
			prompt_tokens: 4,
			completion_tokens: 6,
			total_tokens: 10,
		});

		// Usage recorded from the converted chat JSON (prompt 4 / completion 6)
		const insert = runs.find((r) =>
			r.sql.includes("INSERT INTO usage_logs"),
		);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(10);
		expect(insert?.args[6]).toBe(4);
		expect(insert?.args[7]).toBe(6);
	});

	it("streaming chat inbound + responses channel: converts SSE and records usage from the terminal chat chunk", async () => {
		const sseUpstream = [
			'{"type":"response.created","response":{"id":"resp_8","model":"test-model"}}',
			'{"type":"response.output_text.delta","delta":"Hi"}',
			'{"type":"response.completed","response":{"id":"resp_8","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}',
		]
			.map((payload) => `data: ${payload}\n\n`)
			.join("") + "data: [DONE]\n\n";
		const fetchMock = vi.fn(async () =>
			new Response(sseUpstream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel({ api_format: "responses" })]);
		const mockCtx = makeMockCtx();
		const res = await proxyApp.request(
			"/v1/chat/completions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
			mockCtx.ctx,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/responses");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		// The Responses converter drops stream_options (chat-only field)
		expect(upstreamBody.stream_options).toBeUndefined();
		expect(upstreamBody.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		]);

		const text = await res.text();
		expect(text).toContain("finish_reason\":\"stop\"");
		expect(text.trimEnd()).toMatch(/data: \[DONE\]$/);

		// Deterministically settle the background SSE usage task
		await mockCtx.awaitTasks();
		const insert = runs.find((r) =>
			r.sql.includes("INSERT INTO usage_logs"),
		);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(10);
		expect(insert?.args[6]).toBe(7);
		expect(insert?.args[7]).toBe(3);
	});

	it("streaming responses inbound + responses channel: passes the body through untouched and records usage via response.usage", async () => {
		const sseUpstream = [
			'{"type":"response.created","response":{"id":"resp_9","model":"test-model"}}',
			'{"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":6,"output_tokens":4,"total_tokens":10}}}',
			"data: [DONE]",
		]
			.map((payload) => `data: ${payload}\n\n`)
			.join("");
		const fetchMock = vi.fn(async () =>
			new Response(sseUpstream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel({ api_format: "responses" })]);
		const mockCtx = makeMockCtx();
		const rawBody = JSON.stringify({
			model: "test-model",
			input: "hi",
			stream: true,
		});
		const res = await proxyApp.request(
			"/v1/responses",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: rawBody,
			},
			env,
			mockCtx.ctx,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/responses");
		// R4 passthrough: byte-identical body, no stream_options injection
		expect(String(init.body)).toBe(rawBody);

		await res.text();
		await mockCtx.awaitTasks();
		const insert = runs.find((r) =>
			r.sql.includes("INSERT INTO usage_logs"),
		);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(10);
		expect(insert?.args[6]).toBe(6);
		expect(insert?.args[7]).toBe(4);
	});
});

describe("responses inbound + openai-only channel auto-conversion (AC3/AC4)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("non-stream: upstream gets {base}/chat/completions with a chat body, client gets a Responses body (AC3)", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(CHAT_UPSTREAM_BODY));
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([
			makeChannel({ api_formats: JSON.stringify(["openai"]) }),
		]);
		const res = await proxyApp.request(
			"/v1/responses",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: "test-model", input: "hi" }),
			},
			env,
		);
		expect(res.status).toBe(200);
		// Exactly one upstream call — the removed 400/404 path-fallback retry
		// no longer exists for this combination (AC8)
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
		expect(upstreamBody.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(upstreamBody.input).toBeUndefined();
		// Non-stream call: no stream_options injection
		expect(upstreamBody.stream_options).toBeUndefined();

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.object).toBe("response");
		expect(body.status).toBe("completed");
		const output = body.output as Array<Record<string, unknown>>;
		expect(output[0].type).toBe("message");
		const content = output[0].content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({
			type: "output_text",
			text: "Hello!",
			annotations: [],
		});
		expect(body.usage).toEqual({
			input_tokens: 5,
			output_tokens: 7,
			total_tokens: 12,
		});

		// Usage recorded from the Responses JSON (input/output → prompt/completion)
		const insert = runs.find((r) =>
			r.sql.includes("INSERT INTO usage_logs"),
		);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(12);
		expect(insert?.args[6]).toBe(5);
		expect(insert?.args[7]).toBe(7);
	});

	it("stream: upstream chat body carries stream_options.include_usage, client sees Responses events with usage only in response.completed (AC3)", async () => {
		const chatSseUpstream = [
			'{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
			'{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
			'{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
			'{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
			'{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
		]
			.map((payload) => `data: ${payload}\n\n`)
			.join("") + "data: [DONE]\n\n";
		const fetchMock = vi.fn(async () =>
			new Response(chatSseUpstream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([
			makeChannel({ api_formats: JSON.stringify(["openai"]) }),
		]);
		const mockCtx = makeMockCtx();
		const res = await proxyApp.request(
			"/v1/responses",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					input: "hi",
					stream: true,
				}),
			},
			env,
			mockCtx.ctx,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Upstream received a converted streaming chat call with the usage
		// injection riding on the converted body (design §4.4)
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		expect(upstreamBody.stream_options).toEqual({ include_usage: true });

		// Client stream speaks Responses protocol and never leaks [DONE]
		const text = await res.text();
		expect(text.trimEnd()).not.toMatch(/data: \[DONE\]$/);
		const events = parseSseEvents(text);
		expect(events[0].type).toBe("response.created");
		expect(
			events.some((e) => e.type === "response.output_text.delta"),
		).toBe(true);
		expect(events[events.length - 1].type).toBe("response.completed");

		// Usage rides exactly once, on response.completed, with all three values
		const withUsage = events.filter(
			(e) => (e.response as Record<string, unknown> | undefined)?.usage,
		);
		expect(withUsage).toHaveLength(1);
		expect(withUsage[0].type).toBe("response.completed");
		expect((withUsage[0].response as Record<string, unknown>).usage).toEqual({
			input_tokens: 7,
			output_tokens: 3,
			total_tokens: 10,
		});

		// parseUsageFromSse over the converted client stream recovers the usage
		const sseUsage = await parseUsageFromSse(
			new Response(text, {
				headers: { "content-type": "text/event-stream" },
			}),
		);
		expect(sseUsage.usage).not.toBeNull();
		expect(sseUsage.usage?.promptTokens).toBe(7);
		expect(sseUsage.usage?.promptTokens).toBeGreaterThan(0);

		await mockCtx.awaitTasks();
		const insert = runs.find((r) =>
			r.sql.includes("INSERT INTO usage_logs"),
		);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(10);
		expect(insert?.args[6]).toBe(7);
		expect(insert?.args[7]).toBe(3);
	});

	it("tools round-trip: flat Responses tools convert to nested chat tools and tool_calls come back as function_call output (AC3)", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				id: "chatcmpl-2",
				object: "chat.completion",
				created: 1730000000,
				model: "test-model",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "get_weather",
										arguments: '{"city":"Paris"}',
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({ api_formats: JSON.stringify(["openai"]) }),
		]);
		const res = await proxyApp.request(
			"/v1/responses",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					input: "What is the weather in Paris?",
					tools: [
						{
							type: "function",
							name: "get_weather",
							description: "Get current weather",
							parameters: {
								type: "object",
								properties: { city: { type: "string" } },
							},
						},
					],
					tool_choice: "auto",
				}),
			},
			env,
		);
		expect(res.status).toBe(200);

		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.tools).toEqual([
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "Get current weather",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
					},
				},
			},
		]);
		expect(upstreamBody.tool_choice).toBe("auto");

		const body = (await res.json()) as Record<string, unknown>;
		const output = body.output as Array<Record<string, unknown>>;
		const functionCall = output.find((item) => item.type === "function_call");
		expect(functionCall).toMatchObject({
			call_id: "call_1",
			name: "get_weather",
			arguments: '{"city":"Paris"}',
			status: "completed",
		});
	});

	it("responses inbound + [openai,responses] channel: native passthrough to {base}/responses, no path fallback (AC4)", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(RESPONSES_UPSTREAM_BODY));
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({
				api_format: "openai",
				api_formats: JSON.stringify(["openai", "responses"]),
			}),
		]);
		const rawBody = JSON.stringify({
			model: "test-model",
			input: "hi",
			store: true,
		});
		const res = await proxyApp.request(
			"/v1/responses",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: rawBody,
			},
			env,
		);
		expect(res.status).toBe(200);
		// Native passthrough wins over the openai conversion (preference order),
		// and the removed 400/404 path-fallback retry never fires
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/responses");
		expect(String(init.body)).toBe(rawBody);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.object).toBe("response");
	});
});

describe("Anthropic proxy handler routing (integration)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("anthropic inbound + only responses channel: 503 no_available_channels, zero upstream fetches", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "responses" })]);
		const res = await anthropicApp.request(
			"/messages",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
		);
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.code).toBe("no_available_channels");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("anthropic inbound + openai channel: still converts via chat completions (regression)", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
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
				usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel({ api_format: "openai" })]);
		const res = await anthropicApp.request(
			"/messages",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [target, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
		expect(Array.isArray(upstreamBody.messages)).toBe(true);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.type).toBe("message");
		expect(body.stop_reason).toBe("end_turn");
		const content = body.content as Array<Record<string, unknown>>;
		expect(content[0].type).toBe("text");
		expect(content[0].text).toBe("Hello!");
		expect(body.usage).toEqual({ input_tokens: 2, output_tokens: 3 });
	});

	it("anthropic inbound + [anthropic,openai] channel: native /v1/messages passthrough, no openai conversion (AC6)", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				id: "msg_1",
				type: "message",
				model: "claude-3",
				role: "assistant",
				content: [{ type: "text", text: "Hi" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 2 },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({
				api_format: "openai",
				api_formats: JSON.stringify(["anthropic", "openai"]),
			}),
		]);
		const res = await anthropicApp.request(
			"/messages",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Native anthropic endpoint (normalizeBaseUrl strips the /v1 mirror
		// suffix), authenticated via x-api-key — not the openai conversion path
		const [target, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(target).toBe("https://upstream.example/v1/messages");
		const headers = init.headers as Headers;
		expect(headers.get("x-api-key")).toBe("sk-channel");
		expect(headers.get("authorization")).toBeNull();

		// Original Anthropic body forwarded untouched (no chat conversion)
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
		expect(upstreamBody.max_tokens).toBe(16);
		expect(upstreamBody.messages).toEqual([
			{ role: "user", content: "hi" },
		]);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.type).toBe("message");
	});

	it("chat inbound + [openai,anthropic] channel: openai preferred, native passthrough without conversion traces (AC7)", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(CHAT_UPSTREAM_BODY));
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({
				api_format: "anthropic",
				api_formats: JSON.stringify(["openai", "anthropic"]),
			}),
		]);
		const res = await proxyApp.request(
			"/v1/chat/completions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "test-model",
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Preference order picks openai → native chat completions passthrough
		const [target, init] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const headers = init.headers as Headers;
		// openai branch keeps Bearer auth; the anthropic branch would have
		// swapped it for x-api-key only
		expect(headers.get("authorization")).toBe("Bearer sk-channel");
		expect(headers.get("x-api-key")).toBe("sk-channel");

		// Chat body verbatim — no anthropic conversion artifacts
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
		expect(upstreamBody.messages).toEqual([
			{ role: "user", content: "hi" },
		]);
		expect(upstreamBody.system).toBeUndefined();

		// Response returned untouched in chat protocol
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.object).toBe("chat.completion");
	});
});
