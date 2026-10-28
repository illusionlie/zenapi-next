/**
 * Bidirectional format conversion between OpenAI, Anthropic, and OpenAI
 * Responses APIs.
 */

import { extractReasoningEffort } from "../utils/reasoning";

type OpenAIMessage = {
	role: string;
	content:
		| string
		| Array<{ type: string; text?: string; [k: string]: unknown }>;
	[k: string]: unknown;
};

type OpenAIChatRequest = {
	model?: string;
	messages?: OpenAIMessage[];
	stream?: boolean;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	[k: string]: unknown;
};

type AnthropicContentBlock = {
	type: string;
	text?: string;
	[k: string]: unknown;
};

type AnthropicMessage = {
	role: string;
	content: string | AnthropicContentBlock[];
};

type AnthropicRequest = {
	model?: string;
	messages?: AnthropicMessage[];
	system?: string | Array<{ type: string; text: string }>;
	max_tokens?: number;
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	[k: string]: unknown;
};

type ResponsesRequest = {
	model?: string;
	input?: Array<Record<string, unknown>>;
	instructions?: string;
	max_output_tokens?: number;
	temperature?: number;
	top_p?: number;
	stream?: boolean;
	parallel_tool_calls?: boolean;
	user?: string;
	tools?: Array<Record<string, unknown>>;
	tool_choice?: unknown;
	text?: { format: Record<string, unknown> };
	reasoning?: { effort: string };
	[k: string]: unknown;
};

type ResponsesOutputItem = {
	type?: string;
	id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	content?: Array<Record<string, unknown>>;
	[k: string]: unknown;
};

type ResponsesResponseBody = {
	id?: string;
	model?: string;
	created_at?: number;
	status?: string;
	output?: ResponsesOutputItem[];
	incomplete_details?: { reason?: string } | null;
	usage?: Record<string, unknown>;
	[k: string]: unknown;
};

// --- Request converters ---

// Thinking budget ratio per reasoning effort level (OpenRouter-style public
// convention, research §2), applied against max_tokens and then clamped.
const EFFORT_BUDGET_RATIOS: Record<string, number> = {
	minimal: 0.1,
	low: 0.2,
	medium: 0.5,
	high: 0.8,
	xhigh: 0.95,
	max: 0.95,
};

// Client-provided thinking objects pass through only for these documented
// types; anything else falls back to effort mapping (invalid passthrough
// payloads surface as transparent upstream 400s, never silent rewrites).
const VALID_THINKING_TYPES = new Set(["enabled", "adaptive", "disabled"]);

// Anthropic image sources accept base64 data only for these media types.
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);

/**
 * Clamps a thinking budget into Anthropic's constraints (>= 1024 and <
 * max_tokens). When the client-provided max_tokens is too small for both to
 * hold, the strict upper bound wins — max_tokens is never rewritten upward and
 * the request is left for upstream semantics to judge.
 */
function clampThinkingBudget(budget: number, maxTokens: number): number {
	return Math.min(Math.max(budget, 1024), maxTokens - 1);
}

/**
 * Maps a reasoning effort value to an Anthropic thinking budget, or null when
 * no thinking field should be sent: "none" explicitly disables reasoning,
 * unknown strings are dropped, numeric values count as explicit budgets.
 */
function resolveThinkingBudget(
	effort: string | number | null,
	maxTokens: number,
): number | null {
	if (typeof effort === "number") {
		return clampThinkingBudget(Math.floor(effort), maxTokens);
	}
	if (effort === null || effort === "none") {
		return null;
	}
	const ratio = EFFORT_BUDGET_RATIOS[effort];
	if (ratio === undefined) {
		return null;
	}
	return clampThinkingBudget(Math.floor(maxTokens * ratio), maxTokens);
}

/**
 * Parses a `data:<mime>;base64,<data>` URL into its media type and payload.
 */
function parseBase64DataUrl(
	value: string,
): { mediaType: string; data: string } | null {
	const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
	if (!match) {
		return null;
	}
	return { mediaType: match[1] ?? "", data: match[2] ?? "" };
}

/**
 * Converts a chat user message content (string or part array) into Anthropic
 * content. Unusable parts are dropped with a warning (design D7) instead of
 * failing the whole request; a fully-dropped array falls back to an empty text
 * block so Anthropic never receives an empty content array.
 */
function convertUserContentToAnthropic(
	content: OpenAIMessage["content"],
): string | AnthropicContentBlock[] {
	if (typeof content === "string") {
		return content;
	}
	const blocks: AnthropicContentBlock[] = [];
	for (const part of Array.isArray(content) ? content : []) {
		const block = convertContentPartToAnthropic(part);
		if (block) {
			blocks.push(block);
		}
	}
	if (blocks.length === 0) {
		blocks.push({ type: "text", text: "" });
	}
	return blocks;
}

function convertContentPartToAnthropic(
	part: { type: string; text?: string; [k: string]: unknown } | undefined,
): AnthropicContentBlock | null {
	if (!part || typeof part !== "object") {
		return null;
	}
	switch (part.type) {
		case "text":
			// Non-string text degrades to an empty string instead of dropping the block
			return {
				type: "text",
				text: typeof part.text === "string" ? part.text : "",
			};
		case "image_url":
			return convertImageUrlPartToAnthropic(part);
		case "file":
			return convertFilePartToAnthropic(part);
		case "input_audio":
			// Anthropic has no audio input (research §3)
			console.warn("[format-converter] dropped unsupported content part", {
				partType: "input_audio",
				reason: "anthropic_has_no_audio_input",
			});
			return null;
		default:
			console.warn("[format-converter] dropped unknown content part", {
				partType: String(part.type),
			});
			return null;
	}
}

function convertImageUrlPartToAnthropic(
	part: Record<string, unknown>,
): AnthropicContentBlock | null {
	const imageUrl = part.image_url;
	const url =
		typeof imageUrl === "string"
			? imageUrl
			: ((imageUrl as Record<string, unknown> | undefined)?.url as
					| string
					| undefined);
	if (typeof url !== "string" || !url) {
		console.warn("[format-converter] dropped unusable image_url part", {
			reason: "missing_url",
		});
		return null;
	}
	if (/^https?:\/\//i.test(url)) {
		return { type: "image", source: { type: "url", url } };
	}
	const dataUrl = parseBase64DataUrl(url);
	if (dataUrl && SUPPORTED_IMAGE_MEDIA_TYPES.has(dataUrl.mediaType)) {
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: dataUrl.mediaType,
				data: dataUrl.data,
			},
		};
	}
	// data: URIs in a url source are not documented as supported (research §8)
	console.warn("[format-converter] dropped unusable image_url part", {
		reason: "unsupported_url_scheme_or_media_type",
	});
	return null;
}

function convertFilePartToAnthropic(
	part: Record<string, unknown>,
): AnthropicContentBlock | null {
	const file = part.file as Record<string, unknown> | undefined;
	const fileData =
		typeof file?.file_data === "string" ? file.file_data : undefined;
	const filename = typeof file?.filename === "string" ? file.filename : "";
	if (fileData) {
		const dataUrl = parseBase64DataUrl(fileData);
		if (dataUrl && dataUrl.mediaType === "application/pdf") {
			return {
				type: "document",
				source: {
					type: "base64",
					media_type: "application/pdf",
					data: dataUrl.data,
				},
			};
		}
		if (
			!fileData.startsWith("data:") &&
			filename.toLowerCase().endsWith(".pdf")
		) {
			return {
				type: "document",
				source: {
					type: "base64",
					media_type: "application/pdf",
					data: fileData,
				},
			};
		}
	}
	// Only base64 PDF documents are supported (research §3)
	console.warn("[format-converter] dropped unusable file part", {
		reason: "only_base64_pdf_is_supported",
	});
	return null;
}

/**
 * Converts an OpenAI chat completion request body to an Anthropic Messages request body.
 */
export function openaiToAnthropicRequest(
	body: OpenAIChatRequest,
): AnthropicRequest {
	const result: AnthropicRequest = {};
	if (body.model) {
		result.model = body.model;
	}
	if (body.stream !== undefined) {
		result.stream = body.stream;
	}
	// max_tokens is required by Anthropic; max_completion_tokens wins when both
	// are present (same priority as the responses direction). Default raised to
	// 8192 — 4096 starves reasoning models (research §2).
	const maxTokens =
		(body.max_completion_tokens as number | undefined) ??
		body.max_tokens ??
		8192;
	result.max_tokens = maxTokens;
	if (body.temperature !== undefined) {
		result.temperature = body.temperature;
	}
	if (body.top_p !== undefined) {
		result.top_p = body.top_p;
	}
	if (body.stop) {
		result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
	}

	// Convert OpenAI tools to Anthropic tools format
	if (body.tools) {
		result.tools = (body.tools as Array<Record<string, unknown>>).map(
			(tool) => {
				const fn = ((tool as Record<string, unknown>).function ??
					tool) as Record<string, unknown>;
				return {
					name: fn.name as string,
					description: (fn.description as string) ?? "",
					input_schema: (fn.parameters as Record<string, unknown>) ?? {
						type: "object",
					},
				};
			},
		);
	}

	// Convert tool_choice
	if (body.tool_choice) {
		if (body.tool_choice === "auto") {
			result.tool_choice = { type: "auto" };
		} else if (body.tool_choice === "required") {
			result.tool_choice = { type: "any" };
		} else if (body.tool_choice === "none") {
			// Native "none" value (2025+): tools stay declared, calls are forbidden
			result.tool_choice = { type: "none" };
		} else if (typeof body.tool_choice === "object") {
			const tc = body.tool_choice as Record<string, unknown>;
			const fn = tc.function as Record<string, unknown> | undefined;
			if (fn?.name) {
				result.tool_choice = { type: "tool", name: fn.name };
			}
		}
	}

	// thinking (FR1): a client-provided Anthropic-style thinking object passes
	// through with minimal validation (escape hatch covering adaptive and
	// explicit budgets); otherwise reasoning effort maps onto
	// {type:"enabled", budget_tokens}. "none" sends no thinking field at all.
	const clientThinking = body.thinking as Record<string, unknown> | undefined;
	if (
		clientThinking &&
		typeof clientThinking === "object" &&
		typeof clientThinking.type === "string" &&
		VALID_THINKING_TYPES.has(clientThinking.type)
	) {
		result.thinking = clientThinking;
	} else {
		const budget = resolveThinkingBudget(
			extractReasoningEffort(body),
			maxTokens,
		);
		if (budget !== null) {
			result.thinking = { type: "enabled", budget_tokens: budget };
		}
	}
	// Thinking requests must not carry sampling params (design D5): older model
	// generations reject temperature/top_p together with thinking and newer ones
	// reject non-default sampling outright — stripping is the common safe set.
	if (result.thinking !== undefined) {
		delete result.temperature;
		delete result.top_p;
	}

	const systemParts: string[] = [];
	const rawMessages: Array<{
		role: string;
		content: string | AnthropicContentBlock[];
	}> = [];

	for (const msg of body.messages ?? []) {
		if (msg.role === "system" || msg.role === "developer") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: (msg.content as Array<{ text?: string }>)
							.map((c) => c.text ?? "")
							.join("\n");
			systemParts.push(text);
		} else if (msg.role === "assistant") {
			const contentBlocks: AnthropicContentBlock[] = [];
			if (typeof msg.content === "string") {
				if (msg.content) {
					contentBlocks.push({ type: "text", text: msg.content });
				}
			} else if (Array.isArray(msg.content)) {
				contentBlocks.push(...(msg.content as AnthropicContentBlock[]));
			}
			// Convert tool_calls to tool_use content blocks
			const toolCalls = msg.tool_calls as
				| Array<Record<string, unknown>>
				| undefined;
			if (toolCalls) {
				for (const tc of toolCalls) {
					const fn = tc.function as Record<string, unknown> | undefined;
					let input: unknown = {};
					if (fn?.arguments) {
						try {
							input = JSON.parse(fn.arguments as string);
						} catch {
							input = {};
						}
					}
					contentBlocks.push({
						type: "tool_use",
						id: (tc.id as string) ?? `toolu_${crypto.randomUUID()}`,
						name: (fn?.name as string) ?? "",
						input,
					});
				}
			}
			rawMessages.push({
				role: "assistant",
				content:
					contentBlocks.length === 1 && contentBlocks[0].type === "text"
						? (contentBlocks[0].text ?? "")
						: contentBlocks,
			});
		} else if (msg.role === "tool") {
			// Tool result → user message with tool_result block; array content
			// contributes its text parts joined together (was silently emptied)
			const toolCallId = msg.tool_call_id as string | undefined;
			const contentText =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? (msg.content as Array<{ text?: string }>)
								.map((c) => (typeof c?.text === "string" ? c.text : ""))
								.join("")
						: "";
			rawMessages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: toolCallId ?? "",
						content: contentText,
					},
				],
			});
		} else {
			// user (and any other role): convert multimodal parts conservatively —
			// unusable parts are dropped with a warning instead of a 400 (design D7)
			rawMessages.push({
				role: "user",
				content: convertUserContentToAnthropic(msg.content),
			});
		}
	}

	if (systemParts.length > 0) {
		result.system = systemParts.join("\n\n");
	}

	// Merge consecutive same-role messages (required by Anthropic API)
	const messages: AnthropicMessage[] = [];
	for (const msg of rawMessages) {
		const last = messages[messages.length - 1];
		if (last && last.role === msg.role) {
			const lastContent =
				typeof last.content === "string"
					? [{ type: "text", text: last.content } as AnthropicContentBlock]
					: last.content;
			const curContent =
				typeof msg.content === "string"
					? [{ type: "text", text: msg.content } as AnthropicContentBlock]
					: msg.content;
			last.content = [...lastContent, ...curContent];
		} else {
			messages.push({ ...msg });
		}
	}

	result.messages = messages;
	return result;
}

/**
 * Converts an Anthropic Messages request body to an OpenAI chat completion request body.
 */
export function anthropicToOpenaiRequest(
	body: AnthropicRequest,
): OpenAIChatRequest {
	const result: OpenAIChatRequest = {};
	if (body.model) {
		result.model = body.model;
	}
	if (body.stream !== undefined) {
		result.stream = body.stream;
	}
	if (body.max_tokens !== undefined) {
		result.max_tokens = body.max_tokens;
	}
	if (body.temperature !== undefined) {
		result.temperature = body.temperature;
	}
	if (body.top_p !== undefined) {
		result.top_p = body.top_p;
	}
	if (body.stop_sequences) {
		result.stop = body.stop_sequences;
	}

	// Convert Anthropic tools to OpenAI tools format
	if (body.tools) {
		result.tools = (body.tools as Array<Record<string, unknown>>).map(
			(tool) => ({
				type: "function" as const,
				function: {
					name: tool.name as string,
					description: (tool.description as string) ?? "",
					parameters: (tool.input_schema as Record<string, unknown>) ?? {},
				},
			}),
		);
	}

	// Convert tool_choice
	if (body.tool_choice) {
		const tc = body.tool_choice as Record<string, unknown>;
		if (tc.type === "auto") {
			result.tool_choice = "auto";
		} else if (tc.type === "any") {
			result.tool_choice = "required";
		} else if (tc.type === "tool") {
			result.tool_choice = {
				type: "function",
				function: { name: tc.name as string },
			};
		}
	}

	const messages: OpenAIMessage[] = [];

	if (body.system) {
		const systemText =
			typeof body.system === "string"
				? body.system
				: body.system.map((s) => s.text).join("\n\n");
		messages.push({ role: "system", content: systemText });
	}

	for (const msg of body.messages ?? []) {
		if (msg.role === "assistant") {
			if (typeof msg.content === "string") {
				messages.push({ role: "assistant", content: msg.content });
			} else {
				const blocks = msg.content as AnthropicContentBlock[];
				const textParts: string[] = [];
				const toolCalls: Array<Record<string, unknown>> = [];
				for (const block of blocks) {
					if (block.type === "text") {
						textParts.push(block.text ?? "");
					} else if (block.type === "tool_use") {
						toolCalls.push({
							id: block.id as string,
							type: "function",
							function: {
								name: block.name as string,
								arguments:
									typeof block.input === "string"
										? block.input
										: JSON.stringify(block.input ?? {}),
							},
						});
					}
					// Skip thinking blocks and other unknown types
				}
				const assistantMsg: OpenAIMessage = {
					role: "assistant",
					content: textParts.join("") || "",
				};
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls;
				}
				messages.push(assistantMsg);
			}
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({ role: "user", content: msg.content });
			} else {
				const blocks = msg.content as AnthropicContentBlock[];
				const toolResults: AnthropicContentBlock[] = [];
				const otherBlocks: AnthropicContentBlock[] = [];
				for (const block of blocks) {
					if (block.type === "tool_result") {
						toolResults.push(block);
					} else {
						otherBlocks.push(block);
					}
				}
				// Non-tool content as user message
				if (otherBlocks.length > 0) {
					const textContent = otherBlocks
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("");
					if (textContent) {
						messages.push({ role: "user", content: textContent });
					}
				}
				// Each tool_result becomes a separate tool message
				for (const tr of toolResults) {
					let trContent: string;
					if (typeof tr.content === "string") {
						trContent = tr.content;
					} else if (Array.isArray(tr.content)) {
						trContent = (tr.content as Array<Record<string, unknown>>)
							.map((b) => (b.type === "text" ? ((b.text as string) ?? "") : ""))
							.join("");
					} else {
						trContent = "";
					}
					messages.push({
						role: "tool",
						tool_call_id: tr.tool_use_id as string,
						content: trContent,
					});
				}
			}
		} else {
			// Other roles pass through
			const content =
				typeof msg.content === "string"
					? msg.content
					: (msg.content as AnthropicContentBlock[])
							.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
							.join("");
			messages.push({ role: msg.role, content });
		}
	}

	result.messages = messages;
	return result;
}

// --- Response converters ---

/**
 * Maps an Anthropic stop_reason to an OpenAI finish_reason. Shared by both
 * conversion directions' call sites (the anthropic→chat response/stream path
 * and tests); the full seven-value enum is covered (research §5).
 */
export function mapStopReason(stopReason: string | null | undefined): string {
	if (!stopReason) return "stop";
	switch (stopReason) {
		case "end_turn":
		case "stop_sequence":
		case "pause_turn":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "tool_calls";
		case "refusal":
			return "content_filter";
		default:
			return "stop";
	}
}

/**
 * Maps an OpenAI finish_reason to an Anthropic stop_reason. Shared by both
 * conversion directions' call sites (the chat→anthropic response/stream path
 * and tests).
 */
export function mapFinishReason(
	finishReason: string | null | undefined,
): string {
	if (!finishReason) return "end_turn";
	switch (finishReason) {
		case "stop":
			return "end_turn";
		case "length":
			return "max_tokens";
		case "tool_calls":
			return "tool_use";
		case "content_filter":
			return "refusal";
		default:
			return "end_turn";
	}
}

/**
 * Reads the thinking token count out of Anthropic's
 * `usage.output_tokens_details.thinking_tokens`, when present as a number.
 */
function readThinkingTokens(
	usage: Record<string, unknown> | undefined,
): number | undefined {
	const value = (
		usage?.output_tokens_details as Record<string, unknown> | undefined
	)?.thinking_tokens;
	return typeof value === "number" ? value : undefined;
}

/**
 * Converts Anthropic usage into OpenAI usage semantics (design D6): Anthropic
 * `input_tokens` excludes cached tokens while OpenAI `prompt_tokens` is the
 * total, so the cache_read/cache_creation counters are folded back in.
 */
function anthropicUsageToChat(
	inputTokens: number,
	cacheReadTokens: number,
	cacheCreationTokens: number,
	outputTokens: number,
	thinkingTokens?: number,
): Record<string, unknown> {
	const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
	const result: Record<string, unknown> = {
		prompt_tokens: promptTokens,
		completion_tokens: outputTokens,
		total_tokens: promptTokens + outputTokens,
	};
	if (cacheReadTokens > 0) {
		result.prompt_tokens_details = { cached_tokens: cacheReadTokens };
	}
	if (thinkingTokens !== undefined) {
		result.completion_tokens_details = { reasoning_tokens: thinkingTokens };
	}
	return result;
}

/**
 * Converts an Anthropic Messages API response to an OpenAI chat completion response.
 */
export function anthropicToOpenaiResponse(
	anthropicBody: Record<string, unknown>,
): Record<string, unknown> {
	const content = anthropicBody.content as AnthropicContentBlock[] | undefined;
	const textParts = (content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "");
	const text = textParts.join("");

	// Convert tool_use content blocks to OpenAI tool_calls
	const toolUseBlocks = (content ?? []).filter((b) => b.type === "tool_use");
	const toolCalls =
		toolUseBlocks.length > 0
			? toolUseBlocks.map((b) => ({
					id: (b.id as string) ?? `call_${crypto.randomUUID()}`,
					type: "function" as const,
					function: {
						name: (b.name as string) ?? "",
						arguments:
							typeof b.input === "string"
								? b.input
								: JSON.stringify(b.input ?? {}),
					},
				}))
			: undefined;

	const usage = anthropicBody.usage as Record<string, unknown> | undefined;

	const message: Record<string, unknown> = {
		role: "assistant",
		content: text || null,
	};
	// Thinking blocks surface as reasoning_content (design D3, DeepSeek-style
	// convention), each block's payload being its `thinking` field (`text` as a
	// fallback for compat endpoints). redacted_thinking is never echoed back.
	const reasoningContent = (content ?? [])
		.filter((b) => b.type === "thinking")
		.map((b) => (b.thinking as string) ?? b.text ?? "")
		.filter((t) => t.length > 0)
		.join("\n\n");
	if (reasoningContent) {
		message.reasoning_content = reasoningContent;
	}
	if (toolCalls) {
		message.tool_calls = toolCalls;
	}

	return {
		id: `chatcmpl-${(anthropicBody.id as string) ?? crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: anthropicBody.model as string,
		choices: [
			{
				index: 0,
				message,
				finish_reason: mapStopReason(
					anthropicBody.stop_reason as string | undefined,
				),
			},
		],
		usage: usage
			? anthropicUsageToChat(
					(usage.input_tokens as number) ?? 0,
					(usage.cache_read_input_tokens as number) ?? 0,
					(usage.cache_creation_input_tokens as number) ?? 0,
					(usage.output_tokens as number) ?? 0,
					readThinkingTokens(usage),
				)
			: undefined,
	};
}

/**
 * Converts an OpenAI chat completion response to an Anthropic Messages API response.
 */
export function openaiToAnthropicResponse(
	openaiBody: Record<string, unknown>,
): Record<string, unknown> {
	const choices = openaiBody.choices as
		| Array<Record<string, unknown>>
		| undefined;
	const firstChoice = choices?.[0];
	const message = firstChoice?.message as Record<string, unknown> | undefined;
	const contentText = (message?.content as string) ?? "";
	const toolCalls = message?.tool_calls as
		| Array<Record<string, unknown>>
		| undefined;
	const usage = openaiBody.usage as Record<string, unknown> | undefined;

	const contentBlocks: AnthropicContentBlock[] = [];
	if (contentText) {
		contentBlocks.push({ type: "text", text: contentText });
	}
	if (toolCalls && toolCalls.length > 0) {
		for (const tc of toolCalls) {
			const fn = tc.function as Record<string, unknown> | undefined;
			let input: unknown = {};
			if (fn?.arguments) {
				try {
					input = JSON.parse(fn.arguments as string);
				} catch {
					input = {};
				}
			}
			contentBlocks.push({
				type: "tool_use",
				id: (tc.id as string) ?? `toolu_${crypto.randomUUID()}`,
				name: (fn?.name as string) ?? "",
				input,
			});
		}
	}
	if (contentBlocks.length === 0) {
		contentBlocks.push({ type: "text", text: "" });
	}

	let stopReason = mapFinishReason(
		firstChoice?.finish_reason as string | undefined,
	);
	if (toolCalls && toolCalls.length > 0) {
		stopReason = "tool_use";
	}

	return {
		id:
			((openaiBody.id as string) ?? "").replace("chatcmpl-", "msg_") ||
			`msg_${crypto.randomUUID()}`,
		type: "message",
		role: "assistant",
		model: openaiBody.model as string,
		content: contentBlocks,
		stop_reason: stopReason,
		usage: usage
			? {
					input_tokens: (usage.prompt_tokens as number) ?? 0,
					output_tokens: (usage.completion_tokens as number) ?? 0,
				}
			: { input_tokens: 0, output_tokens: 0 },
	};
}

// --- Stream converters ---

// Input-side usage cached from message_start and merged into the single
// terminal usage chunk (design D6). Anthropic input_tokens excludes cached
// tokens, so all three counters must be carried.
type AnthropicStartUsage = {
	inputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
};

/**
 * Creates a TransformStream that converts Anthropic SSE events to OpenAI SSE chunks.
 */
export function createAnthropicToOpenaiStreamTransform(): TransformStream<
	Uint8Array,
	Uint8Array
> {
	let buffer = "";
	let currentEventType = "";
	let messageId = "";
	let model = "";
	let toolCallIndex = -1;
	let startUsage: AnthropicStartUsage = {
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
	};
	let streamFinished = false;
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let newlineIndex = buffer.indexOf("\n");

			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);

				if (line.startsWith("event:")) {
					currentEventType = line.slice(6).trim();
				} else if (line.startsWith("data:")) {
					const payload = line.slice(5).trim();
					if (!payload) {
						newlineIndex = buffer.indexOf("\n");
						continue;
					}

					try {
						const data = JSON.parse(payload);

						if (data.type === "message_start" && data.message) {
							messageId = data.message.id ?? messageId;
							model = data.message.model ?? model;
							const msgUsage = data.message.usage as
								| Record<string, unknown>
								| undefined;
							if (msgUsage) {
								startUsage = {
									inputTokens: (msgUsage.input_tokens as number) ?? 0,
									cacheReadTokens:
										(msgUsage.cache_read_input_tokens as number) ?? 0,
									cacheCreationTokens:
										(msgUsage.cache_creation_input_tokens as number) ?? 0,
								};
							}
						}

						// In-stream upstream error → one terminal chunk + warn (design D8).
						// The stream is already 200 and OpenAI SSE has no error event type,
						// so a terminal chunk is the only way not to leave the client
						// hanging; afterwards only [DONE] (from a trailing message_stop)
						// may still be emitted.
						if (data.type === "error" || currentEventType === "error") {
							const err = data.error as Record<string, unknown> | undefined;
							console.warn("[format-converter] upstream stream error", {
								error_type:
									typeof err?.type === "string"
										? err.type
										: String(data.type ?? "unknown"),
								error_message:
									typeof err?.message === "string" ? err.message : "",
							});
							if (!streamFinished) {
								streamFinished = true;
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify({
											id: `chatcmpl-${messageId || crypto.randomUUID()}`,
											object: "chat.completion.chunk",
											created: Math.floor(Date.now() / 1000),
											model,
											choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
										})}\n\n`,
									),
								);
							}
							newlineIndex = buffer.indexOf("\n");
							continue;
						}

						if (!streamFinished) {
							// Track tool_use content blocks for index mapping
							if (
								(currentEventType === "content_block_start" ||
									data.type === "content_block_start") &&
								data.content_block?.type === "tool_use"
							) {
								toolCallIndex++;
							}

							const openaiChunk = convertAnthropicEventToOpenaiChunk(
								currentEventType,
								data,
								messageId,
								model,
								toolCallIndex,
								startUsage,
							);

							if (openaiChunk) {
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`),
								);
							}
						}

						if (
							currentEventType === "message_stop" ||
							data.type === "message_stop"
						) {
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						}
					} catch {
						// Skip invalid JSON
					}
				}

				newlineIndex = buffer.indexOf("\n");
			}
		},
		flush(controller) {
			if (buffer.trim()) {
				// Process any remaining data
				const line = buffer.trim();
				if (line.startsWith("data:")) {
					const payload = line.slice(5).trim();
					if (payload && payload !== "[DONE]") {
						try {
							const data = JSON.parse(payload);
							if (!streamFinished) {
								const openaiChunk = convertAnthropicEventToOpenaiChunk(
									currentEventType,
									data,
									messageId,
									model,
									toolCallIndex,
									startUsage,
								);
								if (openaiChunk) {
									controller.enqueue(
										encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`),
									);
								}
							}
						} catch {
							// Skip
						}
					}
				}
			}
			// No [DONE] here: the upstream message_stop event already emitted it.
			// (The old unconditional enqueue was the double-[DONE] defect.)
		},
	});
}

function convertAnthropicEventToOpenaiChunk(
	eventType: string,
	data: Record<string, unknown>,
	messageId: string,
	model: string,
	toolCallIndex: number,
	startUsage: AnthropicStartUsage,
): Record<string, unknown> | null {
	const id = `chatcmpl-${messageId || crypto.randomUUID()}`;
	const base = {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
	};

	switch (eventType) {
		case "message_start": {
			// Role chunk only: usage is cached in the transform and merged into the
			// single terminal usage chunk (design D6; OpenAI carries usage on the
			// final chunk, and splitting it made prompt_tokens record as 0).
			const msg = data.message as Record<string, unknown> | undefined;
			return {
				...base,
				model: (msg?.model as string) ?? model,
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "" },
						finish_reason: null,
					},
				],
			};
		}
		case "content_block_start": {
			const contentBlock = data.content_block as
				| Record<string, unknown>
				| undefined;
			if (contentBlock?.type === "tool_use") {
				return {
					...base,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: toolCallIndex,
										id: contentBlock.id as string,
										type: "function",
										function: {
											name: contentBlock.name as string,
											arguments: "",
										},
									},
								],
							},
							finish_reason: null,
						},
					],
				};
			}
			// text / thinking block starts produce no chunk
			return null;
		}
		case "content_block_delta": {
			const delta = data.delta as Record<string, unknown> | undefined;
			if (delta?.type === "text_delta") {
				return {
					...base,
					choices: [
						{
							index: 0,
							delta: { content: delta.text ?? "" },
							finish_reason: null,
						},
					],
				};
			}
			if (delta?.type === "input_json_delta") {
				return {
					...base,
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: toolCallIndex,
										function: {
											arguments: (delta.partial_json as string) ?? "",
										},
									},
								],
							},
							finish_reason: null,
						},
					],
				};
			}
			if (delta?.type === "thinking_delta") {
				// FR2 (design D3): thinking surfaces as reasoning_content increments
				return {
					...base,
					choices: [
						{
							index: 0,
							delta: { reasoning_content: (delta.thinking as string) ?? "" },
							finish_reason: null,
						},
					],
				};
			}
			// signature_delta / citations_delta are deliberately not forwarded (FR2)
			return null;
		}
		case "message_delta": {
			const delta = data.delta as Record<string, unknown> | undefined;
			const usage = data.usage as Record<string, unknown> | undefined;
			// The single complete usage chunk (design D6): the prompt side comes
			// from the message_start cache, completion from the cumulative
			// message_delta usage (documented as a running total, research §7).
			return {
				...base,
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: mapStopReason(
							delta?.stop_reason as string | undefined,
						),
					},
				],
				usage: usage
					? anthropicUsageToChat(
							startUsage.inputTokens,
							startUsage.cacheReadTokens,
							startUsage.cacheCreationTokens,
							(usage.output_tokens as number) ?? 0,
							readThinkingTokens(usage),
						)
					: undefined,
			};
		}
		default:
			return null;
	}
}

/**
 * Creates a TransformStream that converts OpenAI SSE chunks to Anthropic SSE events.
 */
export function createOpenaiToAnthropicStreamTransform(
	model: string,
): TransformStream<Uint8Array, Uint8Array> {
	let buffer = "";
	let sentMessageStart = false;
	let contentBlockIndex = 0;
	let hasTextBlock = false;
	const activeToolIndices = new Map<number, number>(); // openai tool index → anthropic content block index
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let newlineIndex = buffer.indexOf("\n");

			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);

				if (!line.startsWith("data:")) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}

				const payload = line.slice(5).trim();
				if (!payload || payload === "[DONE]") {
					if (payload === "[DONE]") {
						controller.enqueue(
							encoder.encode(
								`event: message_stop\ndata: {"type":"message_stop"}\n\n`,
							),
						);
					}
					newlineIndex = buffer.indexOf("\n");
					continue;
				}

				try {
					const data = JSON.parse(payload);
					const choices = data.choices as
						| Array<Record<string, unknown>>
						| undefined;
					const firstChoice = choices?.[0];
					const delta = firstChoice?.delta as
						| Record<string, unknown>
						| undefined;
					const finishReason = firstChoice?.finish_reason as
						| string
						| null
						| undefined;
					const usage = data.usage as Record<string, unknown> | undefined;

					// Emit message_start if not yet sent
					if (!sentMessageStart) {
						const messageStart = {
							type: "message_start",
							message: {
								id: `msg_${crypto.randomUUID()}`,
								type: "message",
								role: "assistant",
								model: (data.model as string) ?? model,
								content: [],
								stop_reason: null,
								usage: {
									input_tokens: (usage?.prompt_tokens as number) ?? 0,
									output_tokens: 0,
								},
							},
						};
						controller.enqueue(
							encoder.encode(
								`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`,
							),
						);
						sentMessageStart = true;
					}

					// Handle text content delta
					if (delta?.content != null) {
						if (!hasTextBlock) {
							controller.enqueue(
								encoder.encode(
									`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: contentBlockIndex, content_block: { type: "text", text: "" } })}\n\n`,
								),
							);
							hasTextBlock = true;
							contentBlockIndex++;
						}
						const textDelta = {
							type: "content_block_delta",
							index: contentBlockIndex - 1,
							delta: { type: "text_delta", text: delta.content as string },
						};
						controller.enqueue(
							encoder.encode(
								`event: content_block_delta\ndata: ${JSON.stringify(textDelta)}\n\n`,
							),
						);
					}

					// Handle tool_calls delta
					const toolCallsArr = delta?.tool_calls as
						| Array<Record<string, unknown>>
						| undefined;
					if (toolCallsArr) {
						for (const tc of toolCallsArr) {
							const tcIndex = (tc.index as number) ?? 0;
							const fn = tc.function as Record<string, unknown> | undefined;

							if (tc.id && fn?.name != null) {
								// New tool call — close text block if open and no tool blocks yet
								if (hasTextBlock && activeToolIndices.size === 0) {
									controller.enqueue(
										encoder.encode(
											`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentBlockIndex - 1 })}\n\n`,
										),
									);
								}

								const blockIdx = contentBlockIndex;
								activeToolIndices.set(tcIndex, blockIdx);
								controller.enqueue(
									encoder.encode(
										`event: content_block_start\ndata: ${JSON.stringify({
											type: "content_block_start",
											index: blockIdx,
											content_block: {
												type: "tool_use",
												id: tc.id as string,
												name: fn.name as string,
												input: {},
											},
										})}\n\n`,
									),
								);
								contentBlockIndex++;

								// Send initial arguments if present
								if (fn.arguments && (fn.arguments as string).length > 0) {
									controller.enqueue(
										encoder.encode(
											`event: content_block_delta\ndata: ${JSON.stringify({
												type: "content_block_delta",
												index: blockIdx,
												delta: {
													type: "input_json_delta",
													partial_json: fn.arguments as string,
												},
											})}\n\n`,
										),
									);
								}
							} else if (fn?.arguments != null) {
								// Continuation of arguments for existing tool call
								const blockIdx = activeToolIndices.get(tcIndex);
								if (
									blockIdx !== undefined &&
									(fn.arguments as string).length > 0
								) {
									controller.enqueue(
										encoder.encode(
											`event: content_block_delta\ndata: ${JSON.stringify({
												type: "content_block_delta",
												index: blockIdx,
												delta: {
													type: "input_json_delta",
													partial_json: fn.arguments as string,
												},
											})}\n\n`,
										),
									);
								}
							}
						}
					}

					// Handle finish
					if (finishReason) {
						// Close any open tool blocks
						for (const [, blockIdx] of activeToolIndices) {
							controller.enqueue(
								encoder.encode(
									`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`,
								),
							);
						}
						// Close text block if still open and no tools were used
						if (hasTextBlock && activeToolIndices.size === 0) {
							controller.enqueue(
								encoder.encode(
									`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: contentBlockIndex - 1 })}\n\n`,
								),
							);
						}

						const messageDeltaUsage: Record<string, unknown> = {
							output_tokens: (usage?.completion_tokens as number) ?? 0,
						};
						// Forward the prompt side when the terminal chunk carries it
						// (spec §3.1: the usage lives on the single terminal chunk —
						// message_start only saw the usage-free first chunk, so its
						// input_tokens baseline is 0; parseUsageFromSse's non-null
						// override then recovers the true prompt). Without this the
						// chat→anthropic pivot (anthropic-proxy responses target)
						// would bill prompt_tokens = 0.
						const promptTokens = usage?.prompt_tokens;
						if (typeof promptTokens === "number") {
							messageDeltaUsage.input_tokens = promptTokens;
						}
						const messageDelta = {
							type: "message_delta",
							delta: { stop_reason: mapFinishReason(finishReason) },
							usage: messageDeltaUsage,
						};
						controller.enqueue(
							encoder.encode(
								`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`,
							),
						);
					}
				} catch {
					// Skip invalid JSON
				}

				newlineIndex = buffer.indexOf("\n");
			}
		},
		flush(controller) {
			if (!sentMessageStart) {
				return;
			}
			controller.enqueue(
				encoder.encode(
					`event: message_stop\ndata: {"type":"message_stop"}\n\n`,
				),
			);
		},
	});
}

// --- Responses (OpenAI Responses API) converters ---

function chatContentText(
	content: OpenAIMessage["content"],
	joiner: string,
): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join(joiner);
	}
	return "";
}

function responsesFinishReason(resp: ResponsesResponseBody): string {
	const output = resp.output ?? [];
	if (output.some((item) => item?.type === "function_call")) {
		return "tool_calls";
	}
	if (
		resp.status === "incomplete" &&
		resp.incomplete_details?.reason === "max_output_tokens"
	) {
		return "length";
	}
	return "stop";
}

function responsesUsageToChat(
	usage: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
	if (!usage || typeof usage !== "object") {
		return undefined;
	}
	const promptTokens = (usage.input_tokens as number) ?? 0;
	const completionTokens = (usage.output_tokens as number) ?? 0;
	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens:
			(usage.total_tokens as number) ?? promptTokens + completionTokens,
	};
}

/**
 * Converts an OpenAI chat completion request body to an OpenAI Responses API
 * request body. Unknown / unsupported fields are conservatively dropped
 * (stop / n / logprobs / stream_options / non-function tools etc.).
 */
export function openaiToResponsesRequest(
	body: OpenAIChatRequest,
): ResponsesRequest {
	const result: ResponsesRequest = {};
	if (body.model) {
		result.model = body.model;
	}
	if (body.stream !== undefined) {
		result.stream = body.stream;
	}
	if (body.temperature !== undefined) {
		result.temperature = body.temperature;
	}
	if (body.top_p !== undefined) {
		result.top_p = body.top_p;
	}
	if (body.parallel_tool_calls !== undefined) {
		result.parallel_tool_calls = body.parallel_tool_calls as boolean;
	}
	if (body.user !== undefined) {
		result.user = body.user as string;
	}

	// max_output_tokens: max_completion_tokens wins when both are present
	const maxOutputTokens =
		(body.max_completion_tokens as number | undefined) ?? body.max_tokens;
	if (maxOutputTokens !== undefined) {
		result.max_output_tokens = maxOutputTokens;
	}

	// reasoning effort: direct field first, then reasoning.effort
	// (mirrors extractReasoningEffort's priority)
	const reasoning = body.reasoning as Record<string, unknown> | undefined;
	const effort =
		(body.reasoning_effort as string | number | undefined) ??
		(reasoning?.effort as string | number | undefined);
	if (typeof effort === "string") {
		result.reasoning = { effort };
	}

	// Flatten chat tools {type:"function", function:{...}} into Responses tools;
	// non-function tools are dropped
	const chatTools = body.tools as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(chatTools)) {
		const tools: Array<Record<string, unknown>> = [];
		for (const tool of chatTools) {
			const fn = tool.function as Record<string, unknown> | undefined;
			if (!fn || typeof fn !== "object") {
				continue;
			}
			if (tool.type !== undefined && tool.type !== "function") {
				continue;
			}
			tools.push({
				type: "function",
				name: fn.name as string,
				description: (fn.description as string) ?? "",
				parameters: (fn.parameters as Record<string, unknown>) ?? {
					type: "object",
				},
			});
		}
		if (tools.length > 0) {
			result.tools = tools;
		}
	}

	// tool_choice: strings pass through; {type:"function",function:{name}} flattens
	if (typeof body.tool_choice === "string") {
		result.tool_choice = body.tool_choice;
	} else if (body.tool_choice && typeof body.tool_choice === "object") {
		const tc = body.tool_choice as Record<string, unknown>;
		const fn = tc.function as Record<string, unknown> | undefined;
		if (fn?.name) {
			result.tool_choice = { type: "function", name: fn.name as string };
		}
	}

	// response_format → text.format
	const responseFormat = body.response_format as
		| Record<string, unknown>
		| undefined;
	if (responseFormat && typeof responseFormat === "object") {
		if (responseFormat.type === "json_object") {
			result.text = { format: { type: "json_object" } };
		} else if (responseFormat.type === "json_schema") {
			const js = responseFormat.json_schema as
				| Record<string, unknown>
				| undefined;
			if (js && typeof js === "object") {
				const format: Record<string, unknown> = {
					type: "json_schema",
					name: (js.name as string) ?? "response",
					schema: (js.schema as Record<string, unknown>) ?? {},
				};
				if (js.strict !== undefined) {
					format.strict = js.strict;
				}
				result.text = { format };
			}
		}
	}

	const systemParts: string[] = [];
	const input: Array<Record<string, unknown>> = [];

	for (const msg of body.messages ?? []) {
		if (msg.role === "system" || msg.role === "developer") {
			const text = chatContentText(msg.content, "\n");
			if (text) {
				systemParts.push(text);
			}
			continue;
		}

		if (msg.role === "tool") {
			let output: string;
			if (typeof msg.content === "string") {
				output = msg.content;
			} else if (Array.isArray(msg.content)) {
				output = chatContentText(msg.content, "");
			} else if (msg.content && typeof msg.content === "object") {
				output = JSON.stringify(msg.content);
			} else {
				output = "";
			}
			input.push({
				type: "function_call_output",
				call_id: (msg.tool_call_id as string) ?? "",
				output,
			});
			continue;
		}

		if (msg.role === "assistant") {
			const text = chatContentText(msg.content, "");
			if (text) {
				input.push({
					role: "assistant",
					content: [{ type: "output_text", text }],
				});
			}
			const toolCalls = msg.tool_calls as
				| Array<Record<string, unknown>>
				| undefined;
			if (Array.isArray(toolCalls)) {
				for (const tc of toolCalls) {
					const fn = tc.function as Record<string, unknown> | undefined;
					input.push({
						type: "function_call",
						call_id: (tc.id as string) ?? `call_${crypto.randomUUID()}`,
						name: (fn?.name as string) ?? "",
						arguments: (fn?.arguments as string) ?? "",
					});
				}
			}
			continue;
		}

		// user (and any other role) becomes user input items
		if (typeof msg.content === "string") {
			input.push({
				role: "user",
				content: [{ type: "input_text", text: msg.content }],
			});
		} else if (Array.isArray(msg.content)) {
			const parts: Array<Record<string, unknown>> = [];
			for (const part of msg.content as Array<Record<string, unknown>>) {
				if (part?.type === "text") {
					parts.push({
						type: "input_text",
						text: (part.text as string) ?? "",
					});
				} else if (part?.type === "image_url") {
					// chat image_url is {url, detail?} (or a plain string);
					// Responses expects a string url
					const imageUrl = part.image_url;
					const url =
						typeof imageUrl === "string"
							? imageUrl
							: ((imageUrl as Record<string, unknown> | undefined)?.url as
									| string
									| undefined);
					if (url) {
						const imagePart: Record<string, unknown> = {
							type: "input_image",
							image_url: url,
						};
						const detail =
							typeof imageUrl === "object" && imageUrl !== null
								? (imageUrl as Record<string, unknown>).detail
								: undefined;
						if (detail !== undefined) {
							imagePart.detail = detail;
						}
						parts.push(imagePart);
					}
				}
				// audio and other part types are dropped
			}
			if (parts.length > 0) {
				input.push({ role: "user", content: parts });
			}
		}
	}

	if (systemParts.length > 0) {
		result.instructions = systemParts.join("\n\n");
	}
	result.input = input;
	return result;
}

/**
 * Converts an OpenAI Responses API response body to an OpenAI chat completion
 * response body.
 */
export function responsesToChatResponse(
	data: ResponsesResponseBody,
): Record<string, unknown> {
	const output = data.output ?? [];
	const textParts: string[] = [];
	let refusal: string | undefined;
	const toolCalls: Array<Record<string, unknown>> = [];

	for (const item of output) {
		if (item?.type === "message" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (part?.type === "output_text" && typeof part.text === "string") {
					textParts.push(part.text);
				} else if (
					part?.type === "refusal" &&
					typeof part.refusal === "string" &&
					part.refusal
				) {
					refusal = part.refusal;
				}
			}
		} else if (item?.type === "function_call") {
			toolCalls.push({
				id: item.call_id ?? item.id ?? `call_${crypto.randomUUID()}`,
				type: "function",
				function: {
					name: item.name ?? "",
					arguments: item.arguments ?? "",
				},
			});
		}
		// reasoning / web_search_call and other output types are ignored
	}

	const message: Record<string, unknown> = {
		role: "assistant",
		content: textParts.join("") || null,
	};
	if (refusal !== undefined) {
		message.refusal = refusal;
	}
	if (toolCalls.length > 0) {
		message.tool_calls = toolCalls;
	}

	const result: Record<string, unknown> = {
		id: data.id ?? `chatcmpl-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: data.created_at ?? Math.floor(Date.now() / 1000),
		model: data.model,
		choices: [
			{
				index: 0,
				message,
				finish_reason: responsesFinishReason(data),
			},
		],
	};
	const usage = responsesUsageToChat(data.usage);
	if (usage) {
		result.usage = usage;
	}
	return result;
}

/**
 * Creates a TransformStream that converts OpenAI Responses API SSE events to
 * OpenAI chat completion SSE chunks.
 */
export function createResponsesToChatStreamTransform(): TransformStream<
	Uint8Array,
	Uint8Array
> {
	let buffer = "";
	let messageId = "";
	let model = "";
	let sentFirstChunk = false;
	let finished = false;
	let doneSent = false;
	let nextToolIndex = 0;
	const toolIndexByItem = new Map<string, number>();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	const baseChunk = () => ({
		id: messageId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
	});

	const emitFirstChunk = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		if (sentFirstChunk) {
			return;
		}
		sentFirstChunk = true;
		if (!messageId) {
			messageId = crypto.randomUUID();
		}
		controller.enqueue(
			encoder.encode(
				`data: ${JSON.stringify({
					...baseChunk(),
					choices: [
						{ index: 0, delta: { role: "assistant" }, finish_reason: null },
					],
				})}\n\n`,
			),
		);
	};

	const emitTerminalChunk = (
		controller: TransformStreamDefaultController<Uint8Array>,
		resp: ResponsesResponseBody,
	): void => {
		if (finished) {
			return;
		}
		finished = true;
		const chunk: Record<string, unknown> = {
			...baseChunk(),
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: responsesFinishReason(resp),
				},
			],
		};
		const usage = responsesUsageToChat(resp.usage);
		if (usage) {
			chunk.usage = usage;
		}
		controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
	};

	const emitDone = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		if (doneSent) {
			return;
		}
		doneSent = true;
		controller.enqueue(encoder.encode("data: [DONE]\n\n"));
	};

	const handleEvent = (
		data: Record<string, unknown>,
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		const resp = (
			data.response && typeof data.response === "object" ? data.response : {}
		) as ResponsesResponseBody;

		switch (data.type) {
			case "response.created": {
				if (resp.id) {
					messageId = resp.id;
				}
				if (resp.model) {
					model = resp.model;
				}
				emitFirstChunk(controller);
				break;
			}
			case "response.output_item.added": {
				const item = data.item as ResponsesOutputItem | undefined;
				if (item?.type === "function_call") {
					emitFirstChunk(controller);
					const toolIndex = nextToolIndex++;
					if (item.id) {
						toolIndexByItem.set(item.id, toolIndex);
					}
					if (item.call_id) {
						toolIndexByItem.set(item.call_id, toolIndex);
					}
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								...baseChunk(),
								choices: [
									{
										index: 0,
										delta: {
											tool_calls: [
												{
													index: toolIndex,
													id: item.call_id ?? item.id,
													type: "function",
													function: {
														name: item.name ?? "",
														arguments: "",
													},
												},
											],
										},
										finish_reason: null,
									},
								],
							})}\n\n`,
						),
					);
				}
				break;
			}
			case "response.output_text.delta": {
				emitFirstChunk(controller);
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							...baseChunk(),
							choices: [
								{
									index: 0,
									delta: {
										content: typeof data.delta === "string" ? data.delta : "",
									},
									finish_reason: null,
								},
							],
						})}\n\n`,
					),
				);
				break;
			}
			case "response.function_call_arguments.delta": {
				const itemKey = typeof data.item_id === "string" ? data.item_id : "";
				const toolIndex = itemKey ? toolIndexByItem.get(itemKey) : undefined;
				if (toolIndex !== undefined) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								...baseChunk(),
								choices: [
									{
										index: 0,
										delta: {
											tool_calls: [
												{
													index: toolIndex,
													function: {
														arguments:
															typeof data.delta === "string" ? data.delta : "",
													},
												},
											],
										},
										finish_reason: null,
									},
								],
							})}\n\n`,
						),
					);
				}
				break;
			}
			case "response.completed":
			case "response.incomplete":
			case "response.failed": {
				if (resp.id && !messageId) {
					messageId = resp.id;
				}
				if (resp.model && !model) {
					model = resp.model;
				}
				emitFirstChunk(controller);
				emitTerminalChunk(controller, resp);
				emitDone(controller);
				break;
			}
			default:
				// message / reasoning / content_part events and unknown types
				// are swallowed
				break;
		}
	};

	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let newlineIndex = buffer.indexOf("\n");

			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);

				if (!line.startsWith("data:")) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}

				const payload = line.slice(5).trim();
				if (payload && payload !== "[DONE]") {
					try {
						const data = JSON.parse(payload) as Record<string, unknown>;
						if (data && typeof data === "object") {
							handleEvent(data, controller);
						}
					} catch {
						// Skip invalid JSON
					}
				}

				newlineIndex = buffer.indexOf("\n");
			}
		},
		flush(controller) {
			emitDone(controller);
		},
	});
}

// --- Responses inbound (responses → chat) converters ---

type ChatContentPart = { type: string; text?: string; [k: string]: unknown };

// One Responses-side output item being assembled from chat stream deltas.
// `text` accumulates either the message text or the function arguments.
type ResponsesStreamItem = {
	kind: "message" | "reasoning" | "function_call";
	outputIndex: number;
	itemId: string;
	callId?: string;
	name?: string;
	text: string;
};

/**
 * Derives a Responses-style id from a chat completion id, preserving the
 * upstream suffix so repeated conversions stay deterministic.
 */
function toResponsesId(chatId: unknown, prefix: string): string {
	const stripped =
		typeof chatId === "string" ? chatId.replace(/^chatcmpl-/, "") : "";
	return `${prefix}_${stripped || crypto.randomUUID()}`;
}

/**
 * Converts chat completions usage into Responses usage semantics (inverse of
 * responsesUsageToChat). Missing counters degrade to zero — never fabricated.
 */
function chatUsageToResponses(
	usage: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const inputTokens = (usage?.prompt_tokens as number) ?? 0;
	const outputTokens = (usage?.completion_tokens as number) ?? 0;
	const result: Record<string, unknown> = {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: (usage?.total_tokens as number) ?? inputTokens + outputTokens,
	};
	const cachedTokens = (
		usage?.prompt_tokens_details as Record<string, unknown> | undefined
	)?.cached_tokens;
	if (typeof cachedTokens === "number") {
		result.input_tokens_details = { cached_tokens: cachedTokens };
	}
	const reasoningTokens = (
		usage?.completion_tokens_details as Record<string, unknown> | undefined
	)?.reasoning_tokens;
	if (typeof reasoningTokens === "number") {
		result.output_tokens_details = { reasoning_tokens: reasoningTokens };
	}
	return result;
}

/**
 * Converts a Responses message content (string or part array) into chat-style
 * content parts: input_text/output_text → text, input_image → image_url
 * (http and data URLs pass through untouched). Everything else is dropped
 * with a warning (fail-open, spec §3.4).
 */
function convertResponsesContentParts(content: unknown): ChatContentPart[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	const parts: ChatContentPart[] = [];
	if (!Array.isArray(content)) {
		return parts;
	}
	for (const part of content) {
		const p = part as Record<string, unknown>;
		if (p?.type === "input_text" || p?.type === "output_text") {
			parts.push({
				type: "text",
				text: typeof p.text === "string" ? p.text : "",
			});
			continue;
		}
		if (p?.type === "input_image") {
			if (typeof p.image_url === "string" && p.image_url) {
				parts.push({ type: "image_url", image_url: { url: p.image_url } });
				continue;
			}
			console.warn("[format-converter] dropped unusable input_image part", {
				reason: "missing_url",
			});
			continue;
		}
		console.warn(
			"[format-converter] dropped unsupported message content part",
			{
				partType: String(p?.type ?? "unknown"),
			},
		);
	}
	return parts;
}

/** Joins a Responses message content into plain text (system/assistant side). */
function responsesMessageContentText(content: unknown): string {
	return convertResponsesContentParts(content)
		.filter((p) => p.type === "text")
		.map((p) => (typeof p.text === "string" ? p.text : ""))
		.join("");
}

/** Chat-side user content: plain string when text-only, parts otherwise. */
function convertResponsesUserContent(
	content: unknown,
): string | ChatContentPart[] {
	const parts = convertResponsesContentParts(content);
	if (parts.every((p) => p.type === "text")) {
		return parts
			.map((p) => (typeof p.text === "string" ? p.text : ""))
			.join("");
	}
	return parts;
}

/**
 * Converts one Responses `input` array item into chat messages. Items with a
 * `role` but no `type` (SDK EasyInputMessage shape) count as messages;
 * system/developer texts are hoisted into systemParts (mirroring
 * openaiToAnthropicRequest); unknown item types are dropped with a warning.
 */
function convertResponsesInputItem(
	item: Record<string, unknown>,
	systemParts: string[],
	rawMessages: OpenAIMessage[],
): void {
	if (!item || typeof item !== "object") {
		return;
	}
	const itemType =
		(item.type as string | undefined) ??
		(item.role !== undefined ? "message" : undefined);

	if (itemType === "message") {
		const role = typeof item.role === "string" ? item.role : "user";
		if (role === "system" || role === "developer") {
			const text = responsesMessageContentText(item.content);
			if (text) {
				systemParts.push(text);
			}
			return;
		}
		if (role === "assistant") {
			rawMessages.push({
				role: "assistant",
				content: responsesMessageContentText(item.content),
			});
			return;
		}
		rawMessages.push({
			role: "user",
			content: convertResponsesUserContent(item.content),
		});
		return;
	}

	if (itemType === "function_call") {
		rawMessages.push({
			role: "assistant",
			content: "",
			tool_calls: [
				{
					id:
						(item.call_id as string) ??
						(item.id as string) ??
						`call_${crypto.randomUUID()}`,
					type: "function",
					function: {
						name: (item.name as string) ?? "",
						// Responses arguments are already a JSON string
						arguments:
							typeof item.arguments === "string"
								? item.arguments
								: JSON.stringify(item.arguments ?? {}),
					},
				},
			],
		});
		return;
	}

	if (itemType === "function_call_output") {
		rawMessages.push({
			role: "tool",
			tool_call_id: (item.call_id as string) ?? "",
			content:
				typeof item.output === "string"
					? item.output
					: JSON.stringify(item.output ?? ""),
		});
		return;
	}

	console.warn("[format-converter] dropped unsupported input item", {
		itemType: String(item.type ?? "unknown"),
	});
}

function toChatContentParts(
	content: OpenAIMessage["content"],
): ChatContentPart[] {
	if (typeof content === "string") {
		return content ? [{ type: "text", text: content }] : [];
	}
	return Array.isArray(content) ? (content as ChatContentPart[]) : [];
}

/**
 * Merges consecutive same-role chat messages (mirrors openaiToAnthropicRequest)
 * so parallel Responses function_call items collapse into one assistant
 * message carrying multiple tool_calls. role:"tool" never merges — each tool
 * message must pair with exactly one tool_call_id.
 */
function mergeConsecutiveMessages(
	rawMessages: OpenAIMessage[],
): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [];
	for (const msg of rawMessages) {
		const last = messages[messages.length - 1];
		if (!last || last.role !== msg.role || msg.role === "tool") {
			messages.push({ ...msg });
			continue;
		}
		if (msg.role === "assistant") {
			const textParts = [
				typeof last.content === "string"
					? last.content
					: chatContentText(last.content, ""),
				typeof msg.content === "string"
					? msg.content
					: chatContentText(msg.content, ""),
			].filter((t) => t.length > 0);
			last.content = textParts.join("\n\n");
			const toolCalls = [
				...((last.tool_calls as ChatContentPart[] | undefined) ?? []),
				...((msg.tool_calls as ChatContentPart[] | undefined) ?? []),
			];
			if (toolCalls.length > 0) {
				last.tool_calls = toolCalls;
			}
			continue;
		}
		// system / user: concatenate as content parts, collapsing back to a
		// plain string when the result is text-only
		const parts = [
			...toChatContentParts(last.content),
			...toChatContentParts(msg.content),
		];
		last.content = parts.every((p) => p.type === "text")
			? parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("")
			: parts;
	}
	return messages;
}

/**
 * Converts an OpenAI Responses API request body into a chat completions
 * request body (responses inbound + openai target upstream). Whitelist
 * conversion: unknown input items and fields are dropped with a warning
 * (spec §3.4); stateful fields have no chat carrier and are reported once in
 * aggregate; client-side stream_options is not forwarded.
 */
export function responsesToOpenaiRequest(
	body: ResponsesRequest,
): OpenAIChatRequest {
	const result: OpenAIChatRequest = {};
	if (body.model) {
		result.model = body.model;
	}
	if (body.stream !== undefined) {
		result.stream = body.stream;
	}
	if (body.temperature !== undefined) {
		result.temperature = body.temperature;
	}
	if (body.top_p !== undefined) {
		result.top_p = body.top_p;
	}
	if (body.parallel_tool_calls !== undefined) {
		result.parallel_tool_calls = body.parallel_tool_calls as boolean;
	}
	if (body.user !== undefined) {
		result.user = body.user as string;
	}
	if (body.max_output_tokens !== undefined) {
		result.max_tokens = body.max_output_tokens;
	}

	// reasoning.effort carries over; summary etc. have no chat equivalent
	const reasoning = body.reasoning as Record<string, unknown> | undefined;
	if (reasoning && typeof reasoning === "object") {
		if (typeof reasoning.effort === "string") {
			result.reasoning_effort = reasoning.effort;
		}
		const dropped = Object.keys(reasoning).filter((key) => key !== "effort");
		if (dropped.length > 0) {
			console.warn("[format-converter] dropped unsupported reasoning fields", {
				fields: dropped,
			});
		}
	}

	// Flat Responses function tools → nested chat tools; other tool types dropped
	if (Array.isArray(body.tools)) {
		const tools: Array<Record<string, unknown>> = [];
		for (const tool of body.tools) {
			if (tool?.type !== "function") {
				console.warn("[format-converter] dropped unsupported tool", {
					toolType: String(tool?.type ?? "unknown"),
				});
				continue;
			}
			tools.push({
				type: "function",
				function: {
					name: tool.name as string,
					description: (tool.description as string) ?? "",
					parameters: (tool.parameters as Record<string, unknown>) ?? {
						type: "object",
					},
				},
			});
		}
		if (tools.length > 0) {
			result.tools = tools;
		}
	}

	// tool_choice: strings pass through; {type:"function", name} nests
	if (typeof body.tool_choice === "string") {
		result.tool_choice = body.tool_choice;
	} else if (body.tool_choice && typeof body.tool_choice === "object") {
		const tc = body.tool_choice as Record<string, unknown>;
		if (tc.type === "function" && typeof tc.name === "string") {
			result.tool_choice = { type: "function", function: { name: tc.name } };
		} else {
			console.warn("[format-converter] dropped unsupported tool_choice", {
				toolChoiceType: String(tc.type ?? "unknown"),
			});
		}
	}

	// text.format → response_format (exact inverse of the response_format →
	// text.format branch in openaiToResponsesRequest: same defaults and the
	// same conditional strict field)
	const format = body.text?.format;
	if (format && typeof format === "object") {
		if (format.type === "json_object") {
			result.response_format = { type: "json_object" };
		} else if (format.type === "json_schema") {
			const jsonSchema: Record<string, unknown> = {
				name: (format.name as string) ?? "response",
				schema: (format.schema as Record<string, unknown>) ?? {},
			};
			if (format.strict !== undefined) {
				jsonSchema.strict = format.strict;
			}
			result.response_format = {
				type: "json_schema",
				json_schema: jsonSchema,
			};
		} else if (format.type !== "text" && format.type !== undefined) {
			console.warn("[format-converter] dropped unsupported text format", {
				formatType: String(format.type),
			});
		}
	}

	// Stateful fields have no chat equivalent — one aggregate warning instead
	// of one per field (same state semantics as the chat→responses direction)
	const statefulFields = [
		"store",
		"previous_response_id",
		"conversation",
		"background",
	].filter((field) => body[field] !== undefined);
	if (statefulFields.length > 0) {
		console.warn(
			"[format-converter] dropped stateful responses fields (chat upstream is stateless)",
			{ fields: statefulFields },
		);
	}

	const systemParts: string[] = [];
	const rawMessages: OpenAIMessage[] = [];

	if (typeof body.instructions === "string" && body.instructions) {
		systemParts.push(body.instructions);
	}

	const rawInput = body.input as
		| string
		| Array<Record<string, unknown>>
		| undefined;
	if (typeof rawInput === "string") {
		rawMessages.push({ role: "user", content: rawInput });
	} else if (Array.isArray(rawInput)) {
		for (const item of rawInput) {
			convertResponsesInputItem(item, systemParts, rawMessages);
		}
	}

	if (systemParts.length > 0) {
		rawMessages.unshift({ role: "system", content: systemParts.join("\n\n") });
	}

	result.messages = mergeConsecutiveMessages(rawMessages);
	return result;
}

/**
 * Converts an OpenAI chat completion response body into a Responses API
 * response body (responses inbound + openai target, non-streaming). Shape is
 * the inverse of responsesToChatResponse and its fixtures.
 */
export function openaiToResponsesResponse(
	data: Record<string, unknown>,
): ResponsesResponseBody {
	const choices = data.choices as Array<Record<string, unknown>> | undefined;
	const firstChoice = choices?.[0];
	const message = firstChoice?.message as Record<string, unknown> | undefined;
	const finishReason = firstChoice?.finish_reason as string | null | undefined;

	const contentParts: Array<Record<string, unknown>> = [];
	const contentText = (message?.content as string) ?? "";
	if (contentText) {
		contentParts.push({
			type: "output_text",
			text: contentText,
			annotations: [],
		});
	}
	const refusal = message?.refusal;
	if (typeof refusal === "string" && refusal) {
		contentParts.push({ type: "refusal", refusal });
	}

	const output: ResponsesOutputItem[] = [];
	if (contentParts.length > 0) {
		output.push({
			type: "message",
			id: `msg_${crypto.randomUUID()}`,
			role: "assistant",
			status: "completed",
			content: contentParts,
		});
	}
	const toolCalls = message?.tool_calls as
		| Array<Record<string, unknown>>
		| undefined;
	if (Array.isArray(toolCalls)) {
		for (const tc of toolCalls) {
			const fn = tc.function as Record<string, unknown> | undefined;
			output.push({
				type: "function_call",
				id: `fc_${crypto.randomUUID()}`,
				call_id: (tc.id as string) ?? `call_${crypto.randomUUID()}`,
				name: (fn?.name as string) ?? "",
				arguments: (fn?.arguments as string) ?? "",
				status: "completed",
			});
		}
	}

	// finish → status semantics mirror responsesFinishReason in reverse:
	// only the max_tokens case has a Responses-side incomplete representation
	const stopReason = mapFinishReason(finishReason);
	const incomplete = stopReason === "max_tokens";

	const usage = data.usage as Record<string, unknown> | undefined;
	const result: ResponsesResponseBody = {
		id: toResponsesId(data.id, "resp"),
		object: "response",
		created_at: (data.created as number) ?? Math.floor(Date.now() / 1000),
		status: incomplete ? "incomplete" : "completed",
		model: data.model as string,
		output,
		incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
	};
	if (usage && typeof usage === "object") {
		result.usage = chatUsageToResponses(usage);
	}
	return result;
}

/**
 * Creates a TransformStream that converts OpenAI chat completion SSE chunks
 * into Responses API SSE events (responses inbound + openai target, streaming).
 *
 * - `data: [DONE]` is consumed as the end signal and never forwarded
 *   (Responses SSE terminates via response.completed).
 * - usage is emitted only on response.completed, with all three counters
 *   present (zeros when the upstream sent none — spec §3.1 last-wins).
 * - delta.reasoning_content surfaces as response.reasoning_summary_text.delta
 *   inside a reasoning output item.
 * - An in-stream upstream error payload emits response.failed and swallows
 *   the rest (spec §3.5 philosophy: explicit termination beats hanging).
 */
export function createOpenaiToResponsesStreamTransform(): TransformStream<
	Uint8Array,
	Uint8Array
> {
	let buffer = "";
	let sequenceNumber = 0;
	let responseId = "";
	let model = "";
	const createdAt = Math.floor(Date.now() / 1000);
	let sentCreated = false;
	let finished = false;
	let finishReason: string | null = null;
	let usage: Record<string, unknown> | undefined;
	const items: ResponsesStreamItem[] = [];
	const itemByChatToolIndex = new Map<number, ResponsesStreamItem>();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	const emit = (
		controller: TransformStreamDefaultController<Uint8Array>,
		event: Record<string, unknown>,
	): void => {
		event.sequence_number = sequenceNumber++;
		controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
	};

	const ensureCreated = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		if (sentCreated) {
			return;
		}
		sentCreated = true;
		if (!responseId) {
			responseId = `resp_${crypto.randomUUID()}`;
		}
		emit(controller, {
			type: "response.created",
			response: {
				id: responseId,
				object: "response",
				created_at: createdAt,
				model,
				status: "in_progress",
				output: [],
			},
		});
	};

	const itemAddedEnvelope = (
		item: ResponsesStreamItem,
	): Record<string, unknown> => {
		if (item.kind === "message") {
			return {
				type: "message",
				id: item.itemId,
				status: "in_progress",
				role: "assistant",
				content: [],
			};
		}
		if (item.kind === "reasoning") {
			return { type: "reasoning", id: item.itemId, summary: [] };
		}
		return {
			type: "function_call",
			id: item.itemId,
			call_id: item.callId,
			name: item.name ?? "",
			arguments: "",
			status: "in_progress",
		};
	};

	const itemDoneEnvelope = (
		item: ResponsesStreamItem,
	): Record<string, unknown> => {
		if (item.kind === "message") {
			return {
				type: "message",
				id: item.itemId,
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: item.text, annotations: [] }],
			};
		}
		if (item.kind === "reasoning") {
			return {
				type: "reasoning",
				id: item.itemId,
				summary: item.text ? [{ type: "summary_text", text: item.text }] : [],
			};
		}
		return {
			type: "function_call",
			id: item.itemId,
			call_id: item.callId,
			name: item.name ?? "",
			arguments: item.text,
			status: "completed",
		};
	};

	const addItem = (
		controller: TransformStreamDefaultController<Uint8Array>,
		item: ResponsesStreamItem,
	): void => {
		item.outputIndex = items.length;
		items.push(item);
		emit(controller, {
			type: "response.output_item.added",
			output_index: item.outputIndex,
			item: itemAddedEnvelope(item),
		});
	};

	const emitTerminal = (
		controller: TransformStreamDefaultController<Uint8Array>,
		failed: { code: unknown; message: unknown } | null,
	): void => {
		if (finished) {
			return;
		}
		finished = true;
		ensureCreated(controller);
		for (const item of items) {
			emit(controller, {
				type: "response.output_item.done",
				output_index: item.outputIndex,
				item: itemDoneEnvelope(item),
			});
		}
		if (failed) {
			console.warn("[format-converter] upstream stream error", {
				error_type: typeof failed.code === "string" ? failed.code : "unknown",
				error_message: typeof failed.message === "string" ? failed.message : "",
			});
			emit(controller, {
				type: "response.failed",
				response: {
					id: responseId,
					object: "response",
					created_at: createdAt,
					model,
					status: "failed",
					error: {
						code: failed.code ?? "upstream_error",
						message: failed.message ?? "upstream stream error",
					},
					output: items.map(itemDoneEnvelope),
					usage: chatUsageToResponses(usage),
				},
			});
			return;
		}
		// mapFinishReason inverse of responsesFinishReason: only the max_tokens
		// case has a Responses-side incomplete representation
		const stopReason = mapFinishReason(finishReason);
		const incomplete = stopReason === "max_tokens";
		emit(controller, {
			type: "response.completed",
			response: {
				id: responseId,
				object: "response",
				created_at: createdAt,
				model,
				status: incomplete ? "incomplete" : "completed",
				incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
				output: items.map(itemDoneEnvelope),
				usage: chatUsageToResponses(usage),
			},
		});
	};

	const ensureMessageItem = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): ResponsesStreamItem => {
		const existing = items.find((item) => item.kind === "message");
		if (existing) {
			return existing;
		}
		const item: ResponsesStreamItem = {
			kind: "message",
			outputIndex: -1,
			itemId: `msg_${crypto.randomUUID()}`,
			text: "",
		};
		addItem(controller, item);
		return item;
	};

	const ensureReasoningItem = (
		controller: TransformStreamDefaultController<Uint8Array>,
	): ResponsesStreamItem => {
		const existing = items.find((item) => item.kind === "reasoning");
		if (existing) {
			return existing;
		}
		const item: ResponsesStreamItem = {
			kind: "reasoning",
			outputIndex: -1,
			itemId: `rs_${crypto.randomUUID()}`,
			text: "",
		};
		addItem(controller, item);
		return item;
	};

	const handleChunk = (
		data: Record<string, unknown>,
		controller: TransformStreamDefaultController<Uint8Array>,
	): void => {
		// In-stream upstream error payload → response.failed, then swallow the rest
		if (data.error && typeof data.error === "object") {
			const err = data.error as Record<string, unknown>;
			emitTerminal(controller, { code: err.code, message: err.message });
			return;
		}
		if (finished) {
			return;
		}
		if (!responseId && typeof data.id === "string" && data.id) {
			responseId = toResponsesId(data.id, "resp");
		}
		if (!model && typeof data.model === "string") {
			model = data.model;
		}

		const choices = data.choices as Array<Record<string, unknown>> | undefined;
		const firstChoice = choices?.[0];
		const delta = firstChoice?.delta as Record<string, unknown> | undefined;
		const chunkFinish = firstChoice?.finish_reason;
		if (typeof chunkFinish === "string" && chunkFinish) {
			finishReason = chunkFinish;
		}
		const chunkUsage = data.usage as Record<string, unknown> | undefined;
		if (chunkUsage && typeof chunkUsage === "object") {
			usage = chunkUsage;
		}

		ensureCreated(controller);

		if (!delta) {
			// usage-only terminal chunk (choices: []) or otherwise empty
			return;
		}

		// reasoning increments surface as reasoning summary text deltas
		const reasoningDelta = delta.reasoning_content;
		if (typeof reasoningDelta === "string" && reasoningDelta) {
			const item = ensureReasoningItem(controller);
			item.text += reasoningDelta;
			emit(controller, {
				type: "response.reasoning_summary_text.delta",
				item_id: item.itemId,
				output_index: item.outputIndex,
				summary_index: 0,
				delta: reasoningDelta,
			});
		}

		const contentDelta = delta.content;
		if (typeof contentDelta === "string" && contentDelta) {
			const item = ensureMessageItem(controller);
			item.text += contentDelta;
			emit(controller, {
				type: "response.output_text.delta",
				item_id: item.itemId,
				output_index: item.outputIndex,
				content_index: 0,
				delta: contentDelta,
			});
		}

		// tool_calls increments (index-keyed) aggregate into distinct
		// function_call items
		const toolCalls = delta.tool_calls as
			| Array<Record<string, unknown>>
			| undefined;
		if (Array.isArray(toolCalls)) {
			for (const tc of toolCalls) {
				const chatIndex = (tc.index as number) ?? 0;
				const fn = tc.function as Record<string, unknown> | undefined;
				let item = itemByChatToolIndex.get(chatIndex);
				if (!item && tc.id && fn?.name != null) {
					item = {
						kind: "function_call",
						outputIndex: -1,
						itemId: `fc_${crypto.randomUUID()}`,
						callId: (tc.id as string) ?? `call_${crypto.randomUUID()}`,
						name: (fn.name as string) ?? "",
						text: "",
					};
					itemByChatToolIndex.set(chatIndex, item);
					addItem(controller, item);
				}
				if (!item) {
					continue;
				}
				const argsDelta = fn?.arguments;
				if (typeof argsDelta === "string" && argsDelta) {
					item.text += argsDelta;
					emit(controller, {
						type: "response.function_call_arguments.delta",
						item_id: item.itemId,
						output_index: item.outputIndex,
						delta: argsDelta,
					});
				}
			}
		}
	};

	return new TransformStream({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			let newlineIndex = buffer.indexOf("\n");

			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);

				if (!line.startsWith("data:")) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}

				const payload = line.slice(5).trim();
				if (!payload) {
					newlineIndex = buffer.indexOf("\n");
					continue;
				}
				if (payload === "[DONE]") {
					// End signal only — Responses SSE terminates via response.completed
					emitTerminal(controller, null);
					newlineIndex = buffer.indexOf("\n");
					continue;
				}

				try {
					const data = JSON.parse(payload) as Record<string, unknown>;
					if (data && typeof data === "object") {
						handleChunk(data, controller);
					}
				} catch {
					// Skip invalid JSON
				}

				newlineIndex = buffer.indexOf("\n");
			}
		},
		flush(controller) {
			// Upstream ended without [DONE]: terminate explicitly rather than
			// leaving the client hanging (spec §3.5 philosophy)
			emitTerminal(controller, null);
		},
	});
}

// --- Pivot: responses ↔ anthropic composed via the chat hub (2026-10-27) ---
//
// The two diagonal edges of the routing matrix are NOT new single-hop
// converters — each is a pure composition of the existing eight primitives
// above (design.md §1: zero new conversion logic). The intermediate chat
// shape is the contract both sides already honor (spec §3.1 single terminal
// usage chunk, §3.5 [DONE] exactly once, §3.6 [DONE] consumed as a bare end
// signal), which is what makes the two-hop composition lossless at the seam.
//
// Known lossy surfaces (declared, all inherited from the legs — never new):
// - anthropic cache_creation folds into the chat prompt total and is not
//   separately recoverable (responses clients see it only inside
//   input_tokens; usage_logs.cache_creation_tokens stays NULL on this path).
// - thinking signatures / redacted_thinking never round-trip (existing
//   chat↔anthropic limitation).
// - responses stateful fields (store / previous_response_id / …) are dropped
//   by responsesToOpenaiRequest as before.
// - chat→anthropic cannot split cache_read/creation back out of a chat total
//   (existing convention: "cannot split exactly, don't").

/**
 * Converts an OpenAI Responses API request body into an Anthropic Messages
 * request body (responses inbound + anthropic target, the pivot request leg):
 * `responsesToOpenaiRequest` → `openaiToAnthropicRequest`, so
 * `reasoning.effort` rides through as `reasoning_effort` and lands as a
 * thinking budget.
 */
export function responsesToAnthropicRequest(
	body: ResponsesRequest,
): AnthropicRequest {
	return openaiToAnthropicRequest(responsesToOpenaiRequest(body));
}

/**
 * Converts an Anthropic Messages request body into an OpenAI Responses API
 * request body (anthropic inbound + responses target, the pivot request leg):
 * `anthropicToOpenaiRequest` → `openaiToResponsesRequest`.
 */
export function anthropicToResponsesRequest(
	body: AnthropicRequest,
): ResponsesRequest {
	return openaiToResponsesRequest(anthropicToOpenaiRequest(body));
}

/**
 * Converts an Anthropic Messages API response body into an OpenAI Responses
 * API response body (responses inbound + anthropic target, non-streaming):
 * `anthropicToOpenaiResponse` → `openaiToResponsesResponse`. Cache_read
 * survives via prompt_tokens_details → input_tokens_details; cache_creation
 * stays folded into the totals (declared loss above).
 */
export function anthropicToResponsesResponse(
	anthropicBody: Record<string, unknown>,
): ResponsesResponseBody {
	return openaiToResponsesResponse(anthropicToOpenaiResponse(anthropicBody));
}

/**
 * Converts an OpenAI Responses API response body into an Anthropic Messages
 * API response body (anthropic inbound + responses target, non-streaming):
 * `responsesToChatResponse` → `openaiToAnthropicResponse`. Usage degrades to
 * {input_tokens, output_tokens} totals — cache details have no exact
 * chat→anthropic split (existing convention, no new accounting).
 */
export function responsesToAnthropicResponse(
	responsesBody: ResponsesResponseBody,
): Record<string, unknown> {
	return openaiToAnthropicResponse(responsesToChatResponse(responsesBody));
}

// Developer 角色透传归一化（settings 开关 normalize_developer_role）：
// 与 openaiToAnthropicRequest / convertResponsesInputItem 的既有 developer
// 处理语义刻意不同——那两处是「hoist + 拼接 + 消息消失」（为单 system 字段
// 协议设计：Anthropic 顶层 system / Responses instructions），多模态 part
// 会被压成纯文本、消息移出原位、多条合并。透传归一化是「原位改名」：
// 保序、保内容（含多模态 part 与空内容）、不移动位置、不合并——openai
// chat 协议允许多条 system，改名是最小侵入且对上游无损的兼容手段。
// 两者在各自的合法消费场景互不可替代，不复用。

/**
 * Chat completions 体：`messages` 数组中 `role === "developer"` 的消息原位
 * 改名为 `"system"`。内容零接触（不碰 content / 多模态 part，空内容保留），
 * 位置不动，不合并相邻 system，不触碰 `tool` 等其他角色；messages 缺失或
 * 非数组时 no-op。直接 mutate 传入对象（调用方总在 per-call 副本上操作，
 * 见 proxy.ts buildChannelRequest 的 bodyCopy 模式）。
 * 返回是否发生了修改——false 时调用方应回退字节级透传（不重序列化）。
 */
export function normalizeChatDeveloperRole(
	body: Record<string, unknown>,
): boolean {
	const messages = body.messages;
	if (!Array.isArray(messages)) {
		return false;
	}
	let changed = false;
	for (const msg of messages) {
		if (
			msg &&
			typeof msg === "object" &&
			(msg as Record<string, unknown>).role === "developer"
		) {
			(msg as Record<string, unknown>).role = "system";
			changed = true;
		}
	}
	return changed;
}

/**
 * Responses 体：`input` 数组中 `type === "message" && role === "developer"`
 * 的 item 原位改名为 `"system"`。`function_call` / `function_call_output` /
 * `reasoning` 等非 message item 不命中；input 缺失或非数组时原样 no-op
 * （不崩溃）。mutate 语义与返回值约定同 normalizeChatDeveloperRole。
 */
export function normalizeResponsesDeveloperRole(
	body: Record<string, unknown>,
): boolean {
	const input = body.input;
	if (!Array.isArray(input)) {
		return false;
	}
	let changed = false;
	for (const item of input) {
		if (
			item &&
			typeof item === "object" &&
			(item as Record<string, unknown>).type === "message" &&
			(item as Record<string, unknown>).role === "developer"
		) {
			(item as Record<string, unknown>).role = "system";
			changed = true;
		}
	}
	return changed;
}
