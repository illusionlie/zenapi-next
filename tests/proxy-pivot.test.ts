/**
 * responses↔anthropic 经 chat 枢纽互转（pivot）集成测试。
 *
 * 确定性说明：所有用例都构造**单一候选渠道**（createWeightedOrder 单渠道
 * 加权随机不改变结果），断言不依赖候选顺序。AC4 偏好序的路由级判定在
 * tests/channel-routing.test.ts 锁定；此处集成级用单渠道双声明锁定
 * 「单跳优先于 pivot」的端到端结果。
 *
 * usage 注入核对（本项目曾因漏注入致计费记零）：两个 pivot 分支的出站体
 * 分别是 anthropic 形状与 responses 形状——stream_options.include_usage 注入
 * 条件键于「最终上游体为 chat completions 形状」，两者都不该注入；流式
 * usage 来自协议自带尾块（anthropic message_delta / responses
 * response.completed），测试逐分支断言出站体无 stream_options 且落库
 * prompt > 0。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicApp from "../apps/worker/src/routes/anthropic-proxy";
import proxyApp from "../apps/worker/src/routes/proxy";
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

/** Minimal D1 mock mirroring tests/proxy-responses.test.ts. */
function makeDb(
	options: { channels?: unknown[]; token?: Record<string, unknown> | null } = {},
) {
	const channels = options.channels ?? [];
	const token = options.token === undefined ? tokenRow : options.token;
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
		batch: async (stmts: Array<{ sql: string; boundArgs: unknown[] }>) => {
			for (const s of stmts) runs.push({ sql: s.sql, args: s.boundArgs });
			return stmts.map(() => ({}));
		},
	};
	return { db, runs };
}

type RequestEnv = Parameters<typeof proxyApp.request>[2];
type RequestCtx = Parameters<typeof proxyApp.request>[3];

function makeMockCtx(): { ctx: RequestCtx; awaitTasks: () => Promise<void> } {
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
): { env: RequestEnv; runs: Array<{ sql: string; args: unknown[] }> } {
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

function sseResponse(lines: string[]): Response {
	return new Response(lines.join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * Parses `data: {...}` payloads out of an SSE stream, skipping [DONE].
 * Handles both bare `data:` lines (Responses protocol) and `event:`+`data:`
 * blocks (anthropic protocol).
 */
function parseSseEvents(text: string): Array<Record<string, unknown>> {
	return text
		.split("\n\n")
		.map((block) =>
			block
				.split("\n")
				.find((line) => line.startsWith("data: ")),
		)
		.filter((payload): payload is string => payload !== undefined)
		.map((payload) => payload.slice(6))
		.filter((payload) => payload !== "[DONE]")
		.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

function anthropicSseEvents(events: Array<Record<string, unknown>>): string[] {
	return events.map(
		(e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
	);
}

function responsesSseEvents(events: Array<Record<string, unknown>>): string[] {
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`);
}

function usageInsert(
	runs: Array<{ sql: string; args: unknown[] }>,
): { args: unknown[] } | undefined {
	return runs.find((r) => r.sql.includes("INSERT INTO usage_logs"));
}

// ---------------------------------------------------------------------------
// Direction A: /v1/responses inbound → anthropic-only channel
// ---------------------------------------------------------------------------

const ANTHROPIC_UPSTREAM_BODY = {
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "claude-3",
	content: [{ type: "text", text: "Hello!" }],
	stop_reason: "end_turn",
	usage: {
		input_tokens: 100,
		cache_read_input_tokens: 50,
		cache_creation_input_tokens: 10,
		output_tokens: 7,
	},
};

describe("Direction A: responses inbound → anthropic-only channel (AC2)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("non-stream: upstream gets {base}/v1/messages with an anthropic body, client gets a Responses body", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(ANTHROPIC_UPSTREAM_BODY));
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([
			makeChannel({ api_format: "anthropic" }),
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
					instructions: "Be nice",
					input: "hi",
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// anthropic endpoint: normalizeBaseUrl strips the stored /v1 suffix
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/messages");
		const headers = init.headers as Headers;
		expect(headers.get("x-api-key")).toBe("sk-channel");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(headers.get("authorization")).toBeNull();

		// Outbound body speaks anthropic: instructions hoisted into system,
		// input collapsed into a user message, default max_tokens present
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
		expect(upstreamBody.system).toBe("Be nice");
		expect(upstreamBody.max_tokens).toBe(8192);
		expect(upstreamBody.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(upstreamBody.input).toBeUndefined();
		// usage 注入核对：anthropic 形状出站体不注入 chat 专属 stream_options
		expect(upstreamBody.stream_options).toBeUndefined();

		// Client-facing body speaks Responses
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
		// usage 口径（design §5）：input+cache_read+cache_creation 折总量，
		// cache_read 经 input_tokens_details 存活，cache_creation 不单列
		expect(body.usage).toEqual({
			input_tokens: 160,
			output_tokens: 7,
			total_tokens: 167,
			input_tokens_details: { cached_tokens: 50 },
		});

		// usage_logs 落库：prompt=160（总量）、cached=50、cache_creation=NULL
		const insert = usageInsert(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(167);
		expect(insert?.args[6]).toBe(160);
		expect(insert?.args[7]).toBe(7);
		expect(insert?.args[8]).toBe(50);
		expect(insert?.args[9]).toBeNull();
	});

	it("stream: anthropic SSE → client Responses SSE; usage rides response.completed via the protocol tail (AC2/AC3)", async () => {
		const upstreamSse = sseResponse(
			anthropicSseEvents([
				{
					type: "message_start",
					message: {
						id: "msg_s1",
						model: "claude-3",
						usage: {
							input_tokens: 100,
							cache_read_input_tokens: 50,
							cache_creation_input_tokens: 10,
							output_tokens: 1,
						},
					},
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hel" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "lo" },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 7 },
				},
				{ type: "message_stop" },
			]),
		);
		const fetchMock = vi.fn(async () => upstreamSse);
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([
			makeChannel({ api_format: "anthropic" }),
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

		// Upstream body: streaming anthropic call without chat stream_options
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		expect(upstreamBody.stream_options).toBeUndefined();

		// Client stream speaks Responses: created → text deltas → completed,
		// never leaks [DONE]
		const text = await res.text();
		expect(text.trimEnd()).not.toMatch(/data: \[DONE\]$/);
		const events = parseSseEvents(text);
		expect(events[0].type).toBe("response.created");
		expect(
			events.some((e) => e.type === "response.output_text.delta"),
		).toBe(true);
		expect(events[events.length - 1].type).toBe("response.completed");

		// usage rides exactly once, on response.completed, from the protocol
		// tail (message_delta cumulative + message_start cache), not injection
		const withUsage = events.filter(
			(e) => (e.response as Record<string, unknown> | undefined)?.usage,
		);
		expect(withUsage).toHaveLength(1);
		expect(withUsage[0].type).toBe("response.completed");
		expect((withUsage[0].response as Record<string, unknown>).usage).toEqual({
			input_tokens: 160,
			output_tokens: 7,
			total_tokens: 167,
			input_tokens_details: { cached_tokens: 50 },
		});

		// AC3 seam: parseUsageFromSse over the client stream sees prompt > 0;
		// cache_read survives, cache_creation stays folded (NULL)
		const sseUsage = await parseUsageFromSse(
			new Response(text, {
				headers: { "content-type": "text/event-stream" },
			}),
		);
		expect(sseUsage.usage?.promptTokens).toBe(160);
		expect(sseUsage.usage?.promptTokens).toBeGreaterThan(0);
		expect(sseUsage.usage?.cachedInputTokens).toBe(50);
		expect(sseUsage.usage?.cacheCreationTokens).toBeNull();

		await mockCtx.awaitTasks();
		const insert = usageInsert(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(167);
		expect(insert?.args[6]).toBe(160);
		expect(insert?.args[7]).toBe(7);
		expect(insert?.args[8]).toBe(50);
		expect(insert?.args[9]).toBeNull();
	});

	it("tools round-trip: Responses tools convert to anthropic tools and tool_use comes back as a function_call output", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				id: "msg_t",
				type: "message",
				role: "assistant",
				model: "claude-3",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "get_weather",
						input: { city: "Paris" },
					},
				],
				stop_reason: "tool_use",
				usage: { input_tokens: 9, output_tokens: 4 },
			}),
		);
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

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.tools).toEqual([
			{
				name: "get_weather",
				description: "Get current weather",
				input_schema: {
					type: "object",
					properties: { city: { type: "string" } },
				},
			},
		]);
		expect(upstreamBody.tool_choice).toEqual({ type: "auto" });

		const body = (await res.json()) as Record<string, unknown>;
		const output = body.output as Array<Record<string, unknown>>;
		const functionCall = output.find((item) => item.type === "function_call");
		expect(functionCall).toMatchObject({
			call_id: "toolu_1",
			name: "get_weather",
			arguments: '{"city":"Paris"}',
			status: "completed",
		});
	});

	it("reasoning.effort carries through the chat hub into an anthropic thinking budget", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(ANTHROPIC_UPSTREAM_BODY));
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
				body: JSON.stringify({
					model: "test-model",
					input: "hi",
					reasoning: { effort: "high" },
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		// effort "high" × default max_tokens 8192 → budget floor(8192*0.8)=6553
		expect(upstreamBody.thinking).toEqual({
			type: "enabled",
			budget_tokens: 6553,
		});
		expect(upstreamBody.temperature).toBeUndefined();
		expect(upstreamBody.top_p).toBeUndefined();
	});

	it("seam lock: anthropic upstream in-stream error → client sees a healthy response.completed (content truncated, never response.failed)", async () => {
		const upstreamSse = sseResponse(
			anthropicSseEvents([
				{
					type: "message_start",
					message: {
						id: "msg_e1",
						model: "claude-3",
						usage: { input_tokens: 5, output_tokens: 1 },
					},
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "partial" },
				},
				{
					type: "error",
					error: { type: "overloaded_error", message: "Overloaded" },
				},
			]),
		);
		const fetchMock = vi.fn(async () => upstreamSse);
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
				body: JSON.stringify({
					model: "test-model",
					input: "hi",
					stream: true,
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		const events = parseSseEvents(text);
		// design.md §4: the chat hub terminates with finish_reason stop on an
		// upstream error event, so the Responses side closes healthily —
		// explicit termination beats hanging, no fake failure is reported
		expect(events[events.length - 1].type).toBe("response.completed");
		expect(events.some((e) => e.type === "response.failed")).toBe(false);
		const terminal = events[events.length - 1].response as Record<
			string,
			unknown
		>;
		expect(terminal.status).toBe("completed");
	});
});

// ---------------------------------------------------------------------------
// Direction B: /anthropic/v1/messages inbound → responses-only channel
// ---------------------------------------------------------------------------

const RESPONSES_UPSTREAM_BODY = {
	id: "resp_1",
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
	usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
};

describe("Direction B: anthropic inbound → responses-only channel (AC1)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("non-stream: upstream gets {base}/responses with a Responses body, client gets an anthropic Message", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(RESPONSES_UPSTREAM_BODY));
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([
			makeChannel({ api_format: "responses" }),
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
					system: "Be nice",
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// responses endpoint keeps the stored version path
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/responses");
		const headers = init.headers as Headers;
		expect(headers.get("authorization")).toBe("Bearer sk-channel");

		// Outbound body speaks Responses: system hoisted into instructions,
		// max_tokens → max_output_tokens, user message as input items
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.model).toBe("test-model");
		expect(upstreamBody.instructions).toBe("Be nice");
		expect(upstreamBody.max_output_tokens).toBe(16);
		expect(upstreamBody.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
		]);
		expect(upstreamBody.messages).toBeUndefined();
		// usage 注入核对：responses 形状出站体不注入 chat 专属 stream_options
		expect(upstreamBody.stream_options).toBeUndefined();

		// Client-facing body speaks anthropic
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.type).toBe("message");
		expect(body.role).toBe("assistant");
		const content = body.content as Array<Record<string, unknown>>;
		expect(content[0]).toEqual({ type: "text", text: "Hello!" });
		expect(body.stop_reason).toBe("end_turn");
		// 方向 B 无缓存拆分（既有惯例）：usage 降级为总量
		expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 7 });

		const insert = usageInsert(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(12);
		expect(insert?.args[6]).toBe(5);
		expect(insert?.args[7]).toBe(7);
		expect(insert?.args[8]).toBeNull();
		expect(insert?.args[9]).toBeNull();
	});

	it("stream: responses SSE → client anthropic SSE; message_delta carries the prompt so parseUsageFromSse sees prompt > 0 (AC1/AC3)", async () => {
		const upstreamSse = sseResponse(
			responsesSseEvents([
				{
					type: "response.created",
					response: { id: "resp_9", model: "gpt-4o" },
				},
				{ type: "response.output_text.delta", delta: "Hel" },
				{ type: "response.output_text.delta", delta: "lo" },
				{
					type: "response.completed",
					response: {
						id: "resp_9",
						model: "gpt-4o",
						status: "completed",
						usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
					},
				},
			]),
		);
		const fetchMock = vi.fn(async () => upstreamSse);
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([
			makeChannel({ api_format: "responses" }),
		]);
		const mockCtx = makeMockCtx();
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

		// Upstream body: streaming responses call, no chat stream_options
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		expect(upstreamBody.stream_options).toBeUndefined();

		// Client stream speaks anthropic: message_start → text deltas →
		// message_delta → message_stop, never leaks [DONE]
		const text = await res.text();
		expect(text).not.toContain("[DONE]");
		const events = parseSseEvents(text);
		expect(events[0].type).toBe("message_start");
		expect(
			events.some(
				(e) =>
					e.type === "content_block_delta" &&
					(e.delta as Record<string, unknown> | undefined)?.text === "Hel",
			),
		).toBe(true);
		expect(events[events.length - 1].type).toBe("message_stop");
		const messageDelta = events.find((e) => e.type === "message_delta") as
			| Record<string, unknown>
			| undefined;
		expect(messageDelta).toBeDefined();
		expect(messageDelta?.delta).toEqual({ stop_reason: "end_turn" });
		// usage tail from the protocol (response.completed → terminal chat
		// chunk → message_delta): prompt forwarded so the raw merge recovers it
		expect(messageDelta?.usage).toEqual({
			output_tokens: 4,
			input_tokens: 6,
		});

		// AC3 seam: parseUsageFromSse over the client anthropic stream
		expect(await ssePromptTokens(text)).toBe(6);

		await mockCtx.awaitTasks();
		const insert = usageInsert(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(10);
		expect(insert?.args[6]).toBe(6);
		expect(insert?.args[7]).toBe(4);
	});

	it("tools round-trip: anthropic tools convert to flat Responses tools and a function_call comes back as tool_use", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				id: "resp_t",
				object: "response",
				created_at: 1730000000,
				status: "completed",
				model: "gpt-4o",
				output: [
					{
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "get_weather",
						arguments: '{"city":"Paris"}',
						status: "completed",
					},
				],
				usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
			}),
		);
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
					tools: [
						{
							name: "get_weather",
							description: "Get current weather",
							input_schema: {
								type: "object",
								properties: { city: { type: "string" } },
							},
						},
					],
				}),
			},
			env,
		);
		expect(res.status).toBe(200);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.tools).toEqual([
			{
				type: "function",
				name: "get_weather",
				description: "Get current weather",
				parameters: {
					type: "object",
					properties: { city: { type: "string" } },
				},
			},
		]);

		const body = (await res.json()) as Record<string, unknown>;
		expect(body.stop_reason).toBe("tool_use");
		const content = body.content as Array<Record<string, unknown>>;
		const toolUse = content.find((b) => b.type === "tool_use");
		expect(toolUse).toMatchObject({
			id: "call_1",
			name: "get_weather",
			input: { city: "Paris" },
		});
	});

	it("seam lock: responses upstream response.failed → client sees a healthy anthropic termination (end_turn + message_stop)", async () => {
		const upstreamSse = sseResponse(
			responsesSseEvents([
				{
					type: "response.created",
					response: { id: "resp_f", model: "gpt-4o" },
				},
				{ type: "response.output_text.delta", delta: "partial" },
				{
					type: "response.failed",
					response: {
						id: "resp_f",
						status: "failed",
						error: { code: "upstream_error", message: "boom" },
					},
				},
			]),
		);
		const fetchMock = vi.fn(async () => upstreamSse);
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
					stream: true,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		const events = parseSseEvents(text);
		// design.md §4 symmetry: response.failed converts to a terminal chat
		// chunk (finish_reason stop), so the anthropic side closes healthily —
		// the stream is already 200 and anthropic SSE has no error event type
		expect(events[events.length - 1].type).toBe("message_stop");
		const messageDelta = events.find((e) => e.type === "message_delta");
		expect(messageDelta).toBeDefined();
		expect((messageDelta?.delta as Record<string, unknown>).stop_reason).toBe(
			"end_turn",
		);
		expect(events.some((e) => e.type === "error")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Preset forced-stream × pivot direction B (non-stream client): the disguise
// preset rewrites the outbound responses body to stream:true while the client
// asked non-stream, so the upstream SSE must aggregate into a standard
// non-stream Responses object before the responsesToAnthropicResponse chain.
// Locks the seam reported during implementation review (task 10-27 follow-up).
// ---------------------------------------------------------------------------
describe("Preset forced-stream aggregation × pivot direction B (non-stream client)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("non-stream client + opencode_zen_v1 preset: upstream body forced to stream with conformance tools, aggregated response.completed feeds the anthropic conversion, usage recorded from the aggregate", async () => {
		// Same fixture family as the direction B stream test, with one
		// realism upgrade: the response.completed event carries the complete
		// response object including output items (real Responses SSE does) —
		// the aggregation path reads that object directly instead of the
		// delta stream, so output must be present for a meaningful product.
		const upstreamSse = sseResponse(
			responsesSseEvents([
				{
					type: "response.created",
					response: { id: "resp_9", model: "gpt-4o" },
				},
				{ type: "response.output_text.delta", delta: "Hel" },
				{ type: "response.output_text.delta", delta: "lo" },
				{
					type: "response.completed",
					response: {
						id: "resp_9",
						model: "gpt-4o",
						status: "completed",
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "Hello" }],
							},
						],
						usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
					},
				},
			]),
		);
		const fetchMock = vi.fn(async () => upstreamSse);
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([
			makeChannel({
				api_format: "responses",
				disguise_preset: "opencode_zen_v1",
			}),
		]);
		const mockCtx = makeMockCtx();
		const res = await anthropicApp.request(
			"/messages",
			{
				method: "POST",
				headers: {
					authorization: "Bearer test-token",
					"content-type": "application/json",
				},
				// Client is NON-stream (no stream field) — the preset is what
				// forces the upstream call to stream.
				body: JSON.stringify({
					model: "test-model",
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
			mockCtx.ctx,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// (1) Outbound body: preset forced stream:true + tool conformance on
		// the responses shape (flat function tools, bash always injected)
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/responses");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		const tools = upstreamBody.tools as Array<Record<string, unknown>>;
		expect(Array.isArray(tools)).toBe(true);
		const toolNames = tools.map((t) => t.name);
		expect(toolNames).toContain("bash");
		expect(tools.length).toBeGreaterThanOrEqual(2);
		expect(tools.find((t) => t.name === "bash")).toMatchObject({
			type: "function",
			name: "bash",
		});
		// usage 注入核对：responses 形状出站体不注入 chat 专属 stream_options
		expect(upstreamBody.stream_options).toBeUndefined();

		// (3) Client receives a valid anthropic Messages JSON — the aggregated
		// product passed through responsesToAnthropicResponse, no SSE traces
		expect(res.headers.get("content-type")).toBe("application/json");
		const text = await res.text();
		expect(text).not.toContain("[DONE]");
		expect(text).not.toContain("message_stop");
		expect(text).not.toContain("content_block_");
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(body.type).toBe("message");
		expect(body.role).toBe("assistant");
		expect(body.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(body.stop_reason).toBe("end_turn");
		expect(body.usage).toEqual({ input_tokens: 6, output_tokens: 4 });

		// (4) Usage recorded from the aggregate's response.completed tail
		// (input_tokens 6 → prompt 6 > 0), not zeros
		await mockCtx.awaitTasks();
		const insert = usageInsert(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(10);
		expect(insert?.args[6]).toBe(6);
		expect(insert?.args[7]).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// AC4: single-hop preference over the pivot (integration, deterministic
// single dual-declaration channel — the unit matrix lives in
// tests/channel-routing.test.ts)
// ---------------------------------------------------------------------------

describe("Pivot preference: single-hop wins over the two-hop path (AC4)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("responses inbound + [openai,anthropic] channel: openai single-hop wins, fetch hits /chat/completions", async () => {
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
				usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({
				api_format: "openai",
				api_formats: JSON.stringify(["openai", "anthropic"]),
			}),
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
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
	});

	it("responses inbound + [responses,anthropic] channel: native responses wins, fetch hits /responses", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(RESPONSES_UPSTREAM_BODY));
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({
				api_format: "responses",
				api_formats: JSON.stringify(["responses", "anthropic"]),
			}),
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
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/responses");
		// native passthrough: byte-identical body, no pivot conversion artifacts
		expect(String(init.body)).toBe(
			JSON.stringify({ model: "test-model", input: "hi" }),
		);
	});

	it("anthropic inbound + [openai,responses] channel: openai single-hop wins over the responses pivot, fetch hits /chat/completions", async () => {
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
		const { env } = makeEnv([
			makeChannel({
				api_format: "openai",
				api_formats: JSON.stringify(["openai", "responses"]),
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
		const [target] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
	});

	it("anthropic inbound + [anthropic,responses] channel: native anthropic wins over the responses pivot, fetch hits /v1/messages", async () => {
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
				api_format: "anthropic",
				api_formats: JSON.stringify(["anthropic", "responses"]),
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
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/messages");
		// native passthrough: original anthropic body forwarded untouched
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.max_tokens).toBe(16);
		expect(upstreamBody.input).toBeUndefined();
	});
});

/** Parses an anthropic-shaped client SSE text into its normalized usage. */
async function ssePromptTokens(text: string): Promise<number | null> {
	const { usage } = await parseUsageFromSse(
		new Response(text, {
			headers: { "content-type": "text/event-stream" },
		}),
	);
	expect(usage?.promptTokens).toBeGreaterThan(0);
	return usage?.promptTokens ?? null;
}
