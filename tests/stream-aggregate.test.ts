import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	aggregateUpstreamStream,
	protocolForTargetFormat,
} from "../apps/worker/src/services/stream-aggregate";

/**
 * 上游 SSE 聚合器矩阵（design D6，AC7）：三协议聚合 + 畸形事件 fail-open +
 * 截断流降级 + 入口 fail-open（非 SSE 响应原样返回）。
 * usage 红线：anthropic message_delta.usage 是累计值直取（不二次累加），
 * chat 取最后一个携带 usage 的 chunk（include_usage 尾 chunk）。
 */

// —— helpers（对齐既有 format-converter 测试的 sse/parseSseData 样板） ——

function sseResponse(payloads: string[], contentType = "text/event-stream"): Response {
	const body = payloads.map((p) => `data: ${p}\n\n`).join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": contentType },
	});
}

function chatChunk(
	delta: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		id: "chatcmpl-abc",
		object: "chat.completion.chunk",
		created: 1700000000,
		model: "gpt-4o",
		choices: [{ index: 0, delta, finish_reason: null }],
		...overrides,
	});
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("protocolForTargetFormat", () => {
	it("maps target formats onto aggregate protocols (custom unreachable → chat fallback)", () => {
		expect(protocolForTargetFormat("openai")).toBe("chat");
		expect(protocolForTargetFormat("anthropic")).toBe("anthropic");
		expect(protocolForTargetFormat("responses")).toBe("responses");
		expect(protocolForTargetFormat("custom")).toBe("chat");
	});
});

describe("entry fail-open", () => {
	it("returns a non-SSE response object unchanged", async () => {
		const response = new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
		const out = await aggregateUpstreamStream("chat", response);
		expect(out).toBe(response);
	});

	it("returns a non-ok response unchanged (error paths bypass aggregation)", async () => {
		const response = new Response("boom", {
			status: 502,
			headers: { "content-type": "text/event-stream" },
		});
		const out = await aggregateUpstreamStream("chat", response);
		expect(out).toBe(response);
		expect(out.status).toBe(502);
	});

	it("returns a null-body response unchanged", async () => {
		const response = new Response(null, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const out = await aggregateUpstreamStream("chat", response);
		expect(out).toBe(response);
	});
});

describe("chat protocol aggregation", () => {
	it("concatenates content, merges indexed tool_calls with split arguments, adopts final finish_reason + usage", async () => {
		const response = sseResponse([
			chatChunk({ role: "assistant", content: "Hel" }),
			chatChunk({ reasoning_content: "thinking " }),
			chatChunk({ content: "lo", reasoning_content: "hard" }),
			chatChunk({
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "get_weather", arguments: '{"city":' },
					},
				],
			}),
			chatChunk({
				tool_calls: [
					{ index: 0, function: { arguments: '"Paris"}' } },
					{
						index: 1,
						id: "call_2",
						type: "function",
						function: { name: "get_time", arguments: '{"tz"' },
					},
				],
			}),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
			chatChunk({}, {
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}),
			"[DONE]",
		]);

		const out = await aggregateUpstreamStream("chat", response);
		expect(out.headers.get("content-type")).toBe("application/json");
		const body = (await out.json()) as Record<string, unknown>;
		expect(body.object).toBe("chat.completion");
		expect(body.id).toBe("chatcmpl-abc");
		expect(body.model).toBe("gpt-4o");
		expect(body.created).toBe(1700000000);
		expect(body.usage).toEqual({
			prompt_tokens: 5,
			completion_tokens: 2,
			total_tokens: 7,
		});

		const choices = body.choices as Array<Record<string, unknown>>;
		expect(choices).toHaveLength(1);
		expect(choices[0].finish_reason).toBe("tool_calls");
		const message = choices[0].message as Record<string, unknown>;
		expect(message.role).toBe("assistant");
		expect(message.content).toBe("Hello");
		expect(message.reasoning_content).toBe("thinking hard");
		expect(message.tool_calls).toEqual([
			{
				id: "call_1",
				type: "function",
				function: { name: "get_weather", arguments: '{"city":"Paris"}' },
			},
			{
				id: "call_2",
				type: "function",
				function: { name: "get_time", arguments: '{"tz"' },
			},
		]);
	});

	it("consumes [DONE] exactly once — payloads after it never reach the product", async () => {
		const response = sseResponse([
			chatChunk({ role: "assistant", content: "Hi" }),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			"[DONE]",
			chatChunk({ content: "AFTER-DONE-LEAK" }),
		]);
		const body = (await (
			await aggregateUpstreamStream("chat", response)
		).json()) as Record<string, unknown>;
		const message = (body.choices as Array<Record<string, unknown>>)[0]
			.message as Record<string, unknown>;
		expect(message.content).toBe("Hi");
	});

	it("missing finish_reason → defaults to stop with a warn (truncated stream degrades)", async () => {
		const response = sseResponse([
			chatChunk({ role: "assistant", content: "partial" }),
		]);
		const body = (await (
			await aggregateUpstreamStream("chat", response)
		).json()) as Record<string, unknown>;
		const choices = body.choices as Array<Record<string, unknown>>;
		expect(choices[0].finish_reason).toBe("stop");
		expect((choices[0].message as Record<string, unknown>).content).toBe(
			"partial",
		);
		expect(console.warn).toHaveBeenCalledWith(
			"[stream-aggregate]",
			expect.stringContaining("finish_reason"),
		);
		expect(console.warn).toHaveBeenCalledWith(
			"[stream-aggregate]",
			expect.stringContaining("[DONE]"),
		);
	});

	it("malformed data lines are skipped with a warn, never destroying the product", async () => {
		const response = sseResponse([
			"not-json-at-all",
			chatChunk({ role: "assistant", content: "ok" }),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			"[DONE]",
		]);
		const body = (await (
			await aggregateUpstreamStream("chat", response)
		).json()) as Record<string, unknown>;
		const message = (body.choices as Array<Record<string, unknown>>)[0]
			.message as Record<string, unknown>;
		expect(message.content).toBe("ok");
		expect(console.warn).toHaveBeenCalledWith(
			"[stream-aggregate]",
			expect.stringContaining("non-JSON"),
		);
	});

	it("pure tool-call responses omit the content key; missing usage omits the usage key", async () => {
		const response = sseResponse([
			chatChunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "bash", arguments: "{}" },
					},
				],
			}),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
			"[DONE]",
		]);
		const body = (await (
			await aggregateUpstreamStream("chat", response)
		).json()) as Record<string, unknown>;
		const message = (body.choices as Array<Record<string, unknown>>)[0]
			.message as Record<string, unknown>;
		expect(message.content).toBeUndefined();
		expect(message.tool_calls).toHaveLength(1);
		expect(body.usage).toBeUndefined();
	});
});

describe("anthropic protocol aggregation", () => {
	const MESSAGE_START = JSON.stringify({
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-4-5",
			usage: { input_tokens: 10, output_tokens: 1 },
		},
	});

	it("reassembles text/thinking blocks and tool_use via input_json_delta with content_block_stop parse", async () => {
		const response = sseResponse([
			MESSAGE_START,
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } }),
			JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ok" } }),
			JSON.stringify({ type: "content_block_stop", index: 0 }),
			JSON.stringify({
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			}),
			JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } }),
			JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "World" } }),
			JSON.stringify({ type: "content_block_stop", index: 1 }),
			JSON.stringify({
				type: "content_block_start",
				index: 2,
				content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} },
			}),
			JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":"ls' } }),
			JSON.stringify({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' -la"}' } }),
			JSON.stringify({ type: "content_block_stop", index: 2 }),
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { input_tokens: 10, output_tokens: 25 },
			}),
			JSON.stringify({ type: "message_stop" }),
		]);

		const body = (await (
			await aggregateUpstreamStream("anthropic", response)
		).json()) as Record<string, unknown>;
		expect(body.type).toBe("message");
		expect(body.id).toBe("msg_1");
		expect(body.model).toBe("claude-4-5");
		expect(body.role).toBe("assistant");
		expect(body.stop_reason).toBe("tool_use");

		const content = body.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(3);
		expect(content[0]).toEqual({ type: "thinking", thinking: "hmm ok" });
		expect(content[1]).toEqual({ type: "text", text: "Hello World" });
		expect(content[2]).toEqual({
			type: "tool_use",
			id: "toolu_1",
			name: "bash",
			input: { command: "ls -la" },
		});
		// partial_json 是流式合并过程物，不进产物
		expect(content[2].partial_json).toBeUndefined();
	});

	it("message_delta usage is the cumulative value adopted verbatim — no double-add over the message_start baseline", async () => {
		const response = sseResponse([
			MESSAGE_START,
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
			JSON.stringify({ type: "content_block_stop", index: 0 }),
			// 累计口径：output_tokens=7 是全流总量，不是增量
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 10, output_tokens: 7 },
			}),
			JSON.stringify({ type: "message_stop" }),
		]);
		const body = (await (
			await aggregateUpstreamStream("anthropic", response)
		).json()) as Record<string, unknown>;
		// 直取不叠加：output_tokens === 7（错误实现会给出 1+7=8）
		expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 7 });
		expect(body.stop_reason).toBe("end_turn");
	});

	it("message_stop terminates; truncated streams still emit the partial aggregate with a warn", async () => {
		const response = sseResponse([
			MESSAGE_START,
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut" } }),
			// 无 content_block_stop / message_delta / message_stop —— 干净 EOF 截断
		]);
		const body = (await (
			await aggregateUpstreamStream("anthropic", response)
		).json()) as Record<string, unknown>;
		expect((body.content as Array<Record<string, unknown>>)[0].text).toBe(
			"cut",
		);
		expect(console.warn).toHaveBeenCalledWith(
			"[stream-aggregate]",
			expect.stringContaining("message_stop"),
		);
	});

	it("unknown events and malformed lines are skipped with a warn (fail-open)", async () => {
		const response = sseResponse([
			"{broken json",
			JSON.stringify({ type: "ping" }),
			JSON.stringify({ type: "future_event_9000", data: 1 }),
			MESSAGE_START,
			JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
			JSON.stringify({ type: "content_block_stop", index: 0 }),
			JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
			}),
			JSON.stringify({ type: "message_stop" }),
			// [DONE] 不是 anthropic 标记，作为外来噪音静默跳过
			"[DONE]",
		]);
		const body = (await (
			await aggregateUpstreamStream("anthropic", response)
		).json()) as Record<string, unknown>;
		expect((body.content as Array<Record<string, unknown>>)[0].text).toBe(
			"ok",
		);
		expect(console.warn).toHaveBeenCalledWith(
			"[stream-aggregate]",
			expect.stringContaining("future_event_9000"),
		);
	});
});

describe("responses protocol aggregation", () => {
	it("adopts the response.completed response object verbatim", async () => {
		const completedResponse = {
			id: "resp_1",
			object: "response",
			model: "gpt-4o",
			status: "completed",
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Hi!" }],
				},
			],
			usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
		};
		const response = sseResponse([
			JSON.stringify({ type: "response.created", response: { id: "resp_1" } }),
			JSON.stringify({ type: "response.output_text.delta", delta: "Hi" }),
			JSON.stringify({
				type: "response.completed",
				response: completedResponse,
			}),
		]);
		const body = (await (
			await aggregateUpstreamStream("responses", response)
		).json()) as Record<string, unknown>;
		// 终事件携带完整 response，直取即产物（research §8）
		expect(body).toEqual(completedResponse);
	});

	it("falls back to the response.failed response object when completed never arrives", async () => {
		const failedResponse = {
			id: "resp_2",
			status: "failed",
			error: { code: "server_error", message: "boom" },
		};
		const response = sseResponse([
			JSON.stringify({ type: "response.created", response: { id: "resp_2" } }),
			JSON.stringify({ type: "response.failed", response: failedResponse }),
		]);
		const body = (await (
			await aggregateUpstreamStream("responses", response)
		).json()) as Record<string, unknown>;
		expect(body).toEqual(failedResponse);
	});

	it("neither completed nor failed → synthesized error object with a warn", async () => {
		const response = sseResponse([
			JSON.stringify({ type: "response.created", response: { id: "resp_3" } }),
			JSON.stringify({ type: "response.output_text.delta", delta: "partial" }),
		]);
		const body = (await (
			await aggregateUpstreamStream("responses", response)
		).json()) as Record<string, unknown>;
		expect(body.error).toMatchObject({ type: "upstream_error" });
		expect(console.warn).toHaveBeenCalledWith(
			"[stream-aggregate]",
			expect.stringContaining("response.completed"),
		);
	});
});
