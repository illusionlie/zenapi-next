import { Hono } from "hono";
import type { AppEnv } from "../env";
import { buildChannelRequest, convertResponse } from "../routes/proxy";
import {
	channelExists,
	deleteChannel,
	getChannelById,
	insertChannel,
	listChannels,
	updateChannel,
} from "../services/channel-repo";
import { selectTargetFormat } from "../services/channel-routing";
import {
	fetchChannelModels,
	updateChannelTestResult,
} from "../services/channel-testing";
import {
	type ChannelApiFormat,
	type ChannelRecord,
	normalizeApiFormats,
	normalizeEndpointOverrides,
	parseApiFormats,
} from "../services/channel-types";
import {
	CLIENT_PRESET_IDS,
	isStreamForcingPreset,
} from "../services/client-presets";
import { saveChannelAliases } from "../services/model-aliases";
import {
	buildModelTestRequestBody,
	MODEL_TEST_TIMEOUT_MS,
	type ModelTestOutcome,
	parseModelTestResponse,
} from "../services/model-testing";
import {
	getModelTestPrompt,
	loadProxySettingsCached,
	resolveDeveloperNormalizeFlag,
} from "../services/settings";
import {
	aggregateUpstreamStream,
	protocolForTargetFormat,
} from "../services/stream-aggregate";
import { generateToken } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { safeJsonParse } from "../utils/json";
import { parseApiKeys } from "../utils/keys";
import { nowIso } from "../utils/time";
import { normalizeBaseUrl } from "../utils/url";

const channels = new Hono<AppEnv>();

type AliasConfig = {
	aliases: string[];
	alias_only: boolean;
};

type ChannelPayload = {
	id?: string | number;
	channel_id?: string | number;
	channelId?: string | number;
	name?: string;
	base_url?: string;
	api_key?: string;
	weight?: number;
	status?: string;
	rate_limit?: number;
	models?: unknown[];
	api_format?: string;
	api_formats?: unknown;
	endpoint_overrides?: unknown;
	custom_headers?: string;
	disguise_headers?: string;
	disguise_system_prompt?: string;
	disguise_preset?: string;
	model_aliases?: Record<string, AliasConfig>;
};

/**
 * 校验失败时 400 响应的 message：说明具体原因（格式声明不可为空、不给
 * 「清除」态——null/[]/非法值一律 400，遵循 patch-update-semantics 的
 * 「非法值不静默回退」精神）。code 固定 invalid_api_formats（snake_case，
 * 与同文件既有错误码风格一致）。
 */
const FORMAT_REASON_MESSAGES: Record<string, string> = {
	not_array: "api_formats must be an array of format strings",
	empty:
		"api_formats cannot be empty or contain no valid format; omit the field to keep current values",
	custom_exclusive: "custom format cannot be combined with other formats",
};

function invalidFormatsError(reason: string): {
	message: string;
	code: string;
} {
	return {
		message: FORMAT_REASON_MESSAGES[reason] ?? "invalid_api_formats",
		code: "invalid_api_formats",
	};
}

/**
 * endpoint_overrides 校验失败时 400 响应的 message：说明具体原因并指出
 * 问题键（fail-fast，design D2——端点配置错配静默失效 = 请求打到错误
 * 上游）。code 固定 invalid_endpoint_overrides（snake_case，与同文件
 * 既有错误码风格一致）。
 */
const OVERRIDE_REASON_MESSAGES: Record<string, string> = {
	not_object:
		"endpoint_overrides must be an object keyed by api format, or null to clear all",
	unknown_key:
		"endpoint_overrides keys must be within the {openai, responses, anthropic} whitelist",
	custom_key:
		"custom format cannot have an endpoint override (base_url is the full URL)",
	undeclared_format:
		"endpoint_overrides keys must be formats declared in api_formats",
	invalid_url:
		"endpoint_overrides values must be http(s) URL strings, or null/empty to clear",
};

function invalidOverridesError(
	reason: string,
	key?: string,
): {
	message: string;
	code: string;
} {
	const base = OVERRIDE_REASON_MESSAGES[reason] ?? "invalid endpoint_overrides";
	return {
		message: key ? `${base} (key: ${key})` : base,
		code: "invalid_endpoint_overrides",
	};
}

/**
 * disguise_preset 白名单校验（服务端预设是封闭集合）：空 / NULL = 关闭放行，
 * 非空白值必须命中 CLIENT_PRESET_IDS，非法 400 invalid_disguise_preset
 * （snake_case，不静默回退）。POST trim-or-null 与 PATCH 三态（undefined
 * 保留 / 值含空串覆盖）由各端点先行归一，这里只判终值。
 */
function isValidDisguisePreset(value: string | null): boolean {
	return (
		value === null || (CLIENT_PRESET_IDS as readonly string[]).includes(value)
	);
}

function invalidDisguisePresetError(): { message: string; code: string } {
	return {
		message: `disguise_preset must be one of [${CLIENT_PRESET_IDS.join(", ")}], or empty to disable`,
		code: "invalid_disguise_preset",
	};
}

/**
 * 解析请求体声明的格式集：api_formats 优先，legacy 单值 api_format 映射
 * 为单元素数组，两者都缺 → value: null（由调用方决定默认值或保留现值）。
 * 提供了任一字段但校验失败（非数组 / 空 / custom 组合）→ ok:false。
 */
function resolveBodyApiFormats(
	body: ChannelPayload,
):
	| { ok: true; value: ChannelApiFormat[] | null }
	| { ok: false; reason: string } {
	if (body.api_formats !== undefined) {
		const normalized = normalizeApiFormats(body.api_formats);
		return normalized.ok
			? { ok: true, value: normalized.value }
			: { ok: false, reason: normalized.reason };
	}
	if (body.api_format !== undefined) {
		const normalized = normalizeApiFormats([body.api_format]);
		return normalized.ok
			? { ok: true, value: normalized.value }
			: { ok: false, reason: normalized.reason };
	}
	return { ok: true, value: null };
}

/**
 * base_url 存储规范化。纯 anthropic 渠道沿用 normalizeBaseUrl（存量单格式
 * 行为逐字节不变）；其余（含多格式）trim + 去尾斜杠——openai/responses
 * 端点的存储约定要求 base_url 保留版本路径（如 /v1），normalizeBaseUrl
 * 会剥离 /v1 造成有损转换；而 anthropic 端点在请求时（buildChannelRequest
 * anthropic 分支与探测均再做 normalizeBaseUrl）自会剥离，因此多格式渠道
 * 存储带版本路径的 base_url 对两类端点均可用。
 */
function normalizeChannelBaseUrl(
	formats: ChannelApiFormat[],
	rawBaseUrl: string,
): string {
	if (formats.length === 1 && formats[0] === "anthropic") {
		return normalizeBaseUrl(rawBaseUrl);
	}
	return String(rawBaseUrl).trim().replace(/\/+$/, "");
}

/**
 * Resolves a channel id from request payload.
 *
 * Args:
 *   body: Request payload.
 *
 * Returns:
 *   Channel id if provided.
 */
function resolveChannelId(body: ChannelPayload | null): string | null {
	const candidate = body?.id ?? body?.channel_id ?? body?.channelId;
	if (!candidate) {
		return null;
	}
	const normalized = String(candidate).trim();
	return normalized.length > 0 ? normalized : null;
}

/**
 * Lists all channels.
 */
channels.get("/", async (c) => {
	const rows = await listChannels(c.env.DB, {
		orderBy: "created_at",
		order: "DESC",
	});

	// Collect channel IDs for per-channel alias query
	const channelIds = rows.map((ch) => ch.id as string);

	// Batch-query per-channel aliases (D1 limits bind params to 100)
	const channelAliases: Record<string, Record<string, AliasConfig>> = {};
	if (channelIds.length > 0) {
		const BATCH_SIZE = 80;
		for (let i = 0; i < channelIds.length; i += BATCH_SIZE) {
			const batch = channelIds.slice(i, i + BATCH_SIZE);
			const placeholders = batch.map(() => "?").join(",");
			const aliasRows = await c.env.DB.prepare(
				`SELECT channel_id, model_id, alias, alias_only FROM channel_model_aliases WHERE channel_id IN (${placeholders}) ORDER BY channel_id, model_id, alias`,
			)
				.bind(...batch)
				.all<{
					channel_id: string;
					model_id: string;
					alias: string;
					alias_only: number;
				}>();

			for (const row of aliasRows.results ?? []) {
				if (!channelAliases[row.channel_id]) {
					channelAliases[row.channel_id] = {};
				}
				const chMap = channelAliases[row.channel_id];
				if (!chMap[row.model_id]) {
					chMap[row.model_id] = { aliases: [], alias_only: false };
				}
				chMap[row.model_id].aliases.push(row.alias);
				if (row.alias_only === 1) {
					chMap[row.model_id].alias_only = true;
				}
			}
		}
	}

	return c.json({ channels: rows, channel_aliases: channelAliases });
});

/**
 * Creates a new channel.
 */
channels.post("/", async (c) => {
	const body = (await c.req.json().catch(() => null)) as ChannelPayload | null;
	if (!body?.name || !body?.base_url) {
		return jsonError(c, 400, "missing_fields", "missing_fields");
	}

	const requestedId = resolveChannelId(body);
	if (requestedId) {
		const exists = await channelExists(c.env.DB, requestedId);
		if (exists) {
			return jsonError(c, 409, "channel_id_exists", "channel_id_exists");
		}
	}

	const id = requestedId ?? generateToken("ch_");
	const now = nowIso();
	// 格式声明：api_formats 优先，legacy api_format 映射单元素数组，
	// 都没有 → 默认 ["openai"]（历史默认值）
	const formats = resolveBodyApiFormats(body);
	if (!formats.ok) {
		const error = invalidFormatsError(formats.reason);
		return jsonError(c, 400, error.message, error.code);
	}
	const apiFormats: ChannelApiFormat[] = formats.value ?? ["openai"];
	// 端点覆盖三态（POST 无 DB 现值）：undefined → NULL；提供对象/null 时
	// 以本次生效的声明集为校验基准（键必须是已声明格式）
	let endpointOverridesJson: string | null = null;
	if (body.endpoint_overrides !== undefined) {
		const overrides = normalizeEndpointOverrides(
			body.endpoint_overrides,
			apiFormats,
		);
		if (!overrides.ok) {
			const error = invalidOverridesError(overrides.reason, overrides.key);
			return jsonError(c, 400, error.message, error.code);
		}
		endpointOverridesJson = overrides.value;
	}
	const customHeadersJson = body.custom_headers?.trim() || null;
	const disguiseHeadersJson = body.disguise_headers?.trim() || null;
	const disguiseSystemPrompt = body.disguise_system_prompt?.trim() || null;
	// POST 无 DB 现值：trim-or-null（空 = 不启用），非空白值白名单校验
	const disguisePreset = body.disguise_preset?.trim() || null;
	if (!isValidDisguisePreset(disguisePreset)) {
		const error = invalidDisguisePresetError();
		return jsonError(c, 400, error.message, error.code);
	}

	await insertChannel(c.env.DB, {
		id,
		name: body.name,
		base_url: normalizeChannelBaseUrl(apiFormats, String(body.base_url)),
		api_key: body.api_key ?? "",
		weight: Number(body.weight ?? 1),
		status: body.status ?? "active",
		rate_limit: body.rate_limit ?? 0,
		models_json: JSON.stringify(body.models ?? []),
		type: 1,
		group_name: null,
		priority: 0,
		metadata_json: null,
		api_formats: apiFormats,
		endpoint_overrides: endpointOverridesJson,
		custom_headers_json: customHeadersJson,
		disguise_headers_json: disguiseHeadersJson,
		disguise_system_prompt: disguiseSystemPrompt,
		disguise_preset: disguisePreset,
		created_at: now,
		updated_at: now,
	});

	// Save per-channel model aliases if provided
	if (body.model_aliases && typeof body.model_aliases === "object") {
		const modelIds = (body.models ?? [])
			.map((m: unknown) =>
				typeof m === "string" ? m : ((m as { id?: string })?.id ?? ""),
			)
			.filter(Boolean);
		for (const [modelId, config] of Object.entries(body.model_aliases)) {
			if (!modelIds.includes(modelId)) continue;
			await saveChannelAliases(
				c.env.DB,
				id,
				modelId,
				(config.aliases ?? []).map((a: string) => ({ alias: a })),
				config.alias_only ?? false,
			);
		}
	}

	return c.json({ id });
});

/**
 * Updates a channel.
 */
channels.patch("/:id", async (c) => {
	const body = (await c.req.json().catch(() => null)) as ChannelPayload | null;
	const id = c.req.param("id");
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}

	const current = await getChannelById(c.env.DB, id);
	if (!current) {
		return jsonError(c, 404, "channel_not_found", "channel_not_found");
	}

	const models = body.models ?? safeJsonParse(current.models_json, []);
	// 格式声明三态（patch-update-semantics）：undefined（api_formats 与
	// legacy api_format 均缺席）→ 保留现值；提供任一字段即整体替换，且
	// null / 空数组 / 非法值一律 400——格式声明不可为空，不提供「清除」态
	const formats = resolveBodyApiFormats(body);
	if (!formats.ok) {
		const error = invalidFormatsError(formats.reason);
		return jsonError(c, 400, error.message, error.code);
	}
	const apiFormats: ChannelApiFormat[] =
		formats.value ?? parseApiFormats(current);
	// 端点覆盖三态（patch-update-semantics）：undefined → 保留现值；提供
	// 对象/null 即整体替换（键级 null/空串 = 删除该键），校验基准同样是
	// 本次生效的声明集（body 声明 ?? DB 现值）
	let endpointOverridesJson: string | null = current.endpoint_overrides ?? null;
	if (body.endpoint_overrides !== undefined) {
		const overrides = normalizeEndpointOverrides(
			body.endpoint_overrides,
			apiFormats,
		);
		if (!overrides.ok) {
			const error = invalidOverridesError(overrides.reason, overrides.key);
			return jsonError(c, 400, error.message, error.code);
		}
		endpointOverridesJson = overrides.value;
	}
	const customHeadersJson =
		body.custom_headers !== undefined
			? body.custom_headers?.trim() || null
			: (current.custom_headers_json ?? null);
	// 三态语义照抄 custom_headers：undefined 保留现值，具体值（含空串）trim 后覆盖
	const disguiseHeadersJson =
		body.disguise_headers !== undefined
			? body.disguise_headers?.trim() || null
			: (current.disguise_headers_json ?? null);
	const disguiseSystemPrompt =
		body.disguise_system_prompt !== undefined
			? body.disguise_system_prompt?.trim() || null
			: (current.disguise_system_prompt ?? null);
	// 三态语义照抄 disguise_headers：undefined 保留现值，具体值（含空串）trim
	// 后覆盖（空串 = 清除/关闭）；非空白值须命中 CLIENT_PRESET_IDS 白名单
	const disguisePreset =
		body.disguise_preset !== undefined
			? body.disguise_preset?.trim() || null
			: (current.disguise_preset ?? null);
	if (!isValidDisguisePreset(disguisePreset)) {
		const error = invalidDisguisePresetError();
		return jsonError(c, 400, error.message, error.code);
	}
	const baseUrl = normalizeChannelBaseUrl(
		apiFormats,
		String(body.base_url ?? current.base_url),
	);

	await updateChannel(c.env.DB, id, {
		name: body.name ?? current.name,
		base_url: baseUrl,
		api_key: body.api_key ?? current.api_key,
		weight: Number(body.weight ?? current.weight ?? 1),
		status: body.status ?? current.status,
		rate_limit: body.rate_limit ?? current.rate_limit ?? 0,
		models_json: JSON.stringify(models),
		type: current.type ?? 1,
		group_name: current.group_name ?? null,
		priority: current.priority ?? 0,
		metadata_json: current.metadata_json ?? null,
		api_formats: apiFormats,
		endpoint_overrides: endpointOverridesJson,
		custom_headers_json: customHeadersJson,
		disguise_headers_json: disguiseHeadersJson,
		disguise_system_prompt: disguiseSystemPrompt,
		disguise_preset: disguisePreset,
		updated_at: nowIso(),
	});

	// Save per-channel model aliases if provided
	if (body.model_aliases && typeof body.model_aliases === "object") {
		const modelIds = (Array.isArray(models) ? models : [])
			.map((m: unknown) =>
				typeof m === "string" ? m : ((m as { id?: string })?.id ?? ""),
			)
			.filter(Boolean);
		for (const [modelId, config] of Object.entries(body.model_aliases)) {
			if (!modelIds.includes(modelId)) continue;
			await saveChannelAliases(
				c.env.DB,
				id,
				modelId,
				(config.aliases ?? []).map((a: string) => ({ alias: a })),
				config.alias_only ?? false,
			);
		}
	}

	return c.json({ ok: true });
});

/**
 * Deletes a channel.
 */
channels.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await deleteChannel(c.env.DB, id);
	return c.json({ ok: true });
});

/**
 * Fetches models from an upstream channel without persisting anything.
 * Used by the channel form "拉取模型" button before the channel is saved.
 */
channels.post("/fetch_models", async (c) => {
	const body = (await c.req.json().catch(() => null)) as ChannelPayload | null;
	if (!body?.base_url) {
		return jsonError(c, 400, "missing_fields", "missing_fields");
	}

	// 表单即真相：body 声明的格式集优先（api_formats 优先于 legacy
	// api_format），都缺 → 默认 ["openai"]
	const formats = resolveBodyApiFormats(body);
	if (!formats.ok) {
		const error = invalidFormatsError(formats.reason);
		return jsonError(c, 400, error.message, error.code);
	}
	const apiFormats: ChannelApiFormat[] = formats.value ?? ["openai"];
	// 端点覆盖：无 DB 行（表单即真相），校验基准 = body 声明的格式集；
	// undefined → 无覆盖（全部走 base_url 推导）
	let endpointOverridesJson: string | null = null;
	if (body.endpoint_overrides !== undefined) {
		const overrides = normalizeEndpointOverrides(
			body.endpoint_overrides,
			apiFormats,
		);
		if (!overrides.ok) {
			const error = invalidOverridesError(overrides.reason, overrides.key);
			return jsonError(c, 400, error.message, error.code);
		}
		endpointOverridesJson = overrides.value;
	}
	const baseUrl = normalizeChannelBaseUrl(apiFormats, String(body.base_url));
	const apiKey =
		parseApiKeys(body.api_key ?? "")[0] ?? String(body.api_key ?? "");

	const result = await fetchChannelModels(
		baseUrl,
		apiKey,
		apiFormats,
		body.custom_headers?.trim() || null,
		body.disguise_headers?.trim() || null,
		endpointOverridesJson,
	);

	if (!result.ok) {
		return jsonError(c, 502, "channel_unreachable", "channel_unreachable");
	}

	return c.json({
		ok: true,
		models: result.models,
		elapsed: result.elapsed,
		results: result.results ?? [],
		...(result.probe_warnings ? { probe_warnings: result.probe_warnings } : {}),
	});
});

type ModelTestPayload = {
	id?: string | number;
	base_url?: string;
	api_key?: string;
	api_format?: string;
	endpoint_overrides?: unknown;
	custom_headers?: string;
	disguise_headers?: string;
	disguise_system_prompt?: string;
	disguise_preset?: string;
	model?: string;
	text?: string;
};

/**
 * Runs a one-shot real chat request against a single channel/model.
 * Admin-only tool: no usage recording, no balance deduction, and channel
 * connectivity test results are left untouched.
 */
channels.post("/test-model", async (c) => {
	const body = (await c.req
		.json()
		.catch(() => null)) as ModelTestPayload | null;
	const model = typeof body?.model === "string" ? body.model.trim() : "";
	if (!model) {
		return jsonError(
			c,
			400,
			"model_test_invalid_request",
			"model_test_invalid_request",
		);
	}

	const requestedId =
		body?.id !== undefined && body?.id !== null ? String(body.id).trim() : "";
	const hasBodyBaseUrl =
		typeof body?.base_url === "string" && body.base_url.trim().length > 0;
	if (!requestedId && !hasBodyBaseUrl) {
		return jsonError(
			c,
			400,
			"model_test_invalid_request",
			"model_test_invalid_request",
		);
	}

	// Resolve channel config: DB row when id is given, then body fields
	// override (the form is the source of truth — supports unsaved and
	// dirty forms; same override semantics as PATCH /:id).
	let dbChannel: ChannelRecord | null = null;
	if (requestedId) {
		dbChannel = await getChannelById(c.env.DB, requestedId);
		if (!dbChannel) {
			return jsonError(c, 404, "channel_not_found", "channel_not_found");
		}
	}

	// 表单即真相：body 声明的格式集优先（api_formats 优先于 legacy
	// api_format），回退 DB 行（parseApiFormats 读侧兜底链）。目标格式 =
	// chat 入站偏好序的首个声明格式（chat 可服务全部四格式，声明集经
	// 兜底链非空，?? "openai" 仅为类型收窄的防御兜底）
	const bodyFormats = body
		? resolveBodyApiFormats(body)
		: { ok: true as const, value: null };
	if (!bodyFormats.ok) {
		const error = invalidFormatsError(bodyFormats.reason);
		return jsonError(c, 400, error.message, error.code);
	}
	const declaredFormats: ChannelApiFormat[] =
		bodyFormats.value ?? (dbChannel ? parseApiFormats(dbChannel) : ["openai"]);
	const targetFormat = selectTargetFormat(declaredFormats, "chat") ?? "openai";
	const baseUrl = hasBodyBaseUrl
		? normalizeChannelBaseUrl(declaredFormats, String(body?.base_url))
		: String(dbChannel?.base_url ?? "");
	const apiKey =
		body?.api_key !== undefined
			? String(body.api_key)
			: String(dbChannel?.api_key ?? "");
	const customHeadersJson =
		body?.custom_headers !== undefined
			? body.custom_headers?.trim() || null
			: (dbChannel?.custom_headers_json ?? null);
	const disguiseHeadersJson =
		body?.disguise_headers !== undefined
			? body.disguise_headers?.trim() || null
			: (dbChannel?.disguise_headers_json ?? null);
	const disguiseSystemPrompt =
		body?.disguise_system_prompt !== undefined
			? body.disguise_system_prompt?.trim() || null
			: (dbChannel?.disguise_system_prompt ?? null);
	// 服务端预设表单即真相：body 提供时 trim-or-null 覆盖，缺席回退 DB 行现值
	// （非法值不 400——未知 ID 在预设层 fail-open 关闭，测试路径宽松语义）
	const disguisePreset =
		body?.disguise_preset !== undefined
			? body.disguise_preset?.trim() || null
			: (dbChannel?.disguise_preset ?? null);
	// 端点覆盖表单即真相：body 提供时按本次生效声明集校验规范化后采用，
	// 缺席时回退 DB 行现值（与 api_formats 的覆盖语义一致）
	let endpointOverridesJson: string | null =
		dbChannel?.endpoint_overrides ?? null;
	if (body?.endpoint_overrides !== undefined) {
		const overrides = normalizeEndpointOverrides(
			body.endpoint_overrides,
			declaredFormats,
		);
		if (!overrides.ok) {
			const error = invalidOverridesError(overrides.reason, overrides.key);
			return jsonError(c, 400, error.message, error.code);
		}
		endpointOverridesJson = overrides.value;
	}
	const text =
		typeof body?.text === "string" && body.text.trim().length > 0
			? body.text
			: await getModelTestPrompt(c.env.DB);

	// Minimal ChannelRecord: buildChannelRequest only reads base_url /
	// api_key / api_format / endpoint_overrides / custom_headers_json /
	// disguise_*（plus typing-required identity fields）. api_format 以
	// chat 偏好序选出的目标格式覆盖（与 proxy 路由矩阵的浅拷贝覆盖同构），
	// api_formats 镜像按 repo 双写约定取声明集 JSON。
	const channelLike: ChannelRecord = {
		id: dbChannel?.id ?? "model-test",
		name: dbChannel?.name ?? "model-test",
		base_url: baseUrl,
		api_key: apiKey,
		weight: Number(dbChannel?.weight ?? 1),
		status: dbChannel?.status ?? "active",
		api_format: targetFormat,
		api_formats: JSON.stringify(declaredFormats),
		endpoint_overrides: endpointOverridesJson,
		custom_headers_json: customHeadersJson,
		disguise_headers_json: disguiseHeadersJson,
		disguise_system_prompt: disguiseSystemPrompt,
		disguise_preset: disguisePreset,
	};

	const { bodyText, parsedBody } = buildModelTestRequestBody(model, text);
	const upstreamKey = parseApiKeys(apiKey)[0] ?? apiKey;
	const incomingHeaders = new Headers({ "content-type": "application/json" });
	// developer 归一化开关：经 30s TTL 缓存的代理 settings 快照解析（两级链
	// 无 env 回退），与主代理 / Playground 行为一致
	const normalizeDeveloperRole = resolveDeveloperNormalizeFlag(
		await loadProxySettingsCached(c.env.DB),
	);

	// 豁免全局请求头策略：模型测试不注入/剔除全局头（policy=null，同
	// Playground），渠道级 custom_headers 仍生效
	const {
		target,
		headers,
		body: channelBody,
	} = buildChannelRequest(
		channelLike,
		"/v1/chat/completions",
		"",
		incomingHeaders,
		bodyText,
		parsedBody,
		false,
		upstreamKey,
		null,
		disguiseSystemPrompt,
		normalizeDeveloperRole,
	);

	const start = Date.now();
	let outcome: ModelTestOutcome;
	try {
		const response = await fetch(target, {
			method: "POST",
			headers,
			body: channelBody,
			signal: AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
		});
		// 先归一为 OpenAI 风格再解析：anthropic / responses 渠道复用现有
		// 转换器（非流式），openai / custom 原样透传，保证三种格式得到
		// 统一回显；仅对 2xx 转换，非 2xx 直接走错误分支
		let normalized: Response;
		if (response.ok) {
			// 预设强制上游流式（test-model 恒非流式入站，isStream=false）：
			// 与主代理同构——上游 SSE 先聚合为标准非流 JSON 再喂
			// convertResponse。免费模型验收路径必须聚合，否则
			// parseModelTestResponse 读到的是 SSE 文本而非 JSON；聚合器入口
			// fail-open 覆盖形状门禁未命中（上游未真流式）的场景。
			let upstream = response;
			if (
				response.body &&
				channelLike.api_format !== "custom" &&
				isStreamForcingPreset(channelLike.disguise_preset)
			) {
				upstream = await aggregateUpstreamStream(
					protocolForTargetFormat(channelLike.api_format),
					response,
				);
			}
			normalized = await convertResponse(
				channelLike,
				upstream,
				false,
				"/v1/chat/completions",
			);
		} else {
			normalized = response;
		}
		outcome = await parseModelTestResponse(normalized);
	} catch (error) {
		outcome = {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return c.json({ ...outcome, elapsed: Date.now() - start });
});

/**
 * Tests channel connectivity and updates model list.
 */
channels.post("/:id/test", async (c) => {
	const id = c.req.param("id");
	const channel = await getChannelById(c.env.DB, id);
	if (!channel) {
		return jsonError(c, 404, "channel_not_found", "channel_not_found");
	}

	const result = await fetchChannelModels(
		String(channel.base_url),
		parseApiKeys(String(channel.api_key))[0] ?? String(channel.api_key),
		parseApiFormats(channel),
		channel.custom_headers_json,
		channel.disguise_headers_json ?? null,
		// 逐格式端点覆盖：各声明格式用其解析后端点探测（AC6）
		channel.endpoint_overrides ?? null,
	);

	if (!result.ok) {
		await updateChannelTestResult(c.env.DB, id, {
			ok: false,
			elapsed: result.elapsed,
		});
		return jsonError(c, 502, "channel_unreachable", "channel_unreachable");
	}

	// Check if channel already has models filled in
	const existingModels = safeJsonParse<unknown[]>(channel.models_json, []);
	const channelHasModels =
		Array.isArray(existingModels) && existingModels.length > 0;

	// Only overwrite models_json when the test returned models AND channel has no existing models
	const hasModels = result.models.length > 0;
	const updateData: {
		ok: boolean;
		elapsed: number;
		modelsJson?: string;
		existingModelsJson?: string | null;
	} = { ok: true, elapsed: result.elapsed };
	if (hasModels && result.payload && !channelHasModels) {
		const payloadData = Array.isArray(result.payload)
			? result.payload
			: ((result.payload as { data?: unknown[] })?.data ?? []);
		updateData.modelsJson = JSON.stringify(payloadData);
		updateData.existingModelsJson = channel.models_json ?? null;
	}
	await updateChannelTestResult(c.env.DB, id, updateData);

	const models = hasModels
		? result.models
		: safeJsonParse(channel.models_json, []);
	return c.json({
		ok: true,
		models,
		results: result.results ?? [],
		...(result.probe_warnings ? { probe_warnings: result.probe_warnings } : {}),
	});
});

export default channels;
