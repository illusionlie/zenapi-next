import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicProxyApp from "../apps/worker/src/routes/anthropic-proxy";
import channelsApp from "../apps/worker/src/routes/channels";
import playgroundApp from "../apps/worker/src/routes/playground";
import proxyApp from "../apps/worker/src/routes/proxy";
import type { ChannelRecord } from "../apps/worker/src/services/channels";

/**
 * attempt 循环层 × 服务端预设接线（AC8/AC11，design D6 接线）：
 * - AC8：非流客户端 × 强制流式预设渠道（上游 SSE）→ 客户端拿到合法非流
 *   JSON 且 usage 正常解析计费；流式客户端 → 管线零变化（SSE 结构原样）。
 * - AC11：主代理 / Playground / test-model 三调用方对同一对话信号渲染出
 *   相同指纹（会话/消息 ID、UA）。
 * - anthropic-proxy 路径（AC9）附带一条透传分支冒烟：预设头 + 强制聚合在
 *   独立 attempt 循环同样生效。
 */

function makeChannel(
	overrides: Partial<ChannelRecord> = {},
): ChannelRecord {
	return {
		id: "ch1",
		name: "preset-channel",
		base_url: "https://upstream.example/v1",
		api_key: "sk-channel",
		weight: 1,
		status: "active",
		api_format: "openai",
		disguise_preset: "opencode_zen_v1",
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
 * Minimal D1 mock covering the queries the proxy / playground / channels
 * handlers hit (tokens, channels, aliases, settings) plus batch capture for
 * usage INSERTs.
 */
function makeDb(
	options: {
		channels?: unknown[];
		token?: Record<string, unknown> | null;
	} = {},
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
			return stmts.map(() => ({}) as unknown);
		},
	};
	return { db, runs };
}

type ProxyEnv = Parameters<typeof proxyApp.request>[2];
type ProxyCtx = Parameters<typeof proxyApp.request>[3];

function makeMockCtx(): { ctx: ProxyCtx; awaitTasks: () => Promise<void> } {
	const tasks: Promise<unknown>[] = [];
	return {
		ctx: {
			waitUntil: (p: Promise<unknown>) => {
				tasks.push(p);
			},
			passThroughOnException: () => {},
		} as ProxyCtx,
		awaitTasks: async () => {
			await Promise.allSettled(tasks);
		},
	};
}

function makeEnv(channels: unknown[]): {
	env: ProxyEnv;
	runs: Array<{ sql: string; args: unknown[] }>;
} {
	const { db, runs } = makeDb({ channels });
	return {
		env: { DB: db } as unknown as ProxyEnv,
		runs,
	};
}

function chatSseUpstream(): Response {
	const sse = [
		'{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
		'{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
		'{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
		'{"id":"chatcmpl-1","object":"chat.completion.chunk","created":1730000000,"model":"test-model","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}',
	]
		.map((payload) => `data: ${payload}\n\n`)
		.join("") + "data: [DONE]\n\n";
	return new Response(sse, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const PROXY_REQUEST_INIT = {
	method: "POST",
	headers: {
		authorization: "Bearer test-token",
		"content-type": "application/json",
	},
} as const;

describe("AC8 — non-stream client × stream-forcing preset channel", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("upstream receives a forced-stream compliant body; client gets aggregated non-stream JSON with usage billed", async () => {
		const fetchMock = vi.fn(async () => chatSseUpstream());
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel()]);
		const mockCtx = makeMockCtx();

		const res = await proxyApp.request(
			"/v1/chat/completions",
			{
				...PROXY_REQUEST_INIT,
				body: JSON.stringify({
					model: "test-model",
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
			mockCtx.ctx,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 上游 body：强制 stream:true + stream_options 注入 + 工具合规
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		expect(upstreamBody.stream_options).toEqual({ include_usage: true });
		const tools = upstreamBody.tools as Array<Record<string, unknown>>;
		const names = tools.map((t) => {
			const fn = t.function as Record<string, unknown> | undefined;
			return (fn?.name ?? t.name) as string;
		});
		expect(names).toContain("bash");
		expect(names.length).toBeGreaterThanOrEqual(2);
		// 预设身份头随请求发出
		const headers = init.headers as Headers;
		expect(headers.get("x-opencode-session")).toMatch(
			/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
		);
		expect(headers.get("user-agent")).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
		);

		// 客户端拿到的是聚合后的标准非流 JSON（SSE 不外泄）
		expect(res.headers.get("content-type")).toBe("application/json");
		const text = await res.text();
		expect(text).not.toContain("data:");
		expect(text).not.toContain("[DONE]");
		const body = JSON.parse(text) as Record<string, unknown>;
		expect(body.object).toBe("chat.completion");
		const choices = body.choices as Array<Record<string, unknown>>;
		expect(choices[0].finish_reason).toBe("stop");
		expect((choices[0].message as Record<string, unknown>).content).toBe(
			"Hello",
		);
		expect(body.usage).toEqual({
			prompt_tokens: 5,
			completion_tokens: 3,
			total_tokens: 8,
		});

		// usage 计费链路零改动：聚合产物走非流 JSON 解析入账
		await mockCtx.awaitTasks();
		const insert = runs.find((r) => r.sql.includes("INSERT INTO usage_logs"));
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(8);
		expect(insert?.args[6]).toBe(5);
		expect(insert?.args[7]).toBe(3);
	});

	it("streaming client keeps the passthrough pipeline structurally unchanged (no aggregation)", async () => {
		const upstream = chatSseUpstream();
		const upstreamText = await upstream.clone().text();
		const fetchMock = vi.fn(async () => upstream);
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([makeChannel()]);
		const mockCtx = makeMockCtx();

		const res = await proxyApp.request(
			"/v1/chat/completions",
			{
				...PROXY_REQUEST_INIT,
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
		// 流式客户端：响应管线零变化 —— SSE 原样透传（含 [DONE]）
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		const text = await res.text();
		expect(text).toBe(upstreamText);
	});
});

describe("AC9 smoke — anthropic-proxy passthrough branch with preset", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("anthropic inbound + anthropic-target preset channel: fingerprint headers + forced-stream body on the passthrough", async () => {
		const anthropicSse = [
			'{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","usage":{"input_tokens":4,"output_tokens":1}}}',
			'{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
			'{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hola"}}',
			'{"type":"content_block_stop","index":0}',
			'{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":4,"output_tokens":6}}',
			'{"type":"message_stop"}',
		]
			.map((payload) => `data: ${payload}\n\n`)
			.join("");
		const fetchMock = vi.fn(
			async () =>
				new Response(anthropicSse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({
				api_format: "anthropic",
				api_formats: JSON.stringify(["anthropic"]),
				base_url: "https://upstream.example",
			}),
		]);

		const res = await anthropicProxyApp.request(
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
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/messages");
		const headers = init.headers as Headers;
		// anthropic 目标：anthropic SDK 段 UA + 预设身份头 + 内建鉴权头并存
		expect(headers.get("user-agent")).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.46 runtime/bun/1.3.14",
		);
		expect(headers.get("x-opencode-session")).toMatch(
			/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
		);
		expect(headers.get("x-api-key")).toBe("sk-channel");
		// 非流客户端 × 强制流式：上游 body stream:true + anthropic 形状工具
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		const tools = upstreamBody.tools as Array<Record<string, unknown>>;
		expect(
			tools.map((t) => t.name as string),
		).toEqual(["bash", "read", "edit"]);
		expect(tools[0].input_schema).toMatchObject({ type: "object" });

		// 客户端拿到聚合后的标准非流 Message JSON
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.type).toBe("message");
		expect((body.content as Array<Record<string, unknown>>)[0]).toEqual({
			type: "text",
			text: "Hola",
		});
	});
});

describe("AC9 — anthropic-proxy openai-target branch with preset", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("anthropic inbound + openai-target preset channel: forced-stream body carries include_usage; aggregated usage flows into the Message", async () => {
		const fetchMock = vi.fn(async () => chatSseUpstream());
		vi.stubGlobal("fetch", fetchMock);
		const { env } = makeEnv([
			makeChannel({ api_formats: JSON.stringify(["openai"]) }),
		]);

		const res = await anthropicProxyApp.request(
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

		// 非流客户端 × 强制流式：上游 body stream:true + include_usage（usage
		// 尾 chunk 开关）+ 工具合规
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const upstreamBody = JSON.parse(String(init.body)) as Record<
			string,
			unknown
		>;
		expect(upstreamBody.stream).toBe(true);
		expect(upstreamBody.stream_options).toEqual({ include_usage: true });
		const tools = upstreamBody.tools as Array<Record<string, unknown>>;
		expect(tools.map((t) => (t.function as { name: string }).name)).toContain(
			"bash",
		);

		// 客户端拿到聚合后的标准非流 Message JSON，usage 从聚合产物解析
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.type).toBe("message");
		expect(body.usage).toMatchObject({ input_tokens: 5, output_tokens: 3 });
	});
});

describe("AC11 — three callers render the same fingerprint for identical inputs", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("proxy / playground / test-model produce identical session+message IDs and UA", async () => {
		const captured: Array<Headers> = [];

		// 1) 主代理（非流 × 预设渠道）
		const proxyFetch = vi.fn(async () => chatSseUpstream());
		vi.stubGlobal("fetch", proxyFetch);
		const proxyHarness = makeEnv([makeChannel()]);
		await proxyApp.request(
			"/v1/chat/completions",
			{
				...PROXY_REQUEST_INIT,
				body: JSON.stringify({
					model: "test-model",
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			proxyHarness.env,
			makeMockCtx().ctx,
		);
		captured.push((proxyFetch.mock.calls[0] as [string, RequestInit])[1].headers as Headers);

		// 2) Playground（policy=null 豁免不影响预设层；同一对话信号）
		const playgroundFetch = vi.fn(async () => chatSseUpstream());
		vi.stubGlobal("fetch", playgroundFetch);
		const playgroundHarness = makeEnv([makeChannel()]);
		await playgroundApp.request(
			"/chat",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "test-model",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			},
			playgroundHarness.env,
		);
		captured.push((playgroundFetch.mock.calls[0] as [string, RequestInit])[1].headers as Headers);

		// 3) 渠道单模型测试（免费模型验收路径；表单即真相携带预设）
		const testModelFetch = vi.fn(async () => chatSseUpstream());
		vi.stubGlobal("fetch", testModelFetch);
		const testModelHarness = makeEnv([]);
		const testModelRes = await channelsApp.request(
			"/test-model",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					base_url: "https://upstream.example/v1",
					api_key: "sk-channel",
					model: "test-model",
					text: "hi",
					disguise_preset: "opencode_zen_v1",
				}),
			},
			testModelHarness.env,
		);
		expect(testModelRes.status).toBe(200);
		const testModelOutcome = (await testModelRes.json()) as {
			ok: boolean;
		};
		expect(testModelOutcome.ok).toBe(true);
		captured.push((testModelFetch.mock.calls[0] as [string, RequestInit])[1].headers as Headers);

		// 三调用方指纹逐字节一致（同一对话信号 → 同会话/同回合同消息 ID）
		const sessions = captured.map((h) => h.get("x-opencode-session"));
		const requests = captured.map((h) => h.get("x-opencode-request"));
		const uas = captured.map((h) => h.get("user-agent"));
		expect(sessions[0]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		expect(sessions[0]).toBe(sessions[1]);
		expect(sessions[1]).toBe(sessions[2]);
		expect(requests[0]).toBe(requests[1]);
		expect(requests[1]).toBe(requests[2]);
		expect(requests[0]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		expect(uas[0]).toBe(uas[1]);
		expect(uas[1]).toBe(uas[2]);
		expect(uas[0]).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
		);
	});
});
