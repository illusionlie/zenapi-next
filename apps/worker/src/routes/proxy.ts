import { Hono } from "hono";
import type { AppEnv } from "../env";
import { type TokenRecord, tokenAuth } from "../middleware/tokenAuth";
import {
	filterCoolingChannels,
	recordChannelFailure,
	recordChannelSuccess,
} from "../services/channel-cooldown";
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
	getActiveChannelsCached,
} from "../services/channels";
import {
	applyClientPreset,
	isStreamForcingPreset,
} from "../services/client-presets";
import {
	anthropicToOpenaiResponse,
	createAnthropicToOpenaiStreamTransform,
	createOpenaiToResponsesStreamTransform,
	createResponsesToChatStreamTransform,
	normalizeChatDeveloperRole,
	normalizeResponsesDeveloperRole,
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
import {
	loadProxySettingsCached,
	resolveDeveloperNormalizeFlag,
	resolveProxyRetryConfig,
} from "../services/settings";
import {
	aggregateUpstreamStream,
	protocolForTargetFormat,
} from "../services/stream-aggregate";
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
import { runPostResponse } from "../utils/post-response";
import {
	applyHeaderPolicy,
	type ProxyHeaderPolicy,
	parseHeaderPolicyFromRaw,
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
 * 预设头 → 伪装头 → 渠道级）。disguisePrompt 为渠道伪装系统提示词（design §3.1 矩阵）：
 * openai 透传仅 chat 入站注入（messages 为数组时，mutate 后重新 stringify）；
 * openai 目标 + /v1/responses 入站在转换后的 chat 体 messages 注入；
 * anthropic / responses 分支转换完成后注入；/v1/responses 透传注入
 * instructions；custom 分支不解释 body 仅注入头。
 * normalizeDeveloperRole 为设置开关（normalize_developer_role，默认 false）：
 * 仅作用于 openai 协议族两处裸透传（chat 透传的 messages / responses 原生
 * 透传的 input message item），把 role:"developer" 原位改名为 "system"；
 * 与 disguisePrompt 共享同一次 bodyCopy 拷贝与 stringify（先归一化后注入），
 * 无 developer 且无伪装时回退字节级 requestText（不重序列化）。anthropic /
 * responses 转换分支（已 hoist）与 custom 分支不受影响。
 * disguise_preset 为渠道服务端客户端预设（services/client-presets.ts）：函数
 * 开头按（渠道行预设 ID, 目标格式, parsedBody, isStream）求值一次，NULL /
 * 未知 ID → null（fail-open），全部分支保持无预设的既有结构与字节输出。headers
 * 经 applyHeaderPolicy 第 5 参注入（预设层已求值、字面值不解释模板；顺序保证
 * 全局剔除可删预设头、全局注入不覆盖预设头、伪装 / custom 可覆盖预设）；body
 * 合规（工具注入 + 非流客户端强制上游流式）按 design D5 接线表在副本 / 转换
 * 产物上 transform——custom 目标仅头生效不解释 body，裸透传 gate 并入预设且
 * transform 无修改、无其他动作时回退 requestText（零重序列化，不重序列化即
 * 不落任何副本）。
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
	normalizeDeveloperRole?: boolean,
): { target: string; headers: Headers; body: string | undefined } {
	const effectiveKey = apiKey ?? channel.api_key;
	const apiFormat = channel.api_format ?? "openai";
	const headerPolicy = policy ?? null;
	const headers = new Headers(incomingHeaders);
	headers.delete("host");
	headers.delete("content-length");
	// 服务端客户端预设：每请求求值一次（headers 内含当次派生的会话/消息 ID）。
	// NULL/未知 ID 在引擎内首行短路返回 null——无预设路径不做任何额外工作。
	const preset = applyClientPreset(channel.disguise_preset ?? null, {
		targetFormat: apiFormat,
		parsedBody,
		isStream,
	});

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
			preset?.headers,
		);

		const anthropicBody = parsedBody
			? openaiToAnthropicRequest(parsedBody)
			: {};
		if (isStream) {
			(anthropicBody as Record<string, unknown>).stream = true;
		}
		// 预设 body 合规（工具注入 + 非流强制流式）：转换产物是每次新建的
		// fresh body，mutate 不会泄漏跨重试轮；该分支本就重序列化。先 transform
		// 后注入伪装（两者互不触碰对方字段，顺序仅约定）。
		if (preset && parsedBody !== null) {
			preset.transformBody(anthropicBody as Record<string, unknown>);
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
			// pristine across retry rounds and channels. Developer-role
			// normalization (normalize_developer_role) rides the same rewrite
			// gate (design D4, single stringify): input items are cloned per-item
			// before the in-place rename so the caller's shared parsed body never
			// mutates — otherwise a retry after a successful rename would find no
			// developer left and fall back to the un-normalized requestText.
			target = cfSafeUrl(`${baseUrl}/responses${querySuffix}`);
			const shouldNormalizeInput =
				normalizeDeveloperRole === true && parsedBody !== null;
			// 预设 body 合规并入同一 gate（design D5）：仅在确有入站 body 时
			// 进入重写路径——无预设时该条件恒 false，gate 与既有结构逐字节一致。
			const presetTouchesBody = preset !== null && parsedBody !== null;
			if (
				(disguisePrompt && parsedBody) ||
				shouldNormalizeInput ||
				presetTouchesBody
			) {
				const bodyCopy: Record<string, unknown> = { ...parsedBody };
				if (shouldNormalizeInput && Array.isArray(bodyCopy.input)) {
					// Per-item clone before the in-place rename: the caller's shared
					// parsed body must stay pristine across retry rounds (a rename
					// leaking into it would make a retry find no developer left and
					// fall back to the un-normalized requestText).
					bodyCopy.input = (bodyCopy.input as unknown[]).map((item) =>
						item && typeof item === "object"
							? { ...(item as Record<string, unknown>) }
							: item,
					);
				}
				let changed = false;
				if (preset) {
					// 先 transform（工具合规 + 非流强制流式）后注入伪装；transform
					// 只写 bodyCopy 顶层字段（tools 数组引擎内先拷贝再追加），不改
					// 共享 parsedBody。返回 false 且无其他动作 → 下方回退 requestText
					// （零重序列化，字节级透传）。
					if (preset.transformBody(bodyCopy)) {
						changed = true;
					}
				}
				if (shouldNormalizeInput) {
					changed = normalizeResponsesDeveloperRole(bodyCopy) || changed;
				}
				if (disguisePrompt && parsedBody) {
					injectSystemPromptResponses(bodyCopy, disguisePrompt);
					changed = true;
				}
				// Flag on but no developer item found and no disguise fired → keep
				// the original requestText (byte-identical passthrough, no
				// re-serialization, AC1/AC2).
				body = changed ? JSON.stringify(bodyCopy) : requestText || undefined;
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
			// 预设 body 合规：转换产物 fresh，mutate 不泄漏；该分支本就重序列化
			// （无零重序列化诉求）。
			if (preset && parsedBody !== null) {
				preset.transformBody(responsesBody as Record<string, unknown>);
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
			preset?.headers,
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
		// 预设同理：仅头生效（预设引擎对 custom 目标的 transformBody 本就是
		// no-op，此处亦不设调用点——协议未知不解释 body，design D5）。
		applyHeaderPolicy(
			headers,
			headerPolicy,
			channel.custom_headers_json,
			channel.disguise_headers_json,
			preset?.headers,
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
		} else if (preset?.forceUpstreamStream === true) {
			// 预设强制上游流式（客户端非流）与 handler 层注入条件同源：上游真
			// 流式才有 usage 尾 chunk 可解析。stream 字段由下方 transformBody
			// 写入，此处只补 include_usage。
			(chatBody as Record<string, unknown>).stream_options = {
				include_usage: true,
			};
		}
		// 预设 body 合规（工具注入 + 非流强制流式）：转换产物 fresh，mutate
		// 不泄漏；该分支本就重序列化。先 transform 后注入伪装。
		if (preset && parsedBody !== null) {
			preset.transformBody(chatBody as Record<string, unknown>);
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
		preset?.headers,
	);
	// Disguise prompt (#1, design §3.1): chat inbound only — inject into a
	// per-call copy of the parsed body (messages array cloned) so the caller's
	// shared parsed body never accumulates injections across retry rounds and
	// channels. Embeddings and other bodies without a messages array pass
	// through untouched, same as the stream_options injection precedent.
	// Developer-role normalization (normalize_developer_role setting) rides
	// the same rewrite gate (design D4, single stringify): messages are cloned
	// per-item before the in-place rename so the caller's shared parsed body
	// never mutates — otherwise a retry after a successful rename would find
	// no developer left and fall back to the un-normalized requestText. Flag
	// on with no developer message and no disguise → body stays byte-identical
	// requestText (no re-serialization, AC1/AC2).
	// 预设 body 合规并入同一 gate（design D5）：仅在确有入站 body 时进入重写
	// 路径——无预设时该条件恒 false，gate 与既有结构逐字节一致。gate 内先
	// transform 后归一化/注入伪装；transform 返回 false 且无其他动作时
	// changed 保持 false → 回退字节级 requestText（零重序列化）。
	let body: string | undefined = requestText || undefined;
	const shouldNormalizeDeveloper =
		normalizeDeveloperRole === true &&
		parsedBody !== null &&
		Array.isArray(parsedBody.messages);
	const injectDisguisePrompt =
		Boolean(disguisePrompt) &&
		parsedBody !== null &&
		isConvertedChatPath(targetPath) &&
		Array.isArray(parsedBody.messages);
	const presetTouchesBody = preset !== null && parsedBody !== null;
	if (shouldNormalizeDeveloper || injectDisguisePrompt || presetTouchesBody) {
		const bodyCopy: Record<string, unknown> = { ...parsedBody };
		if (Array.isArray(bodyCopy.messages)) {
			const items = bodyCopy.messages as unknown[];
			// Normalize path: per-item clone before the in-place rename — the
			// caller's shared parsed body must stay pristine across retry rounds
			// (a rename leaking into it would make a retry find no developer left
			// and fall back to the un-normalized requestText). Disguise /
			// preset-only path: plain array clone, unchanged behavior.
			bodyCopy.messages = shouldNormalizeDeveloper
				? items.map((msg) =>
						msg && typeof msg === "object"
							? { ...(msg as Record<string, unknown>) }
							: msg,
					)
				: [...items];
		}
		let changed = false;
		if (preset) {
			// transformBody 只写 bodyCopy 顶层字段（tools 数组在引擎内先拷贝
			// 再追加），绝不触碰共享 parsedBody——重试轮/换渠道不累积。
			if (preset.transformBody(bodyCopy)) {
				changed = true;
			}
		}
		if (shouldNormalizeDeveloper) {
			changed = normalizeChatDeveloperRole(bodyCopy) || changed;
		}
		if (disguisePrompt && isConvertedChatPath(targetPath)) {
			injectSystemPromptOpenAI(bodyCopy, disguisePrompt);
			changed = true;
		}
		if (changed) {
			body = JSON.stringify(bodyCopy);
		}
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

	// 热路径读并行合一（design.md）：per-channel 别名解析、aliasOnly 全图、
	// 活跃渠道、代理运行时 settings（5 键一次 IN 查询）进单个 Promise.all——
	// 鉴权 JOIN 之后只剩这一个串行 RTT 阶段。channels / 别名走 10s TTL 缓存、
	// settings 只缓存 raw 读（30s）；头策略 fail-open 解析与重试配置三级
	// 回退链（settings → env → 默认，含 clamp）从 raw map 纯解析，每次照常执行。
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
	// developer 归一化开关：同快照纯解析（两级链，无 env 回退），零新增查询
	const normalizeDeveloperRole = resolveDeveloperNormalizeFlag(proxySettings);

	const reasoningEffort = extractReasoningEffort(parsedBody);

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

	// Chat-only stream_options usage injection for chat-shaped inbound bodies
	// (spec §3.1). /v1/responses inbound is exempt — that protocol has no
	// stream_options parameter. For responses inbound bodies the equivalent
	// injection happens post-conversion inside buildChannelRequest (openai
	// target converts the body into a chat completions call and injects
	// stream_options on the fresh converted body), so the final upstream body
	// carries it exactly once.
	// 位于路由矩阵 / stream_only 过滤之后：客户端非流式但渠道预设强制上游流式
	// （forceUpstreamStream）时，上游真流式才有 usage 尾 chunk 可解析，注入
	// 条件须看最终候选池是否含强制流式预设的渠道；custom 目标预设不解释
	// body、不强制流式，予以排除。纯流式客户端路径与既有行为一致——候选池
	// 判定仅在 !isStream 时求值；注入在 model 改写之后执行，此处 stringify
	// 的 requestText 已含别名解析后的 model，后续逐渠道别名拷贝展开同一
	// parsedBody 自然携带注入结果。
	const isResponsesInbound = c.req.path
		.toLowerCase()
		.startsWith("/v1/responses");
	const upstreamForcedStream =
		!isStream &&
		candidates.some(
			(ch) =>
				ch.api_format !== "custom" && isStreamForcingPreset(ch.disguise_preset),
		);
	if (
		(isStream || upstreamForcedStream) &&
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
	const querySuffix = c.req.url.includes("?")
		? `?${c.req.url.split("?")[1]}`
		: "";
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
			const keys = shuffleArray(parseApiKeys(channel.api_key));
			let channelRetryable = false;
			// Last attempt outcome for this channel — drives the cooldown
			// accounting at the abandonment point below (design.md §判定语义).
			let channelLastResponse: Response | null = null;
			let channelLastAttemptThrew = false;

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
					normalizeDeveloperRole,
				);

				// Per-attempt response for the cooldown accounting: a fetch throw
				// and a post-response conversion throw must not be conflated —
				// any received HTTP response proves the upstream alive (design's
				// success rule applies "无论后续是否解析失败").
				let attemptResponse: Response | null = null;
				try {
					const response = await fetch(target, {
						method: c.req.method,
						headers,
						body: channelBody,
					});
					attemptResponse = response;

					lastResponse = response;
					channelLastResponse = response;
					channelLastAttemptThrew = false;
					if (response.ok) {
						// 预设强制上游流式（客户端非流），仅对当前尝试渠道生效：
						// 上游 SSE 在网关侧聚合为标准非流 JSON 再喂 convertResponse
						// （其非流分支本就 await response.json()，本体零改动）。
						// 聚合器入口 fail-open：非 SSE 响应原样返回——形状门禁未
						// 命中（embeddings 等 body 未被改写、上游并未真流式）时零
						// 行为变化。原 SSE body 由聚合器消费，聚合产物是新
						// Response，后续 clone 的错误/usage 路径不受单次消费影响；
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
						// Convert response based on the channel's target format
						lastResponse = await convertResponse(
							channel,
							upstream,
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

	if (!lastResponse) {
		// Usage recording is post-response: never blocks the error reply
		// (waitUntil when available, fire-and-forget otherwise).
		runPostResponse(c, () =>
			recordUsage(c.env.DB, {
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
			}),
		);
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
				userId: tokenRecord.user_id,
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
			// Same helper as the non-stream / error paths: waitUntil when a Workers
			// ExecutionContext is available, fire-and-forget otherwise (the task
			// handles its own errors, so the helper's catch never fires here).
			runPostResponse(c, () => task);
		} else {
			logUsage("immediate", immediateUsage, immediateSource);
			// Non-stream responses no longer await the usage write — billing lands
			// post-response (waitUntil / fire-and-forget degradation).
			runPostResponse(c, () => record(immediateUsage, latencyMs));
		}
	}

	return lastResponse;
});

export default proxy;
