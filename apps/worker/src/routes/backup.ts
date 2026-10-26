import type { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { listChannels } from "../services/channel-repo";
import {
	type ValidatedBackupChannel,
	validateBackupChannelEntry,
} from "../services/channel-validation";
import { listSettings } from "../services/settings";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";

const backup = new Hono<AppEnv>();

export const BACKUP_VERSION = 1;
/** 请求体上限防护（design §2）：超过 2MB 直接 413，不进解析。 */
export const BACKUP_MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/**
 * settings 导出排除清单（安全冗余，design §1）：管理台 GET 可见即可导，
 * 本清单是第二道闸——凡命中者即使出现在白名单也绝不导出、且导入载荷中
 * 拒收（fail-closed，防止跨实例恢复时意外覆盖管理员密码 / Turnstile
 * secret 把操作者锁在门外）。
 *
 * 实际存储键核对（routes/settings.ts GET/PUT + services/settings.ts 全文）：
 *   - admin_password_hash：管理员密码哈希（GET 只回 admin_password_set 布尔）
 *   - turnstile_secret_key：Turnstile 服务端密钥（GET 只回 *_set 布尔）
 *   - LinuxDO OAuth secret 不存 settings 表（LINUXDO_CLIENT_ID/SECRET 是
 *     env.ts Bindings 环境变量），天然不进备份，无需清单项。
 * 会话态不存 settings（admin_sessions / user_sessions 各有独立表），同样
 * 天然不进备份。
 */
export const BACKUP_SETTINGS_EXCLUDED_KEYS: readonly string[] = [
	"admin_password_hash",
	"turnstile_secret_key",
];

/**
 * settings 导出白名单 = 管理台 GET 可见字段对应的存储键（键名逐一核对自
 * services/settings.ts 的 *_KEY 常量与 routes/settings.ts GET 响应体）。
 * 白名单之外的未知键（未来的新功能键）不导出——新键要进备份必须在此显式
 * 登记，避免「秘密键默认导出」的失败模式。
 */
export const BACKUP_SETTINGS_EXPORT_KEYS: readonly string[] = [
	"log_retention_days",
	"session_ttl_hours",
	"registration_mode",
	"checkin_reward",
	"require_invite_code",
	"ldc_payment_enabled",
	"ldc_epay_pid",
	"ldc_epay_key",
	"ldc_epay_gateway",
	"ldc_exchange_rate",
	"default_balance",
	"announcement",
	"proxy_extra_headers",
	"proxy_remove_headers",
	"proxy_retry_rounds",
	"proxy_retry_delay_ms",
	"token_rpm_default",
	"ip_auth_fail_limit",
	"model_test_prompt",
	"debug_request_body_log",
	"normalize_developer_role",
	"turnstile_enabled",
	"turnstile_site_key",
];

type BackupSettingsPayload = Record<string, unknown>;

type BackupPayload = {
	version?: unknown;
	exportedAt?: unknown;
	channels?: unknown;
	model_aliases?: unknown;
	channel_model_aliases?: unknown;
	settings?: unknown;
};

type BackupAliasRow = {
	id: string;
	model_id?: string;
	channel_id?: string;
	alias: string;
	is_primary: number;
	alias_only: number;
	created_at: string;
	updated_at: string;
};

/**
 * Exports the full configuration (channels with plaintext keys, aliases,
 * whitelisted settings) as a JSON download. Response carries no-store plus an
 * attachment filename — the file holds upstream API keys in plaintext.
 */
backup.get("/export", async (c) => {
	const exportedAt = nowIso();
	const [channelRows, aliasRows, channelAliasRows, settingsMap] =
		await Promise.all([
			listChannels(c.env.DB),
			c.env.DB.prepare(
				"SELECT id, model_id, alias, is_primary, alias_only, created_at, updated_at FROM model_aliases",
			).all<BackupAliasRow>(),
			c.env.DB.prepare(
				"SELECT id, channel_id, model_id, alias, is_primary, alias_only, created_at, updated_at FROM channel_model_aliases",
			).all<BackupAliasRow>(),
			listSettings(c.env.DB),
		]);

	// 白名单 ∩ 非排除清单（排除清单是安全冗余第二道闸，见常量注释）
	const settings: Record<string, string> = {};
	for (const key of BACKUP_SETTINGS_EXPORT_KEYS) {
		if (BACKUP_SETTINGS_EXCLUDED_KEYS.includes(key)) {
			continue;
		}
		const value = settingsMap[key];
		if (value !== undefined) {
			settings[key] = value;
		}
	}

	const payload = {
		version: BACKUP_VERSION,
		exportedAt,
		channels: channelRows,
		model_aliases: aliasRows.results ?? [],
		channel_model_aliases: channelAliasRows.results ?? [],
		settings,
	};

	return c.json(payload, 200, {
		"Cache-Control": "no-store",
		"Content-Disposition": `attachment; filename="zenapi-backup-${exportedAt.slice(0, 10)}.json"`,
	});
});

/** 语义布尔列（is_primary / alias_only）：严格 0/1（或 true/false），缺失 = 0，非法 = null。 */
function coerceAliasBit(value: unknown): number | null {
	if (value === undefined || value === null) {
		return 0;
	}
	if (value === true) {
		return 1;
	}
	if (value === false) {
		return 0;
	}
	if (value === 0 || value === 1) {
		return value;
	}
	return null;
}

function aliasRowOk(
	entry: unknown,
): { ok: true; value: BackupAliasRow } | { ok: false } {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return { ok: false };
	}
	const row = entry as Record<string, unknown>;
	if (typeof row.alias !== "string" || row.alias.trim() === "") {
		return { ok: false };
	}
	const isPrimary = coerceAliasBit(row.is_primary);
	const aliasOnly = coerceAliasBit(row.alias_only);
	if (isPrimary === null || aliasOnly === null) {
		return { ok: false };
	}
	return {
		ok: true,
		value: {
			id:
				typeof row.id === "string" && row.id !== ""
					? row.id
					: crypto.randomUUID(),
			model_id:
				typeof row.model_id === "string" && row.model_id !== ""
					? row.model_id
					: undefined,
			channel_id:
				typeof row.channel_id === "string" && row.channel_id !== ""
					? row.channel_id
					: undefined,
			alias: row.alias,
			is_primary: isPrimary,
			alias_only: aliasOnly,
			created_at:
				typeof row.created_at === "string" && row.created_at !== ""
					? row.created_at
					: nowIso(),
			updated_at:
				typeof row.updated_at === "string" && row.updated_at !== ""
					? row.updated_at
					: nowIso(),
		},
	};
}

/**
 * Imports a backup payload: validate everything first, then wipe the config
 * domain tables and re-insert in a single db.batch (D1 batch = single
 * transaction — any failure rolls the whole replace back). Billing / user
 * domain tables (users / tokens / usage_logs / usage_stats_daily /
 * recharge_orders / invite_codes / session tables) are never touched.
 */
backup.post("/import", async (c) => {
	// 大小防护两道：content-length 头先行（不缓冲即拒），缺失/不可信时
	// 回退到读后长度检查
	const contentLength = Number(c.req.header("content-length") ?? "0");
	if (
		Number.isFinite(contentLength) &&
		contentLength > BACKUP_MAX_IMPORT_BYTES
	) {
		return jsonError(c, 413, "payload_too_large", "payload_too_large");
	}
	const text = await c.req.text();
	if (text.length > BACKUP_MAX_IMPORT_BYTES) {
		return jsonError(c, 413, "payload_too_large", "payload_too_large");
	}

	let payload: BackupPayload | null = null;
	try {
		const parsed: unknown = JSON.parse(text);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			payload = parsed as BackupPayload;
		}
	} catch {
		payload = null;
	}
	if (!payload) {
		return jsonError(
			c,
			400,
			"invalid_backup_payload",
			"invalid_backup_payload",
		);
	}
	if (payload.version !== BACKUP_VERSION) {
		return jsonError(
			c,
			400,
			`unsupported_backup_version: expected ${BACKUP_VERSION}`,
			"unsupported_backup_version",
		);
	}
	if (
		!Array.isArray(payload.channels) ||
		!Array.isArray(payload.model_aliases) ||
		!Array.isArray(payload.channel_model_aliases) ||
		typeof payload.settings !== "object" ||
		payload.settings === null ||
		Array.isArray(payload.settings)
	) {
		return jsonError(
			c,
			400,
			"invalid_backup_payload",
			"invalid_backup_payload",
		);
	}
	const settingsPayload = payload.settings as BackupSettingsPayload;

	// settings 载荷：值必须全为字符串（settings.value TEXT NOT NULL）；
	// 排除清单键 fail-closed 拒收（见 BACKUP_SETTINGS_EXCLUDED_KEYS 注释）
	for (const [key, value] of Object.entries(settingsPayload)) {
		if (BACKUP_SETTINGS_EXCLUDED_KEYS.includes(key)) {
			return jsonError(
				c,
				400,
				`forbidden_settings_key: settings key "${key}" is excluded from backups`,
				"forbidden_settings_key",
			);
		}
		if (typeof value !== "string") {
			return jsonError(
				c,
				400,
				`invalid_backup_payload: settings.${key} must be a string`,
				"invalid_backup_payload",
			);
		}
	}

	// 逐渠道校验（与渠道 CRUD 共用规则集）；任一非法 → 400 带定位，零写入
	const validatedChannels: ValidatedBackupChannel[] = [];
	for (let i = 0; i < payload.channels.length; i++) {
		const result = validateBackupChannelEntry(payload.channels[i], i);
		if (!result.ok) {
			return jsonError(c, 400, result.message, result.code);
		}
		validatedChannels.push(result.value);
	}
	const channelIdSet = new Set(validatedChannels.map((ch) => ch.id));
	if (channelIdSet.size !== validatedChannels.length) {
		return jsonError(
			c,
			400,
			"invalid_backup_channel: duplicate channel id in payload",
			"invalid_backup_channel",
		);
	}

	// 别名行校验：必填列 + 引用完整性 + 载荷内唯一性（唯一索引在 batch 内
	// 才炸会把可预检的错误变成 500，这里前置成 400 带定位）
	const modelAliases: BackupAliasRow[] = [];
	const modelAliasSeen = new Set<string>();
	for (let i = 0; i < payload.model_aliases.length; i++) {
		const row = aliasRowOk(payload.model_aliases[i]);
		if (!row.ok || !row.value.model_id) {
			return jsonError(
				c,
				400,
				`invalid_backup_payload: model_aliases[${i}] must be an object with non-empty model_id and alias`,
				"invalid_backup_payload",
			);
		}
		if (modelAliasSeen.has(row.value.alias)) {
			return jsonError(
				c,
				400,
				`invalid_backup_payload: model_aliases[${i}] duplicate alias "${row.value.alias}"`,
				"invalid_backup_payload",
			);
		}
		modelAliasSeen.add(row.value.alias);
		modelAliases.push(row.value);
	}

	const channelAliases: BackupAliasRow[] = [];
	const channelAliasSeen = new Set<string>();
	for (let i = 0; i < payload.channel_model_aliases.length; i++) {
		const row = aliasRowOk(payload.channel_model_aliases[i]);
		if (!row.ok || !row.value.model_id || !row.value.channel_id) {
			return jsonError(
				c,
				400,
				`invalid_backup_payload: channel_model_aliases[${i}] must be an object with non-empty channel_id, model_id and alias`,
				"invalid_backup_payload",
			);
		}
		if (!channelIdSet.has(row.value.channel_id)) {
			return jsonError(
				c,
				400,
				`invalid_backup_payload: channel_model_aliases[${i}] references unknown channel "${row.value.channel_id}"`,
				"invalid_backup_payload",
			);
		}
		const uniqueKey = `${row.value.channel_id}\u0000${row.value.alias}`;
		if (channelAliasSeen.has(uniqueKey)) {
			return jsonError(
				c,
				400,
				`invalid_backup_payload: channel_model_aliases[${i}] duplicate alias "${row.value.alias}" for channel "${row.value.channel_id}"`,
				"invalid_backup_payload",
			);
		}
		channelAliasSeen.add(uniqueKey);
		channelAliases.push(row.value);
	}

	// 先清后写，单次 db.batch（单事务，任一语句失败整体回滚）：
	//   DELETE channels / model_aliases / channel_model_aliases 全表 +
	//   settings 仅「载荷包含的键」（载荷没有的键保留现值），再原样 INSERT。
	// users / tokens / usage_logs / usage_stats_daily / recharge_orders /
	// invite_codes / 各会话表一律不触碰（导入范围铁律）。
	const now = nowIso();
	const statements: ReturnType<D1Database["prepare"]>[] = [
		c.env.DB.prepare("DELETE FROM channels"),
		c.env.DB.prepare("DELETE FROM model_aliases"),
		c.env.DB.prepare("DELETE FROM channel_model_aliases"),
	];
	for (const key of Object.keys(settingsPayload)) {
		statements.push(
			c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key),
		);
	}
	for (const ch of validatedChannels) {
		statements.push(
			c.env.DB.prepare(
				"INSERT INTO channels (id, name, base_url, api_key, weight, status, rate_limit, models_json, type, group_name, priority, metadata_json, test_time, response_time_ms, api_format, api_formats, endpoint_overrides, custom_headers_json, disguise_headers_json, disguise_system_prompt, disguise_preset, stream_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			).bind(
				ch.id,
				ch.name,
				ch.base_url,
				ch.api_key,
				ch.weight,
				ch.status,
				ch.rate_limit,
				ch.models_json,
				ch.type,
				ch.group_name,
				ch.priority,
				ch.metadata_json,
				ch.test_time,
				ch.response_time_ms,
				ch.api_format,
				ch.api_formats,
				ch.endpoint_overrides,
				ch.custom_headers_json,
				ch.disguise_headers_json,
				ch.disguise_system_prompt,
				ch.disguise_preset,
				ch.stream_only,
				ch.created_at,
				ch.updated_at,
			),
		);
	}
	for (const row of modelAliases) {
		statements.push(
			c.env.DB.prepare(
				"INSERT INTO model_aliases (id, model_id, alias, is_primary, alias_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).bind(
				row.id,
				row.model_id ?? "",
				row.alias,
				row.is_primary,
				row.alias_only,
				row.created_at,
				row.updated_at,
			),
		);
	}
	for (const row of channelAliases) {
		statements.push(
			c.env.DB.prepare(
				"INSERT INTO channel_model_aliases (id, channel_id, model_id, alias, is_primary, alias_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).bind(
				row.id,
				row.channel_id ?? "",
				row.model_id ?? "",
				row.alias,
				row.is_primary,
				row.alias_only,
				row.created_at,
				row.updated_at,
			),
		);
	}
	for (const [key, value] of Object.entries(settingsPayload)) {
		statements.push(
			c.env.DB.prepare(
				"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
			).bind(key, value, now),
		);
	}

	try {
		await c.env.DB.batch(statements);
	} catch (error) {
		console.error("[backup] import batch failed", {
			error: error instanceof Error ? error.message : String(error),
			channels: validatedChannels.length,
			model_aliases: modelAliases.length,
			channel_model_aliases: channelAliases.length,
			settings: Object.keys(settingsPayload).length,
		});
		return jsonError(c, 500, "import_failed", "import_failed");
	}

	// 热路径缓存无失效接口：渠道/别名 ≤10s、settings ≤30s TTL 自然过期
	// （与渠道 CRUD 一致的陈旧边界），响应体显式提示
	return c.json({
		ok: true,
		imported: {
			channels: validatedChannels.length,
			model_aliases: modelAliases.length,
			channel_model_aliases: channelAliases.length,
			settings: Object.keys(settingsPayload).length,
		},
		cache_staleness: { channels_seconds: 10, settings_seconds: 30 },
	});
});

export default backup;
