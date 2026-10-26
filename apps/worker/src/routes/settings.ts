import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	getAnnouncement,
	getCheckinReward,
	getDefaultBalance,
	getLdcEpayGateway,
	getLdcEpayKey,
	getLdcEpayPid,
	getLdcExchangeRate,
	getLdcPaymentEnabled,
	getModelTestPrompt,
	getProxyExtraHeaders,
	getProxyRemoveHeaders,
	getRegistrationMode,
	getRequireInviteCode,
	getRetentionDays,
	getSessionTtlHours,
	getTurnstileConfig,
	isAdminPasswordSet,
	loadDebugLogFlagDirect,
	loadDeveloperNormalizeFlagDirect,
	loadProxyRetryConfig,
	loadRateLimitConfigDirect,
	MAX_PROXY_RETRY_DELAY_MS,
	MAX_PROXY_RETRY_ROUNDS,
	MAX_RATE_LIMIT_VALUE,
	MIN_PROXY_RETRY_DELAY_MS,
	MIN_PROXY_RETRY_ROUNDS,
	MIN_RATE_LIMIT_VALUE,
	type RegistrationMode,
	setAdminPasswordHash,
	setAnnouncement,
	setCheckinReward,
	setDebugRequestBodyLog,
	setDefaultBalance,
	setDeveloperNormalizeFlag,
	setIpAuthFailLimit,
	setLdcEpayGateway,
	setLdcEpayKey,
	setLdcEpayPid,
	setLdcExchangeRate,
	setLdcPaymentEnabled,
	setModelTestPrompt,
	setProxyExtraHeaders,
	setProxyRemoveHeaders,
	setProxyRetryDelayMs,
	setProxyRetryRounds,
	setRegistrationMode,
	setRequireInviteCode,
	setRetentionDays,
	setSessionTtlHours,
	setTokenRpmDefault,
	setTurnstileEnabled,
	setTurnstileSecretKey,
	setTurnstileSiteKey,
} from "../services/settings";
import { sha256Hex } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { parseExtraHeaders, parseRemoveHeaders } from "../utils/proxy-headers";

const settings = new Hono<AppEnv>();

/**
 * Returns settings values.
 */
settings.get("/", async (c) => {
	const retention = await getRetentionDays(c.env.DB);
	const sessionTtlHours = await getSessionTtlHours(c.env.DB);
	const adminPasswordSet = await isAdminPasswordSet(c.env.DB);
	const registrationMode = await getRegistrationMode(c.env.DB);
	const checkinReward = await getCheckinReward(c.env.DB);
	const requireInviteCode = await getRequireInviteCode(c.env.DB);
	const ldcPaymentEnabled = await getLdcPaymentEnabled(c.env.DB);
	const ldcEpayPid = await getLdcEpayPid(c.env.DB);
	const ldcEpayKey = await getLdcEpayKey(c.env.DB);
	const ldcEpayGateway = await getLdcEpayGateway(c.env.DB);
	const ldcExchangeRate = await getLdcExchangeRate(c.env.DB);
	const defaultBalance = await getDefaultBalance(c.env.DB);
	const announcement = await getAnnouncement(c.env.DB);
	const proxyExtraHeaders = await getProxyExtraHeaders(c.env.DB);
	const proxyRemoveHeaders = await getProxyRemoveHeaders(c.env.DB);
	const modelTestPrompt = await getModelTestPrompt(c.env.DB);
	const proxyRetryConfig = await loadProxyRetryConfig(c.env.DB);
	const turnstileConfig = await getTurnstileConfig(c.env.DB);
	// 不带 env 回退、绕过 30s TTL 缓存（与 loadProxyRetryConfig(db) 同一
	// "admin form truth" GET 契约）：PUT 后同 isolate 的 GET 必须立即看到新值
	// （loadDebugLogFlagDirect），/v1 热路径中间件仍走缓存的 loadDebugLogFlag；
	// 也不透显 env 值，避免保存时把 env 值意外固化进 settings
	const debugRequestBodyLog = await loadDebugLogFlagDirect(c.env.DB);
	// 同一 "admin form truth" GET 契约：绕 30s 缓存直读，两级链无 env 回退
	const normalizeDeveloperRole = await loadDeveloperNormalizeFlagDirect(
		c.env.DB,
	);
	// 客户端限流两键同契约：直读 clamp 后有效值（表单即真相；缺失键 = 0 = 关闭）
	const rateLimitConfig = await loadRateLimitConfigDirect(c.env.DB);
	return c.json({
		log_retention_days: retention,
		session_ttl_hours: sessionTtlHours,
		admin_password_set: adminPasswordSet,
		registration_mode: registrationMode,
		checkin_reward: checkinReward,
		require_invite_code: requireInviteCode,
		ldc_payment_enabled: ldcPaymentEnabled,
		ldc_epay_pid: ldcEpayPid,
		ldc_epay_key: ldcEpayKey,
		ldc_epay_gateway: ldcEpayGateway,
		ldc_exchange_rate: ldcExchangeRate,
		default_balance: defaultBalance,
		announcement: announcement,
		proxy_extra_headers: proxyExtraHeaders,
		proxy_remove_headers: proxyRemoveHeaders,
		proxy_retry_rounds: proxyRetryConfig.rounds,
		proxy_retry_delay_ms: proxyRetryConfig.delayMs,
		// 客户端限流两键（表单即真相：clamp 后有效值，缺失 = 0 = 关闭）
		token_rpm_default: rateLimitConfig.tokenRpmDefault,
		ip_auth_fail_limit: rateLimitConfig.ipAuthFailLimit,
		model_test_prompt: modelTestPrompt,
		debug_request_body_log: debugRequestBodyLog,
		normalize_developer_role: normalizeDeveloperRole,
		// secret 永不回显，只返回已设置布尔（先例：admin_password_hash）
		turnstile_enabled: turnstileConfig.enabled,
		turnstile_site_key: turnstileConfig.siteKey,
		turnstile_secret_key_set: turnstileConfig.secretKey !== "",
	});
});

/**
 * Updates settings values.
 */
settings.put("/", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body) {
		return jsonError(c, 400, "settings_required", "settings_required");
	}

	let touched = false;

	if (body.log_retention_days !== undefined) {
		const days = Number(body.log_retention_days);
		if (Number.isNaN(days) || days < 1) {
			return jsonError(
				c,
				400,
				"invalid_log_retention_days",
				"invalid_log_retention_days",
			);
		}
		await setRetentionDays(c.env.DB, days);
		touched = true;
	}

	if (body.session_ttl_hours !== undefined) {
		const hours = Number(body.session_ttl_hours);
		if (Number.isNaN(hours) || hours < 1) {
			return jsonError(
				c,
				400,
				"invalid_session_ttl_hours",
				"invalid_session_ttl_hours",
			);
		}
		await setSessionTtlHours(c.env.DB, hours);
		touched = true;
	}

	if (typeof body.admin_password === "string" && body.admin_password.trim()) {
		const hash = await sha256Hex(body.admin_password.trim());
		await setAdminPasswordHash(c.env.DB, hash);
		touched = true;
	}

	if (body.registration_mode !== undefined) {
		const validModes: RegistrationMode[] = ["open", "linuxdo_only", "closed"];
		if (!validModes.includes(body.registration_mode)) {
			return jsonError(
				c,
				400,
				"invalid_registration_mode",
				"invalid_registration_mode",
			);
		}
		await setRegistrationMode(c.env.DB, body.registration_mode);
		touched = true;
	}

	if (body.checkin_reward !== undefined) {
		const reward = Number(body.checkin_reward);
		if (Number.isNaN(reward) || reward <= 0) {
			return jsonError(
				c,
				400,
				"invalid_checkin_reward",
				"invalid_checkin_reward",
			);
		}
		await setCheckinReward(c.env.DB, reward);
		touched = true;
	}

	if (body.require_invite_code !== undefined) {
		const value =
			body.require_invite_code === true || body.require_invite_code === "true";
		await setRequireInviteCode(c.env.DB, value);
		touched = true;
	}

	if (body.ldc_payment_enabled !== undefined) {
		const value =
			body.ldc_payment_enabled === true || body.ldc_payment_enabled === "true";
		await setLdcPaymentEnabled(c.env.DB, value);
		touched = true;
	}

	if (body.ldc_epay_pid !== undefined) {
		await setLdcEpayPid(c.env.DB, String(body.ldc_epay_pid));
		touched = true;
	}

	if (body.ldc_epay_key !== undefined) {
		await setLdcEpayKey(c.env.DB, String(body.ldc_epay_key));
		touched = true;
	}

	if (body.ldc_epay_gateway !== undefined) {
		await setLdcEpayGateway(c.env.DB, String(body.ldc_epay_gateway));
		touched = true;
	}

	if (body.ldc_exchange_rate !== undefined) {
		const rate = Number(body.ldc_exchange_rate);
		if (Number.isNaN(rate) || rate <= 0) {
			return jsonError(
				c,
				400,
				"invalid_ldc_exchange_rate",
				"invalid_ldc_exchange_rate",
			);
		}
		await setLdcExchangeRate(c.env.DB, rate);
		touched = true;
	}

	if (body.default_balance !== undefined) {
		const amount = Number(body.default_balance);
		if (Number.isNaN(amount) || amount < 0) {
			return jsonError(
				c,
				400,
				"invalid_default_balance",
				"invalid_default_balance",
			);
		}
		await setDefaultBalance(c.env.DB, amount);
		touched = true;
	}

	if (body.announcement !== undefined) {
		await setAnnouncement(c.env.DB, String(body.announcement));
		touched = true;
	}

	if (body.proxy_extra_headers !== undefined) {
		const raw = body.proxy_extra_headers;
		if (typeof raw !== "string" || parseExtraHeaders(raw) === null) {
			return jsonError(
				c,
				400,
				"invalid_proxy_extra_headers",
				"invalid_proxy_extra_headers",
			);
		}
		await setProxyExtraHeaders(c.env.DB, raw);
		touched = true;
	}

	if (body.proxy_remove_headers !== undefined) {
		const raw = body.proxy_remove_headers;
		if (typeof raw !== "string" || parseRemoveHeaders(raw) === null) {
			return jsonError(
				c,
				400,
				"invalid_proxy_remove_headers",
				"invalid_proxy_remove_headers",
			);
		}
		await setProxyRemoveHeaders(c.env.DB, raw);
		touched = true;
	}

	if (body.proxy_retry_rounds !== undefined) {
		const rounds = Number(body.proxy_retry_rounds);
		if (
			!Number.isInteger(rounds) ||
			rounds < MIN_PROXY_RETRY_ROUNDS ||
			rounds > MAX_PROXY_RETRY_ROUNDS
		) {
			return jsonError(
				c,
				400,
				"invalid_proxy_retry_rounds",
				"invalid_proxy_retry_rounds",
			);
		}
		await setProxyRetryRounds(c.env.DB, rounds);
		touched = true;
	}

	if (body.proxy_retry_delay_ms !== undefined) {
		const delayMs = Number(body.proxy_retry_delay_ms);
		if (
			!Number.isInteger(delayMs) ||
			delayMs < MIN_PROXY_RETRY_DELAY_MS ||
			delayMs > MAX_PROXY_RETRY_DELAY_MS
		) {
			return jsonError(
				c,
				400,
				"invalid_proxy_retry_delay_ms",
				"invalid_proxy_retry_delay_ms",
			);
		}
		await setProxyRetryDelayMs(c.env.DB, delayMs);
		touched = true;
	}

	// 客户端限流两键：数值契约同 proxy_retry_*（写侧严格整数 + 范围校验
	// [MIN_RATE_LIMIT_VALUE, MAX_RATE_LIMIT_VALUE]，读侧 clamp / 脏值降 0 在
	// resolveRateLimitConfig——两级形态，无 env 层）；0 = 关闭对应限流器
	if (body.token_rpm_default !== undefined) {
		const tokenRpmDefault = Number(body.token_rpm_default);
		if (
			!Number.isInteger(tokenRpmDefault) ||
			tokenRpmDefault < MIN_RATE_LIMIT_VALUE ||
			tokenRpmDefault > MAX_RATE_LIMIT_VALUE
		) {
			return jsonError(
				c,
				400,
				"invalid_token_rpm_default",
				"invalid_token_rpm_default",
			);
		}
		await setTokenRpmDefault(c.env.DB, tokenRpmDefault);
		touched = true;
	}

	if (body.ip_auth_fail_limit !== undefined) {
		const ipAuthFailLimit = Number(body.ip_auth_fail_limit);
		if (
			!Number.isInteger(ipAuthFailLimit) ||
			ipAuthFailLimit < MIN_RATE_LIMIT_VALUE ||
			ipAuthFailLimit > MAX_RATE_LIMIT_VALUE
		) {
			return jsonError(
				c,
				400,
				"invalid_ip_auth_fail_limit",
				"invalid_ip_auth_fail_limit",
			);
		}
		await setIpAuthFailLimit(c.env.DB, ipAuthFailLimit);
		touched = true;
	}

	// Debug request body log（P2）：写侧严格布尔 —— 仅接受 true/false（布尔或
	// "true"/"false" 字符串）；0/1、"yes" 等一切其他值拒绝（400），防止真值
	// 强制转换悄悄打开全量请求体日志
	if (body.debug_request_body_log !== undefined) {
		const value = body.debug_request_body_log;
		if (
			value !== true &&
			value !== false &&
			value !== "true" &&
			value !== "false"
		) {
			return jsonError(
				c,
				400,
				"invalid_debug_request_body_log",
				"invalid_debug_request_body_log",
			);
		}
		await setDebugRequestBodyLog(c.env.DB, value === true || value === "true");
		touched = true;
	}

	// Developer 角色归一化开关：写侧严格布尔（同 debug 键约定——仅接受
	// true/false 布尔或 "true"/"false" 字符串，其余 400）；读取侧两级链
	// 无 env 回退，缺失/脏值一律降级 false（默认关闭）
	if (body.normalize_developer_role !== undefined) {
		const value = body.normalize_developer_role;
		if (
			value !== true &&
			value !== false &&
			value !== "true" &&
			value !== "false"
		) {
			return jsonError(
				c,
				400,
				"invalid_normalize_developer_role",
				"invalid_normalize_developer_role",
			);
		}
		await setDeveloperNormalizeFlag(
			c.env.DB,
			value === true || value === "true",
		);
		touched = true;
	}

	// 与 announcement 相同的宽容语义：接受任意字符串原样存库；
	// 空串/空白在 getModelTestPrompt 读取时回退内置默认值
	if (body.model_test_prompt !== undefined) {
		await setModelTestPrompt(c.env.DB, String(body.model_test_prompt));
		touched = true;
	}

	// Turnstile：先合并三态解析（键缺省 = 保留现值），校验全部通过后再落库，
	// 保证库内不出现「enabled=true 而两键缺失」的半配置脏状态（写侧 fail-closed）
	const bodyIsObject = typeof body === "object" && body !== null;
	const hasTurnstileFields =
		bodyIsObject &&
		("turnstile_enabled" in body ||
			"turnstile_site_key" in body ||
			"turnstile_secret_key" in body);

	if (bodyIsObject && hasTurnstileFields) {
		const current = await getTurnstileConfig(c.env.DB);

		let enabled: boolean;
		if (body.turnstile_enabled !== undefined) {
			if (
				body.turnstile_enabled !== "true" &&
				body.turnstile_enabled !== "false"
			) {
				return jsonError(
					c,
					400,
					"invalid_turnstile_enabled",
					"invalid_turnstile_enabled",
				);
			}
			enabled = body.turnstile_enabled === "true";
		} else {
			enabled = current.enabled;
		}

		let siteKey: string;
		if (body.turnstile_site_key !== undefined) {
			if (typeof body.turnstile_site_key !== "string") {
				return jsonError(
					c,
					400,
					"invalid_turnstile_site_key",
					"invalid_turnstile_site_key",
				);
			}
			siteKey = body.turnstile_site_key.trim();
			if (siteKey.length > 200) {
				return jsonError(
					c,
					400,
					"invalid_turnstile_site_key",
					"invalid_turnstile_site_key",
				);
			}
		} else {
			siteKey = current.siteKey;
		}

		// secret 三态：键缺省 = 保留；null / "" = 清除；非空字符串 = 覆盖
		let secretKey: string;
		if ("turnstile_secret_key" in body) {
			const raw = body.turnstile_secret_key;
			if (raw === null || raw === "") {
				secretKey = "";
			} else if (typeof raw === "string") {
				secretKey = raw;
			} else {
				return jsonError(
					c,
					400,
					"invalid_turnstile_secret_key",
					"invalid_turnstile_secret_key",
				);
			}
		} else {
			secretKey = current.secretKey;
		}

		if (enabled && (siteKey === "" || secretKey === "")) {
			return jsonError(c, 400, "turnstile_incomplete", "turnstile_incomplete");
		}

		if (body.turnstile_enabled !== undefined) {
			await setTurnstileEnabled(c.env.DB, enabled);
			touched = true;
		}
		if (body.turnstile_site_key !== undefined) {
			await setTurnstileSiteKey(c.env.DB, siteKey);
			touched = true;
		}
		if ("turnstile_secret_key" in body) {
			await setTurnstileSecretKey(c.env.DB, secretKey);
			touched = true;
		}
	}

	if (!touched) {
		return jsonError(c, 400, "settings_empty", "settings_empty");
	}

	return c.json({ ok: true });
});

export default settings;
