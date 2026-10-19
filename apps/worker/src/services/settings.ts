import type { D1Database } from "@cloudflare/workers-types";
import {
	getTtlCache,
	PROXY_SETTINGS_CACHE_TTL_MS,
	type TtlCache,
} from "../utils/cache";
import {
	PROXY_EXTRA_HEADERS_KEY,
	PROXY_REMOVE_HEADERS_KEY,
} from "../utils/proxy-headers";
import { nowIso } from "../utils/time";
import { MODEL_TEST_DEFAULT_PROMPT } from "./model-testing";

const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_SESSION_TTL_HOURS = 12;
const RETENTION_KEY = "log_retention_days";
const SESSION_TTL_KEY = "session_ttl_hours";
const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";

async function readSetting(
	db: D1Database,
	key: string,
): Promise<string | null> {
	const setting = await db
		.prepare("SELECT value FROM settings WHERE key = ?")
		.bind(key)
		.first<{ value?: string }>();
	return setting?.value ? String(setting.value) : null;
}

async function upsertSetting(
	db: D1Database,
	key: string,
	value: string,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		)
		.bind(key, value, nowIso())
		.run();
}

/** Raw settings-table read: key → stored value (null for a NULL column). */
export type SettingsRawMap = Record<string, string | null>;

/**
 * Reads the given settings keys with a single `key IN` SQL query.
 * Absent keys are simply missing from the returned map — callers normalize
 * to null when looking values up.
 */
async function readSettingsRawMap(
	db: D1Database,
	keys: readonly string[],
): Promise<SettingsRawMap> {
	const placeholders = keys.map(() => "?").join(", ");
	const result = await db
		.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
		.bind(...keys)
		.all<{ key: string; value: string | null }>();
	const map: SettingsRawMap = {};
	for (const row of result.results ?? []) {
		map[String(row.key)] = row.value ?? null;
	}
	return map;
}

function parsePositiveNumber(value: string | null, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && parsed > 0) {
		return parsed;
	}
	return fallback;
}

/**
 * Returns the log retention days from settings or default fallback.
 */
export async function getRetentionDays(db: D1Database): Promise<number> {
	const value = await readSetting(db, RETENTION_KEY);
	return parsePositiveNumber(value, DEFAULT_LOG_RETENTION_DAYS);
}

/**
 * Updates the log retention days setting.
 */
export async function setRetentionDays(
	db: D1Database,
	days: number,
): Promise<void> {
	const value = Math.max(1, Math.floor(days)).toString();
	await upsertSetting(db, RETENTION_KEY, value);
}

/**
 * Returns the session TTL hours from settings or default fallback.
 */
export async function getSessionTtlHours(db: D1Database): Promise<number> {
	const value = await readSetting(db, SESSION_TTL_KEY);
	return parsePositiveNumber(value, DEFAULT_SESSION_TTL_HOURS);
}

/**
 * Updates the session TTL hours setting.
 */
export async function setSessionTtlHours(
	db: D1Database,
	hours: number,
): Promise<void> {
	const value = Math.max(1, Math.floor(hours)).toString();
	await upsertSetting(db, SESSION_TTL_KEY, value);
}

/**
 * Returns the admin password hash.
 */
export async function getAdminPasswordHash(
	db: D1Database,
): Promise<string | null> {
	return readSetting(db, ADMIN_PASSWORD_HASH_KEY);
}

/**
 * Updates the admin password hash.
 */
export async function setAdminPasswordHash(
	db: D1Database,
	hash: string,
): Promise<void> {
	if (!hash) {
		return;
	}
	await upsertSetting(db, ADMIN_PASSWORD_HASH_KEY, hash);
}

/**
 * Returns whether the admin password is set.
 */
export async function isAdminPasswordSet(db: D1Database): Promise<boolean> {
	const hash = await getAdminPasswordHash(db);
	return Boolean(hash);
}

const REGISTRATION_MODE_KEY = "registration_mode";
export type RegistrationMode = "open" | "linuxdo_only" | "closed";
const VALID_REGISTRATION_MODES: RegistrationMode[] = [
	"open",
	"linuxdo_only",
	"closed",
];

/**
 * Returns the registration mode setting.
 */
export async function getRegistrationMode(
	db: D1Database,
): Promise<RegistrationMode> {
	const value = await readSetting(db, REGISTRATION_MODE_KEY);
	if (value && VALID_REGISTRATION_MODES.includes(value as RegistrationMode)) {
		return value as RegistrationMode;
	}
	return "open";
}

/**
 * Updates the registration mode setting.
 */
export async function setRegistrationMode(
	db: D1Database,
	mode: RegistrationMode,
): Promise<void> {
	if (!VALID_REGISTRATION_MODES.includes(mode)) {
		return;
	}
	await upsertSetting(db, REGISTRATION_MODE_KEY, mode);
}

/**
 * Loads generic settings as a key/value map.
 */
export async function listSettings(
	db: D1Database,
): Promise<Record<string, string>> {
	const result = await db.prepare("SELECT key, value FROM settings").all();
	const map: Record<string, string> = {};
	for (const row of result.results ?? []) {
		map[String(row.key)] = String(row.value);
	}
	return map;
}

const CHECKIN_REWARD_KEY = "checkin_reward";
const DEFAULT_CHECKIN_REWARD = 0.5;

/**
 * Returns the check-in reward amount from settings or default fallback.
 */
export async function getCheckinReward(db: D1Database): Promise<number> {
	const value = await readSetting(db, CHECKIN_REWARD_KEY);
	return parsePositiveNumber(value, DEFAULT_CHECKIN_REWARD);
}

/**
 * Updates the check-in reward amount setting.
 */
export async function setCheckinReward(
	db: D1Database,
	amount: number,
): Promise<void> {
	const value = Math.max(0.01, amount).toString();
	await upsertSetting(db, CHECKIN_REWARD_KEY, value);
}

const REQUIRE_INVITE_CODE_KEY = "require_invite_code";

/**
 * Returns whether invite code is required for registration.
 */
export async function getRequireInviteCode(db: D1Database): Promise<boolean> {
	const value = await readSetting(db, REQUIRE_INVITE_CODE_KEY);
	return value === "true";
}

/**
 * Updates the require invite code setting.
 */
export async function setRequireInviteCode(
	db: D1Database,
	required: boolean,
): Promise<void> {
	await upsertSetting(db, REQUIRE_INVITE_CODE_KEY, required ? "true" : "false");
}

// LDC Payment settings
const LDC_PAYMENT_ENABLED_KEY = "ldc_payment_enabled";
const LDC_EPAY_PID_KEY = "ldc_epay_pid";
const LDC_EPAY_KEY_KEY = "ldc_epay_key";
const LDC_EPAY_GATEWAY_KEY = "ldc_epay_gateway";
const LDC_EXCHANGE_RATE_KEY = "ldc_exchange_rate";
const DEFAULT_LDC_EPAY_GATEWAY = "https://credit.linux.do/epay";
const DEFAULT_LDC_EXCHANGE_RATE = 0.1;

export async function getLdcPaymentEnabled(db: D1Database): Promise<boolean> {
	const value = await readSetting(db, LDC_PAYMENT_ENABLED_KEY);
	return value === "true";
}

export async function setLdcPaymentEnabled(
	db: D1Database,
	enabled: boolean,
): Promise<void> {
	await upsertSetting(db, LDC_PAYMENT_ENABLED_KEY, enabled ? "true" : "false");
}

export async function getLdcEpayPid(db: D1Database): Promise<string> {
	const value = await readSetting(db, LDC_EPAY_PID_KEY);
	return value ?? "";
}

export async function setLdcEpayPid(
	db: D1Database,
	pid: string,
): Promise<void> {
	await upsertSetting(db, LDC_EPAY_PID_KEY, pid);
}

export async function getLdcEpayKey(db: D1Database): Promise<string> {
	const value = await readSetting(db, LDC_EPAY_KEY_KEY);
	return value ?? "";
}

export async function setLdcEpayKey(
	db: D1Database,
	key: string,
): Promise<void> {
	await upsertSetting(db, LDC_EPAY_KEY_KEY, key);
}

export async function getLdcEpayGateway(db: D1Database): Promise<string> {
	const value = await readSetting(db, LDC_EPAY_GATEWAY_KEY);
	return value || DEFAULT_LDC_EPAY_GATEWAY;
}

export async function setLdcEpayGateway(
	db: D1Database,
	gateway: string,
): Promise<void> {
	await upsertSetting(db, LDC_EPAY_GATEWAY_KEY, gateway);
}

export async function getLdcExchangeRate(db: D1Database): Promise<number> {
	const value = await readSetting(db, LDC_EXCHANGE_RATE_KEY);
	if (!value) return DEFAULT_LDC_EXCHANGE_RATE;
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && parsed > 0) return parsed;
	return DEFAULT_LDC_EXCHANGE_RATE;
}

export async function setLdcExchangeRate(
	db: D1Database,
	rate: number,
): Promise<void> {
	const value = Math.max(0.001, rate).toString();
	await upsertSetting(db, LDC_EXCHANGE_RATE_KEY, value);
}

// Default balance for new users
const DEFAULT_BALANCE_KEY = "default_balance";

/**
 * Returns the default balance for new users.
 */
export async function getDefaultBalance(db: D1Database): Promise<number> {
	const value = await readSetting(db, DEFAULT_BALANCE_KEY);
	if (!value) return 0;
	const parsed = Number(value);
	if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
	return 0;
}

/**
 * Updates the default balance for new users.
 */
export async function setDefaultBalance(
	db: D1Database,
	amount: number,
): Promise<void> {
	const value = Math.max(0, amount).toString();
	await upsertSetting(db, DEFAULT_BALANCE_KEY, value);
}

// Proxy header policy (global inject / remove, raw JSON strings)

/**
 * Returns the global proxy extra headers JSON (empty string if not set).
 */
export async function getProxyExtraHeaders(db: D1Database): Promise<string> {
	const value = await readSetting(db, PROXY_EXTRA_HEADERS_KEY);
	return value ?? "";
}

/**
 * Updates the global proxy extra headers JSON. Pass empty string to clear.
 */
export async function setProxyExtraHeaders(
	db: D1Database,
	value: string,
): Promise<void> {
	await upsertSetting(db, PROXY_EXTRA_HEADERS_KEY, value);
}

/**
 * Returns the global proxy remove headers JSON (empty string if not set).
 */
export async function getProxyRemoveHeaders(db: D1Database): Promise<string> {
	const value = await readSetting(db, PROXY_REMOVE_HEADERS_KEY);
	return value ?? "";
}

/**
 * Updates the global proxy remove headers JSON. Pass empty string to clear.
 */
export async function setProxyRemoveHeaders(
	db: D1Database,
	value: string,
): Promise<void> {
	await upsertSetting(db, PROXY_REMOVE_HEADERS_KEY, value);
}

// Announcement
const ANNOUNCEMENT_KEY = "announcement";

/**
 * Returns the current site announcement text (empty string if not set).
 */
export async function getAnnouncement(db: D1Database): Promise<string> {
	const value = await readSetting(db, ANNOUNCEMENT_KEY);
	return value ?? "";
}

/**
 * Updates the site announcement. Pass empty string to clear.
 */
export async function setAnnouncement(
	db: D1Database,
	text: string,
): Promise<void> {
	await upsertSetting(db, ANNOUNCEMENT_KEY, text);
}

// Model test prompt (default text for channel model testing)
const MODEL_TEST_PROMPT_KEY = "model_test_prompt";

/**
 * Returns the model test prompt from settings, falling back to the built-in
 * default when the key is missing or blank.
 */
export async function getModelTestPrompt(db: D1Database): Promise<string> {
	const value = await readSetting(db, MODEL_TEST_PROMPT_KEY);
	return value && value.trim().length > 0 ? value : MODEL_TEST_DEFAULT_PROMPT;
}

/**
 * Updates the model test prompt. Pass empty string to reset to the default.
 */
export async function setModelTestPrompt(
	db: D1Database,
	text: string,
): Promise<void> {
	await upsertSetting(db, MODEL_TEST_PROMPT_KEY, text);
}

// Proxy retry rounds / delay (global retry behavior for the proxy paths)

export const PROXY_RETRY_ROUNDS_KEY = "proxy_retry_rounds";
export const PROXY_RETRY_DELAY_MS_KEY = "proxy_retry_delay_ms";
export const DEFAULT_PROXY_RETRY_ROUNDS = 2;
export const DEFAULT_PROXY_RETRY_DELAY_MS = 200;
export const MIN_PROXY_RETRY_ROUNDS = 1;
export const MAX_PROXY_RETRY_ROUNDS = 10;
export const MIN_PROXY_RETRY_DELAY_MS = 0;
export const MAX_PROXY_RETRY_DELAY_MS = 60000;

export type ProxyRetryConfig = { rounds: number; delayMs: number };

/** Raw env-var fallback (`PROXY_RETRY_ROUNDS` / `PROXY_RETRY_DELAY_MS`). */
export type ProxyRetryEnvFallback = {
	rounds?: string;
	delayMs?: string;
};

/**
 * Parses a stored/env-provided raw value into a bounded integer.
 * Missing/blank/non-integer input returns null (= fall through the fallback
 * chain); out-of-range integers are clamped into [min, max] instead of
 * failing, so dirty stored values never break proxy requests.
 */
function parseBoundedRetryInt(
	raw: string | null | undefined,
	min: number,
	max: number,
): number | null {
	if (raw === null || raw === undefined || raw === "") {
		return null;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed)) {
		return null;
	}
	return Math.min(max, Math.max(min, parsed));
}

/**
 * Loads the proxy retry configuration (rounds + delay ms) with the fallback
 * chain: settings value → env var fallback → built-in default. Single SQL
 * query with both keys bound (same per-request preheat pattern as
 * loadProxyHeaderPolicy); out-of-range stored values are clamped on read.
 */
export async function loadProxyRetryConfig(
	db: D1Database,
	envFallback?: ProxyRetryEnvFallback,
): Promise<ProxyRetryConfig> {
	const raw = await readSettingsRawMap(db, [
		PROXY_RETRY_ROUNDS_KEY,
		PROXY_RETRY_DELAY_MS_KEY,
	]);
	return resolveProxyRetryConfig(raw, envFallback);
}

/**
 * Pure resolver for the retry config: raw settings map (+ optional env
 * fallback) → config, walking settings → env → default with read-side
 * clamping. Kept DB-free so callers reading the settings table through the
 * shared cached snapshot (loadProxySettingsCached) get the exact same
 * fallback-chain semantics, re-evaluated on every call.
 */
export function resolveProxyRetryConfig(
	raw: SettingsRawMap,
	envFallback?: ProxyRetryEnvFallback,
): ProxyRetryConfig {
	const rounds =
		parseBoundedRetryInt(
			raw[PROXY_RETRY_ROUNDS_KEY] ?? null,
			MIN_PROXY_RETRY_ROUNDS,
			MAX_PROXY_RETRY_ROUNDS,
		) ??
		parseBoundedRetryInt(
			envFallback?.rounds,
			MIN_PROXY_RETRY_ROUNDS,
			MAX_PROXY_RETRY_ROUNDS,
		) ??
		DEFAULT_PROXY_RETRY_ROUNDS;
	const delayMs =
		parseBoundedRetryInt(
			raw[PROXY_RETRY_DELAY_MS_KEY] ?? null,
			MIN_PROXY_RETRY_DELAY_MS,
			MAX_PROXY_RETRY_DELAY_MS,
		) ??
		parseBoundedRetryInt(
			envFallback?.delayMs,
			MIN_PROXY_RETRY_DELAY_MS,
			MAX_PROXY_RETRY_DELAY_MS,
		) ??
		DEFAULT_PROXY_RETRY_DELAY_MS;
	return { rounds, delayMs };
}

/**
 * Updates the proxy retry rounds setting.
 */
export async function setProxyRetryRounds(
	db: D1Database,
	rounds: number,
): Promise<void> {
	await upsertSetting(db, PROXY_RETRY_ROUNDS_KEY, rounds.toString());
}

/**
 * Updates the proxy retry delay (ms) setting.
 */
export async function setProxyRetryDelayMs(
	db: D1Database,
	delayMs: number,
): Promise<void> {
	await upsertSetting(db, PROXY_RETRY_DELAY_MS_KEY, delayMs.toString());
}

// Proxy runtime settings snapshot (header policy ×2 + retry ×2, cached read)

/**
 * The four settings keys the proxy hot path consumes, read in one query:
 * global header policy (extra/remove) + retry config (rounds/delay).
 */
export const PROXY_SETTING_KEYS = [
	PROXY_EXTRA_HEADERS_KEY,
	PROXY_REMOVE_HEADERS_KEY,
	PROXY_RETRY_ROUNDS_KEY,
	PROXY_RETRY_DELAY_MS_KEY,
] as const;

const PROXY_SETTINGS_CACHE_KEY = "proxy";

/**
 * Per-db cache registry. Production binds one D1Database object per isolate,
 * so entries persist across requests; tests pass distinct mock dbs and never
 * share cached state.
 */
const proxySettingsCaches = new WeakMap<D1Database, TtlCache<SettingsRawMap>>();

/**
 * Loads the four proxy runtime settings keys with a single SQL query,
 * memoized PROXY_SETTINGS_CACHE_TTL_MS per db binding. Only the raw
 * settings-table read is cached — callers re-run the pure fallback-chain /
 * clamp / fail-open parsers (resolveProxyRetryConfig, parseHeaderPolicyFromRaw)
 * on every call, so the tiered fallback semantics are untouched (the existing
 * settings tests keep passing unchanged). Management edits become visible
 * within the TTL window (documented staleness bound, AGENTS §8).
 */
export async function loadProxySettingsCached(
	db: D1Database,
): Promise<SettingsRawMap> {
	const cache = getTtlCache(
		proxySettingsCaches,
		db,
		PROXY_SETTINGS_CACHE_TTL_MS,
	);
	const hit = cache.get(PROXY_SETTINGS_CACHE_KEY);
	if (hit !== undefined) {
		return hit;
	}
	const raw = await readSettingsRawMap(db, PROXY_SETTING_KEYS);
	cache.set(PROXY_SETTINGS_CACHE_KEY, raw);
	return raw;
}

// Turnstile (login/register human verification)

export const TURNSTILE_ENABLED_KEY = "turnstile_enabled";
export const TURNSTILE_SITE_KEY_KEY = "turnstile_site_key";
export const TURNSTILE_SECRET_KEY_KEY = "turnstile_secret_key";

export type TurnstileKeysConfig = {
	/** 存储态开关（严格 "true" 才为 true；脏值一律视为未启用） */
	enabled: boolean;
	siteKey: string;
	secretKey: string;
};

/**
 * Loads the three turnstile settings keys with a single SQL query
 * (same `key IN` pattern as loadProxyRetryConfig). Read-side lenient:
 * missing keys / dirty values degrade to disabled + empty keys.
 */
export async function getTurnstileConfig(
	db: D1Database,
): Promise<TurnstileKeysConfig> {
	const result = await db
		.prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)")
		.bind(
			TURNSTILE_ENABLED_KEY,
			TURNSTILE_SITE_KEY_KEY,
			TURNSTILE_SECRET_KEY_KEY,
		)
		.all<{ key: string; value: string | null }>();
	let enabledRaw: string | null = null;
	let siteKey = "";
	let secretKey = "";
	for (const row of result.results ?? []) {
		if (row.key === TURNSTILE_ENABLED_KEY) {
			enabledRaw = row.value ?? null;
		} else if (row.key === TURNSTILE_SITE_KEY_KEY) {
			siteKey = row.value ?? "";
		} else if (row.key === TURNSTILE_SECRET_KEY_KEY) {
			secretKey = row.value ?? "";
		}
	}
	return { enabled: enabledRaw === "true", siteKey, secretKey };
}

/**
 * Updates the turnstile enabled flag.
 */
export async function setTurnstileEnabled(
	db: D1Database,
	enabled: boolean,
): Promise<void> {
	await upsertSetting(db, TURNSTILE_ENABLED_KEY, enabled ? "true" : "false");
}

/**
 * Updates the turnstile site key. Pass empty string to clear.
 */
export async function setTurnstileSiteKey(
	db: D1Database,
	siteKey: string,
): Promise<void> {
	await upsertSetting(db, TURNSTILE_SITE_KEY_KEY, siteKey);
}

/**
 * Updates the turnstile secret key. Pass empty string to clear.
 */
export async function setTurnstileSecretKey(
	db: D1Database,
	secretKey: string,
): Promise<void> {
	await upsertSetting(db, TURNSTILE_SECRET_KEY_KEY, secretKey);
}
