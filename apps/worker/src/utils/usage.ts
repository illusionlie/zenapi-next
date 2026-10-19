import { safeJsonParse } from "./json";

export type NormalizedUsage = {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	cachedInputTokens: number | null;
	cacheCreationTokens: number | null;
};

export type StreamUsage = {
	usage: NormalizedUsage | null;
	firstTokenLatencyMs: number | null;
};

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function pickNumber(...values: Array<unknown>): number | null {
	for (const value of values) {
		const parsed = toNumber(value);
		if (parsed !== null) {
			return parsed;
		}
	}
	return null;
}

function readNestedNumber(
	data: Record<string, unknown>,
	key: string,
	field: string,
): number | null {
	const nested = data[key];
	if (!nested || typeof nested !== "object") {
		return null;
	}
	return toNumber((nested as Record<string, unknown>)[field]);
}

export function normalizeUsage(raw: unknown): NormalizedUsage | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const data = raw as Record<string, unknown>;
	const promptTokens = pickNumber(
		data.prompt_tokens,
		data.promptTokens,
		data.input_tokens,
		data.inputTokens,
	);
	const completionTokens = pickNumber(
		data.completion_tokens,
		data.completionTokens,
		data.output_tokens,
		data.outputTokens,
	);
	// prompt_tokens 口径全路径统一为「含缓存的总输入」：仅当 prompt 取自
	// input_tokens/inputTokens 别名（纯 Anthropic 形态，input_tokens 不含缓存）
	// 且存在 cache_read/creation 时折算 input + cache_read + cache_creation；
	// prompt_tokens/promptTokens 别名（OpenAI 形态 / 协议转换产物）原生已含，
	// 不得二次叠加。
	const promptFromInputAlias =
		promptTokens !== null &&
		pickNumber(data.prompt_tokens, data.promptTokens) === null;
	const cacheReadTokens = pickNumber(data.cache_read_input_tokens);
	const cacheCreationTokens = pickNumber(data.cache_creation_input_tokens);
	const resolvedPromptTokens =
		promptFromInputAlias &&
		(cacheReadTokens !== null || cacheCreationTokens !== null)
			? (promptTokens ?? 0) +
				(cacheReadTokens ?? 0) +
				(cacheCreationTokens ?? 0)
			: (promptTokens ?? 0);
	// 缓存命中提取优先级：OpenAI chat details → Responses details →
	// DeepSeek 系 → Anthropic cache_read；首个有限数字生效。
	const cachedInputTokens = pickNumber(
		readNestedNumber(data, "prompt_tokens_details", "cached_tokens"),
		readNestedNumber(data, "input_tokens_details", "cached_tokens"),
		data.prompt_cache_hit_tokens,
		data.cache_read_input_tokens,
	);
	let totalTokens = pickNumber(
		data.total_tokens,
		data.totalTokens,
		data.total,
		data.tokens,
		data.token_count,
	);
	if (
		totalTokens === null &&
		(promptTokens !== null || completionTokens !== null)
	) {
		totalTokens = resolvedPromptTokens + (completionTokens ?? 0);
	}
	if (totalTokens === null) {
		return null;
	}
	return {
		totalTokens,
		promptTokens: resolvedPromptTokens,
		completionTokens: completionTokens ?? 0,
		cachedInputTokens: cachedInputTokens ?? null,
		cacheCreationTokens: cacheCreationTokens ?? null,
	};
}

/**
 * Extracts the raw usage object from an API payload: top-level usage, or
 * nested under `data` / `response` (Responses-style events) / `message`
 * (Anthropic message_start).
 */
function extractRawUsage(payload: unknown): Record<string, unknown> | null {
	if (!payload || typeof payload !== "object") {
		return null;
	}
	const data = payload as Record<string, unknown>;
	const usage =
		data.usage ??
		(data.data && typeof data.data === "object"
			? (data.data as Record<string, unknown>).usage
			: null) ??
		(data.response && typeof data.response === "object"
			? (data.response as Record<string, unknown>).usage
			: null) ??
		(data.message && typeof data.message === "object"
			? (data.message as Record<string, unknown>).usage
			: null);
	if (!usage || typeof usage !== "object") {
		return null;
	}
	return usage as Record<string, unknown>;
}

/**
 * Field-wise merge for SSE usage accumulation: non-null fields of the next
 * usage overwrite, absent/null fields keep the previously seen value. Keeps
 * Anthropic native streams' message_start input/cache counters alive when
 * later message_delta chunks only carry output_tokens.
 */
function mergeRawUsage(
	acc: Record<string, unknown>,
	next: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...acc };
	for (const [key, value] of Object.entries(next)) {
		if (value !== null && value !== undefined) {
			merged[key] = value;
		}
	}
	return merged;
}

export function parseUsageFromJson(payload: unknown): NormalizedUsage | null {
	return normalizeUsage(extractRawUsage(payload));
}

export function parseUsageFromHeaders(
	headers: Headers,
): NormalizedUsage | null {
	const jsonHeader = headers.get("x-usage") ?? headers.get("x-openai-usage");
	if (jsonHeader) {
		const parsed = safeJsonParse<unknown>(jsonHeader, null);
		const normalized = normalizeUsage(parsed);
		if (normalized) {
			return normalized;
		}
	}

	const totalTokens = pickNumber(
		headers.get("x-usage-total-tokens"),
		headers.get("x-openai-usage-total-tokens"),
	);
	const promptTokens = pickNumber(
		headers.get("x-usage-prompt-tokens"),
		headers.get("x-openai-usage-prompt-tokens"),
	);
	const completionTokens = pickNumber(
		headers.get("x-usage-completion-tokens"),
		headers.get("x-openai-usage-completion-tokens"),
	);

	if (
		totalTokens === null &&
		promptTokens === null &&
		completionTokens === null
	) {
		return null;
	}

	return {
		totalTokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
		promptTokens: promptTokens ?? 0,
		completionTokens: completionTokens ?? 0,
		// 响应头路径无缓存字段，恒 NULL。
		cachedInputTokens: null,
		cacheCreationTokens: null,
	};
}

export async function parseUsageFromSse(
	response: Response,
): Promise<StreamUsage> {
	if (!response.body) {
		return { usage: null, firstTokenLatencyMs: null };
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let rawUsage: Record<string, unknown> | null = null;
	const start = Date.now();
	let firstTokenLatencyMs: number | null = null;

	const consumeLinePayload = (payload: string) => {
		if (!payload || payload === "[DONE]") {
			return;
		}
		if (firstTokenLatencyMs === null) {
			firstTokenLatencyMs = Date.now() - start;
		}
		const parsed = safeJsonParse<unknown>(payload, null);
		const raw = extractRawUsage(parsed);
		if (raw) {
			rawUsage = rawUsage ? mergeRawUsage(rawUsage, raw) : raw;
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line.startsWith("data:")) {
				consumeLinePayload(line.slice(5).trim());
			}
			newlineIndex = buffer.indexOf("\n");
		}
	}

	const remaining = buffer.trim();
	if (remaining.startsWith("data:")) {
		consumeLinePayload(remaining.slice(5).trim());
	}

	return {
		usage: rawUsage ? normalizeUsage(rawUsage) : null,
		firstTokenLatencyMs,
	};
}
