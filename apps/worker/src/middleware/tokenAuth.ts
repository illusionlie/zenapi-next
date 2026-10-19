import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { canConsumeQuota, normalizeQuota } from "../services/quota";
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
 * Validates API tokens for the OpenAI-compatible proxy.
 */
export const tokenAuth = createMiddleware<AppEnv>(async (c, next) => {
	const token = getBearerToken(c);
	if (!token) {
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
		        t.allowed_channels, t.allowed_models, t.user_id,
		        u.balance AS user_balance, u.status AS user_status,
		        u.allowed_models AS user_allowed_models_raw
		 FROM tokens t
		 LEFT JOIN users u ON u.id = t.user_id
		 WHERE t.key_hash = ?`,
	)
		.bind(tokenHash)
		.first<TokenRecord>();

	if (!record) {
		return jsonError(c, 401, "invalid_token", "invalid_token");
	}

	if (record.status !== "active") {
		return jsonError(c, 403, "token_disabled", "token_disabled");
	}

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

	c.set("tokenRecord", {
		...record,
		quota_total: normalized.quotaTotal,
		quota_used: normalized.quotaUsed,
		token_allowed_models: parseAllowlist(record.allowed_models),
		user_allowed_models: userAllowedModels,
	});
	await next();
});
