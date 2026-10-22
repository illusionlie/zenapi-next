import { Hono } from "hono";
import type { AppEnv } from "../env";
import { collectUniqueModelIds } from "../services/channel-models";
import { selectTargetFormat } from "../services/channel-routing";
import { parseApiFormats } from "../services/channel-types";
import { type ChannelRecord, createWeightedOrder } from "../services/channels";
import { isStreamForcingPreset } from "../services/client-presets";
import {
	loadProxyRetryConfig,
	loadProxySettingsCached,
	resolveDeveloperNormalizeFlag,
} from "../services/settings";
import {
	aggregateUpstreamStream,
	protocolForTargetFormat,
} from "../services/stream-aggregate";
import { jsonError } from "../utils/http";
import { parseApiKeys, shuffleArray } from "../utils/keys";
import { isRetryableStatus, sleep } from "../utils/retry";
import {
	buildChannelRequest,
	channelSupportsModel,
	convertResponse,
} from "./proxy";

const playground = new Hono<AppEnv>();

/**
 * Returns all unique model IDs from active channels, sorted alphabetically.
 */
playground.get("/models", async (c) => {
	const channelResult = await c.env.DB.prepare(
		"SELECT * FROM channels WHERE status = ?",
	)
		.bind("active")
		.all();
	const channels = (channelResult.results ?? []) as ChannelRecord[];
	const modelIds = collectUniqueModelIds(channels);
	return c.json({ models: modelIds.sort() });
});

/**
 * Simplified proxy for admin chat testing.
 * No usage recording, no balance deduction.
 */
playground.post("/chat", async (c) => {
	const body = await c.req.json<{
		model: string;
		messages: Array<{ role: string; content: string }>;
		stream?: boolean;
	}>();

	const { model, messages, stream: isStream = true } = body;

	if (!model || !messages || messages.length === 0) {
		return jsonError(
			c,
			400,
			"invalid_request",
			"model and messages are required",
		);
	}

	// Build OpenAI-compatible request body
	const requestBody: Record<string, unknown> = {
		model,
		messages,
		stream: isStream,
	};
	if (isStream) {
		requestBody.stream_options = { include_usage: true };
	}
	const requestText = JSON.stringify(requestBody);

	// Find active channels supporting this model
	const channelResult = await c.env.DB.prepare(
		"SELECT * FROM channels WHERE status = ?",
	)
		.bind("active")
		.all();
	const activeChannels = (channelResult.results ?? []) as ChannelRecord[];
	// Chat inbound (design.md §3.1): playground targets the chat completions
	// protocol, so each channel's target format comes from the shared routing
	// matrix with inbound="chat" (every declared format is serviceable —
	// openai/custom natively, responses/anthropic via the existing conversion
	// branches — so single-format routing is unchanged, AC13). The target
	// rides on a shallow copy (api_format overridden) for
	// buildChannelRequest/convertResponse.
	const candidates = activeChannels.flatMap((ch) => {
		if (!channelSupportsModel(ch, model)) {
			return [];
		}
		const targetFormat = selectTargetFormat(parseApiFormats(ch), "chat");
		return targetFormat ? [{ ...ch, api_format: targetFormat }] : [];
	});

	if (candidates.length === 0) {
		return jsonError(c, 503, "no_available_channels", "no_available_channels");
	}

	const ordered = createWeightedOrder(candidates);
	const targetPath = "/v1/chat/completions";
	// 该路径无并行预载块，循环前单次读取重试配置（settings → env → 内置默认）
	const { rounds: retryRounds, delayMs: retryDelayMs } =
		await loadProxyRetryConfig(c.env.DB, {
			rounds: c.env.PROXY_RETRY_ROUNDS,
			delayMs: c.env.PROXY_RETRY_DELAY_MS,
		});
	// developer 归一化开关：经 30s TTL 缓存的代理 settings 快照解析（两级链
	// 无 env 回退），与主代理 / test-model 行为一致
	const normalizeDeveloperRole = resolveDeveloperNormalizeFlag(
		await loadProxySettingsCached(c.env.DB),
	);
	let lastResponse: Response | null = null;

	let round = 0;
	while (round < retryRounds) {
		let shouldRetry = false;
		for (const channel of ordered) {
			const keys = shuffleArray(parseApiKeys(channel.api_key));
			let channelRetryable = false;

			for (const apiKey of keys) {
				const incomingHeaders = new Headers();
				incomingHeaders.set("content-type", "application/json");

				// 豁免全局请求头策略：Playground 对话测试不注入/剔除全局头，
				// 不传 policy（默认 null），渠道级 custom_headers 仍生效。
				// 伪装头/提示词不受豁免（D4）：完整传入渠道两字段
				const {
					target,
					headers,
					body: channelBody,
				} = buildChannelRequest(
					channel,
					targetPath,
					"",
					incomingHeaders,
					requestText,
					requestBody,
					isStream,
					apiKey,
					null,
					channel.disguise_system_prompt ?? null,
					normalizeDeveloperRole,
				);

				try {
					const response = await fetch(target, {
						method: "POST",
						headers,
						body: channelBody,
					});

					if (response.ok) {
						// 预设强制上游流式（客户端非流）：与主代理同构——上游 SSE
						// 先聚合为标准非流 JSON 再喂 convertResponse。聚合器入口
						// fail-open 覆盖形状门禁未命中（上游未真流式）的场景；
						// 客户端流式请求不进此分支，流式路径结构不变。
						let upstream = response;
						if (
							!isStream &&
							response.body &&
							channel.api_format !== "custom" &&
							isStreamForcingPreset(channel.disguise_preset)
						) {
							upstream = await aggregateUpstreamStream(
								protocolForTargetFormat(channel.api_format),
								response,
							);
						}
						lastResponse = await convertResponse(
							channel,
							upstream,
							isStream,
							targetPath,
						);
						// Return immediately on success
						if (isStream && lastResponse.body) {
							return new Response(lastResponse.body, {
								status: 200,
								headers: {
									"content-type": "text/event-stream",
									"cache-control": "no-cache",
									connection: "keep-alive",
								},
							});
						}
						return lastResponse;
					}

					lastResponse = response;
					if (isRetryableStatus(response.status)) {
						channelRetryable = true;
					} else {
						break;
					}
				} catch {
					lastResponse = null;
					channelRetryable = true;
				}
			}

			if (channelRetryable) {
				shouldRetry = true;
			}
		}

		if (!shouldRetry) break;
		round += 1;
		if (round < retryRounds) {
			await sleep(retryDelayMs);
		}
	}

	if (!lastResponse) {
		return jsonError(c, 502, "upstream_unavailable", "upstream_unavailable");
	}
	return lastResponse;
});

export default playground;
