import {
	type ChannelApiFormat,
	normalizeApiFormats,
	normalizeEndpointOverrides,
} from "./channel-types";
import { CLIENT_PRESET_IDS } from "./client-presets";

/**
 * 渠道配置校验的共享规则集（唯一实现，双消费方）：
 *   - routes/channels.ts 的渠道 CRUD（POST / PATCH / fetch_models / test-model）
 *   - routes/backup.ts 的配置备份导入（逐渠道校验，design §2）
 * 2026-10-26 自 routes/channels.ts 原样抽取（纯函数、无 Context / DB 依赖），
 * 抽取前后 POST 对同一载荷的行为逐字节一致（既有渠道 CRUD 测试为锚）。
 * 任何校验规则改动必须同时作用于两条路径——共用本模块保证永不漂移。
 */

/**
 * 校验失败时 400 响应的 message：说明具体原因（格式声明不可为空、不给
 * 「清除」态——null/[]/非法值一律 400，遵循 patch-update-semantics 的
 * 「非法值不静默回退」精神）。code 固定 invalid_api_formats（snake_case，
 * 与渠道 CRUD 既有错误码风格一致）。
 */
const FORMAT_REASON_MESSAGES: Record<string, string> = {
	not_array: "api_formats must be an array of format strings",
	empty:
		"api_formats cannot be empty or contain no valid format; omit the field to keep current values",
	custom_exclusive: "custom format cannot be combined with other formats",
};

export function invalidFormatsError(reason: string): {
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
 * 上游）。code 固定 invalid_endpoint_overrides（snake_case，与渠道 CRUD
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

export function invalidOverridesError(
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
export function isValidDisguisePreset(value: string | null): boolean {
	return (
		value === null || (CLIENT_PRESET_IDS as readonly string[]).includes(value)
	);
}

export function invalidDisguisePresetError(): {
	message: string;
	code: string;
} {
	return {
		message: `disguise_preset must be one of [${CLIENT_PRESET_IDS.join(", ")}], or empty to disable`,
		code: "invalid_disguise_preset",
	};
}

// ---------------------------------------------------------------------------
// 配置备份导入的逐渠道校验（消费上方共享原语 + channel-types 写侧函数）
// ---------------------------------------------------------------------------

/** 备份文件中单条渠道行的校验通过产物：列集与 channels 表 INSERT 对齐。 */
export type ValidatedBackupChannel = {
	id: string;
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	status: string;
	rate_limit: number;
	models_json: string;
	type: number;
	group_name: string | null;
	priority: number;
	metadata_json: string | null;
	test_time: number | null;
	response_time_ms: number | null;
	api_format: string;
	api_formats: string;
	endpoint_overrides: string | null;
	custom_headers_json: string | null;
	disguise_headers_json: string | null;
	disguise_system_prompt: string | null;
	disguise_preset: string | null;
	stream_only: number;
	created_at: string;
	updated_at: string;
};

export type BackupChannelValidationResult =
	| { ok: true; value: ValidatedBackupChannel }
	| { ok: false; message: string; code: string };

/**
 * 与 normalizeApiFormats 同源的白名单判定（镜像列 api_format 的一致性校验用）。
 */
const FORMAT_WHITELIST: readonly ChannelApiFormat[] = [
	"openai",
	"responses",
	"anthropic",
	"custom",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 语义布尔列（is_primary / alias_only / stream_only）：0/1 数值，缺失 = 0。 */
function coerceBitColumn(value: unknown, fallback = 0): number | null {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (value === true) {
		return 1;
	}
	if (value === false) {
		return 0;
	}
	if (typeof value === "number" && (value === 0 || value === 1)) {
		return value;
	}
	return null;
}

/** 数值列：Number 可解析则取整数值，否则回退默认（备份导入侧从严，不落 NaN）。 */
function coerceNumberColumn(value: unknown, fallback: number): number {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/** 可空字符串列（JSON 串 / 文本列）：缺失 = null，非字符串类型显式拒绝。 */
function coerceNullableString(
	value: unknown,
): { ok: true; value: string | null } | { ok: false } {
	if (value === undefined || value === null) {
		return { ok: true, value: null };
	}
	if (typeof value === "string") {
		return { ok: true, value };
	}
	return { ok: false };
}

/**
 * 校验备份文件中的单条渠道行（design §2：与渠道 CRUD 相同的规则集，非法
 * 400 带定位）。规则实现在上方共享原语与 channel-types 的写侧函数，本函数
 * 只做备份行形态（TEXT 列字符串形态）到共享规则的接线：
 *   - api_formats / endpoint_overrides 在备份里是 DB 存储形态（JSON 字符串），
 *     先 parse 再过 normalizeApiFormats / normalizeEndpointOverrides；
 *   - 校验通过后调用方对 JSON 列**回写原字符串**（round-trip 字节保真，
 *     不 re-stringify parse 产物），parse 只承担校验职责。
 */
export function validateBackupChannelEntry(
	entry: unknown,
	index: number,
): BackupChannelValidationResult {
	const label =
		isPlainObject(entry) &&
		typeof entry.name === "string" &&
		entry.name.trim() !== ""
			? `channels[${index}] "${entry.name}"`
			: `channels[${index}]`;
	const fail = (code: string, detail: string) => ({
		ok: false as const,
		message: `${label}: ${detail}`,
		code,
	});

	if (!isPlainObject(entry)) {
		return fail("invalid_backup_payload", "channel entry must be an object");
	}

	// id 必须保留（备份导入把原 id 原样写回，token.allowed_channels /
	// usage_logs.channel_id 等引用不断链）
	if (typeof entry.id !== "string" || entry.id.trim() === "") {
		return fail("invalid_backup_channel", "id must be a non-empty string");
	}
	// name / base_url 缺失 → 与渠道 POST 同码 missing_fields
	if (typeof entry.name !== "string" || entry.name.trim() === "") {
		return fail("missing_fields", "name is required");
	}
	if (typeof entry.base_url !== "string" || entry.base_url.trim() === "") {
		return fail("missing_fields", "base_url is required");
	}
	if (entry.api_key !== undefined && typeof entry.api_key !== "string") {
		return fail("invalid_backup_channel", "api_key must be a string");
	}
	if (entry.status !== undefined && typeof entry.status !== "string") {
		return fail("invalid_backup_channel", "status must be a string");
	}

	// models_json：DB 存储形态 JSON 数组字符串；空/缺失归一 "[]"（POST 语义）
	let modelsJson = "[]";
	if (entry.models_json !== undefined && entry.models_json !== null) {
		if (
			typeof entry.models_json !== "string" ||
			entry.models_json.trim() === ""
		) {
			return fail(
				"invalid_backup_channel",
				"models_json must be a JSON array string",
			);
		}
		let parsedModels: unknown;
		try {
			parsedModels = JSON.parse(entry.models_json);
		} catch {
			return fail(
				"invalid_backup_channel",
				"models_json must be a JSON array string",
			);
		}
		if (!Array.isArray(parsedModels)) {
			return fail(
				"invalid_backup_channel",
				"models_json must be a JSON array string",
			);
		}
		modelsJson = entry.models_json;
	}

	// 格式声明：备份行 api_formats 优先（存储形态字符串）；缺失时 legacy
	// api_format 镜像映射单元素数组；都缺 → 默认 ["openai"]（与 POST 同默认）
	let parsedFormats: unknown;
	if (
		typeof entry.api_formats === "string" &&
		entry.api_formats.trim() !== ""
	) {
		try {
			parsedFormats = JSON.parse(entry.api_formats);
		} catch {
			const error = invalidFormatsError("not_array");
			return fail(error.code, error.message);
		}
	} else if (
		typeof entry.api_format === "string" &&
		entry.api_format.trim() !== ""
	) {
		parsedFormats = [entry.api_format];
	} else {
		parsedFormats = ["openai"];
	}
	const normalized = normalizeApiFormats(parsedFormats);
	if (!normalized.ok) {
		const error = invalidFormatsError(normalized.reason);
		return fail(error.code, error.message);
	}
	const declaredFormats: ChannelApiFormat[] = normalized.value;
	// 镜像列一致性：存储形态镜像 = 规范化声明首元素（repo 双写不变量）；
	// 缺失时派生，非法/越界显式拒绝（不静默回退）
	let apiFormatMirror: string = declaredFormats[0] ?? "openai";
	if (entry.api_format !== undefined && entry.api_format !== null) {
		if (
			typeof entry.api_format !== "string" ||
			!(FORMAT_WHITELIST as readonly string[]).includes(entry.api_format)
		) {
			return fail(
				"invalid_backup_channel",
				"api_format mirror must be a whitelisted format string",
			);
		}
		if (!declaredFormats.includes(entry.api_format as ChannelApiFormat)) {
			return fail(
				"invalid_backup_channel",
				"api_format mirror must be declared in api_formats",
			);
		}
		apiFormatMirror = entry.api_format;
	}

	// 端点覆盖：存储形态 JSON 对象字符串 / null；parse 后过共享 normalize，
	// 通过则回写原字符串
	let endpointOverridesJson: string | null = null;
	if (
		typeof entry.endpoint_overrides === "string" &&
		entry.endpoint_overrides.trim() !== ""
	) {
		let parsedOverrides: unknown;
		try {
			parsedOverrides = JSON.parse(entry.endpoint_overrides);
		} catch {
			const error = invalidOverridesError("not_object");
			return fail(error.code, error.message);
		}
		const overrides = normalizeEndpointOverrides(
			parsedOverrides,
			declaredFormats,
		);
		if (!overrides.ok) {
			const error = invalidOverridesError(overrides.reason, overrides.key);
			return fail(error.code, error.message);
		}
		endpointOverridesJson = entry.endpoint_overrides;
	} else if (
		entry.endpoint_overrides !== undefined &&
		entry.endpoint_overrides !== null
	) {
		return fail(
			"invalid_backup_channel",
			"endpoint_overrides must be a JSON object string or null",
		);
	}

	// 伪装预设：空串 = 关闭（读侧语义），非空白须命中白名单（共享原语）
	let disguisePreset: string | null = null;
	if (typeof entry.disguise_preset === "string") {
		if (
			entry.disguise_preset.trim() !== "" &&
			!isValidDisguisePreset(entry.disguise_preset)
		) {
			const error = invalidDisguisePresetError();
			return fail(error.code, error.message);
		}
		disguisePreset = entry.disguise_preset;
	} else if (
		entry.disguise_preset !== undefined &&
		entry.disguise_preset !== null
	) {
		return fail(
			"invalid_backup_channel",
			"disguise_preset must be a string or null",
		);
	}

	const group_name = coerceNullableString(entry.group_name);
	if (!group_name.ok) {
		return fail(
			"invalid_backup_channel",
			"group_name must be a string or null",
		);
	}
	const metadata_json = coerceNullableString(entry.metadata_json);
	if (!metadata_json.ok) {
		return fail(
			"invalid_backup_channel",
			"metadata_json must be a string or null",
		);
	}
	const custom_headers_json = coerceNullableString(entry.custom_headers_json);
	if (!custom_headers_json.ok) {
		return fail(
			"invalid_backup_channel",
			"custom_headers_json must be a string or null",
		);
	}
	const disguise_headers_json = coerceNullableString(
		entry.disguise_headers_json,
	);
	if (!disguise_headers_json.ok) {
		return fail(
			"invalid_backup_channel",
			"disguise_headers_json must be a string or null",
		);
	}
	const disguise_system_prompt = coerceNullableString(
		entry.disguise_system_prompt,
	);
	if (!disguise_system_prompt.ok) {
		return fail(
			"invalid_backup_channel",
			"disguise_system_prompt must be a string or null",
		);
	}
	const streamOnly = coerceBitColumn(entry.stream_only);
	if (streamOnly === null) {
		return fail("invalid_backup_channel", "stream_only must be 0 or 1");
	}

	const now = new Date().toISOString();
	const createdAt =
		typeof entry.created_at === "string" && entry.created_at !== ""
			? entry.created_at
			: now;
	const updatedAt =
		typeof entry.updated_at === "string" && entry.updated_at !== ""
			? entry.updated_at
			: now;
	const testTime =
		typeof entry.test_time === "number" && Number.isFinite(entry.test_time)
			? entry.test_time
			: null;
	const responseTimeMs =
		typeof entry.response_time_ms === "number" &&
		Number.isFinite(entry.response_time_ms)
			? entry.response_time_ms
			: null;

	return {
		ok: true,
		value: {
			id: entry.id,
			name: entry.name,
			base_url: entry.base_url,
			api_key: typeof entry.api_key === "string" ? entry.api_key : "",
			weight: coerceNumberColumn(entry.weight, 1),
			status: typeof entry.status === "string" ? entry.status : "active",
			rate_limit: coerceNumberColumn(entry.rate_limit, 0),
			models_json: modelsJson,
			type: coerceNumberColumn(entry.type, 1),
			group_name: group_name.value,
			priority: coerceNumberColumn(entry.priority, 0),
			metadata_json: metadata_json.value,
			test_time: testTime,
			response_time_ms: responseTimeMs,
			api_format: apiFormatMirror,
			// 声明集有备份原串则原样回写（字节保真）；派生场景（缺失）才落
			// 规范化 JSON（与 repo toApiFormatColumns 产物一致）
			api_formats:
				typeof entry.api_formats === "string" && entry.api_formats.trim() !== ""
					? entry.api_formats
					: JSON.stringify(declaredFormats),
			endpoint_overrides: endpointOverridesJson,
			custom_headers_json: custom_headers_json.value,
			disguise_headers_json: disguise_headers_json.value,
			disguise_system_prompt: disguise_system_prompt.value,
			disguise_preset: disguisePreset,
			stream_only: streamOnly,
			created_at: createdAt,
			updated_at: updatedAt,
		},
	};
}
