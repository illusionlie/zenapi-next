import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createOpenaiToResponsesStreamTransform,
	createResponsesToChatStreamTransform,
	openaiToResponsesRequest,
	openaiToResponsesResponse,
	responsesToChatResponse,
	responsesToOpenaiRequest,
} from "../apps/worker/src/services/format-converter";
import { parseUsageFromSse } from "../apps/worker/src/utils/usage";

// Dropped input items / parts and in-stream errors warn by design (fail-open,
// spec §3.4/§3.5) — silence the noise and keep the spy available.
beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

// --- helpers ---

function sse(events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function chatChunk(
	delta: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "chatcmpl-abc",
		object: "chat.completion.chunk",
		created: 1700000000,
		model: "gpt-4o",
		choices: [{ index: 0, delta, finish_reason: null }],
		...overrides,
	};
}

function chatSse(
	chunks: Array<Record<string, unknown>>,
	done = true,
): string {
	const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
	return done ? `${body}data: [DONE]\n\n` : body;
}

async function runStreamTransform(
	input: string,
	transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<string> {
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

function eventTypes(events: SseItem[]): unknown[] {
	return events.map((event) =>
		typeof event === "string" ? event : event.type,
	);
}

// --- responsesToOpenaiRequest ---

describe("responsesToOpenaiRequest", () => {
	it("maps instructions onto a leading system message and string input onto a single user message", () => {
		const out = responsesToOpenaiRequest({
			model: "gpt-4o",
			instructions: "Be terse.",
			input: "Hi",
		});
		expect(out.model).toBe("gpt-4o");
		expect(out.messages).toEqual([
			{ role: "system", content: "Be terse." },
			{ role: "user", content: "Hi" },
		]);
	});

	it("maps message items: text parts → text, input_image (http + data URL) → image_url, unknown parts dropped with warn", () => {
		const out = responsesToOpenaiRequest({
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "What is this?" },
						{ type: "input_image", image_url: "https://example.com/cat.png" },
						{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
						{ type: "input_file", file_id: "f_1" },
					],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "A cat." }],
				},
			],
		});
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "What is this?" },
					{ type: "image_url", image_url: { url: "https://example.com/cat.png" } },
					{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
				],
			},
			{ role: "assistant", content: "A cat." },
		]);
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] dropped unsupported message content part",
			{ partType: "input_file" },
		);
	});

	it("maps function_call onto assistant tool_calls and function_call_output onto tool messages", () => {
		const out = responsesToOpenaiRequest({
			input: [
				{ type: "message", role: "user", content: "Weather in Paris?" },
				{
					type: "function_call",
					call_id: "call_1",
					name: "get_weather",
					arguments: '{"city":"Paris"}',
				},
				{ type: "function_call_output", call_id: "call_1", output: "Sunny 20C" },
				{ type: "function_call_output", call_id: "call_2", output: { result: 42 } },
			],
		});
		expect(out.messages).toEqual([
			{ role: "user", content: "Weather in Paris?" },
			{
				role: "assistant",
				content: "",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "get_weather", arguments: '{"city":"Paris"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "Sunny 20C" },
			{ role: "tool", tool_call_id: "call_2", content: '{"result":42}' },
		]);
	});

	it("merges adjacent assistant items (text + parallel function_calls) and keeps tool messages unmerged", () => {
		const out = responsesToOpenaiRequest({
			input: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Checking." }],
				},
				{ type: "function_call", call_id: "call_1", name: "a", arguments: "{}" },
				{ type: "function_call", call_id: "call_2", name: "b", arguments: "{}" },
				{ type: "function_call_output", call_id: "call_1", output: "1" },
				{ type: "function_call_output", call_id: "call_2", output: "2" },
			],
		});
		expect(out.messages).toEqual([
			{
				role: "assistant",
				content: "Checking.",
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
					{ id: "call_2", type: "function", function: { name: "b", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "1" },
			{ role: "tool", tool_call_id: "call_2", content: "2" },
		]);
	});

	it("drops unknown input items with warn and hoists system/developer messages next to instructions", () => {
		const out = responsesToOpenaiRequest({
			instructions: "Sys.",
			input: [
				{ type: "reasoning", id: "rs_1", summary: [] },
				{ type: "local_shell_call", id: "ls_1", action: {} },
				{ type: "message", role: "developer", content: "Dev note." },
				{ type: "message", role: "user", content: "Hi" },
			],
		});
		expect(out.messages).toEqual([
			{ role: "system", content: "Sys.\n\nDev note." },
			{ role: "user", content: "Hi" },
		]);
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] dropped unsupported input item",
			{ itemType: "reasoning" },
		);
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] dropped unsupported input item",
			{ itemType: "local_shell_call" },
		);
	});

	it("flattens function tools and drops other tool types with warn", () => {
		const out = responsesToOpenaiRequest({
			input: [],
			tools: [
				{
					type: "function",
					name: "f",
					description: "d",
					parameters: { type: "object" },
				},
				{ type: "web_search" },
			],
		});
		expect(out.tools).toEqual([
			{
				type: "function",
				function: { name: "f", description: "d", parameters: { type: "object" } },
			},
		]);
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] dropped unsupported tool",
			{ toolType: "web_search" },
		);
	});

	it("passes string tool_choice through, nests object tool_choice, drops others with warn", () => {
		expect(
			responsesToOpenaiRequest({ input: [], tool_choice: "auto" }).tool_choice,
		).toBe("auto");
		expect(
			responsesToOpenaiRequest({ input: [], tool_choice: "none" }).tool_choice,
		).toBe("none");
		expect(
			responsesToOpenaiRequest({ input: [], tool_choice: "required" })
				.tool_choice,
		).toBe("required");
		expect(
			responsesToOpenaiRequest({
				input: [],
				tool_choice: { type: "function", name: "f" },
			}).tool_choice,
		).toEqual({ type: "function", function: { name: "f" } });
		expect(
			responsesToOpenaiRequest({
				input: [],
				tool_choice: { type: "allowed_tools", mode: "auto" },
			}).tool_choice,
		).toBeUndefined();
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] dropped unsupported tool_choice",
			{ toolChoiceType: "allowed_tools" },
		);
	});

	it("maps reasoning.effort onto reasoning_effort and drops the rest with warn", () => {
		const out = responsesToOpenaiRequest({
			input: [],
			reasoning: { effort: "high", summary: "auto" },
		});
		expect(out.reasoning_effort).toBe("high");
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] dropped unsupported reasoning fields",
			{ fields: ["summary"] },
		);
	});

	it("passes through sampling params, maps max_output_tokens → max_tokens, never leaks client params", () => {
		const out = responsesToOpenaiRequest({
			model: "gpt-4o",
			stream: true,
			temperature: 0.5,
			top_p: 0.9,
			parallel_tool_calls: false,
			max_output_tokens: 256,
			user: "u_1",
			input: [],
			stream_options: { include_usage: true },
			stop: ["END"],
		});
		expect(out.model).toBe("gpt-4o");
		expect(out.stream).toBe(true);
		expect(out.temperature).toBe(0.5);
		expect(out.top_p).toBe(0.9);
		expect(out.parallel_tool_calls).toBe(false);
		expect(out.max_tokens).toBe(256);
		expect(out.user).toBe("u_1");
		expect(out.max_output_tokens).toBeUndefined();
		expect(out.stream_options).toBeUndefined();
		expect(out.stop).toBeUndefined();
	});

	it("drops stateful fields with exactly one aggregate warning", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = responsesToOpenaiRequest({
			input: [],
			store: false,
			previous_response_id: "resp_old",
			conversation: "conv_1",
			background: true,
		});
		expect(out.store).toBeUndefined();
		expect(out.previous_response_id).toBeUndefined();
		expect(out.conversation).toBeUndefined();
		expect(out.background).toBeUndefined();
		const statefulCalls = warnSpy.mock.calls.filter(
			([message]) =>
				message ===
				"[format-converter] dropped stateful responses fields (chat upstream is stateless)",
		);
		expect(statefulCalls).toHaveLength(1);
		expect(statefulCalls[0][1]).toEqual({
			fields: ["store", "previous_response_id", "conversation", "background"],
		});
	});

	it("merges consecutive same-role user messages, collapsing text-only ones back to a string", () => {
		const out = responsesToOpenaiRequest({
			input: [
				{ type: "message", role: "user", content: "Hello" },
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "Look: " },
						{ type: "input_image", image_url: "https://example.com/x.png" },
					],
				},
			],
		});
		expect(out.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "Hello" },
					{ type: "text", text: "Look: " },
					{ type: "image_url", image_url: { url: "https://example.com/x.png" } },
				],
			},
		]);
	});

	it("maps text.format json_schema onto response_format and round-trips via openaiToResponsesRequest", () => {
		const format = {
			type: "json_schema",
			name: "out",
			schema: { type: "object", properties: { ok: { type: "boolean" } } },
			strict: true,
		};
		const out = responsesToOpenaiRequest({ input: [], text: { format } });
		expect(out.response_format).toEqual({
			type: "json_schema",
			json_schema: {
				name: "out",
				schema: { type: "object", properties: { ok: { type: "boolean" } } },
				strict: true,
			},
		});
		// exact inverse: the chat-side response_format converts back to the same text.format
		expect(openaiToResponsesRequest(out).text).toEqual({ format });
	});

	it("applies json_schema defaults (name/schema) symmetrically in both directions", () => {
		const out = responsesToOpenaiRequest({
			input: [],
			text: { format: { type: "json_schema" } },
		});
		expect(out.response_format).toEqual({
			type: "json_schema",
			json_schema: { name: "response", schema: {} },
		});
		expect(openaiToResponsesRequest(out).text).toEqual({
			format: { type: "json_schema", name: "response", schema: {} },
		});
	});

	it("maps text.format json_object onto response_format json_object (round-trip)", () => {
		const out = responsesToOpenaiRequest({
			input: [],
			text: { format: { type: "json_object" } },
		});
		expect(out.response_format).toEqual({ type: "json_object" });
		expect(openaiToResponsesRequest(out).text).toEqual({
			format: { type: "json_object" },
		});
	});

	it("omits response_format for text format and missing text config", () => {
		expect(
			responsesToOpenaiRequest({
				input: [],
				text: { format: { type: "text" } },
			}).response_format,
		).toBeUndefined();
		expect(
			responsesToOpenaiRequest({ input: [] }).response_format,
		).toBeUndefined();
	});

	it("drops unsupported text formats with warn", () => {
		const out = responsesToOpenaiRequest({
			input: [],
			text: { format: { type: "grammar", grammar: { syntax: "lark" } } },
		});
		expect(out.response_format).toBeUndefined();
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] dropped unsupported text format",
			{ formatType: "grammar" },
		);
	});
});

// --- openaiToResponsesResponse ---

describe("openaiToResponsesResponse", () => {
	it("maps text onto a message item with output_text + annotations and converts usage", () => {
		const out = openaiToResponsesResponse({
			id: "chatcmpl-abc",
			object: "chat.completion",
			created: 1700000000,
			model: "gpt-4o",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "Hello!" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});
		expect(out.id).toBe("resp_abc");
		expect(out.object).toBe("response");
		expect(out.created_at).toBe(1700000000);
		expect(out.model).toBe("gpt-4o");
		expect(out.status).toBe("completed");
		expect(out.incomplete_details).toBeNull();
		expect(out.output).toEqual([
			{
				type: "message",
				id: expect.any(String),
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello!", annotations: [] }],
			},
		]);
		expect(out.usage).toEqual({
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
		});
	});

	it("maps tool_calls onto function_call items and routes usage details into *_details", () => {
		const out = openaiToResponsesResponse({
			id: "chatcmpl-2",
			model: "gpt-4o",
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
			usage: {
				prompt_tokens: 10,
				completion_tokens: 5,
				total_tokens: 15,
				prompt_tokens_details: { cached_tokens: 4 },
				completion_tokens_details: { reasoning_tokens: 2 },
			},
		});
		expect(out.status).toBe("completed");
		expect(out.output).toEqual([
			{
				type: "function_call",
				id: expect.any(String),
				call_id: "call_1",
				name: "get_weather",
				arguments: '{"city":"Paris"}',
				status: "completed",
			},
		]);
		expect(out.usage).toEqual({
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
			input_tokens_details: { cached_tokens: 4 },
			output_tokens_details: { reasoning_tokens: 2 },
		});
	});

	it("maps finish_reason length onto incomplete/max_output_tokens and other reasons onto completed", () => {
		const length = openaiToResponsesResponse({
			id: "chatcmpl-3",
			model: "gpt-4o",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "Par" },
					finish_reason: "length",
				},
			],
		});
		expect(length.status).toBe("incomplete");
		expect(length.incomplete_details).toEqual({ reason: "max_output_tokens" });

		const filter = openaiToResponsesResponse({
			id: "chatcmpl-4",
			model: "gpt-4o",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "" },
					finish_reason: "content_filter",
				},
			],
		});
		expect(filter.status).toBe("completed");
		expect(filter.incomplete_details).toBeNull();
	});

	it("maps message.refusal onto a refusal content part and omits usage when absent", () => {
		const out = openaiToResponsesResponse({
			id: "chatcmpl-5",
			model: "gpt-4o",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: null, refusal: "No can do" },
					finish_reason: "stop",
				},
			],
		});
		expect(out.output).toEqual([
			{
				type: "message",
				id: expect.any(String),
				role: "assistant",
				status: "completed",
				content: [{ type: "refusal", refusal: "No can do" }],
			},
		]);
		expect(out.usage).toBeUndefined();
	});

	it("round-trips back to the original chat completion via responsesToChatResponse", () => {
		const original = {
			id: "chatcmpl-abc",
			object: "chat.completion",
			created: 1700000000,
			model: "gpt-4o",
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: "It is sunny.",
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
			usage: {
				prompt_tokens: 12,
				completion_tokens: 8,
				total_tokens: 20,
				prompt_tokens_details: { cached_tokens: 3 },
			},
		};
		const back = responsesToChatResponse(openaiToResponsesResponse(original));
		expect(back.id).toBe("resp_abc");
		expect(back.model).toBe("gpt-4o");
		const choices = back.choices as Array<Record<string, unknown>>;
		const message = choices[0].message as Record<string, unknown>;
		expect(message.content).toBe("It is sunny.");
		expect(message.tool_calls).toEqual([
			{
				id: "call_1",
				type: "function",
				function: { name: "get_weather", arguments: '{"city":"Paris"}' },
			},
		]);
		expect(choices[0].finish_reason).toBe("tool_calls");
		expect(back.usage).toEqual({
			prompt_tokens: 12,
			completion_tokens: 8,
			total_tokens: 20,
		});
	});
});

// --- createOpenaiToResponsesStreamTransform ---

describe("createOpenaiToResponsesStreamTransform", () => {
	it("emits created → added → text deltas → done → completed with sequential numbers and usage only on completed", async () => {
		const input = chatSse([
			chatChunk({ role: "assistant", content: "" }),
			chatChunk({ content: "Hel" }),
			chatChunk({ content: "lo" }),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			chatChunk({}, {
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}),
		]);
		const output = await runStreamTransform(
			input,
			createOpenaiToResponsesStreamTransform(),
		);
		// [DONE] is consumed as an end signal, never forwarded
		expect(output).not.toContain("[DONE]");

		const events = parseSseData(output) as Array<Record<string, unknown>>;
		expect(eventTypes(events)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.output_text.delta",
			"response.output_text.delta",
			"response.output_item.done",
			"response.completed",
		]);
		expect(events.map((e) => e.sequence_number)).toEqual([0, 1, 2, 3, 4, 5]);

		// id/model captured from the first upstream chunk before emitting created
		expect(events[0].response).toMatchObject({
			id: "resp_abc",
			object: "response",
			model: "gpt-4o",
			status: "in_progress",
		});

		const added = events[1].item as Record<string, unknown>;
		expect(added).toMatchObject({
			type: "message",
			role: "assistant",
			status: "in_progress",
		});
		const itemId = added.id as string;
		expect(events[2].item_id).toBe(itemId);
		expect(events[2].delta).toBe("Hel");
		expect(events[3].delta).toBe("lo");

		const done = events[4].item as Record<string, unknown>;
		expect(done).toMatchObject({
			type: "message",
			status: "completed",
			content: [{ type: "output_text", text: "Hello", annotations: [] }],
		});

		const completed = events[5].response as Record<string, unknown>;
		expect(completed).toMatchObject({
			id: "resp_abc",
			model: "gpt-4o",
			status: "completed",
			output: [done],
			usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
		});
		// usage appears only on response.completed (spec §3.1 last-wins)
		for (const event of events.slice(0, 5)) {
			expect((event.response as Record<string, unknown> | undefined)?.usage)
				.toBeUndefined();
		}
	});

	it("emits a zero-valued usage object on completed when the upstream sends none", async () => {
		const input = chatSse([
			chatChunk({ role: "assistant" }),
			chatChunk({ content: "Hi" }),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
		]);
		const events = parseSseData(
			await runStreamTransform(
				input,
				createOpenaiToResponsesStreamTransform(),
			),
		) as Array<Record<string, unknown>>;
		const completed = events[events.length - 1].response as Record<
			string,
			unknown
		>;
		expect(completed.usage).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			total_tokens: 0,
		});
	});

	it("aggregates indexed tool_calls increments into distinct function_call items", async () => {
		const input = chatSse([
			chatChunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "get_weather", arguments: "" },
					},
				],
			}),
			chatChunk({
				tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
			}),
			chatChunk({
				tool_calls: [
					{
						index: 1,
						id: "call_2",
						type: "function",
						function: { name: "get_time", arguments: '{"tz":' },
					},
					{ index: 0, function: { arguments: '"Paris"}' } },
				],
			}),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
		]);
		const events = parseSseData(
			await runStreamTransform(
				input,
				createOpenaiToResponsesStreamTransform(),
			),
		) as Array<Record<string, unknown>>;
		expect(eventTypes(events)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.function_call_arguments.delta",
			"response.output_item.added",
			"response.function_call_arguments.delta",
			"response.function_call_arguments.delta",
			"response.output_item.done",
			"response.output_item.done",
			"response.completed",
		]);

		const added1 = events[1].item as Record<string, unknown>;
		expect(added1).toMatchObject({
			type: "function_call",
			call_id: "call_1",
			name: "get_weather",
			arguments: "",
		});
		expect(events[1].output_index).toBe(0);
		const added2 = events[3].item as Record<string, unknown>;
		expect(added2).toMatchObject({
			type: "function_call",
			call_id: "call_2",
			name: "get_time",
		});
		expect(events[3].output_index).toBe(1);
		// argument deltas are routed by item_id
		expect(events[2].item_id).toBe(added1.id);
		expect(events[2].delta).toBe('{"city":');
		expect(events[4].item_id).toBe(added2.id);
		expect(events[4].delta).toBe('{"tz":');
		expect(events[5].item_id).toBe(added1.id);
		expect(events[5].delta).toBe('"Paris"}');

		const completed = events[8].response as Record<string, unknown>;
		expect(completed.status).toBe("completed");
		expect(completed.output).toEqual([
			{
				type: "function_call",
				id: added1.id,
				call_id: "call_1",
				name: "get_weather",
				arguments: '{"city":"Paris"}',
				status: "completed",
			},
			{
				type: "function_call",
				id: added2.id,
				call_id: "call_2",
				name: "get_time",
				arguments: '{"tz":',
				status: "completed",
			},
		]);
	});

	it("surfaces delta.reasoning_content as reasoning summary deltas inside a reasoning item", async () => {
		const input = chatSse([
			chatChunk({ role: "assistant" }),
			chatChunk({ reasoning_content: "thinking hard" }),
			chatChunk({ reasoning_content: " now" }),
			chatChunk({ content: "Hi" }),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
		]);
		const events = parseSseData(
			await runStreamTransform(
				input,
				createOpenaiToResponsesStreamTransform(),
			),
		) as Array<Record<string, unknown>>;
		expect(eventTypes(events)).toEqual([
			"response.created",
			"response.output_item.added",
			"response.reasoning_summary_text.delta",
			"response.reasoning_summary_text.delta",
			"response.output_item.added",
			"response.output_text.delta",
			"response.output_item.done",
			"response.output_item.done",
			"response.completed",
		]);

		const reasoningAdded = events[1].item as Record<string, unknown>;
		expect(reasoningAdded).toEqual({
			type: "reasoning",
			id: expect.any(String),
			summary: [],
		});
		expect(events[2].delta).toBe("thinking hard");
		expect(events[2].summary_index).toBe(0);
		expect(events[3].delta).toBe(" now");
		// the message item gets the next output index
		expect(events[4].output_index).toBe(1);

		const completed = events[8].response as Record<string, unknown>;
		const reasoningDone = (completed.output as Array<Record<string, unknown>>)[0];
		expect(reasoningDone).toEqual({
			type: "reasoning",
			id: reasoningAdded.id,
			summary: [{ type: "summary_text", text: "thinking hard now" }],
		});
	});

	it("terminates with response.completed on flush when upstream never sends [DONE]", async () => {
		const input = chatSse(
			[
				chatChunk({ role: "assistant" }),
				chatChunk({ content: "Hi" }),
				chatChunk({}, {
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				}),
			],
			false,
		);
		const output = await runStreamTransform(
			input,
			createOpenaiToResponsesStreamTransform(),
		);
		expect(output).not.toContain("[DONE]");
		const events = parseSseData(output) as Array<Record<string, unknown>>;
		expect(events[events.length - 1].type).toBe("response.completed");
	});

	it("emits response.failed on an in-stream upstream error, swallows the rest, and warns", async () => {
		const input = chatSse([
			chatChunk({ role: "assistant", content: "" }),
			{ error: { code: "server_error", message: "boom" } },
			chatChunk({ content: "late" }),
		]);
		const output = await runStreamTransform(
			input,
			createOpenaiToResponsesStreamTransform(),
		);
		const events = parseSseData(output) as Array<Record<string, unknown>>;
		expect(eventTypes(events)).toEqual(["response.created", "response.failed"]);
		expect(events[1].response).toMatchObject({
			id: "resp_abc",
			status: "failed",
			error: { code: "server_error", message: "boom" },
		});
		expect(console.warn).toHaveBeenCalledWith(
			"[format-converter] upstream stream error",
			{ error_type: "server_error", error_message: "boom" },
		);
	});

	it("round-trips through createResponsesToChatStreamTransform back into chat chunks", async () => {
		const chatIn = chatSse([
			chatChunk({ role: "assistant", content: "" }),
			chatChunk({ content: "Hello" }),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			chatChunk({}, {
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}),
		]);
		const responsesSse = await runStreamTransform(
			chatIn,
			createOpenaiToResponsesStreamTransform(),
		);
		const chunks = parseSseData(
			await runStreamTransform(
				responsesSse,
				createResponsesToChatStreamTransform(),
			),
		);
		expect(chunks[chunks.length - 1]).toBe("[DONE]");
		expect(firstDelta(chunks[0])).toEqual({ role: "assistant" });
		expect(firstDelta(chunks[1])).toEqual({ content: "Hello" });
		const terminal = chunks[2] as Record<string, unknown>;
		const choice = (terminal.choices as Array<Record<string, unknown>>)[0];
		expect(choice.finish_reason).toBe("stop");
		expect(terminal.usage).toEqual({
			prompt_tokens: 5,
			completion_tokens: 2,
			total_tokens: 7,
		});
	});

	it("produced Responses SSE feeds parseUsageFromSse with promptTokens > 0", async () => {
		const chatIn = chatSse([
			chatChunk({ role: "assistant", content: "" }),
			chatChunk({ content: "Hello" }),
			chatChunk({}, {
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			chatChunk({}, {
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}),
		]);
		const responsesSse = await runStreamTransform(
			chatIn,
			createOpenaiToResponsesStreamTransform(),
		);
		const { usage } = await parseUsageFromSse(
			new Response(responsesSse, {
				headers: { "content-type": "text/event-stream" },
			}),
		);
		expect(usage).toEqual({
			totalTokens: 7,
			promptTokens: 5,
			completionTokens: 2,
			cachedInputTokens: null,
			cacheCreationTokens: null,
		});
	});
});

function firstDelta(chunk: SseItem): unknown {
	const choices = (chunk as Record<string, unknown>).choices as Array<
		Record<string, unknown>
	>;
	return choices[0].delta;
}
