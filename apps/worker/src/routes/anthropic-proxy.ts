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
import { aggregateUpstreamStream } from "../services/stream-aggregate";
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
						// Disguise prompt (#7, design §3.1) 与预设 body 合规（D5）
						// 共享同一重写 gate：无预设且无伪装时保持既有字节（零重
						// 序列化，零回归）。openaiCopy 是每尝试浅拷贝——共享的转换
						// 产物 channelOpenaiBody 跨重试轮/Key 复用，mutate 必须落在
						// 拷贝上（inject 只写顶层字段，transform 的 tools 数组在
						// 引擎内先拷贝再追加，均不污染共享体）。
						const presetTouchesBody =
							preset !== null && channelOpenaiBody !== null;
						if ((disguisePrompt && channelOpenaiBody) || presetTouchesBody) {
							const openaiCopy: Record<string, unknown> = {
								...channelOpenaiBody,
							};
							let changed = false;
							if (preset) {
								changed = preset.transformBody(openaiCopy) || changed;
								if (preset.forceUpstreamStream && openaiCopy.stream === true) {
									// 强制流式的 chat 上游同样需要 usage 尾 chunk（上游真
									// 流式才有 usage 可解析）；stream === true 即形状门禁
									// 已命中、transformBody 已写流式标记。
									openaiCopy.stream_options = { include_usage: true };
									changed = true;
								}
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
