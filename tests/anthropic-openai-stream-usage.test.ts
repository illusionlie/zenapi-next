/**
 * anthropic 入站 + openai-only 渠道：stream_options.include_usage 注入与
 * message_stop 恰一不变量的集成锁定（任务 10-28-stream-usage-and-stop-fix）。
 *
 * 确定性说明：单一候选渠道（createWeightedOrder 单渠道加权随机不改变结果），
 * 断言不依赖候选顺序，风格照 tests/proxy-pivot.test.ts。
 *
 * 计费缺口背景（存量，非 pivot 引入）：该路径普通流式此前不注入
 * include_usage——OpenAI 兼容上游不自愿携带 SSE usage 尾块时 usage 落库记零。
 * 注入矩阵现状：chat 入站 handler 预注入 ✓；/v1/responses 入站
 * buildChannelRequest 注入 ✓；anthropic 入站 openai 目标 ✓（本文件锁定）；
 * 两个 pivot 分支出站体非 chat 形状不适用（tests/proxy-pivot.test.ts 锁定
 * stream_options undefined）。
 *
 * usage 接缝：落库解析走客户端可见的转换后 anthropic 流
 * （parseUsageFromSse 的 message.usage / message_delta.usage 合并链），usage
 * 依赖上游把三值放在终止 chunk 上（message_delta 的 input_tokens 转发，spec
 * format-conversion.md §3.7 方向 B）；converter 对空 choices 的 usage 尾块
 * 不产事件（openai 空尾块照带，验证其被吸收、不产生第二个 message_delta）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicApp from "../apps/worker/src/routes/anthropic-proxy";
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
		api_formats: JSON.stringify(["openai"]),
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

/** Minimal D1 mock mirroring tests/proxy-pivot.test.ts. */
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

type RequestEnv = Parameters<typeof anthropicApp.request>[2];
type RequestCtx = Parameters<typeof anthropicApp.request>[3];

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

/**
 * OpenAI 兼容上游按 include_usage 约定回流的 chat SSE：usage 在终止 chunk
 * 携带（prompt_tokens 5 / completion_tokens 3 / total 8）+ 空 choices 的
 * usage 尾块 + [DONE]。
 */
function chatSseUpstream(): Response {
	const chunk = (
		choices: unknown[],
		usage?: Record<string, unknown>,
	): string =>
		`data: ${JSON.stringify({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1730000000,
			model: "test-model",
			choices,
			...(usage !== undefined ? { usage } : {}),
		})}\n\n`;
	const sse =
		chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]) +
		chunk([{ index: 0, delta: { content: "Hello" }, finish_reason: null }]) +
		chunk(
			[{ index: 0, delta: {}, finish_reason: "stop" }],
			{ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
		) +
		chunk([], { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) +
		"data: [DONE]\n\n";
	return new Response(sse, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** Parses anthropic-shaped SSE blocks into {event, data} pairs. */
function parseAnthropicEvents(
	text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
	return text
		.split("\n\n")
		.map((block) => block.trim())
		.filter((block) => block.length > 0)
		.map((block) => {
			const eventLine = block
				.split("\n")
				.find((line) => line.startsWith("event: "));
			const dataLine = block
				.split("\n")
				.find((line) => line.startsWith("data: "));
			return {
				event: eventLine?.slice("event: ".length) ?? "",
				data: JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as Record<
					string,
					unknown
				>,
			};
		});
}

function usageInsert(
	runs: Array<{ sql: string; args: unknown[] }>,
): { args: unknown[] } | undefined {
	return runs.find((r) => r.sql.includes("INSERT INTO usage_logs"));
}

describe("anthropic inbound + openai-only channel: include_usage injection (AC1/AC2)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("streaming client: upstream body carries stream_options.include_usage exactly once; usage billed with prompt > 0", async () => {
		const fetchMock = vi.fn(async () => chatSseUpstream());
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel()]);
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

		// 出站体：流式 chat 体 + include_usage 恰一次注入
		const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(target).toBe("https://upstream.example/v1/chat/completions");
		const rawBody = String(init.body);
		const upstreamBody = JSON.parse(rawBody) as Record<string, unknown>;
		expect(upstreamBody.stream).toBe(true);
		expect(upstreamBody.stream_options).toEqual({ include_usage: true });
		expect((rawBody.match(/stream_options/g) ?? []).length).toBe(1);

		// 客户端拿到 anthropic SSE：message_start → text → message_delta →
		// message_stop（恰一次，锁定双 stop 不变量在集成级成立）
		const text = await res.text();
		expect(text).not.toContain("[DONE]");
		const events = parseAnthropicEvents(text);
		expect(events[0].event).toBe("message_start");
		expect(
			events.filter((e) => e.event === "message_delta"),
		).toHaveLength(1);
		expect(
			events.filter((e) => e.event === "message_stop"),
		).toHaveLength(1);
		expect(events[events.length - 1].event).toBe("message_stop");
		const messageDelta = events.find((e) => e.event === "message_delta");
		expect(messageDelta?.data.usage).toEqual({
			output_tokens: 3,
			input_tokens: 5,
		});

		// AC2 seam: parseUsageFromSse over the client anthropic stream
		const { usage } = await parseUsageFromSse(
			new Response(text, {
				headers: { "content-type": "text/event-stream" },
			}),
		);
		expect(usage).toEqual({
			totalTokens: 8,
			promptTokens: 5,
			completionTokens: 3,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
		expect(usage?.promptTokens).toBeGreaterThan(0);

		// 落库 usage 三值齐全：total 8 / prompt 5 / completion 3
		await mockCtx.awaitTasks();
		const insert = usageInsert(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(8);
		expect(insert?.args[6]).toBe(5);
		expect(insert?.args[7]).toBe(3);
	});

	it("non-stream client: outbound body keeps existing bytes (no stream_options, no stream flag)", async () => {
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
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const { env, runs } = makeEnv([makeChannel()]);
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
					messages: [{ role: "user", content: "hi" }],
				}),
			},
			env,
			mockCtx.ctx,
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 字节零变化红线：非流式出站体不含 stream_options，也不强制流式
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const rawBody = String(init.body);
		const upstreamBody = JSON.parse(rawBody) as Record<string, unknown>;
		expect("stream_options" in upstreamBody).toBe(false);
		expect(upstreamBody.stream).toBeUndefined();
		expect((rawBody.match(/stream_options/g) ?? []).length).toBe(0);

		// 客户端拿到标准非流 Message JSON，usage 正常折算
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.type).toBe("message");
		expect(body.usage).toEqual({ input_tokens: 5, output_tokens: 3 });

		// 非流式路径的落库不受注入改动影响（三值齐全）
		await mockCtx.awaitTasks();
		const insert = usageInsert(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[5]).toBe(8);
		expect(insert?.args[6]).toBe(5);
		expect(insert?.args[7]).toBe(3);
	});
});
