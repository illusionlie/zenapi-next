import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { canConsumeQuota, normalizeQuota } from "../services/quota";
import {
	checkTokenRpm,
	hasTokenRpmRequests,
	ipAuthFailureCount,
	ipThrottleRetryAfterSec,
	isIpThrottled,
	noteTokenRpmArrival,
	recordIpAuthFailure,
} from "../services/rate-limiter";
import {
	loadProxySettingsCached,
	resolveRateLimitConfig,
} from "../services/settings";
import { sha256Hex } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { parseAllowlist } from "../utils/model-allowlist";
import { getBearerToken } from "../utils/request";

export type TokenRecord = {
	id: string;
	name: string;
	quota_total: number | null;
	quota_used: number;
	status: string;
	allowed_channels: string | null;
	allowed_models: string | null;
	/** Optional expiry (ISO-8601 UTC; null = permanent). Evaluated lazily below. */
	expires_at: string | null;
	/**
	 * Per-token RPM cap (migration 0029): positive integer = requests per
	 * minute, 0 = explicitly unlimited (exempts the global default), null =
	 * follow the global default (settings token_rpm_default).
	 */
	rpm_limit: number | null;
	user_id: string | null;
	/** Joined users.balance (null when the token has no user or the user row is missing). */
	user_balance?: number | null;
	/** Joined users.status (null when the token has no user or the user row is missing). */
	user_status?: string | null;
	/** Joined users.allowed_models raw TEXT (null when the token has no user or the user row is missing). */
	user_allowed_models_raw?: string | null;
	/** User-level model allowlist (parsed); null/undefined = unrestricted. */
	user_allowed_models?: string[] | null;
	/** Token-level model allowlist (parsed from tokens.allowed_models); null/undefined = unrestricted. */
	token_allowed_models?: string[] | null;
};

/**
 * Client IP for the auth-failure throttle: cf-connecting-ip (set by
 * Cloudflare for edge traffic) → first x-forwarded-for hop → null (both
 * client-side gates skipped — no attribution basis, never a guess).
 */
function extractClientIp(c: Context): string | null {
	const cfIp = c.req.header("cf-connecting-ip");
	if (cfIp?.trim()) {
		return cfIp.trim();
	}
	const forwarded = c.req.header("x-forwarded-for");
	if (forwarded) {
		const first = forwarded.split(",")[0]?.trim();
		if (first) {
			return first;
		}
	}
	return null;
}

/**
 * Validates API tokens for the OpenAI-compatible proxy.
 */
export const tokenAuth = createMiddleware<AppEnv>(async (c, next) => {
	// [客户端限流·IP 节流门]（design.md §4，D1 查询之前）：同 IP 60s 滑窗内的
	// 鉴权失败达阈值（settings ip_auth_fail_limit，0 = 关）→ 直接 429，零 D1
	// 查询（防 token 字典爆破扫描）。惰性短路：零失败记录的 IP 在任何阈值下都
	// 不可能被节流，因此无需读取 settings——全默认配置下的请求路径保持与
	// 改造前完全一致的 D1 查询次数（既有测试的单查询行为锚点）。
	const clientIp = extractClientIp(c);
	if (clientIp && ipAuthFailureCount(clientIp) > 0) {
		const rateLimitConfig = resolveRateLimitConfig(
			await loadProxySettingsCached(c.env.DB),
		);
		if (isIpThrottled(clientIp, rateLimitConfig.ipAuthFailLimit)) {
			c.header("Retry-After", String(ipThrottleRetryAfterSec(clientIp)));
			return jsonError(c, 429, "auth_throttled", "auth_throttled");
		}
	}

	const token = getBearerToken(c);
	if (!token) {
		if (clientIp) {
			recordIpAuthFailure(clientIp);
		}
		return jsonError(c, 401, "token_required", "token_required");
	}

	const tokenHash = await sha256Hex(token);
	// Single-round-trip auth: tokens LEFT JOIN users replaces the former two
	// serial queries (tokens → users by user_id). User-side columns are all
	// aliased `user_*` — both tables share the `status` / `allowed_models`
	// column names, which must never be selected bare. LEFT JOIN keeps no-user
	// tokens working (user fields come back null, user gates below skipped
	// exactly as before); a dangling user_id yields null user fields and hits
	// the same `user_disabled` rejection as the old missing-row path.
	const record = await c.env.DB.prepare(
		`SELECT t.id, t.name, t.quota_total, t.quota_used, t.status,
		        t.allowed_channels, t.allowed_models, t.user_id, t.expires_at,
		        t.rpm_limit,
		        u.balance AS user_balance, u.status AS user_status,
		        u.allowed_models AS user_allowed_models_raw
		 FROM tokens t
		 LEFT JOIN users u ON u.id = t.user_id
		 WHERE t.key_hash = ?`,
	)
		.bind(tokenHash)
		.first<TokenRecord>();

	if (!record) {
		if (clientIp) {
			recordIpAuthFailure(clientIp);
		}
		return jsonError(c, 401, "invalid_token", "invalid_token");
	}

	if (record.status !== "active") {
		if (clientIp) {
			recordIpAuthFailure(clientIp);
		}
		return jsonError(c, 403, "token_disabled", "token_disabled");
	}

	// Lazy expiry gate (task 10-26-token-expiry R2): an expired token is
	// rejected in place — never deleted, never status-flipped (expiry is a
	// computed state; `status` stays the admin-intent state). Comparison is
	// millisecond-precision ISO parsing, mirroring the session-expiry
	// precedent in adminAuth/userAuth. Invalid stored values parse to NaN,
	// and `NaN <= anything` is false → fail open (treated as permanent), so
	// legacy dirty rows never brick live traffic.
	if (
		record.expires_at &&
		new Date(record.expires_at).getTime() <= Date.now()
	) {
		if (clientIp) {
			recordIpAuthFailure(clientIp);
		}
		return jsonError(c, 403, "token_expired", "token_expired");
	}

	// IP 失败计数口径（design.md §4 定稿）：仅上述四个出口（401 token_required
	// / invalid_token、403 token_disabled / token_expired）计数；下方 402
	// quota/balance 是合法客户端的资金问题、403 user_disabled 时令牌本身有效
	// ——都不是爆破信号，不计数。鉴权成功也不计数（正常流量不推进失败窗）。

	const quotaTotal =
		record.quota_total === null || record.quota_total === undefined
			? null
			: Number(record.quota_total);
	const quotaUsed = Number(record.quota_used ?? 0);
	const normalized = normalizeQuota(
		Number.isNaN(quotaTotal) ? null : quotaTotal,
		Number.isNaN(quotaUsed) ? 0 : quotaUsed,
	);
	if (!canConsumeQuota(normalized.quotaTotal, normalized.quotaUsed, 1)) {
		return jsonError(c, 402, "quota_exceeded", "quota_exceeded");
	}

	// User-associated tokens: check user status and balance from the joined
	// columns (null user fields = missing user row → same rejections as the
	// old two-query flow)
	let userAllowedModels: string[] | null = null;
	if (record.user_id) {
		if (record.user_status !== "active") {
			return jsonError(c, 403, "user_disabled", "user_disabled");
		}
		if (Number(record.user_balance ?? 0) <= 0) {
			return jsonError(c, 402, "insufficient_balance", "insufficient_balance");
		}
		userAllowedModels = parseAllowlist(record.user_allowed_models_raw);
	}

	// [客户端限流·RPM 门]（尾部，next 之前；isolate 内存 60s 滑窗近似，限到达
	// 速率）：rpm_limit 三态——0 = 显式豁免；正整数 = 每分钟上限；NULL = 跟随
	// 全局默认 token_rpm_default。超限 429 rate_limit_exceeded + Retry-After，
	// 此处拦截天然不发上游、不写 usage_logs、不扣费（R4）。
	// 惰性短路：NULL 且窗口为空时，任何默认值（0 = 关或任意正数）对空窗口都
	// 判 allowed——首个到达按到达语义记账即可，窗口非空后才解析全局默认，
	// 全默认配置下不新增任何 settings D1 读（loadProxySettingsCached 30s TTL
	// 缓存与代理热路径共享同一快照）。
	const rawRpmLimit = record.rpm_limit;
	const tokenRpmLimit =
		rawRpmLimit === null || rawRpmLimit === undefined
			? null
			: Number(rawRpmLimit);
	if (tokenRpmLimit !== 0) {
		let effectiveLimit: number | null = tokenRpmLimit;
		if (effectiveLimit === null) {
			if (hasTokenRpmRequests(record.id)) {
				const rateLimitConfig = resolveRateLimitConfig(
					await loadProxySettingsCached(c.env.DB),
				);
				effectiveLimit = rateLimitConfig.tokenRpmDefault;
			} else {
				noteTokenRpmArrival(record.id);
			}
		}
		if (effectiveLimit !== null && effectiveLimit > 0) {
			const rpmResult = checkTokenRpm(record.id, effectiveLimit);
			if (!rpmResult.allowed) {
				c.header("Retry-After", String(rpmResult.retryAfterSec));
				return jsonError(c, 429, "rate_limit_exceeded", "rate_limit_exceeded");
			}
		}
	}

	c.set("tokenRecord", {
		...record,
		quota_total: normalized.quotaTotal,
		quota_used: normalized.quotaUsed,
		token_allowed_models: parseAllowlist(record.allowed_models),
		user_allowed_models: userAllowedModels,
	});
	await next();
});
