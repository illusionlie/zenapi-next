import { describe, expect, it } from "vitest";
import {
	normalizeUsage,
	parseUsageFromJson,
	parseUsageFromSse,
} from "../apps/worker/src/utils/usage";

describe("parseUsageFromJson - Responses API response.usage", () => {
	it("parses usage from a response.completed SSE event payload", () => {
		const event = {
			type: "response.completed",
			response: {
				id: "resp_123",
				usage: {
					input_tokens: 12,
					output_tokens: 34,
					total_tokens: 46,
				},
			},
		};
		expect(parseUsageFromJson(event)).toEqual({
			totalTokens: 46,
			promptTokens: 12,
			completionTokens: 34,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});

	it("computes totalTokens when response.usage only has input/output tokens", () => {
		const event = {
			type: "response.completed",
			response: {
				usage: {
					input_tokens: 7,
					output_tokens: 3,
				},
			},
		};
		expect(parseUsageFromJson(event)).toEqual({
			totalTokens: 10,
			promptTokens: 7,
			completionTokens: 3,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});

	it("returns null when response exists but carries no usage", () => {
		const event = {
			type: "response.created",
			response: {
				id: "resp_123",
			},
		};
		expect(parseUsageFromJson(event)).toBeNull();
	});

	it("still parses top-level usage (non-stream regression)", () => {
		const payload = {
			id: "chatcmpl_1",
			choices: [],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 2,
				total_tokens: 7,
			},
		};
		expect(parseUsageFromJson(payload)).toEqual({
			totalTokens: 7,
			promptTokens: 5,
			completionTokens: 2,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});

	it("still parses usage nested under data (regression)", () => {
		const payload = {
			data: {
				usage: {
					prompt_tokens: 8,
					completion_tokens: 4,
					total_tokens: 12,
				},
			},
		};
		expect(parseUsageFromJson(payload)).toEqual({
			totalTokens: 12,
			promptTokens: 8,
			completionTokens: 4,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});

	it("prefers top-level usage over response.usage", () => {
		const payload = {
			usage: {
				prompt_tokens: 1,
				completion_tokens: 1,
				total_tokens: 2,
			},
			response: {
				usage: {
					input_tokens: 100,
					output_tokens: 100,
					total_tokens: 200,
				},
			},
		};
		expect(parseUsageFromJson(payload)).toEqual({
			totalTokens: 2,
			promptTokens: 1,
			completionTokens: 1,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});
});

describe("normalizeUsage - Responses token naming", () => {
	it("maps input_tokens/output_tokens onto prompt/completion tokens", () => {
		expect(
			normalizeUsage({
				input_tokens: 11,
				output_tokens: 22,
				total_tokens: 33,
			}),
		).toEqual({
			totalTokens: 33,
			promptTokens: 11,
			completionTokens: 22,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});
});

describe("parseUsageFromSse - Responses stream", () => {
	it("extracts usage from a response.completed event in the SSE stream", async () => {
		const body = [
			'data: {"type":"response.created","response":{}}',
			"",
			'data: {"type":"response.output_text.delta","delta":"Hi"}',
			"",
			'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}',
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
			promptTokens: 7,
			completionTokens: 3,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});

	it("still extracts usage from chat completion SSE chunks (regression)", async () => {
		const body = [
			'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}',
			"",
			'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}',
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
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});
});
