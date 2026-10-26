import { serializeAllowlist } from "../utils/model-allowlist";

/**
 * Shape of a token row as read from the DB, used as the base for
 * three-state PATCH resolution.
 */
export type ExistingToken = {
	name: string;
	quota_total: number | null;
	quota_used: number;
	status: string;
	allowed_channels: string | null;
	allowed_models: string | null;
	/** Optional expiry (ISO-8601 UTC; null = permanent). */
	expires_at: string | null;
	/**
	 * Per-token RPM cap: null = follow the global default, 0 = explicitly
	 * unlimited, positive = requests per minute.
	 */
	rpm_limit: number | null;
};

/** Final column values to write back after a successful update. */
export type TokenUpdateValues = ExistingToken;

/** snake_case error codes aligned with the jsonError convention. */
export type TokenUpdateError =
	| "missing_body"
	| "invalid_name"
	| "invalid_quota"
	| "invalid_status"
	| "invalid_allowed_models"
	| "invalid_expires_at"
	| "invalid_rpm_limit";

export type TokenUpdateResult =
	| { ok: true; values: TokenUpdateValues }
	| { ok: false; error: TokenUpdateError };

/**
 * Validates and normalizes an expiry input for write paths (POST creates and
 * the PATCH resolvers share this single gate; pure function).
 *
 * - `undefined` / `null` / `""` → `{ ok: true, value: null }` (permanent).
 *   POST treats those identically (nothing to keep — there is no existing
 *   row); PATCH distinguishes `undefined` (keep) upstream, before calling.
 * - a string that parses to a finite timestamp strictly later than now →
 *   normalized to ISO-8601 UTC (`toISOString()`), the storage invariant
 *   shared with `created_at`.
 * - anything else (past dates, unparseable strings, non-strings) →
 *   `invalid_expires_at` — never a silent fallback.
 */
export function resolveExpiresAtValue(
	raw: unknown,
):
	| { ok: true; value: string | null }
	| { ok: false; error: "invalid_expires_at" } {
	if (raw === null || raw === undefined || raw === "") {
		return { ok: true, value: null };
	}
	const ms = typeof raw === "string" ? new Date(raw).getTime() : Number.NaN;
	if (!Number.isFinite(ms) || ms <= Date.now()) {
		return { ok: false, error: "invalid_expires_at" };
	}
	return { ok: true, value: new Date(ms).toISOString() };
}

/**
 * Validates and normalizes a token RPM limit for write paths (POST creates
 * and the PATCH resolvers share this single gate; pure function, mirrors
 * resolveExpiresAtValue).
 *
 * - `undefined` / `null` / `""` → `{ ok: true, value: null }` (follow the
 *   global default). POST treats those identically; PATCH distinguishes
 *   `undefined` (keep) upstream, before calling.
 * - 0 (explicitly unlimited — exempts the global default) or a positive
 *   integer → stored as-is.
 * - anything else (negative, fractional, non-number, NaN, Infinity) →
 *   `invalid_rpm_limit` — never a silent fallback.
 */
export function resolveRpmLimitValue(
	raw: unknown,
):
	| { ok: true; value: number | null }
	| { ok: false; error: "invalid_rpm_limit" } {
	if (raw === null || raw === undefined || raw === "") {
		return { ok: true, value: null };
	}
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
		return { ok: false, error: "invalid_rpm_limit" };
	}
	return { ok: true, value: raw };
}

/**
 * Resolves a PATCH payload against an existing token row (pure function).
 *
 * Three-state semantics per field (design.md D5.2):
 * - `undefined`  → keep the existing value
 * - `null`       → clear (only meaningful for quota_total / allowed_channels /
 *   allowed_models; treated as undefined elsewhere)
 * - concrete value → validate strictly; invalid input is rejected with 400
 *   instead of silently falling back to the old value
 *
 * The body must be a plain object; anything else (null, primitives, arrays)
 * yields `missing_body`.
 */
export function resolveTokenUpdate(
	body: unknown,
	existing: ExistingToken,
): TokenUpdateResult {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, error: "missing_body" };
	}
	const input = body as Record<string, unknown>;

	let name = existing.name;
	const rawName = input.name;
	if (rawName !== undefined && rawName !== null) {
		if (typeof rawName !== "string" || !rawName.trim()) {
			return { ok: false, error: "invalid_name" };
		}
		name = rawName;
	}

	let quotaTotal = existing.quota_total;
	const rawQuotaTotal = input.quota_total;
	if (rawQuotaTotal === null) {
		// null = clear back to unlimited
		quotaTotal = null;
	} else if (rawQuotaTotal !== undefined) {
		if (
			typeof rawQuotaTotal !== "number" ||
			!Number.isFinite(rawQuotaTotal) ||
			rawQuotaTotal < 0
		) {
			return { ok: false, error: "invalid_quota" };
		}
		quotaTotal = rawQuotaTotal;
	}

	let quotaUsed = existing.quota_used;
	const rawQuotaUsed = input.quota_used;
	if (rawQuotaUsed !== undefined && rawQuotaUsed !== null) {
		if (
			typeof rawQuotaUsed !== "number" ||
			!Number.isInteger(rawQuotaUsed) ||
			rawQuotaUsed < 0
		) {
			return { ok: false, error: "invalid_quota" };
		}
		quotaUsed = rawQuotaUsed;
	}

	let status = existing.status;
	const rawStatus = input.status;
	if (rawStatus !== undefined && rawStatus !== null) {
		if (rawStatus !== "active" && rawStatus !== "disabled") {
			return { ok: false, error: "invalid_status" };
		}
		status = rawStatus;
	}

	let allowedChannels = existing.allowed_channels;
	const rawAllowedChannels = input.allowed_channels;
	if (rawAllowedChannels === null) {
		// null = clear the channel restriction
		allowedChannels = null;
	} else if (rawAllowedChannels !== undefined) {
		// Existing format is passed through as-is (legacy flat array or
		// per-model map); not interpreted here.
		allowedChannels = JSON.stringify(rawAllowedChannels);
	}

	let allowedModels = existing.allowed_models;
	const rawAllowedModels = input.allowed_models;
	if (rawAllowedModels === null) {
		// null = unrestricted
		allowedModels = null;
	} else if (rawAllowedModels !== undefined) {
		const serialized = serializeAllowlist(rawAllowedModels);
		if (!serialized.ok) {
			return { ok: false, error: "invalid_allowed_models" };
		}
		allowedModels = serialized.value;
	}

	let expiresAt = existing.expires_at;
	const rawExpiresAt = input.expires_at;
	if (rawExpiresAt !== undefined) {
		// Three-state: undefined keeps; null / "" clears back to permanent;
		// a value must be a future ISO-8601 timestamp (normalized on write)
		const resolvedExpiry = resolveExpiresAtValue(rawExpiresAt);
		if (!resolvedExpiry.ok) {
			return { ok: false, error: resolvedExpiry.error };
		}
		expiresAt = resolvedExpiry.value;
	}

	let rpmLimit = existing.rpm_limit;
	const rawRpmLimit = input.rpm_limit;
	if (rawRpmLimit !== undefined) {
		// Three-state: undefined keeps; null / "" clears back to follow-the-
		// global-default; 0 = explicit exemption; positive integer = per-minute cap
		const resolvedRpm = resolveRpmLimitValue(rawRpmLimit);
		if (!resolvedRpm.ok) {
			return { ok: false, error: resolvedRpm.error };
		}
		rpmLimit = resolvedRpm.value;
	}

	return {
		ok: true,
		values: {
			name,
			quota_total: quotaTotal,
			quota_used: quotaUsed,
			status,
			allowed_channels: allowedChannels,
			allowed_models: allowedModels,
			expires_at: expiresAt,
			rpm_limit: rpmLimit,
		},
	};
}

/**
 * Shape of the token columns the user-facing PATCH endpoint reads and writes
 * (quota / channel columns stay admin-only and are never part of this row).
 */
export type UserExistingToken = {
	name: string;
	status: string;
	allowed_models: string | null;
	expires_at: string | null;
	/** Per-token RPM cap (same three-state semantics as the admin resolver). */
	rpm_limit: number | null;
};

/** Final column values to write back after a successful user-side update. */
export type UserTokenUpdateValues = UserExistingToken;

/** snake_case error codes aligned with the jsonError convention. */
export type UserTokenUpdateError =
	| "missing_body"
	| "invalid_name"
	| "invalid_status"
	| "invalid_allowed_models"
	| "invalid_expires_at"
	| "invalid_rpm_limit";

export type UserTokenUpdateResult =
	| { ok: true; values: UserTokenUpdateValues }
	| { ok: false; error: UserTokenUpdateError };

/**
 * Resolves a user-facing PATCH payload against an existing token row (pure
 * function). Users may edit name / status / allowed_models only; quota and
 * channel fields are rejected upstream (`field_not_editable`).
 *
 * Three-state semantics per field, aligned with `resolveTokenUpdate`:
 * - `undefined`  → keep the existing value
 * - `null`       → clear for allowed_models (unrestricted); treated as
 *   undefined for name / status
 * - concrete value → validate strictly; invalid input is rejected with 400
 *   instead of silently falling back to the old value
 *
 * The body must be a plain object; anything else (null, primitives, arrays)
 * yields `missing_body`.
 */
export function resolveUserTokenUpdate(
	body: unknown,
	existing: UserExistingToken,
): UserTokenUpdateResult {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, error: "missing_body" };
	}
	const input = body as Record<string, unknown>;

	let name = existing.name;
	const rawName = input.name;
	if (rawName !== undefined && rawName !== null) {
		if (typeof rawName !== "string" || !rawName.trim()) {
			return { ok: false, error: "invalid_name" };
		}
		name = rawName;
	}

	let status = existing.status;
	const rawStatus = input.status;
	if (rawStatus !== undefined && rawStatus !== null) {
		if (rawStatus !== "active" && rawStatus !== "disabled") {
			return { ok: false, error: "invalid_status" };
		}
		status = rawStatus;
	}

	let allowedModels = existing.allowed_models;
	const rawAllowedModels = input.allowed_models;
	if (rawAllowedModels === null) {
		// null = unrestricted
		allowedModels = null;
	} else if (rawAllowedModels !== undefined) {
		const serialized = serializeAllowlist(rawAllowedModels);
		if (!serialized.ok) {
			return { ok: false, error: "invalid_allowed_models" };
		}
		allowedModels = serialized.value;
	}

	let expiresAt = existing.expires_at;
	const rawExpiresAt = input.expires_at;
	if (rawExpiresAt !== undefined) {
		// Three-state semantics identical to the admin resolver (undefined
		// keeps; null / "" clears back to permanent; future ISO value sets)
		const resolvedExpiry = resolveExpiresAtValue(rawExpiresAt);
		if (!resolvedExpiry.ok) {
			return { ok: false, error: resolvedExpiry.error };
		}
		expiresAt = resolvedExpiry.value;
	}

	let rpmLimit = existing.rpm_limit;
	const rawRpmLimit = input.rpm_limit;
	if (rawRpmLimit !== undefined) {
		// Three-state semantics identical to the admin resolver (undefined
		// keeps; null / "" clears back to follow-the-global-default; 0 /
		// positive integer sets)
		const resolvedRpm = resolveRpmLimitValue(rawRpmLimit);
		if (!resolvedRpm.ok) {
			return { ok: false, error: resolvedRpm.error };
		}
		rpmLimit = resolvedRpm.value;
	}

	return {
		ok: true,
		values: {
			name,
			status,
			allowed_models: allowedModels,
			expires_at: expiresAt,
			rpm_limit: rpmLimit,
		},
	};
}
