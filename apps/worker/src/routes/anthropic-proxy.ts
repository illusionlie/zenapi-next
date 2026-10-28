import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { type TokenRecord, tokenAuth } from "../middleware/tokenAuth";
import {
	filterCoolingChannels,
	recordChannelFailure,
	recordChannelSuccess,
} from "../services/channel-cooldown";
import { resolveChannelRoute } from "../services/channel-route";
import {
	resolveEndpointBaseUrl,
	selectTargetFormat,
} from "../services/channel-routing";
import { parseApiFormats } from "../services/channel-types";
import {
	type ChannelRecord,
	createWeightedOrder,
	getActiveChannelsCached,
} from "../services/channels";
import {
	applyClientPreset,
	isStreamForcingPreset,
} from "../services/client-presets";
import {
	anthropicToOpenaiRequest,
	createOpenaiToAnthropicStreamTransform,
	createResponsesToChatStreamTransform,
	openaiToAnthropicResponse,
	openaiToResponsesRequest,
	responsesToAnthropicResponse,
} from "../services/format-converter";
import {
	filterCoolingKeys,
	keyFingerprint,
	recordKeyAuthFailure,
	recordKeyRetryableFailure,
	recordKeySuccess,
} from "../services/key-cooldown";
import {
	type ChannelAliasHit,
	loadChannelAliasesByAlias,
	loadChannelAliasOnlyMap,
} from "../services/model-aliases";
import { calculateCost, getModelPrice } from "../services/pricing";
import {
	loadProxySettingsCached,
	resolveProxyRetryConfig,
	type SettingsRawMap,
} from "../services/settings";
import { aggregateUpstreamStream } from "../services/stream-aggregate";
import { recordUsage } from "../services/usage";
import {
	injectSystemPromptAnthropic,
	injectSystemPromptOpenAI,
	injectSystemPromptResponses,
} from "../utils/client-disguise";
import { jsonError } from "../utils/http";
import { safeJsonParse } from "../utils/json";
import { parseApiKeys, shuffleArray } from "../utils/keys";
import { isModelAllowedByAll } from "../utils/model-allowlist";
import { runPostResponse } from "../utils/post-response";
import {
	applyHeaderPolicy,
	parseHeaderPolicyFromRaw,
} from "../utils/proxy-headers";
import { isRetryableStatus, sleep } from "../utils/retry";
import { cfSafeUrl } from "../utils/url";
import {
	type NormalizedUsage,
	normalizeUsage,
	parseUsageFromHeaders,
	parseUsageFromSse,
} from "../utils/usage";
import { channelSupportsModel, filterAllowedChannels } from "./proxy";

const anthropicProxy = new Hono<AppEnv>();

/**
 * Hot-path read snapshot shared by the anthropic inbound endpoints
 * (`/messages` and `/messages/count_tokens`): per-channel alias resolution,
 * alias_only map, active channels and proxy runtime settings in a single
 * parallel Promise.all (the only serial RTT stage after the auth JOIN).
 * Channels / aliases ride the 10s TTL caches, settings the 30s raw cache.
 */
type AnthropicProxyHotState = {
	channelAliasHitMap: Map<string, ChannelAliasHit>;
	perChannelAliasOnlyMap: Map<string, Set<string>>;
	activeChannels: ChannelRecord[];
	proxySettings: SettingsRawMap;
};

async function loadAnthropicProxyHotState(
	db: D1Database,
	model: string | null,
): Promise<AnthropicProxyHotState> {
	const [
		channelAliasHits,
		perChannelAliasOnlyMap,
		activeChannels,
		proxySettings,
	] = await Promise.all([
		model ? loadChannelAliasesByAlias(db, model) : Promise.resolve([]),
		loadChannelAliasOnlyMap(db),
		getActiveChannelsCached(db),
		loadProxySettingsCached(db),
	]);
	return {
		channelAliasHitMap: new Map(channelAliasHits.map((h) => [h.channel_id, h])),
		perChannelAliasOnlyMap,
		activeChannels,
		proxySettings,
	};
}

/**
 * Model governance + candidate selection shared by the anthropic inbound
 * endpoints: `channel_name/model` routing syntax, token-allowed channel
 * filter, per-channel alias hits and alias_only suppression. Returns the
 * governance-qualified candidates BEFORE target-format routing
 * (see routeAnthropicTargetFormats).
 */
function selectAnthropicInboundCandidates(
	model: string | null,
	tokenRecord: TokenRecord,
	state: AnthropicProxyHotState,
): {
	targetChannel: ChannelRecord | null;
	actualModel: string | null;
	effectiveModel: string | null;
	candidates: ChannelRecord[];
} {
	// Resolve channel/model routing syntax (uses original model name)
	const { targetChannel, actualModel } = resolveChannelRoute(
		model,
		state.activeChannels,
	);
	const effectiveModel = targetChannel ? actualModel : model;

	let candidates: ChannelRecord[];
	if (targetChannel) {
		candidates = [targetChannel];
	} else {
		const allowedChannels = filterAllowedChannels(
			state.activeChannels,
			tokenRecord,
			model,
		);
		if (model) {
			candidates = allowedChannels.filter((channel) => {
				// Channel matched via per-channel alias → include
				if (state.channelAliasHitMap.has(channel.id)) return true;
				// Channel natively supports this model → include UNLESS alias_only
				if (channelSupportsModel(channel, model)) {
					const aliasOnlyModels = state.perChannelAliasOnlyMap.get(channel.id);
					return !aliasOnlyModels?.has(model);
				}
				return false;
			});
		} else {
			// No model specified — all channels qualify
			candidates = allowedChannels;
		}
	}
	return { targetChannel, actualModel, effectiveModel, candidates };
}

/**
 * Routing matrix step (design.md §3): pick each candidate's target format for
 * the anthropic inbound protocol. Since the responses↔anthropic pivot
 * (2026-10-27), responses-declared-only channels qualify with target
 * "responses" (two-hop conversion via the chat hub); the target rides on a
 * shallow copy (api_format overridden) so downstream format branches act on it.
 */
function routeAnthropicTargetFormats(
	candidates: ChannelRecord[],
): ChannelRecord[] {
	return candidates.flatMap((ch) => {
		const targetFormat = selectTargetFormat(parseApiFormats(ch), "anthropic");
		return targetFormat ? [{ ...ch, api_format: targetFormat }] : [];
	});
}

/**
 * Local coarse estimate for count_tokens: input_tokens ≈
 * ceil(serialized-request-length / 4). Deliberately rough (no tokenizer
 * dependency) — count_tokens is a client-side context hint, never a billing
 * input; a stable estimate beats a 404 for Claude Code's context management.
 */
function estimateCountTokensResponse(
	parsedBody: Record<string, unknown> | null,
	requestText: string,
): Response {
	const basis = parsedBody ? JSON.stringify(parsedBody) : requestText;
	const inputTokens = Math.max(1, Math.ceil(basis.length / 4));
	return new Response(JSON.stringify({ input_tokens: inputTokens }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Anthropic Messages API compatible proxy handler.
 * Accepts requests in Anthropic format and routes through channels.
 */
anthropicProxy.post("/messages", tokenAuth, async (c) => {
	const tokenRecord = c.get("tokenRecord") as TokenRecord;
	const requestText = await c.req.text();
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

	// 热路径读并行合一（design.md，与 proxy.ts 同构）：per-channel 别名解析、
	// aliasOnly 全图、活跃渠道、代理运行时 settings（4 键一次 IN 查询）进单个
	// Promise.all——鉴权 JOIN 之后只剩这一个串行 RTT 阶段。channels / 别名走
	// 10s TTL 缓存、settings 只缓存 raw 读（30s）；头策略 fail-open 解析与
	// 重试配置三级回退链（settings → env → 默认，含 clamp）从 raw map 纯解析，
	// 每次照常执行。与 /messages/count_tokens 共享 loadAnthropicProxyHotState。
	const hotState = await loadAnthropicProxyHotState(c.env.DB, model);
	const headerPolicy = parseHeaderPolicyFromRaw(hotState.proxySettings);
	const retryConfig = resolveProxyRetryConfig(hotState.proxySettings, {
		rounds: c.env.PROXY_RETRY_ROUNDS,
		delayMs: c.env.PROXY_RETRY_DELAY_MS,
	});

	// Convert Anthropic request -> OpenAI format for internal use
	const openaiBody = parsedBody ? anthropicToOpenaiRequest(parsedBody) : null;

	// Model governance + candidate selection shared with /messages/count_tokens
	const {
		targetChannel,
		actualModel,
		effectiveModel,
		candidates: modelCandidates,
	} = selectAnthropicInboundCandidates(model, tokenRecord, hotState);

	// If channel routing matched, replace model in the request bodies
	let effectiveRequestText = requestText;
	if (targetChannel && parsedBody && actualModel !== null) {
		parsedBody.model = actualModel;
		effectiveRequestText = JSON.stringify(parsedBody);
		if (openaiBody) {
			(openaiBody as Record<string, unknown>).model = actualModel;
		}
	}

	if (modelCandidates.length === 0) {
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

	// Routing matrix (design.md §3): pick each channel's target format for the
	// Anthropic inbound protocol. A channel declaring ["responses"] now targets
	// its native responses format via the chat-hub pivot (two-hop conversion);
	// ["anthropic","openai"] still targets native anthropic. The target rides
	// on a shallow copy (api_format overridden) so the per-format branches
	// below act on it unchanged.
	let candidates = routeAnthropicTargetFormats(modelCandidates);
	if (candidates.length === 0) {
		return jsonError(c, 503, "no_available_channels", "no_available_channels");
	}

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

	// Channel cooldown (P2): drop cooling-down channels from the candidate
	// pool before weighted ordering — same eligibility tier as the routing
	// matrix above, createWeightedOrder stays a pure function. fail-open is
	// built into filterCoolingChannels: when every candidate is cooling the
	// full pool is kept, so cooldown never causes an early no_available_channels.
	const nonCoolingIds = new Set(
		filterCoolingChannels(candidates.map((ch) => ch.id)),
	);
	candidates = candidates.filter((ch) => nonCoolingIds.has(ch.id));

	const ordered = createWeightedOrder(candidates);
	const { rounds: retryRounds, delayMs: retryDelayMs } = retryConfig;
	let lastResponse: Response | null = null;
	let lastChannel: ChannelRecord | null = null;
	const start = Date.now();
	let selectedChannel: ChannelRecord | null = null;
	let selectedModelName: string | null = effectiveModel;
	// Channel cooldown (P2): at most one failure record per channel per
	// request, so multi-round retries cannot black-hole a channel alone.
	const cooldownFailureRecorded = new Set<string>();
	// Key attribution for usage records (R3): the fp of the key that served
	// the successful response, or of the last attempted key when the request
	// ended in an error (may stay null — channels with no serviceable keys).
	let servedKeyFp: string | null = null;
	let lastAttemptKeyFp: string | null = null;

	let round = 0;
	while (round < retryRounds && !selectedChannel) {
		let shouldRetry = false;

		for (const channel of ordered) {
			lastChannel = channel;
			const apiFormat = channel.api_format ?? "openai";
			const disguisePrompt = channel.disguise_system_prompt ?? null;
			// Key-level cooldown (R1): drop cooling-down keys from this round's
			// rotation before the shuffled order is consumed. fail-open is
			// built into filterCoolingKeys — when every key is cooling the
			// full list is kept, so key cooldown never starves a channel.
			const keys = filterCoolingKeys(
				channel.id,
				shuffleArray(parseApiKeys(channel.api_key)),
			);
			let channelRetryable = false;
			// Last attempt outcome for this channel — drives the cooldown
			// accounting at the abandonment point below (design.md §判定语义).
			let channelLastResponse: Response | null = null;
			let channelLastAttemptThrew = false;
			// Key attribution resets per channel: the usage row is written for
			// `selectedChannel ?? lastChannel`, so the tag must come from the
			// last attempted channel only.
			lastAttemptKeyFp = null;

			// Determine the model name this channel actually supports
			let channelRequestText = effectiveRequestText;
			let channelOpenaiBody = openaiBody;
			let channelModelName = effectiveModel;
			if (!targetChannel && parsedBody) {
				// Check if this channel was matched via per-channel alias
				const aliasHit = hotState.channelAliasHitMap.get(channel.id);
				if (aliasHit) {
					channelModelName = aliasHit.model_id;
					const channelParsedBody = { ...parsedBody, model: channelModelName };
					channelRequestText = JSON.stringify(channelParsedBody);
					if (openaiBody) {
						channelOpenaiBody = { ...openaiBody, model: channelModelName };
					}
				}
			}

			for (const apiKey of keys) {
				// Key attribution (R3): fp of whichever key is on the wire now.
				lastAttemptKeyFp = keyFingerprint(apiKey);
				// Per-attempt response for the cooldown accounting: a fetch throw
				// and a post-response conversion throw must not be conflated —
				// any received HTTP response proves the upstream alive (design's
				// success rule applies "无论后续是否解析失败").
				let attemptResponse: Response | null = null;
				try {
					let response: Response;

					if (apiFormat === "anthropic") {
						// Pass-through: send original Anthropic body directly
						// 每格式端点覆盖：无覆盖 = normalizeBaseUrl(base_url)，与既有
						// 行为逐字节一致；有 anthropic 覆盖 = normalizeBaseUrl(override)
						const baseUrl = resolveEndpointBaseUrl(channel, "anthropic");
						const target = cfSafeUrl(`${baseUrl}/v1/messages`);
						const headers = new Headers();
						headers.set("x-api-key", String(apiKey));
						headers.set(
							"anthropic-version",
							c.req.header("anthropic-version") ?? "2023-06-01",
						);
						headers.set("content-type", "application/json");

						// Forward anthropic-beta header (needed for extended thinking, prompt caching, tool use, etc.)
						const betaHeader = c.req.header("anthropic-beta");
						if (betaHeader) {
							headers.set("anthropic-beta", betaHeader);
						}

						// 服务端客户端预设：每尝试求值一次（headers 内含当次派生的
						// 会话/消息 ID；NULL/未知 ID → null，fail-open 关闭）。
						// parsedBody 传 anthropic 入站体——与透传 body 同源，形状
						// 门禁与身份 ID 从同一对话信号派生。
						const preset = applyClientPreset(channel.disguise_preset ?? null, {
							targetFormat: "anthropic",
							parsedBody,
							isStream,
						});

						applyHeaderPolicy(
							headers,
							headerPolicy,
							channel.custom_headers_json,
							channel.disguise_headers_json,
							preset?.headers,
						);

						// Disguise prompt (#6, design §3.1) 与预设 body 合规（D5）
						// 共享同一重写 gate：无预设且无伪装时保持原文本字节级透传
						// （零重序列化，零回归）。gate 内先 transform（工具合规 +
						// 非流强制流式；形状门禁未命中返回 false）后注入伪装；
						// transform 只写 bodyCopy 顶层字段（tools 数组引擎内先拷贝
						// 再追加），不改共享 parsedBody。
						let upstreamBody = channelRequestText;
						const presetTouchesBody = preset !== null && parsedBody !== null;
						if ((disguisePrompt && parsedBody) || presetTouchesBody) {
							const bodyCopy: Record<string, unknown> = { ...parsedBody };
							if (channelModelName !== effectiveModel) {
								// Per-channel alias matched: carry the alias-resolved model
								// like the channelRequestText stringify chain does.
								bodyCopy.model = channelModelName;
							}
							let changed = false;
							if (preset) {
								changed = preset.transformBody(bodyCopy) || changed;
							}
							if (disguisePrompt) {
								injectSystemPromptAnthropic(bodyCopy, disguisePrompt);
								changed = true;
							}
							if (changed) {
								upstreamBody = JSON.stringify(bodyCopy);
							}
						}

						response = await fetch(target, {
							method: "POST",
							headers,
							body: upstreamBody,
						});
						attemptResponse = response;
						channelLastResponse = response;
						channelLastAttemptThrew = false;

						if (response.ok) {
							// Key success (R1): clear this key's cooldown window and
							// remember it as the serving key for the usage row.
							recordKeySuccess(channel.id, apiKey);
							servedKeyFp = lastAttemptKeyFp;
							selectedChannel = channel;
							selectedModelName = channelModelName;
							// 预设强制上游流式（客户端非流式入站）：上游 SSE 在网关
							// 侧聚合为标准非流 Message JSON——客户端入站协议即
							// anthropic，聚合产物即其非流形态，原样返回。聚合器入口
							// fail-open：上游未真流式（形状门禁未命中、body 未改写）
							// 时原样透传，零行为变化；客户端流式路径不进此分支。
							lastResponse =
								!isStream &&
								response.body &&
								isStreamForcingPreset(channel.disguise_preset)
									? await aggregateUpstreamStream("anthropic", response)
									: response;
							break;
						}
					} else if (apiFormat === "openai") {
						// Convert Anthropic -> OpenAI, send to OpenAI upstream
						// 每格式端点覆盖：无覆盖 = base_url 保留版本路径去尾斜杠，
						// 与既有行为逐字节一致；有 openai 覆盖 = 覆盖值去尾斜杠
						const baseUrl = resolveEndpointBaseUrl(channel, "openai");
						const target = cfSafeUrl(`${baseUrl}/chat/completions`);
						const headers = new Headers();
						headers.set("Authorization", `Bearer ${apiKey}`);
						headers.set("content-type", "application/json");
						// 服务端客户端预设：每尝试求值一次；parsedBody 传转换后的
						// chat 体（实际上游 body）——形状门禁与工具检测都作用于它
						const preset = applyClientPreset(channel.disguise_preset ?? null, {
							targetFormat: "openai",
							parsedBody: channelOpenaiBody,
							isStream,
						});
						applyHeaderPolicy(
							headers,
							headerPolicy,
							channel.custom_headers_json,
							channel.disguise_headers_json,
							preset?.headers,
						);

						let bodyToSend = channelOpenaiBody
							? JSON.stringify(channelOpenaiBody)
							: channelRequestText;
						// Disguise prompt (#7, design §3.1)、预设 body 合规（D5）与
						// 流式 usage 注入共享同一重写 gate：无预设、无伪装且客户端
						// 非流式时保持既有字节（零重序列化，零回归）。openaiCopy 是
						// 每尝试浅拷贝——共享的转换产物 channelOpenaiBody 跨重试轮/
						// Key 复用，mutate 必须落在拷贝上（inject 只写顶层字段，
						// transform 的 tools 数组在引擎内先拷贝再追加，均不污染
						// 共享体）。channelOpenaiBody 为 null（channelRequestText
						// 回退）时上游体形状未知，gate 不放行、不注入。
						const presetTouchesBody =
							preset !== null && channelOpenaiBody !== null;
						if (
							(disguisePrompt && channelOpenaiBody) ||
							presetTouchesBody ||
							(isStream && channelOpenaiBody)
						) {
							const openaiCopy: Record<string, unknown> = {
								...channelOpenaiBody,
							};
							let changed = false;
							if (preset) {
								changed = preset.transformBody(openaiCopy) || changed;
							}
							// 流式 usage 注入（恰一次的单一表达式）：客户端流式的普通
							// 路径与预设强制上游流式共用——OpenAI 兼容上游需要 usage
							// 尾 chunk 开关，否则该路径 usage 依赖上游自愿携带（存量
							// 计费缺口）；非流式请求不进此分支（字节零变化）。预设
							// 分支的 stream === true 即形状门禁已命中、transformBody
							// 已写流式标记。
							if (
								isStream ||
								(preset?.forceUpstreamStream === true &&
									openaiCopy.stream === true)
							) {
								openaiCopy.stream_options = { include_usage: true };
								changed = true;
							}
							if (disguisePrompt) {
								injectSystemPromptOpenAI(openaiCopy, disguisePrompt);
								changed = true;
							}
							if (changed) {
								bodyToSend = JSON.stringify(openaiCopy);
							}
						}

						response = await fetch(target, {
							method: "POST",
							headers,
							body: bodyToSend,
						});
						attemptResponse = response;
						channelLastResponse = response;
						channelLastAttemptThrew = false;

						if (response.ok) {
							// Key success (R1): clear this key's cooldown window and
							// remember it as the serving key for the usage row.
							recordKeySuccess(channel.id, apiKey);
							servedKeyFp = lastAttemptKeyFp;
							selectedChannel = channel;
							selectedModelName = channelModelName;
							// Convert OpenAI response back to Anthropic format
							if (isStream && response.body) {
								const transform = createOpenaiToAnthropicStreamTransform(
									effectiveModel ?? "",
								);
								const transformed = response.body.pipeThrough(transform);
								lastResponse = new Response(transformed, {
									status: 200,
									headers: {
										"content-type": "text/event-stream",
										"cache-control": "no-cache",
										connection: "keep-alive",
									},
								});
							} else {
								// 预设强制上游流式（客户端非流，else 分支即 !isStream）：
								// 上游 SSE 先聚合为 chat completion 标准非流 JSON，再走
								// 既有 openai→anthropic 非流转换链（语义零改动）。聚合
								// 器入口 fail-open：上游未真流式时原样解析，行为不变。
								const upstream = isStreamForcingPreset(channel.disguise_preset)
									? await aggregateUpstreamStream("chat", response)
									: response;
								const openaiData = (await upstream.json()) as Record<
									string,
									unknown
								>;
								const anthropicData = openaiToAnthropicResponse(openaiData);
								lastResponse = new Response(JSON.stringify(anthropicData), {
									status: 200,
									headers: { "content-type": "application/json" },
								});
							}
							break;
						}
					} else if (apiFormat === "responses") {
						// Responses target (responses↔anthropic pivot): convert
						// Anthropic → chat → Responses. channelOpenaiBody already
						// carries the alias-resolved model; the converted Responses
						// body is fresh per attempt, so preset transform and disguise
						// injection can mutate it safely (mirrors the openai branch's
						// copy discipline without an extra shallow copy). The upstream
						// stream carries its own usage in response.completed — the
						// chat-only stream_options.include_usage injection does not
						// apply to this shape.
						const baseUrl = resolveEndpointBaseUrl(channel, "responses");
						const target = cfSafeUrl(`${baseUrl}/responses`);
						const headers = new Headers();
						headers.set("Authorization", `Bearer ${apiKey}`);
						headers.set("content-type", "application/json");
						const responsesBody = channelOpenaiBody
							? openaiToResponsesRequest(channelOpenaiBody)
							: {};
						if (isStream) {
							(responsesBody as Record<string, unknown>).stream = true;
						}
						// 服务端客户端预设：每尝试求值一次；parsedBody 传转换后的
						// responses 体（实际上游 body）——形状门禁（input）与工具检测
						// 都作用于它
						const preset = applyClientPreset(channel.disguise_preset ?? null, {
							targetFormat: "responses",
							parsedBody: responsesBody,
							isStream,
						});
						applyHeaderPolicy(
							headers,
							headerPolicy,
							channel.custom_headers_json,
							channel.disguise_headers_json,
							preset?.headers,
						);
						// 先 transform（工具合规 + 非流强制流式）后注入伪装
						// （Disguise #7 responses 同款：注入 instructions）
						if (preset) {
							preset.transformBody(responsesBody as Record<string, unknown>);
						}
						if (disguisePrompt && parsedBody) {
							injectSystemPromptResponses(
								responsesBody as Record<string, unknown>,
								disguisePrompt,
							);
						}

						response = await fetch(target, {
							method: "POST",
							headers,
							body: JSON.stringify(responsesBody),
						});
						attemptResponse = response;
						channelLastResponse = response;
						channelLastAttemptThrew = false;

						if (response.ok) {
							// Key success (R1): clear this key's cooldown window and
							// remember it as the serving key for the usage row.
							recordKeySuccess(channel.id, apiKey);
							servedKeyFp = lastAttemptKeyFp;
							selectedChannel = channel;
							selectedModelName = channelModelName;
							// Convert Responses response back to Anthropic format:
							// streaming pipes responses→chat→anthropic transforms in
							// series (the intermediate chat stream never hits the
							// wire); non-stream composes the two response legs.
							if (isStream && response.body) {
								const transformed = response.body
									.pipeThrough(createResponsesToChatStreamTransform())
									.pipeThrough(
										createOpenaiToAnthropicStreamTransform(
											effectiveModel ?? "",
										),
									);
								lastResponse = new Response(transformed, {
									status: 200,
									headers: {
										"content-type": "text/event-stream",
										"cache-control": "no-cache",
										connection: "keep-alive",
									},
								});
							} else {
								// 预设强制上游流式（客户端非流，else 分支即 !isStream）：
								// 上游 SSE 先聚合为 Responses 标准非流对象
								// （response.completed 直取），再走 responses→chat→
								// anthropic 非流转换链。聚合器入口 fail-open：上游未真
								// 流式时原样解析，行为不变。
								const upstream = isStreamForcingPreset(channel.disguise_preset)
									? await aggregateUpstreamStream("responses", response)
									: response;
								const responsesData = (await upstream.json()) as Record<
									string,
									unknown
								>;
								const anthropicData =
									responsesToAnthropicResponse(responsesData);
								lastResponse = new Response(JSON.stringify(anthropicData), {
									status: 200,
									headers: { "content-type": "application/json" },
								});
							}
							break;
						}
					} else {
						// custom: forward as-is
						const target = cfSafeUrl(channel.base_url);
						const headers = new Headers();
						headers.set("Authorization", `Bearer ${apiKey}`);
						headers.set("x-api-key", String(apiKey));
						headers.set("content-type", "application/json");
						// 服务端客户端预设：custom 目标仅头生效（协议未知不解释
						// body，transform no-op、不强制流式，design D2/D5）
						const preset = applyClientPreset(channel.disguise_preset ?? null, {
							targetFormat: "custom",
							parsedBody,
							isStream,
						});
						// custom (#8, design §3.1): body forwarded as-is, headers only
						applyHeaderPolicy(
							headers,
							headerPolicy,
							channel.custom_headers_json,
							channel.disguise_headers_json,
							preset?.headers,
						);

						response = await fetch(target, {
							method: "POST",
							headers,
							body: channelRequestText,
						});
						attemptResponse = response;
						channelLastResponse = response;
						channelLastAttemptThrew = false;

						if (response.ok) {
							// Key success (R1): clear this key's cooldown window and
							// remember it as the serving key for the usage row.
							recordKeySuccess(channel.id, apiKey);
							servedKeyFp = lastAttemptKeyFp;
							selectedChannel = channel;
							selectedModelName = channelModelName;
							lastResponse = response;
							break;
						}
					}

					lastResponse = response;
					if (response.status === 401 || response.status === 403) {
						// Key-level auth failure (R1/R2, intentional client-visible
						// behavior change): the credential is very likely dead —
						// cool this key for 10 minutes and fail over to the next
						// key (previously: break). NOT a channel failure — the
						// upstream answered, proving it alive — so channelRetryable
						// stays unset and the abandonment-point accounting keeps
						// treating 401/403 as channel success (attribution split).
						recordKeyAuthFailure(channel.id, apiKey);
						continue;
					}
					if (isRetryableStatus(response.status)) {
						// 408/429/5xx: upstream pressure, not a dead key — short
						// key cooldown, then the existing semantics (next key +
						// channel retryable).
						recordKeyRetryableFailure(channel.id, apiKey);
						channelRetryable = true;
					} else {
						// Other non-retryable 4xx (400/404/413/422…): request-level
						// error, another key cannot help — no key cooldown, skip
						// remaining keys (unchanged).
						break;
					}
				} catch {
					lastResponse = null;
					if (attemptResponse === null) {
						// fetch itself threw (network error): no HTTP response was
						// received on this attempt — the accounting must reflect that
						channelLastResponse = null;
						channelLastAttemptThrew = true;
						// Network error cools the key briefly (R1): same family as
						// the retryable statuses.
						recordKeyRetryableFailure(channel.id, apiKey);
					}
					// else: a response arrived but downstream conversion/parse
					// failed — channelLastResponse keeps it as alive-proof, and
					// the key itself did its job (no key cooldown).
					channelRetryable = true;
				}
			}

			if (selectedChannel) {
				// Any ok response proves the upstream alive — clears its failure
				// streak immediately (recovered channels serve again without
				// waiting out the cooldown window).
				recordChannelSuccess(channel.id);
				break;
			}
			// Channel abandoned for this request (P2 cooldown accounting): the
			// last attempt decides — a network error (fetch threw, no response)
			// or a retryable status (408/429/5xx) records one failure per channel
			// per request (the set guard keeps multi-round retries from stacking,
			// never from flipping a failure into a success); any other received
			// HTTP response (non-retryable 4xx, or an ok response whose
			// conversion failed) proves the upstream alive and clears the streak.
			const lastFailedRetryably =
				channelLastAttemptThrew ||
				(channelLastResponse !== null &&
					isRetryableStatus(channelLastResponse.status));
			if (lastFailedRetryably) {
				if (!cooldownFailureRecorded.has(channel.id)) {
					cooldownFailureRecorded.add(channel.id);
					recordChannelFailure(channel.id);
				}
			} else if (channelLastResponse !== null) {
				recordChannelSuccess(channel.id);
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
	const requestPath = "/anthropic/v1/messages";

	if (!lastResponse) {
		// Usage recording is post-response: never blocks the error reply
		// (waitUntil when available, fire-and-forget otherwise).
		runPostResponse(c, () =>
			recordUsage(c.env.DB, {
				tokenId: tokenRecord.id,
				model: effectiveModel,
				requestPath,
				totalTokens: 0,
				latencyMs,
				firstTokenLatencyMs: isStream ? null : latencyMs,
				stream: isStream,
				status: "error",
				errorMessage: "upstream_unavailable",
				// Last-attempt key attribution (R3); null when no key was ever
				// put on the wire.
				keyTag: lastAttemptKeyFp,
			}),
		);
		return jsonError(c, 502, "upstream_unavailable", "upstream_unavailable");
	}

	// Record usage
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
		const recordFn = async (
			usage: NormalizedUsage | null,
			firstTokenLatencyMs?: number | null,
			// 流式成功路径传入「起点 → 流尾」总时长（parseUsageFromSse 的
			// elapsedMs），替代 headers 时刻的 latencyMs；SSE 解析失败回退与
			// 非流式路径不传，保持旧值。
			streamLatencyMs?: number | null,
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
			await recordUsage(c.env.DB, {
				tokenId: tokenRecord.id,
				userId: tokenRecord.user_id,
				channelId: channelForUsage.id,
				model: effectiveModel,
				requestPath,
				totalTokens: normalized.totalTokens,
				promptTokens: normalized.promptTokens,
				completionTokens: normalized.completionTokens,
				cachedInputTokens: normalized.cachedInputTokens,
				cacheCreationTokens: normalized.cacheCreationTokens,
				cost,
				latencyMs: streamLatencyMs ?? latencyMs,
				firstTokenLatencyMs:
					firstTokenLatencyMs ?? (isStream ? null : latencyMs),
				stream: isStream,
				status: lastResponse.ok ? "ok" : "error",
				errorCode,
				errorMessage,
				// Key attribution (R3): the serving key on success, the last
				// attempted key when the request ended in an upstream error.
				keyTag: lastResponse.ok ? servedKeyFp : lastAttemptKeyFp,
			});
		};

		const headerUsage = parseUsageFromHeaders(lastResponse.headers);

		if (isStream) {
			const task = parseUsageFromSse(lastResponse.clone(), start)
				.then((streamUsage) => {
					const usage = headerUsage ?? streamUsage.usage;
					return recordFn(
						usage,
						streamUsage.firstTokenLatencyMs,
						streamUsage.elapsedMs,
					);
				})
				.catch(async () => {
					// SSE parsing failed (stream interrupted, etc.) — still record with whatever we have
					try {
						await recordFn(headerUsage, null);
					} catch {
						/* truly lost */
					}
				});
			// Same helper as proxy.ts: waitUntil when a Workers ExecutionContext is
			// available, fire-and-forget otherwise. This also fixes the former bare
			// `(c as {executionCtx}).executionCtx` assertion, whose getter throws
			// outside the Workers runtime (quality-guidelines gotcha).
			runPostResponse(c, () => task);
		} else {
			let jsonUsage: NormalizedUsage | null = null;
			if (
				lastResponse.ok &&
				lastResponse.headers.get("content-type")?.includes("application/json")
			) {
				const data = await lastResponse
					.clone()
					.json()
					.catch(() => null);
				if (data && typeof data === "object") {
					const anthropicUsage = (data as Record<string, unknown>).usage;
					if (anthropicUsage) {
						jsonUsage = normalizeUsage(anthropicUsage);
					}
				}
			}
			// Non-stream responses no longer await the usage write — billing lands
			// post-response (waitUntil / fire-and-forget degradation).
			runPostResponse(c, () => recordFn(jsonUsage ?? headerUsage, latencyMs));
		}
	}

	return lastResponse;
});

/**
 * POST /messages/count_tokens — Anthropic token counting endpoint (Claude Code
 * calls this frequently for context management; previously a 404).
 *
 * Semantics (task 10-26-count-tokens-endpoint):
 * - Model governance identical to /messages: token/user allowlists,
 *   `channel/model` routing syntax, per-channel alias resolution, unknown
 *   model 404 — shared helpers guarantee the same chain.
 * - anthropic-target channel: single upstream probe to
 *   `{resolveEndpointBaseUrl(channel,"anthropic")}/v1/messages/count_tokens`,
 *   response passed through untouched. No retries and no channel failover —
 *   on any failure (network error / non-2xx) degrade to the local estimate.
 * - Non-anthropic targets (openai/responses/custom): no upstream request at
 *   all, local coarse estimate (estimateCountTokensResponse).
 * - Zero-cost discipline (R5): no usage_logs writes, no quota/balance
 *   mutation, no cooldown accounting — tokenAuth's existing precheck is the
 *   only billing-adjacent gate.
 */
anthropicProxy.post("/messages/count_tokens", tokenAuth, async (c) => {
	const tokenRecord = c.get("tokenRecord") as TokenRecord;
	const requestText = await c.req.text();
	const parsedBody = requestText
		? safeJsonParse<Record<string, unknown> | null>(requestText, null)
		: null;
	const model =
		parsedBody?.model !== undefined && parsedBody?.model !== null
			? String(parsedBody.model)
			: null;

	// Token-level and user-level model allowlists — same gate as /messages:
	// each list independently gates the requested model name (exact match,
	// alias unresolved) before any channel routing work.
	if (
		!isModelAllowedByAll(
			[tokenRecord.token_allowed_models, tokenRecord.user_allowed_models],
			model,
		)
	) {
		return jsonError(c, 403, "model_not_allowed", "model_not_allowed");
	}

	const hotState = await loadAnthropicProxyHotState(c.env.DB, model);
	const {
		targetChannel,
		actualModel,
		candidates: modelCandidates,
	} = selectAnthropicInboundCandidates(model, tokenRecord, hotState);
	if (modelCandidates.length === 0) {
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
	const routed = routeAnthropicTargetFormats(modelCandidates);
	if (routed.length === 0) {
		return jsonError(c, 503, "no_available_channels", "no_available_channels");
	}

	// Model rewrite chain mirrors /messages: `channel/model` routing syntax
	// first, then the selected channel's per-channel alias hit (below).
	let bodyToSend = requestText;
	if (targetChannel && parsedBody && actualModel !== null) {
		bodyToSend = JSON.stringify({ ...parsedBody, model: actualModel });
	}

	// Only anthropic-target channels get a real upstream count; everything
	// else (openai/responses/custom target) estimates locally with zero
	// upstream traffic. Cooldown applies at the same eligibility tier as
	// /messages (fail-open when every candidate is cooling); count_tokens
	// itself never records cooldown failures/successes.
	const anthropicTargets = routed.filter(
		(ch) => (ch.api_format ?? "openai") === "anthropic",
	);
	const nonCoolingIds = new Set(
		filterCoolingChannels(anthropicTargets.map((ch) => ch.id)),
	);
	const pool = anthropicTargets.filter((ch) => nonCoolingIds.has(ch.id));
	if (pool.length === 0) {
		return estimateCountTokensResponse(parsedBody, requestText);
	}
	// Light query: one weighted pick, one attempt — no retry rounds (R5).
	const channel = createWeightedOrder(pool)[0];
	const aliasHit = hotState.channelAliasHitMap.get(channel.id);
	if (!targetChannel && parsedBody && aliasHit) {
		bodyToSend = JSON.stringify({ ...parsedBody, model: aliasHit.model_id });
	}

	const baseUrl = resolveEndpointBaseUrl(channel, "anthropic");
	const target = cfSafeUrl(`${baseUrl}/v1/messages/count_tokens`);
	const headers = new Headers();
	const apiKey = shuffleArray(parseApiKeys(channel.api_key))[0] ?? "";
	headers.set("x-api-key", String(apiKey));
	headers.set(
		"anthropic-version",
		c.req.header("anthropic-version") ?? "2023-06-01",
	);
	headers.set("content-type", "application/json");
	// Forward anthropic-beta like the /messages anthropic branch (counting
	// semantics can differ per beta feature).
	const betaHeader = c.req.header("anthropic-beta");
	if (betaHeader) {
		headers.set("anthropic-beta", betaHeader);
	}
	applyHeaderPolicy(
		headers,
		parseHeaderPolicyFromRaw(hotState.proxySettings),
		channel.custom_headers_json,
		channel.disguise_headers_json,
	);

	try {
		const response = await fetch(target, {
			method: "POST",
			headers,
			body: bodyToSend,
		});
		if (response.ok) {
			// Upstream count passes through untouched ({input_tokens}); no
			// usage recording, no quota mutation.
			return response;
		}
	} catch {
		// Network error — degrade to the local estimate below.
	}
	// Upstream non-2xx or network error: no retry, no channel failover.
	return estimateCountTokensResponse(parsedBody, requestText);
});

export default anthropicProxy;
