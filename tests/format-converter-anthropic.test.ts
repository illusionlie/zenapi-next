import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	anthropicToOpenaiResponse,
	createAnthropicToOpenaiStreamTransform,
	createOpenaiToAnthropicStreamTransform,
	mapFinishReason,
	mapStopReason,
	openaiToAnthropicRequest,
} from "../apps/worker/src/services/format-converter";
import { parseUsageFromSse } from "../apps/worker/src/utils/usage";

// Dropped multimodal parts and in-stream errors warn by design (D7/D8) —
// silence the noise and keep the spy available for assertions.
beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

// --- helpers ---

function anthropicSse(events: Array<{ event: string; data: unknown }>): string {
	return events
		.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
		.join("");
}

async function runStreamTransform(input: string): Promise<string> {
	const transform = createAnthropicToOpenaiStreamTransform();
	const writer = transform.writable.getWriter();
	const reader = transform.readable.getReader();
	const write = (async () => {
		await writer.write(new TextEncoder().encode(input));
		await writer.close();
	})();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		output += new TextDecoder().decode(value);
	}
	await write;
	return output;
}

type SseItem = Record<string, unknown> | "[DONE]";

function parseSseData(output: string): SseItem[] {
	return output
		.split("\n\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			expect(line.startsWith("data: ")).toBe(true);
			const payload = line.slice("data: ".length);
			return payload === "[DONE]"
				? "[DONE]"
				: (JSON.parse(payload) as Record<string, unknown>);
		});
}

function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> {
	const choices = chunk.choices as Array<Record<string, unknown>>;
	expect(choices).toHaveLength(1);
	return choices[0];
}

function finishReasonOf(out: Record<string, unknown>): unknown {
	return (out.choices as Array<Record<string, unknown>>)[0].finish_reason;
}

function messageOf(out: Record<string, unknown>): Record<string, unknown> {
	return (out.choices as Array<Record<string, unknown>>)[0]
		.message as Record<string, unknown>;
}

// --- openaiToAnthropicRequest ---

describe("openaiToAnthropicRequest", () => {
	it("passes through model / stream / sampling / stop and converts tools (regression)", () => {
		const out = openaiToAnthropicRequest({
			model: "claude-sonnet-4-5",
			stream: true,
			temperature: 0.7,
			top_p: 0.9,
			stop: ["END", "STOP"],
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{
					type: "function",
					function: { name: "f", description: "d", parameters: { type: "object" } },
				},
			],
		});
		expect(out.model).toBe("claude-sonnet-4-5");
		expect(out.stream).toBe(true);
		expect(out.temperature).toBe(0.7);
		expect(out.top_p).toBe(0.9);
		expect(out.stop_sequences).toEqual(["END", "STOP"]);
		expect(out.tools).toEqual([
			{ name: "f", description: "d", input_schema: { type: "object" } },
		]);
	});

	it("max_completion_tokens wins over max_tokens; default is 8192 (AC5)", () => {
		expect(
			openaiToAnthropicRequest({
				messages: [],
				max_completion_tokens: 200,
				max_tokens: 100,
			}).max_tokens,
		).toBe(200);
		expect(
			openaiToAnthropicRequest({ messages: [], max_tokens: 100 }).max_tokens,
		).toBe(100);
		expect(openaiToAnthropicRequest({ messages: [] }).max_tokens).toBe(8192);
	});

	it("maps every reasoning_effort level onto budget_tokens per the ratio table (AC1)", () => {
		const cases: Array<[string, number]> = [
			["minimal", 1024],
			["low", 1638],
			["medium", 4096],
			["high", 6553],
			["xhigh", 7782],
			["max", 7782],
		];
		for (const [effort, expected] of cases) {
			const out = openaiToAnthropicRequest({
				messages: [],
				reasoning_effort: effort,
				max_tokens: 8192,
			});
			expect(out.thinking).toEqual({ type: "enabled", budget_tokens: expected });
			const budget = (out.thinking as Record<string, unknown>)
				.budget_tokens as number;
			expect(budget).toBeGreaterThanOrEqual(1024);
			expect(budget).toBeLessThan(8192);
		}
	});

	it("effort 'none', unknown strings and absent effort send no thinking field (AC1)", () => {
		expect(
			openaiToAnthropicRequest({ messages: [], reasoning_effort: "none" })
				.thinking,
		).toBeUndefined();
		expect(
			openaiToAnthropicRequest({ messages: [], reasoning_effort: "turbo" })
				.thinking,
		).toBeUndefined();
		expect(
			openaiToAnthropicRequest({ messages: [] }).thinking,
		).toBeUndefined();
	});

	it("maps reasoning.effort object form; direct reasoning_effort wins", () => {
		expect(
			openaiToAnthropicRequest({
				messages: [],
				reasoning: { effort: "medium" },
				max_tokens: 8192,
			}).thinking,
		).toEqual({ type: "enabled", budget_tokens: 4096 });
		expect(
			openaiToAnthropicRequest({
				messages: [],
				reasoning_effort: "low",
				reasoning: { effort: "high" },
				max_tokens: 8192,
			}).thinking,
		).toEqual({ type: "enabled", budget_tokens: 1638 });
	});

	it("clamps budget into [1024, max_tokens-1]; numeric effort is an explicit budget (AC1)", () => {
		// floor clamp: 1200 * 0.8 = 960 → 1024
		expect(
			openaiToAnthropicRequest({
				messages: [],
				reasoning_effort: "high",
				max_tokens: 1200,
			}).thinking,
		).toEqual({ type: "enabled", budget_tokens: 1024 });
		// upper clamp: numeric budget above max_tokens - 1
		expect(
			openaiToAnthropicRequest({
				messages: [],
				reasoning_effort: 5000,
				max_tokens: 3000,
			}).thinking,
		).toEqual({ type: "enabled", budget_tokens: 2999 });
		// numeric within range is used directly
		expect(
			openaiToAnthropicRequest({
				messages: [],
				reasoning_effort: 2000,
				max_tokens: 3000,
			}).thinking,
		).toEqual({ type: "enabled", budget_tokens: 2000 });
	});

	it("strips temperature/top_p only when thinking ends up in the request (AC2)", () => {
		const withThinking = openaiToAnthropicRequest({
			messages: [],
			reasoning_effort: "high",
			temperature: 0.5,
			top_p: 0.9,
		});
		expect(withThinking.thinking).toBeDefined();
		expect(withThinking.temperature).toBeUndefined();
		expect(withThinking.top_p).toBeUndefined();

		const withoutThinking = openaiToAnthropicRequest({
			messages: [],
			temperature: 0.5,
			top_p: 0.9,
		});
		expect(withoutThinking.thinking).toBeUndefined();
		expect(withoutThinking.temperature).toBe(0.5);
		expect(withoutThinking.top_p).toBe(0.9);
	});

	it("passes through client thinking objects and strips sampling too (AC2)", () => {
		const enabled = openaiToAnthropicRequest({
			messages: [],
			thinking: { type: "enabled", budget_tokens: 2048 },
			temperature: 0.5,
			top_p: 0.9,
		});
		expect(enabled.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
		expect(enabled.temperature).toBeUndefined();
		expect(enabled.top_p).toBeUndefined();

		expect(
			openaiToAnthropicRequest({
				messages: [],
				thinking: { type: "adaptive" },
			}).thinking,
		).toEqual({ type: "adaptive" });

		// invalid type falls back to effort mapping (none here → no thinking)
		expect(
			openaiToAnthropicRequest({
				messages: [],
				thinking: { type: "bogus" },
			}).thinking,
		).toBeUndefined();
	});

	it("tool_choice 'none' maps to {type:'none'} and keeps tools declared (AC5)", () => {
		const out = openaiToAnthropicRequest({
			messages: [],
			tool_choice: "none",
			tools: [{ type: "function", function: { name: "f" } }],
		});
		expect(out.tool_choice).toEqual({ type: "none" });
		expect(out.tools).toHaveLength(1);
	});

	it("maps tool_choice auto / required / {function} (regression)", () => {
		expect(
			openaiToAnthropicRequest({ messages: [], tool_choice: "auto" })
				.tool_choice,
		).toEqual({ type: "auto" });
		expect(
			openaiToAnthropicRequest({ messages: [], tool_choice: "required" })
				.tool_choice,
		).toEqual({ type: "any" });
		expect(
			openaiToAnthropicRequest({
				messages: [],
				tool_choice: { type: "function", function: { name: "f" } },
			}).tool_choice,
		).toEqual({ type: "tool", name: "f" });
	});

	it("joins system and developer messages into top-level system (AC5)", () => {
		const out = openaiToAnthropicRequest({
			messages: [
				{ role: "system", content: "Be terse." },
				{ role: "developer", content: "Also be safe." },
				{ role: "user", content: "hi" },
			],
		});
		expect(out.system).toBe("Be terse.\n\nAlso be safe.");
		expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	it("converts image_url parts: http URL → url source, data URL → base64 source (AC7)", () => {
		const out = openaiToAnthropicRequest({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{
							type: "image_url",
							image_url: { url: "https://example.com/cat.png", detail: "low" },
						},
						{ type: "image_url", image_url: "https://example.com/dog.png" },
						{
							type: "image_url",
							image_url: { url: "data:image/png;base64,aGVsbG8=" },
						},
					],
				},
			],
		});
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", source: { type: "url", url: "https://example.com/cat.png" } },
					{ type: "image", source: { type: "url", url: "https://example.com/dog.png" } },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
					},
				],
			},
		]);
	});

	it("drops unusable image, audio and unknown parts without failing the request (AC7/FR7)", () => {
		const out = openaiToAnthropicRequest({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "keep" },
						{ type: "text", text: 42 },
						{ type: "image_url", image_url: { url: "ftp://example.com/x.png" } },
						{ type: "image_url", image_url: { url: "data:text/html;base64,PGI+" } },
						{ type: "image_url", image_url: {} },
						{
							type: "input_audio",
							input_audio: { data: "abc", format: "wav" },
						},
						{ type: "video_url", video_url: "https://example.com/v.mp4" },
					],
				},
			],
		});
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "keep" },
					{ type: "text", text: "" },
				],
			},
		]);
	});

	it("converts PDF file parts to document blocks; non-PDF files are dropped (AC7/FR6)", () => {
		const out = openaiToAnthropicRequest({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "file",
							file: {
								file_data: "data:application/pdf;base64,JVBERi0=",
								filename: "report.pdf",
							},
						},
						{ type: "file", file: { file_data: "JVBERi0=", filename: "notes.pdf" } },
						{
							type: "file",
							file: { file_data: "data:text/plain;base64,aGk=", filename: "a.txt" },
						},
						{ type: "file", file: { file_id: "file_123" } },
					],
				},
			],
		});
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
					},
					{
						type: "document",
						source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
					},
				],
			},
		]);
	});

	it("falls back to a single empty text block when every part is dropped (AC7)", () => {
		const out = openaiToAnthropicRequest({
			messages: [
				{
					role: "user",
					content: [
						{ type: "input_audio", input_audio: { data: "x", format: "mp3" } },
					],
				},
			],
		});
		expect(out.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "" }] },
		]);
	});

	it("joins tool message content arrays from their text parts", () => {
		const out = openaiToAnthropicRequest({
			messages: [
				{ role: "user", content: "q" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "f", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "call_1",
					content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }],
				},
			],
		});
		expect(out.messages).toEqual([
			{ role: "user", content: "q" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "f", input: {} }],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "part1part2" },
				],
			},
		]);
	});

	it("merges consecutive same-role messages (regression)", () => {
		const out = openaiToAnthropicRequest({
			messages: [
				{ role: "user", content: "a" },
				{ role: "user", content: "b" },
				{ role: "assistant", content: "c" },
			],
		});
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
			},
			{ role: "assistant", content: "c" },
		]);
	});
});

// --- anthropicToOpenaiResponse ---

describe("anthropicToOpenaiResponse", () => {
	it("maps text / tool_use content and response metadata (regression)", () => {
		const out = anthropicToOpenaiResponse({
			id: "msg_1",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 3, output_tokens: 2 },
		});
		expect(out.id).toBe("chatcmpl-msg_1");
		expect(out.object).toBe("chat.completion");
		expect(out.model).toBe("claude-sonnet-4-5");
		const message = messageOf(out);
		expect(message.role).toBe("assistant");
		expect(message.content).toBe("Hello world");
		expect(message.reasoning_content).toBeUndefined();
		expect(finishReasonOf(out)).toBe("stop");
		expect(out.usage).toEqual({
			prompt_tokens: 3,
			completion_tokens: 2,
			total_tokens: 5,
		});
	});

	it("maps thinking blocks onto reasoning_content and never echoes redacted_thinking (FR2)", () => {
		const out = anthropicToOpenaiResponse({
			id: "msg_2",
			model: "claude-sonnet-4-5",
			content: [
				{ type: "thinking", thinking: "first thought", signature: "sig1" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second thought", signature: "sig2" },
				{ type: "redacted_thinking", data: "opaque" },
			],
			stop_reason: "end_turn",
		});
		const message = messageOf(out);
		expect(message.reasoning_content).toBe("first thought\n\nsecond thought");
		expect(message.content).toBe("answer");
		const serialized = JSON.stringify(out);
		expect(serialized).not.toContain("redacted_thinking");
		expect(serialized).not.toContain("opaque");
		expect(serialized).not.toContain("signature");
	});

	it("maps tool_use blocks onto tool_calls with tool_calls finish reason (regression)", () => {
		const out = anthropicToOpenaiResponse({
			id: "msg_3",
			model: "claude-sonnet-4-5",
			content: [
				{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
			],
			stop_reason: "tool_use",
		});
		const message = messageOf(out);
		expect(message.tool_calls).toEqual([
			{
				id: "toolu_1",
				type: "function",
				function: { name: "get_weather", arguments: '{"city":"Paris"}' },
			},
		]);
		expect(finishReasonOf(out)).toBe("tool_calls");
	});

	it("maps all seven stop_reason values (AC6)", () => {
		const cases: Array<[string, string]> = [
			["end_turn", "stop"],
			["stop_sequence", "stop"],
			["max_tokens", "length"],
			["tool_use", "tool_calls"],
			["refusal", "content_filter"],
			["model_context_window_exceeded", "length"],
			["pause_turn", "stop"],
		];
		for (const [stopReason, expected] of cases) {
			expect(
				finishReasonOf(
					anthropicToOpenaiResponse({
						content: [{ type: "text", text: "x" }],
						stop_reason: stopReason,
					}),
				),
			).toBe(expected);
		}
		expect(
			finishReasonOf(anthropicToOpenaiResponse({ content: [] })),
		).toBe("stop");
	});

	it("converts usage with cache semantics and reasoning tokens (AC4)", () => {
		const out = anthropicToOpenaiResponse({
			content: [{ type: "text", text: "x" }],
			usage: {
				input_tokens: 10,
				output_tokens: 7,
				cache_read_input_tokens: 30,
				cache_creation_input_tokens: 5,
				output_tokens_details: { thinking_tokens: 4 },
			},
		});
		expect(out.usage).toEqual({
			prompt_tokens: 45,
			completion_tokens: 7,
			total_tokens: 52,
			prompt_tokens_details: { cached_tokens: 30 },
			completion_tokens_details: { reasoning_tokens: 4 },
		});

		// no cache activity → no prompt_tokens_details; no thinking → no details
		const plain = anthropicToOpenaiResponse({
			content: [],
			usage: { input_tokens: 10, output_tokens: 2 },
		});
		expect(plain.usage).toEqual({
			prompt_tokens: 10,
			completion_tokens: 2,
			total_tokens: 12,
		});
	});
});

// --- createAnthropicToOpenaiStreamTransform ---

describe("createAnthropicToOpenaiStreamTransform", () => {
	it("emits a role chunk without usage, text deltas, one terminal usage chunk and exactly one [DONE] (AC3/AC4)", async () => {
		const input = anthropicSse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: {
						id: "msg_1",
						model: "claude-sonnet-4-5",
						usage: {
							input_tokens: 8,
							cache_read_input_tokens: 2,
							cache_creation_input_tokens: 1,
							output_tokens: 1,
						},
					},
				},
			},
			{ event: "ping", data: { type: "ping" } },
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hel" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "lo" },
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 0 },
			},
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 5 },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const output = await runStreamTransform(input);
		const chunks = parseSseData(output);
		expect(chunks.filter((c) => c === "[DONE]")).toHaveLength(1);

		const first = chunks[0] as Record<string, unknown>;
		expect(firstChoice(first).delta).toEqual({ role: "assistant", content: "" });
		expect("usage" in first).toBe(false);
		expect(first.model).toBe("claude-sonnet-4-5");

		// [role, text, text, terminal, [DONE]]
		expect(chunks).toHaveLength(5);
		const terminal = chunks[3] as Record<string, unknown>;
		expect(chunks[4]).toBe("[DONE]");
		expect(firstChoice(terminal).delta).toEqual({});
		expect(firstChoice(terminal).finish_reason).toBe("stop");
		expect(terminal.usage).toEqual({
			prompt_tokens: 11,
			completion_tokens: 5,
			total_tokens: 16,
			prompt_tokens_details: { cached_tokens: 2 },
		});

		// billing integration: parseUsageFromSse must see the merged terminal usage
		const parsed = await parseUsageFromSse(new Response(output));
		expect(parsed.usage).toEqual({
			totalTokens: 16,
			promptTokens: 11,
			completionTokens: 5,
			cachedInputTokens: 2,
			cacheCreationTokens: null,
		});
		expect(parsed.usage?.promptTokens).toBeGreaterThan(0);
	});

	it("streams thinking_delta as reasoning_content; signature/citations produce nothing (AC3/FR2)", async () => {
		const input = anthropicSse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "msg_2", model: "m", usage: { input_tokens: 5 } },
				},
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "thought " },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "one" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "signature_delta", signature: "sig" },
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 0 },
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 1,
					content_block: { type: "text", text: "" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 1,
					delta: { type: "text_delta", text: "ans" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 1,
					delta: {
						type: "citations_delta",
						citation: { type: "web_search_result_location", cited_text: "x" },
					},
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 1 },
			},
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const chunks = parseSseData(await runStreamTransform(input));
		// [role, thinking, thinking, text, terminal, [DONE]]
		expect(chunks).toHaveLength(6);
		expect(firstChoice(chunks[1] as Record<string, unknown>).delta).toEqual({
			reasoning_content: "thought ",
		});
		expect(firstChoice(chunks[2] as Record<string, unknown>).delta).toEqual({
			reasoning_content: "one",
		});
		expect(firstChoice(chunks[3] as Record<string, unknown>).delta).toEqual({
			content: "ans",
		});
		const terminal = chunks[4] as Record<string, unknown>;
		expect(terminal.usage).toEqual({
			prompt_tokens: 5,
			completion_tokens: 3,
			total_tokens: 8,
			completion_tokens_details: { reasoning_tokens: 2 },
		});
	});

	it("emits a single terminal chunk on in-stream error and suppresses dangling output (AC8)", async () => {
		const input = anthropicSse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "msg_3", model: "m", usage: { input_tokens: 4 } },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "par" },
				},
			},
			{
				event: "error",
				data: {
					type: "error",
					error: { type: "overloaded_error", message: "Overloaded" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "late" },
				},
			},
			{
				event: "error",
				data: { type: "error", error: { type: "api_error", message: "again" } },
			},
		]);
		const chunks = parseSseData(await runStreamTransform(input));
		// [role, text, terminal] — no late delta, no second terminal, no [DONE]
		expect(chunks).toHaveLength(3);
		const terminal = chunks[2] as Record<string, unknown>;
		expect(firstChoice(terminal).finish_reason).toBe("stop");
		expect(firstChoice(terminal).delta).toEqual({});
		expect(terminal.usage).toBeUndefined();
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] upstream stream error",
			{ error_type: "overloaded_error", error_message: "Overloaded" },
		);
	});

	it("maps tool_use blocks and input_json_delta onto indexed tool_calls (regression)", async () => {
		const input = anthropicSse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "msg_4", model: "m", usage: { input_tokens: 6 } },
				},
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 0,
					content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"city"' },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: ':"Paris"}' },
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 0 },
			},
			{
				event: "content_block_start",
				data: {
					type: "content_block_start",
					index: 1,
					content_block: { type: "tool_use", id: "toolu_2", name: "f2" },
				},
			},
			{
				event: "content_block_delta",
				data: {
					type: "content_block_delta",
					index: 1,
					delta: { type: "input_json_delta", partial_json: "{}" },
				},
			},
			{
				event: "content_block_stop",
				data: { type: "content_block_stop", index: 1 },
			},
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: { output_tokens: 9 },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const chunks = parseSseData(await runStreamTransform(input));
		// [role, tool1 start, arg, arg, tool2 start, arg, terminal, [DONE]]
		expect(chunks).toHaveLength(8);
		expect(firstChoice(chunks[1] as Record<string, unknown>).delta).toEqual({
			tool_calls: [
				{
					index: 0,
					id: "toolu_1",
					type: "function",
					function: { name: "get_weather", arguments: "" },
				},
			],
		});
		expect(firstChoice(chunks[2] as Record<string, unknown>).delta).toEqual({
			tool_calls: [{ index: 0, function: { arguments: '{"city"' } }],
		});
		expect(firstChoice(chunks[4] as Record<string, unknown>).delta).toEqual({
			tool_calls: [
				{
					index: 1,
					id: "toolu_2",
					type: "function",
					function: { name: "f2", arguments: "" },
				},
			],
		});
		expect(firstChoice(chunks[5] as Record<string, unknown>).delta).toEqual({
			tool_calls: [{ index: 1, function: { arguments: "{}" } }],
		});
		const terminal = chunks[6] as Record<string, unknown>;
		expect(firstChoice(terminal).finish_reason).toBe("tool_calls");
		expect(chunks[7]).toBe("[DONE]");
	});

	it("maps message_delta stop_reason max_tokens onto length and swallows pings (AC6)", async () => {
		const input = anthropicSse([
			{
				event: "message_start",
				data: {
					type: "message_start",
					message: { id: "msg_5", model: "m", usage: { input_tokens: 2 } },
				},
			},
			{ event: "ping", data: { type: "ping" } },
			{
				event: "message_delta",
				data: {
					type: "message_delta",
					delta: { stop_reason: "max_tokens" },
					usage: { output_tokens: 8 },
				},
			},
			{ event: "message_stop", data: { type: "message_stop" } },
		]);
		const chunks = parseSseData(await runStreamTransform(input));
		expect(chunks).toHaveLength(3);
		expect(firstChoice(chunks[1] as Record<string, unknown>).finish_reason).toBe(
			"length",
		);
	});
});

// --- createOpenaiToAnthropicStreamTransform（anthropic 入站 + openai 目标方向）---

/** OpenAI chat SSE chunk data line（含可选 usage / finish_reason 覆盖）。 */
function chatChunkLine(
	delta: Record<string, unknown>,
	options: { finishReason?: string | null; usage?: Record<string, unknown> } = {},
): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1730000000,
		model: "test-model",
		choices: [
			{ index: 0, delta, finish_reason: options.finishReason ?? null },
		],
		...(options.usage !== undefined ? { usage: options.usage } : {}),
	})}\n\n`;
}

async function runOpenaiToAnthropicStream(input: string): Promise<string> {
	const transform = createOpenaiToAnthropicStreamTransform("test-model");
	const writer = transform.writable.getWriter();
	const reader = transform.readable.getReader();
	const write = (async () => {
		await writer.write(new TextEncoder().encode(input));
		await writer.close();
	})();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		output += new TextDecoder().decode(value);
	}
	await write;
	return output;
}

type AnthropicEvent = { event: string; data: Record<string, unknown> };

/** 解析转换器产出的 anthropic SSE（event: X + data: {...} 双行块）。 */
function parseAnthropicEvents(output: string): AnthropicEvent[] {
	return output
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

function countStops(events: AnthropicEvent[]): number {
	return events.filter((e) => e.event === "message_stop").length;
}

describe("createOpenaiToAnthropicStreamTransform message_stop 恰一不变量（AC3）", () => {
	it("[DONE] 正常收尾：message_stop 恰一次（flush 不补发），usage 尾经 message_delta 存活", async () => {
		const input = [
			chatChunkLine({ role: "assistant", content: "" }),
			chatChunkLine({ content: "Hello" }),
			chatChunkLine(
				{},
				{
					finishReason: "stop",
					usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
				},
			),
			"data: [DONE]\n\n",
		].join("");
		const output = await runOpenaiToAnthropicStream(input);
		const events = parseAnthropicEvents(output);
		expect(countStops(events)).toBe(1);
		expect(events[events.length - 1].event).toBe("message_stop");

		// message_start → text 块（空 role chunk 的 "" 与 "Hello" 各一个 delta）
		// → message_delta → message_stop
		expect(events[0].event).toBe("message_start");
		const textDeltas = events.filter((e) => e.event === "content_block_delta");
		expect(textDeltas).toHaveLength(2);
		expect(textDeltas[1].data.delta).toEqual({
			type: "text_delta",
			text: "Hello",
		});
		const messageDelta = events.find((e) => e.event === "message_delta");
		expect(messageDelta?.data.delta).toEqual({ stop_reason: "end_turn" });
		// 终止 chunk 携带 prompt 时转发 input_tokens（spec §3.7 方向 B seam）
		expect(messageDelta?.data.usage).toEqual({
			output_tokens: 3,
			input_tokens: 5,
		});

		// parseUsageFromSse 联动：raw 合并恢复 prompt（message_start 基线 0
		// 被非 null 覆盖），三值齐全
		const parsed = await parseUsageFromSse(new Response(output));
		expect(parsed.usage).toEqual({
			totalTokens: 8,
			promptTokens: 5,
			completionTokens: 3,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
		expect(parsed.usage?.promptTokens).toBeGreaterThan(0);
	});

	it("截断流（无 [DONE]）：flush 兜底发出恰一次 message_stop", async () => {
		const input = [
			chatChunkLine({ role: "assistant", content: "" }),
			chatChunkLine(
				{},
				{ finishReason: "stop", usage: { prompt_tokens: 4, completion_tokens: 2 } },
			),
		].join("");
		const output = await runOpenaiToAnthropicStream(input);
		const events = parseAnthropicEvents(output);
		expect(countStops(events)).toBe(1);
		expect(events[events.length - 1].event).toBe("message_stop");
		expect(events.filter((e) => e.event === "message_delta")).toHaveLength(1);
	});

	it("流内 error 载荷：恰一次 message_stop（error chunk 触发 message_start，无 message_delta）", async () => {
		const input = [
			`data: ${JSON.stringify({
				error: { message: "boom", type: "server_error" },
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("");
		const output = await runOpenaiToAnthropicStream(input);
		const events = parseAnthropicEvents(output);
		expect(events[0].event).toBe("message_start");
		expect(events.filter((e) => e.event === "message_delta")).toHaveLength(0);
		expect(countStops(events)).toBe(1);
		expect(events[events.length - 1].event).toBe("message_stop");
	});

	it("空流（只有 [DONE]）：零 message_stop、零 message_start（孤儿 stop 消除）", async () => {
		const output = await runOpenaiToAnthropicStream("data: [DONE]\n\n");
		expect(output).toBe("");
		expect(parseAnthropicEvents(output)).toHaveLength(0);
	});
});

// --- shared stop reason mappings (AC9) ---

describe("mapStopReason / mapFinishReason (shared, reverse direction lock)", () => {
	it("maps the full anthropic stop_reason enum with stop defaults", () => {
		expect(mapStopReason("end_turn")).toBe("stop");
		expect(mapStopReason("stop_sequence")).toBe("stop");
		expect(mapStopReason("max_tokens")).toBe("length");
		expect(mapStopReason("tool_use")).toBe("tool_calls");
		expect(mapStopReason("refusal")).toBe("content_filter");
		expect(mapStopReason("model_context_window_exceeded")).toBe("length");
		expect(mapStopReason("pause_turn")).toBe("stop");
		expect(mapStopReason(null)).toBe("stop");
		expect(mapStopReason(undefined)).toBe("stop");
		expect(mapStopReason("something_new")).toBe("stop");
	});

	it("maps finish reasons including content_filter → refusal", () => {
		expect(mapFinishReason("stop")).toBe("end_turn");
		expect(mapFinishReason("length")).toBe("max_tokens");
		expect(mapFinishReason("tool_calls")).toBe("tool_use");
		expect(mapFinishReason("content_filter")).toBe("refusal");
		expect(mapFinishReason("function_call")).toBe("end_turn");
		expect(mapFinishReason(null)).toBe("end_turn");
	});
});
