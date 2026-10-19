import { Hono } from "hono";
import type { AppEnv } from "../env";
import { type TokenRecord, tokenAuth } from "../middleware/tokenAuth";
import { extractModelIds } from "../services/channel-models";
import { resolveChannelRoute } from "../services/channel-route";
import {
	inboundProtocolForPath,
	resolveEndpointBaseUrl,
	selectTargetFormat,
} from "../services/channel-routing";
import { parseApiFormats } from "../services/channel-types";
import {
	type ChannelRecord,
	createWeightedOrder,
	extractModels,
} from "../services/channels";
import {
	anthropicToOpenaiResponse,
	createAnthropicToOpenaiStreamTransform,
	createOpenaiToResponsesStreamTransform,
	createResponsesToChatStreamTransform,
	openaiToAnthropicRequest,
	openaiToResponsesRequest,
	openaiToResponsesResponse,
	responsesToChatResponse,
	responsesToOpenaiRequest,
} from "../services/format-converter";
import {
	loadAllChannelAliasesGrouped,
	loadChannelAliasesByAlias,
	loadChannelAliasOnlyMap,
} from "../services/model-aliases";
import { calculateCost, getModelPrice } from "../services/pricing";
import { loadProxyRetryConfig } from "../services/settings";
import { recordUsage } from "../services/usage";
import {
	injectSystemPromptAnthropic,
	injectSystemPromptOpenAI,
	injectSystemPromptResponses,
} from "../utils/client-disguise";
import { jsonError } from "../utils/http";
import { safeJsonParse } from "../utils/json";
import { parseApiKeys, shuffleArray } from "../utils/keys";
import {
	filterModelsByAllowlist,
	isModelAllowedByAll,
} from "../utils/model-allowlist";
import {
	applyHeaderPolicy,
	loadProxyHeaderPolicy,
	type ProxyHeaderPolicy,
} from "../utils/proxy-headers";
import { extractReasoningEffort } from "../utils/reasoning";
import { isRetryableStatus, sleep } from "../utils/retry";
import { cfSafeUrl } from "../utils/url";
import {
	type NormalizedUsage,
	parseUsageFromHeaders,
	parseUsageFromJson,
	parseUsageFromSse,
} from "../utils/usage";

const proxy = new Hono<AppEnv>();

type ExecutionContextLike = {
	waitUntil: (promise: Promise<unknown>) => void;
};

export function channelSupportsModel(
	channel: ChannelRecord,
	model?: string | null,
): boolean {
	if (!model) {
		return true;
	}
	const models = extractModels(channel);
	return models.some((entry) => entry.id === model);
}

export function filterAllowedChannels(
	channels: ChannelRecord[],
	tokenRecord: TokenRecord,
	model?: string | null,
): ChannelRecord[] {
	const raw = safeJsonParse<string[] | Record<string, string[]> | null>(
		tokenRecord.allowed_channels,
		null,
	);
	if (!raw) {
		return channels;
	}
	// Legacy flat array format: ["ch1", "ch2"]
	if (Array.isArray(raw)) {
		if (raw.length === 0) return channels;
		const allowedSet = new Set(raw);
		return channels.filter((channel) => allowedSet.has(channel.id));
	}
	// Per-model map format: { "model-a": ["ch1", "ch2"] }
	if (typeof raw === "object") {
		if (!model) return channels;
		const perModel = raw[model];
		if (!perModel || perModel.length === 0) return channels;
		const allowedSet = new Set(perModel);
		return channels.filter((channel) => allowedSet.has(channel.id));
	}
	return channels;
}

// Chat endpoint paths — inbound protocols that non-openai channels can serve
// via request conversion (anthropic & responses channels both handle these)
const CHAT_PATHS = ["/v1/chat/completions", "/v1/responses"];

function isChatPath(path: string): boolean {
	const lower = path.toLowerCase();
	return CHAT_PATHS.some((p) => lower.startsWith(p));
}

/**
 * Whether the inbound path is a chat completions call that gets converted for
 * responses-format channels. In the target-format world (design.md §3) this
 * is equivalent to "target format is responses AND inbound is chat": the
 * responses-target conversion branch only ever evaluates it under that target,
 * and the openai-target disguise gate uses it to keep injections chat-only.
 */
function isConvertedChatPath(path: string): boolean {
	const lower = path.toLowerCase();
	return isChatPath(lower) && !lower.startsWith("/v1/responses");
}

/**
 * Builds per-channel fetch target and body based on channel api_format.
 * Returns the target URL, headers, and request body.
 * `channel.api_format` is the selected **target format**: the proxy /
 * anthropic-proxy / playground handlers pick it per inbound protocol via
 * `selectTargetFormat` and pass a shallow copy with api_format overridden, so
 * every branch here (URL rules, headers, disguise) acts on the target.
 * policy 为 null 时跳过全局注入/剔除（Playground 豁免），渠道级 custom_headers
 * 与伪装头经 applyHeaderPolicy 统一在各格式分支生效（剔除 → 全局注入 →
 * 伪装头 → 渠道级）。disguisePrompt 为渠道伪装系统提示词（design §3.1 矩阵）：
 * openai 透传仅 chat 入站注入（messages 为数组时，mutate 后重新 stringify）；
 * openai 目标 + /v1/responses 入站在转换后的 chat 体 messages 注入；
 * anthropic / responses 分支转换完成后注入；/v1/responses 透传注入
 * instructions；custom 分支不解释 body 仅注入头。
 */
export function buildChannelRequest(
	channel: ChannelRecord,
	targetPath: string,
	querySuffix: string,
	incomingHeaders: Headers,
	requestText: string,
	parsedBody: Record<string, unknown> | null,
	isStream: boolean,
	apiKey?: string,
	policy?: ProxyHeaderPolicy | null,
	disguisePrompt?: string | null,
): { target: string; headers: Headers; body: string | undefined } {
	const effectiveKey = apiKey ?? channel.api_key;
	const apiFormat = channel.api_format ?? "openai";
	const headerPolicy = policy ?? null;
	const headers = new Headers(incomingHeaders);
	headers.delete("host");
	headers.delete("content-length");

	if (apiFormat === "anthropic") {
		// 每格式端点覆盖（design.md §1）：无覆盖 = normalizeBaseUrl(base_url)，
		// 与既有行为逐字节一致；有 anthropic 覆盖 = normalizeBaseUrl(override)
		const baseUrl = resolveEndpointBaseUrl(channel, "anthropic");
		const target = cfSafeUrl(`${baseUrl}/v1/messages`);
		headers.set("x-api-key", String(effectiveKey));
		headers.set("anthropic-version", "2023-06-01");
		headers.set("content-type", "application/json");
		headers.delete("Authorization");
		applyHeaderPolicy(
			headers,
			headerPolicy,
			channel.custom_headers_json,
			channel.disguise_headers_json,
		);

		const anthropicBody = parsedBody
			? openaiToAnthropicRequest(parsedBody)
			: {};
		if (isStream) {
			(anthropicBody as Record<string, unknown>).stream = true;
		}
		// Disguise prompt (#2, design §3.1): inject after conversion — the
		// converted body is fresh per call, so mutating it cannot leak across
		// retry rounds or channels.
		if (disguisePrompt && parsedBody) {
			injectSystemPromptAnthropic(
				anthropicBody as Record<string, unknown>,
				disguisePrompt,
			);
		}
		return { target, headers, body: JSON.stringify(anthropicBody) };
	}

	if (apiFormat === "responses") {
		// Endpoint resolver: no override → base_url keeps its version path
		// (e.g. /v1), same rule as openai; a responses override replaces the
		// prefix (trailing slashes stripped, version path preserved)
		const baseUrl = resolveEndpointBaseUrl(channel, "responses");
		const lower = targetPath.toLowerCase();
		let target: string;
		let body: string | undefined;
		if (lower.startsWith("/v1/responses")) {
			// Responses inbound: pass through untouched (R4) — ZenAPI does not
			// interpret store / previous_response_id etc.; state lives upstream.
			// Disguise prompt (#4, design §3.1) still injects into `instructions`
			// via a per-call shallow copy so the caller's parsed body stays
			// pristine across retry rounds and channels.
			target = cfSafeUrl(`${baseUrl}/responses${querySuffix}`);
			if (disguisePrompt && parsedBody) {
				const bodyCopy: Record<string, unknown> = { ...parsedBody };
				injectSystemPromptResponses(bodyCopy, disguisePrompt);
				body = JSON.stringify(bodyCopy);
			} else {
				body = requestText || undefined;
			}
		} else if (isChatPath(lower)) {
			// Chat inbound: convert the chat completion request into a Responses
			// request (the converter drops stream_options and other unsupported
			// fields; parsedBody already carries the alias-resolved model)
			target = cfSafeUrl(`${baseUrl}/responses${querySuffix}`);
			const responsesBody = parsedBody
				? openaiToResponsesRequest(parsedBody)
				: {};
			if (isStream) {
				(responsesBody as Record<string, unknown>).stream = true;
			}
			// Disguise prompt (#3, design §3.1): converted body is fresh per
			// call — inject instructions directly.
			if (disguisePrompt && parsedBody) {
				injectSystemPromptResponses(
					responsesBody as Record<string, unknown>,
					disguisePrompt,
				);
			}
			body = JSON.stringify(responsesBody);
		} else {
			// Non-chat passthrough paths follow the openai rules
			const subPath = targetPath.replace(/^\/v1\b/, "");
			target = cfSafeUrl(`${baseUrl}${subPath}${querySuffix}`);
			body = requestText || undefined;
		}
		headers.set("Authorization", `Bearer ${effectiveKey}`);
		headers.set("x-api-key", String(effectiveKey));
		applyHeaderPolicy(
			headers,
			headerPolicy,
			channel.custom_headers_json,
			channel.disguise_headers_json,
		);
		return { target, headers, body };
	}

	if (apiFormat === "custom") {
		// For custom format, base_url IS the full target URL
		const target = cfSafeUrl(`${channel.base_url}${querySuffix}`);
		headers.set("Authorization", `Bearer ${effectiveKey}`);
		headers.set("x-api-key", String(effectiveKey));
		// Disguise prompt NOT injected (#5, design §3.1): body structure is
		// unknown, blind edits could corrupt the request — headers only.
		applyHeaderPolicy(
			headers,
			headerPolicy,
			channel.custom_headers_json,
			channel.disguise_headers_json,
		);
		return { target, headers, body: requestText || undefined };
	}

	// Default: openai target pass-through
	// Endpoint resolver: no override → base_url already includes version path
	// (e.g. /v1), so strip /v1 from incoming path; an openai override replaces
	// the prefix (trailing slashes stripped, version path preserved)
	const baseUrl = resolveEndpointBaseUrl(channel, "openai");
	if (targetPath.toLowerCase().startsWith("/v1/responses")) {
		// Responses inbound + openai target (design.md §5): the channel declares
		// no native Responses endpoint, so the request converts into a chat
		// completions call — the old transparent forward plus its 400/404 path
		// fallback retry was removed along with that combination (AC8).
		const target = cfSafeUrl(`${baseUrl}/chat/completions${querySuffix}`);
		const chatBody = parsedBody ? responsesToOpenaiRequest(parsedBody) : {};
		if (isStream) {
			(chatBody as Record<string, unknown>).stream = true;
			// Chat-only usage injection rides on the fresh converted body (spec
			// §3.1 last-wins): the original Responses body is never mutated and
			// the converter never forwards stream_options, so one upstream call
			// cannot see the field twice.
			(chatBody as Record<string, unknown>).stream_options = {
				include_usage: true,
			};
		}
		// Disguise prompt: the converted body is fresh per call — inject into
		// messages directly (same post-conversion pattern as the anthropic and
		// responses branches, design §3.1 #2/#3).
		if (disguisePrompt) {
			injectSystemPromptOpenAI(
				chatBody as Record<string, unknown>,
				disguisePrompt,
			);
		}
		return { target, headers, body: JSON.stringify(chatBody) };
	}
	const subPath = targetPath.replace(/^\/v1\b/, "");
	const target = cfSafeUrl(`${baseUrl}${subPath}${querySuffix}`);
	headers.set("Authorization", `Bearer ${effectiveKey}`);
	headers.set("x-api-key", String(effectiveKey));
	applyHeaderPolicy(
		headers,
		headerPolicy,
		channel.custom_headers_json,
		channel.disguise_headers_json,
	);
	// Disguise prompt (#1, design §3.1): chat inbound only — inject into a
	// per-call copy of the parsed body (messages array cloned) so the caller's
	// shared parsed body never accumulates injections across retry rounds and
	// channels. Embeddings and other bodies without a messages array pass
	// through untouched, same as the stream_options injection precedent.
	let body: string | undefined = requestText || undefined;
	if (
		disguisePrompt &&
		parsedBody &&
		isConvertedChatPath(targetPath) &&
		Array.isArray(parsedBody.messages)
	) {
		const bodyCopy: Record<string, unknown> = {
			...parsedBody,
			messages: [...parsedBody.messages],
		};
		injectSystemPromptOpenAI(bodyCopy, disguisePrompt);
		body = JSON.stringify(bodyCopy);
	}
	return { target, headers, body };
}

/**
 * Converts upstream response based on the channel's target format back to the
 * inbound protocol. `channel.api_format` is the target format selected by the
 * caller; inboundPath is the inbound protocol path:
 * - responses target + chat inbound → Responses→chat conversion (existing)
 * - openai target + /v1/responses inbound → chat→Responses conversion (the
 *   request side was converted to a chat completions call)
 * - anthropic target → Anthropic→chat conversion
 * Responses-native (/v1/responses target) and passthrough paths return as-is.
 */
export async function convertResponse(
	channel: ChannelRecord,
	response: Response,
	isStream: boolean,
	inboundPath: string,
): Promise<Response> {
	const apiFormat = channel.api_format ?? "openai";

	if (
		apiFormat === "responses" &&
		response.ok &&
		isConvertedChatPath(inboundPath)
	) {
		if (isStream && response.body) {
			const transform = createResponsesToChatStreamTransform();
			const transformed = response.body.pipeThrough(transform);
			return new Response(transformed, {
				status: response.status,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		}

		const responsesData = (await response.json()) as Record<string, unknown>;
		const chatData = responsesToChatResponse(responsesData);
		return new Response(JSON.stringify(chatData), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	if (
		apiFormat === "openai" &&
		response.ok &&
		inboundPath.toLowerCase().startsWith("/v1/responses")
	) {
		if (isStream && response.body) {
			const transform = createOpenaiToResponsesStreamTransform();
			const transformed = response.body.pipeThrough(transform);
			return new Response(transformed, {
				status: response.status,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		}

		const chatData = (await response.json()) as Record<string, unknown>;
		const responsesData = openaiToResponsesResponse(chatData);
		return new Response(JSON.stringify(responsesData), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	if (apiFormat === "anthropic" && response.ok) {
		if (isStream && response.body) {
			const transform = createAnthropicToOpenaiStreamTransform();
			const transformed = response.body.pipeThrough(transform);
			return new Response(transformed, {
				status: response.status,
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				},
			});
		}

		const anthropicData = (await response.json()) as Record<string, unknown>;
		const openaiData = anthropicToOpenaiResponse(anthropicData);
		return new Response(JSON.stringify(openaiData), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}

	// openai / custom / responses-native / passthrough: return as-is
	return response;
}

/**
 * OpenAI-compatible /models endpoint.
 * Returns all callable model names using the effective mapping algorithm.
 */
proxy.get("/models", tokenAuth, async (c) => {
	const tokenRecord = c.get("tokenRecord") as TokenRecord;
	const channelResult = await c.env.DB.prepare(
		"SELECT * FROM channels WHERE status = ?",
	)
		.bind("active")
		.all();
	const activeChannels = (channelResult.results ?? []) as ChannelRecord[];

	// Parse allowed_channels once for per-model filtering
	const rawAllowed = safeJsonParse<string[] | Record<string, string[]> | null>(
		tokenRecord.allowed_channels,
		null,
	);
	const isPerModelMap =
		rawAllowed !== null &&
		!Array.isArray(rawAllowed) &&
		typeof rawAllowed === "object";

	// For legacy flat-array format, pre-filter channels once
	const baseAllowed = isPerModelMap
		? activeChannels
		: filterAllowedChannels(activeChannels, tokenRecord);

	// Build per-channel model ID sets
	const channelModelIds = new Map<string, string[]>();
	for (const ch of baseAllowed) {
		channelModelIds.set(ch.id, extractModelIds(ch));
	}

	// Load alias data
	const aliasGroups = await loadAllChannelAliasesGrouped(c.env.DB);

	// Compute effective mapping
	const now = Math.floor(Date.now() / 1000);
	const modelData: Array<{
		id: string;
		object: string;
		created: number;
		owned_by: string;
	}> = [];
	const seen = new Set<string>();

	for (const ch of baseAllowed) {
		const modelIds = channelModelIds.get(ch.id) ?? [];
		const chAliases = aliasGroups.get(ch.id);

		for (const modelId of modelIds) {
			// Per-model channel restriction: skip if this channel is not allowed for this model
			if (isPerModelMap) {
				const perModel = (rawAllowed as Record<string, string[]>)[modelId];
				if (perModel && perModel.length > 0 && !perModel.includes(ch.id))
					continue;
			}

			const aliasInfo = chAliases?.get(modelId);
			const isAliasOnly = aliasInfo?.alias_only ?? false;

			// Original name (unless alias_only)
			if (!isAliasOnly && !seen.has(modelId)) {
				seen.add(modelId);
				modelData.push({
					id: modelId,
					object: "model",
					created: now,
					owned_by: "system",
				});
			}

			// Alias names
			if (aliasInfo) {
				for (const alias of aliasInfo.aliases) {
					if (!seen.has(alias)) {
						seen.add(alias);
						modelData.push({
							id: alias,
							object: "model",
							created: now,
							owned_by: "system",
						});
					}
				}
			}
		}
	}

	// Token-level then user-level model allowlists (design.md D3/D4): only
	// expose callable names both lists permit (each list is fail-open when null)
	const visibleModels = filterModelsByAllowlist(
		filterModelsByAllowlist(modelData, tokenRecord.token_allowed_models),
		tokenRecord.user_allowed_models,
	);

	return c.json({
		object: "list",
		data: visibleModels,
	});
});

/**
 * OpenAI-compatible proxy handler.
 */
proxy.all("/*", tokenAuth, async (c) => {
	const tokenRecord = c.get("tokenRecord") as TokenRecord;
	let requestText = await c.req.text();
	const parsedBody = requestText
		? safeJsonParse<Record<string, unknown> | null>(requestText, null)
		: null;
	const model =
		parsedBody?.model !== undefined && parsedBody?.model !== null
			? String(parsedBody.model)
			: null;
	const isStream = parsedBody?.stream === true;

	// Token-level and user-level model allowlists (design.md D3/D4): each list
	// independently gates the requested model name (exact match, alias
	// unresolved) before any channel routing work
	if (
		!isModelAllowedByAll(
			[tokenRecord.token_allowed_models, tokenRecord.user_allowed_models],
			model,
		)
	) {
		return jsonError(c, 403, "model_not_allowed", "model_not_allowed");
	}

	// Resolve per-channel aliases for this model name
	const channelAliasHits = model
		? await loadChannelAliasesByAlias(c.env.DB, model)
		: [];
	const channelAliasHitMap = new Map(
		channelAliasHits.map((h) => [h.channel_id, h]),
	);

	// Load per-channel alias-only map
	const perChannelAliasOnlyMap = await loadChannelAliasOnlyMap(c.env.DB);

	const reasoningEffort = extractReasoningEffort(parsedBody);
	// Chat-only stream_options usage injection happens here for chat-shaped
	// inbound bodies (spec §3.1). /v1/responses inbound is exempt — that
	// protocol has no stream_options parameter. For responses inbound bodies
	// the equivalent injection happens post-conversion inside
	// buildChannelRequest (openai target converts the body into a chat
	// completions call and injects stream_options on the fresh converted
	// body), so the final upstream body carries it exactly once.
	const isResponsesInbound = c.req.path
		.toLowerCase()
		.startsWith("/v1/responses");
	if (
		isStream &&
		parsedBody &&
		typeof parsedBody === "object" &&
		!isResponsesInbound
	) {
		const streamOptions = (parsedBody as Record<string, unknown>)
			.stream_options;
		if (!streamOptions || typeof streamOptions !== "object") {
			(parsedBody as Record<string, unknown>).stream_options = {
				include_usage: true,
			};
		} else if (
			(streamOptions as Record<string, unknown>).include_usage !== true
		) {
			(streamOptions as Record<string, unknown>).include_usage = true;
		}
		requestText = JSON.stringify(parsedBody);
	}

	// 全局头策略、重试配置与活跃渠道查询并行预载：每请求只读两次库，重试轮复用
	const [channelResult, headerPolicy, retryConfig] = await Promise.all([
		c.env.DB.prepare("SELECT * FROM channels WHERE status = ?")
			.bind("active")
			.all(),
		loadProxyHeaderPolicy(c.env.DB),
		loadProxyRetryConfig(c.env.DB, {
			rounds: c.env.PROXY_RETRY_ROUNDS,
			delayMs: c.env.PROXY_RETRY_DELAY_MS,
		}),
	]);
	const activeChannels = (channelResult.results ?? []) as ChannelRecord[];

	// Resolve channel/model routing syntax (uses original model name)
	const { targetChannel, actualModel } = resolveChannelRoute(
		model,
		activeChannels,
	);
	const effectiveModel = targetChannel ? actualModel : model;

	// If channel routing matched, replace model in the request body
	if (targetChannel && parsedBody && actualModel !== null) {
		parsedBody.model = actualModel;
		requestText = JSON.stringify(parsedBody);
	}

	let candidates: ChannelRecord[];
	if (targetChannel) {
		// Explicit channel routing — verify the model exists on this channel
		if (!channelSupportsModel(targetChannel, actualModel)) {
			return jsonError(
				c,
				404,
				"model_not_found",
				`The model '${actualModel}' does not exist on channel '${targetChannel.name}'.`,
			);
		}
		candidates = [targetChannel];
	} else {
		const allowedChannels = filterAllowedChannels(
			activeChannels,
			tokenRecord,
			model,
		);
		if (model) {
			candidates = allowedChannels.filter((channel) => {
				// Channel matched via per-channel alias → include
				if (channelAliasHitMap.has(channel.id)) return true;
				// Channel natively supports this model → include UNLESS alias_only
				if (channelSupportsModel(channel, model)) {
					const aliasOnlyModels = perChannelAliasOnlyMap.get(channel.id);
					return !aliasOnlyModels?.has(model);
				}
				return false;
			});
		} else {
			// No model specified — all channels qualify
			candidates = allowedChannels;
		}
	}

	if (candidates.length === 0) {
		if (model) {
			return jsonError(
				c,
				404,
				"model_not_found",
				`The model '${model}' does not exist or is not available.`,
			);
		}
		return jsonError(c, 503, "no_available_channels", "no_available_channels");
	}

	const targetPath = c.req.path;

	// Routing matrix (design.md §3): pick each channel's target format for the
	// inbound protocol via the shared preference matrix; channels with no
	// serviceable declared format are dropped. The target rides on a shallow
	// copy (api_format overridden) so every downstream branch keyed on
	// channel.api_format — request building, disguise, header policy, response
	// conversion — naturally acts on the target format.
	const inboundProtocol = inboundProtocolForPath(targetPath);
	const routed: ChannelRecord[] = [];
	for (const ch of candidates) {
		const targetFormat = selectTargetFormat(
			parseApiFormats(ch),
			inboundProtocol,
		);
		if (targetFormat) {
			routed.push({ ...ch, api_format: targetFormat });
		}
	}
	if (routed.length === 0) {
		return jsonError(c, 503, "no_available_channels", "no_available_channels");
	}
	candidates = routed;

	// stream_only channels should not serve non-streaming requests
	if (!isStream) {
		candidates = candidates.filter((ch) => !ch.stream_only);
		if (candidates.length === 0) {
			return jsonError(
				c,
				400,
				"stream_required",
				"所有可用渠道要求使用流式调用",
			);
		}
	}

	const ordered = createWeightedOrder(candidates);
	const querySuffix = c.req.url.includes("?")
		? `?${c.req.url.split("?")[1]}`
		: "";
	const { rounds: retryRounds, delayMs: retryDelayMs } = retryConfig;
	let lastResponse: Response | null = null;
	let lastChannel: ChannelRecord | null = null;
	const start = Date.now();
	let selectedChannel: ChannelRecord | null = null;
	let selectedModelName: string | null = effectiveModel;

	let round = 0;
	while (round < retryRounds && !selectedChannel) {
		let shouldRetry = false;
		for (const channel of ordered) {
			lastChannel = channel;
			const keys = shuffleArray(parseApiKeys(channel.api_key));
			let channelRetryable = false;

			// Determine the model name this channel actually supports
			// and prepare a channel-specific request body if needed
			let channelRequestText = requestText;
			let channelParsedBody = parsedBody;
			let channelModelName = effectiveModel;
			if (!targetChannel && parsedBody) {
				// Check if this channel was matched via per-channel alias
				const aliasHit = channelAliasHitMap.get(channel.id);
				if (aliasHit) {
					channelModelName = aliasHit.model_id;
					channelParsedBody = { ...parsedBody, model: channelModelName };
					channelRequestText = JSON.stringify(channelParsedBody);
				}
			}

			for (const apiKey of keys) {
				const incomingHeaders = new Headers(c.req.header());

				const {
					target,
					headers,
					body: channelBody,
				} = buildChannelRequest(
					channel,
					targetPath,
					querySuffix,
					incomingHeaders,
					channelRequestText,
					channelParsedBody,
					isStream,
					apiKey,
					headerPolicy,
					channel.disguise_system_prompt ?? null,
				);

				try {
					const response = await fetch(target, {
						method: c.req.method,
						headers,
						body: channelBody,
					});

					lastResponse = response;
					if (response.ok) {
						// Convert response based on the channel's target format
						lastResponse = await convertResponse(
							channel,
							response,
							isStream,
							targetPath,
						);
						selectedChannel = channel;
						selectedModelName = channelModelName;
						break;
					}

					if (isRetryableStatus(response.status)) {
						channelRetryable = true;
					} else {
						// Non-retryable error — skip remaining keys for this channel
						break;
					}
				} catch {
					lastResponse = null;
					channelRetryable = true;
				}
			}

			if (selectedChannel) {
				break;
			}
			if (channelRetryable) {
				shouldRetry = true;
			}
		}

		if (selectedChannel || !shouldRetry) {
			break;
		}

		round += 1;
		if (round < retryRounds) {
			await sleep(retryDelayMs);
		}
	}

	const latencyMs = Date.now() - start;

	if (!lastResponse) {
		await recordUsage(c.env.DB, {
			tokenId: tokenRecord.id,
			model: effectiveModel,
			requestPath: targetPath,
			totalTokens: 0,
			latencyMs,
			firstTokenLatencyMs: isStream ? null : latencyMs,
			stream: isStream,
			reasoningEffort,
			status: "error",
			errorMessage: "upstream_unavailable",
		});
		return jsonError(c, 502, "upstream_unavailable", "upstream_unavailable");
	}

	const channelForUsage = selectedChannel ?? lastChannel;
	if (channelForUsage && lastResponse) {
		const price = getModelPrice(
			channelForUsage.models_json,
			selectedModelName ?? "",
		);
		let errorCode: number | null = null;
		let errorMessage: string | null = null;
		if (!lastResponse.ok) {
			errorCode = lastResponse.status;
			try {
				const errText = await lastResponse.clone().text();
				errorMessage = errText.slice(0, 512);
			} catch {
				errorMessage = null;
			}
		}
		const record = async (
			usage: NormalizedUsage | null,
			firstTokenLatencyMs?: number | null,
		) => {
			const normalized = usage ?? {
				totalTokens: 0,
				promptTokens: 0,
				completionTokens: 0,
				cachedInputTokens: null,
				cacheCreationTokens: null,
			};
			const cost = price
				? calculateCost(
						price,
						normalized.promptTokens,
						normalized.completionTokens,
						normalized.totalTokens,
					)
				: 0;
			const resolvedFirstTokenLatencyMs =
				firstTokenLatencyMs ?? (isStream ? null : latencyMs);
			await recordUsage(c.env.DB, {
				tokenId: tokenRecord.id,
				channelId: channelForUsage.id,
				model: effectiveModel,
				requestPath: targetPath,
				totalTokens: normalized.totalTokens,
				promptTokens: normalized.promptTokens,
				completionTokens: normalized.completionTokens,
				cachedInputTokens: normalized.cachedInputTokens,
				cacheCreationTokens: normalized.cacheCreationTokens,
				cost,
				latencyMs,
				firstTokenLatencyMs: resolvedFirstTokenLatencyMs,
				stream: isStream,
				reasoningEffort,
				status: lastResponse.ok ? "ok" : "error",
				errorCode,
				errorMessage,
			});
			// Deduct user balance
			if (cost > 0 && tokenRecord.user_id) {
				const now = new Date().toISOString();
				await c.env.DB.prepare(
					"UPDATE users SET balance = balance - ?, updated_at = ? WHERE id = ?",
				)
					.bind(cost, now, tokenRecord.user_id)
					.run();
			}
		};
		const logUsage = (
			label: string,
			usage: NormalizedUsage | null,
			source: string,
		) => {
			console.log(`[usage] ${label}`, {
				source,
				total_tokens: usage?.totalTokens ?? 0,
				prompt_tokens: usage?.promptTokens ?? 0,
				completion_tokens: usage?.completionTokens ?? 0,
				stream: isStream,
				status: lastResponse.status,
				model: effectiveModel,
				path: targetPath,
			});
		};

		const headerUsage = parseUsageFromHeaders(lastResponse.headers);
		let jsonUsage: NormalizedUsage | null = null;
		if (
			!isStream &&
			lastResponse.ok &&
			lastResponse.headers.get("content-type")?.includes("application/json")
		) {
			const data = await lastResponse
				.clone()
				.json()
				.catch(() => null);
			jsonUsage = parseUsageFromJson(data);
		}
		const immediateUsage = jsonUsage ?? headerUsage;
		const immediateSource = jsonUsage
			? "json"
			: headerUsage
				? "header"
				: "none";

		if (isStream) {
			// Hono's executionCtx getter throws outside the Workers runtime
			// (e.g. the vitest request harness); degrade to the fire-and-forget
			// fallback below in that case instead of failing the request.
			let executionCtx: ExecutionContextLike | undefined;
			try {
				executionCtx = c.executionCtx;
			} catch {
				executionCtx = undefined;
			}
			const task = parseUsageFromSse(lastResponse.clone())
				.then((streamUsage) => {
					const usageValue = immediateUsage ?? streamUsage.usage;
					const source = immediateUsage
						? immediateSource
						: streamUsage.usage
							? "sse"
							: "sse-none";
					logUsage("stream", usageValue, source);
					return record(usageValue, streamUsage.firstTokenLatencyMs);
				})
				.catch(async () => {
					// SSE parsing failed (stream interrupted, etc.) — still record with whatever we have
					try {
						logUsage("stream-fallback", immediateUsage, immediateSource);
						await record(immediateUsage, null);
					} catch {
						/* truly lost */
					}
				});
			if (executionCtx?.waitUntil) {
				executionCtx.waitUntil(task);
			} else {
				task.catch(() => undefined);
			}
		} else {
			logUsage("immediate", immediateUsage, immediateSource);
			await record(immediateUsage, latencyMs);
		}
	}

	return lastResponse;
});

export default proxy;
