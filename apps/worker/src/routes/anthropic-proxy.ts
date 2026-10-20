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
	anthropicToOpenaiRequest,
	createOpenaiToAnthropicStreamTransform,
	openaiToAnthropicResponse,
} from "../services/format-converter";
import {
	loadChannelAliasesByAlias,
	loadChannelAliasOnlyMap,
} from "../services/model-aliases";
import { calculateCost, getModelPrice } from "../services/pricing";
import {
	loadProxySettingsCached,
	resolveProxyRetryConfig,
} from "../services/settings";
import { recordUsage } from "../services/usage";
import {
	injectSystemPromptAnthropic,
	injectSystemPromptOpenAI,
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
	// 每次照常执行。
	const [
		channelAliasHits,
		perChannelAliasOnlyMap,
		activeChannels,
		proxySettings,
	] = await Promise.all([
		model ? loadChannelAliasesByAlias(c.env.DB, model) : Promise.resolve([]),
		loadChannelAliasOnlyMap(c.env.DB),
		getActiveChannelsCached(c.env.DB),
		loadProxySettingsCached(c.env.DB),
	]);
	const channelAliasHitMap = new Map(
		channelAliasHits.map((h) => [h.channel_id, h]),
	);
	const headerPolicy = parseHeaderPolicyFromRaw(proxySettings);
	const retryConfig = resolveProxyRetryConfig(proxySettings, {
		rounds: c.env.PROXY_RETRY_ROUNDS,
		delayMs: c.env.PROXY_RETRY_DELAY_MS,
	});

	// Convert Anthropic request -> OpenAI format for internal use
	const openaiBody = parsedBody ? anthropicToOpenaiRequest(parsedBody) : null;

	// Resolve channel/model routing syntax (uses original model name)
	const { targetChannel, actualModel } = resolveChannelRoute(
		model,
		activeChannels,
	);
	const effectiveModel = targetChannel ? actualModel : model;

	// If channel routing matched, replace model in the request bodies
	let effectiveRequestText = requestText;
	if (targetChannel && parsedBody && actualModel !== null) {
		parsedBody.model = actualModel;
		effectiveRequestText = JSON.stringify(parsedBody);
		if (openaiBody) {
			(openaiBody as Record<string, unknown>).model = actualModel;
		}
	}

	let candidates: ChannelRecord[];
	if (targetChannel) {
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

	// Routing matrix (design.md §3): pick each channel's target format for the
	// Anthropic inbound protocol. responses-declared-only channels have no
	// responses→anthropic conversion and are dropped (design.md D2/D5); a
	// channel declaring ["anthropic","openai"] targets its native anthropic
	// format. The target rides on a shallow copy (api_format overridden) so
	// the per-format branches below act on it unchanged.
	candidates = candidates.flatMap((ch) => {
		const targetFormat = selectTargetFormat(parseApiFormats(ch), "anthropic");
		return targetFormat ? [{ ...ch, api_format: targetFormat }] : [];
	});
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

	let round = 0;
	while (round < retryRounds && !selectedChannel) {
		let shouldRetry = false;

		for (const channel of ordered) {
			lastChannel = channel;
			const apiFormat = channel.api_format ?? "openai";
			const disguisePrompt = channel.disguise_system_prompt ?? null;
			const keys = shuffleArray(parseApiKeys(channel.api_key));
			let channelRetryable = false;
			// Last attempt outcome for this channel — drives the cooldown
			// accounting at the abandonment point below (design.md §判定语义).
			let channelLastResponse: Response | null = null;
			let channelLastAttemptThrew = false;

			// Determine the model name this channel actually supports
			let channelRequestText = effectiveRequestText;
			let channelOpenaiBody = openaiBody;
			let channelModelName = effectiveModel;
			if (!targetChannel && parsedBody) {
				// Check if this channel was matched via per-channel alias
				const aliasHit = channelAliasHitMap.get(channel.id);
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

						applyHeaderPolicy(
							headers,
							headerPolicy,
							channel.custom_headers_json,
							channel.disguise_headers_json,
						);

						// Disguise prompt (#6, design §3.1): inject into a per-attempt
						// copy of the parsed Anthropic body via the same stringify chain
						// as effectiveRequestText. Without a prompt the original text
						// passes through byte-identical (zero regression).
						let upstreamBody = channelRequestText;
						if (disguisePrompt && parsedBody) {
							const bodyCopy: Record<string, unknown> = { ...parsedBody };
							if (channelModelName !== effectiveModel) {
								// Per-channel alias matched: carry the alias-resolved model
								// like the channelRequestText stringify chain does.
								bodyCopy.model = channelModelName;
							}
							injectSystemPromptAnthropic(bodyCopy, disguisePrompt);
							upstreamBody = JSON.stringify(bodyCopy);
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
							selectedChannel = channel;
							selectedModelName = channelModelName;
							lastResponse = response;
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
						applyHeaderPolicy(
							headers,
							headerPolicy,
							channel.custom_headers_json,
							channel.disguise_headers_json,
						);

						let bodyToSend = channelOpenaiBody
							? JSON.stringify(channelOpenaiBody)
							: channelRequestText;
						// Disguise prompt (#7, design §3.1): inject into a per-attempt
						// shallow copy — the inject function only assigns top-level
						// fields, so the shared converted body is never mutated.
						if (disguisePrompt && channelOpenaiBody) {
							const openaiCopy: Record<string, unknown> = {
								...channelOpenaiBody,
							};
							injectSystemPromptOpenAI(openaiCopy, disguisePrompt);
							bodyToSend = JSON.stringify(openaiCopy);
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
								const openaiData = (await response.json()) as Record<
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
					} else {
						// custom: forward as-is
						const target = cfSafeUrl(channel.base_url);
						const headers = new Headers();
						headers.set("Authorization", `Bearer ${apiKey}`);
						headers.set("x-api-key", String(apiKey));
						headers.set("content-type", "application/json");
						// custom (#8, design §3.1): body forwarded as-is, headers only
						applyHeaderPolicy(
							headers,
							headerPolicy,
							channel.custom_headers_json,
							channel.disguise_headers_json,
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
							selectedChannel = channel;
							selectedModelName = channelModelName;
							lastResponse = response;
							break;
						}
					}

					lastResponse = response;
					if (isRetryableStatus(response.status)) {
						channelRetryable = true;
					} else {
						break;
					}
				} catch {
					lastResponse = null;
					if (attemptResponse === null) {
						// fetch itself threw (network error): no HTTP response was
						// received on this attempt — the accounting must reflect that
						channelLastResponse = null;
						channelLastAttemptThrew = true;
					}
					// else: a response arrived but downstream conversion/parse
					// failed — channelLastResponse keeps it as alive-proof
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
				latencyMs,
				firstTokenLatencyMs:
					firstTokenLatencyMs ?? (isStream ? null : latencyMs),
				stream: isStream,
				status: lastResponse.ok ? "ok" : "error",
				errorCode,
				errorMessage,
			});
		};

		const headerUsage = parseUsageFromHeaders(lastResponse.headers);

		if (isStream) {
			const task = parseUsageFromSse(lastResponse.clone())
				.then((streamUsage) => {
					const usage = headerUsage ?? streamUsage.usage;
					return recordFn(usage, streamUsage.firstTokenLatencyMs);
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

export default anthropicProxy;
