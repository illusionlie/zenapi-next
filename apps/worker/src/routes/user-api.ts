import { Hono } from "hono";
import type { AppEnv } from "../env";
import type { UserRecord } from "../middleware/userAuth";
import { userAuth } from "../middleware/userAuth";
import { extractModelPricings } from "../services/channel-models";
import { listActiveChannels } from "../services/channel-repo";
import { loadAllChannelAliasesGrouped } from "../services/model-aliases";
import {
	getCheckinReward,
	getLdcExchangeRate,
	getLdcPaymentEnabled,
} from "../services/settings";
import {
	resolveExpiresAtValue,
	resolveRpmLimitValue,
	resolveUserTokenUpdate,
} from "../services/token-update";
import {
	loadModelDailyTrends,
	loadModelRequestStats,
	loadUserDailyUsage,
	loadUserUsageTotals,
	loadWindowTotals,
	splitWindow,
} from "../services/usage-stats";
import { generateToken, sha256Hex } from "../utils/crypto";
import { jsonError } from "../utils/http";
import {
	filterModelsByAllowlist,
	parseAllowlist,
	serializeAllowlist,
} from "../utils/model-allowlist";
import { buildModelMonitoring } from "../utils/model-monitoring";
import { resolveMonitoringRange } from "../utils/monitoring";
import { nowIso } from "../utils/time";

const userApi = new Hono<AppEnv>();

// All routes require user authentication
userApi.use("/*", userAuth);

/**
 * Returns models visible to users using the effective mapping algorithm.
 */
userApi.get("/models", async (c) => {
	const channels = await listActiveChannels(c.env.DB);

	// Load alias data
	const aliasGroups = await loadAllChannelAliasesGrouped(c.env.DB);

	// Compute effective mapping
	type ChannelEntry = {
		id: string;
		name: string;
		input_price: number | null;
		output_price: number | null;
	};
	const effectiveMap = new Map<
		string,
		{ channels: Map<string, ChannelEntry> }
	>();

	for (const channel of channels) {
		const pricings = extractModelPricings(channel);
		const chAliases = aliasGroups.get(channel.id);

		for (const p of pricings) {
			const aliasInfo = chAliases?.get(p.id);
			const isAliasOnly = aliasInfo?.alias_only ?? false;
			const chInfo: ChannelEntry = {
				id: channel.id,
				name: channel.name,
				input_price: p.input_price ?? null,
				output_price: p.output_price ?? null,
			};

			// Original name (unless alias_only)
			if (!isAliasOnly) {
				let entry = effectiveMap.get(p.id);
				if (!entry) {
					entry = { channels: new Map() };
					effectiveMap.set(p.id, entry);
				}
				entry.channels.set(channel.id, chInfo);
			}

			// Alias names
			if (aliasInfo) {
				for (const alias of aliasInfo.aliases) {
					let entry = effectiveMap.get(alias);
					if (!entry) {
						entry = { channels: new Map() };
						effectiveMap.set(alias, entry);
					}
					entry.channels.set(channel.id, chInfo);
				}
			}
		}
	}

	const models: Array<{ id: string; channels: ChannelEntry[] }> = [];
	for (const [callableName, entry] of effectiveMap) {
		models.push({
			id: callableName,
			channels: Array.from(entry.channels.values()),
		});
	}

	// Filter by the current user's model allowlist (null = unrestricted)
	const userRecord = c.get("userRecord") as UserRecord;
	const allowlist = parseAllowlist(userRecord.allowed_models);
	const visibleModels = filterModelsByAllowlist(models, allowlist);

	return c.json({ models: visibleModels });
});

/**
 * Model-availability monitoring for the current user.
 *
 * Aggregates usage_logs by model only — no join to channels, so the response
 * never carries channel names / ids / api_format / error messages. Model rows
 * and trends are filtered by the user's allowed_models allowlist (same
 * semantics as /models: null/empty = unrestricted).
 */
userApi.get("/monitoring", async (c) => {
	const range = c.req.query("range") ?? "7d";
	const config = resolveMonitoringRange(range);
	const now = new Date();
	const since = new Date(now.getTime() - config.ms).toISOString().slice(0, 19);
	// Two-segment assembly (platform-wide, same as admin monitoring): complete
	// past days from usage_stats_daily, today's rows from usage_logs; sub-day
	// ranges go raw-only with exact bounds (same splitWindow rule). Trend
	// slots use the rollup only when the slot size is a full day.
	const split = splitWindow(since, null, now);

	// Per-model aggregates within the selected range
	const modelAggs = await loadModelRequestStats(c.env.DB, split);
	const modelRows = modelAggs.map((row) => ({
		model: row.model,
		total_requests: row.total_requests,
		success_count: row.total_requests - row.error_count,
		error_count: row.error_count,
		avg_latency_ms:
			row.total_requests > 0 ? row.latency_sum / row.total_requests : 0,
		last_seen: row.last_seen,
	}));

	// Per-model × time-slot trends within the selected range
	const trendAggs = await loadModelDailyTrends(
		c.env.DB,
		since,
		split,
		config.sqlSlice,
	);
	const trendRows = trendAggs.map((row) => ({
		model: row.model,
		day: row.day,
		requests: row.requests,
		success: row.requests - row.errors,
		errors: row.errors,
		avg_latency_ms: row.requests > 0 ? row.latency_sum / row.requests : 0,
	}));

	// Global aggregates within the selected range
	const globalTotals = await loadWindowTotals(c.env.DB, split);
	const globalRow = {
		total_requests: globalTotals.total_requests,
		total_success: globalTotals.total_requests - globalTotals.total_errors,
		total_errors: globalTotals.total_errors,
		avg_latency_ms:
			globalTotals.total_requests > 0
				? globalTotals.latency_sum / globalTotals.total_requests
				: 0,
	};

	// Always query last 15 minutes for system status
	const recentSince = new Date(now.getTime() - 15 * 60_000)
		.toISOString()
		.slice(0, 19);
	const recentRow = await c.env.DB.prepare(
		`SELECT
			COUNT(*) AS total_requests,
			COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS total_success,
			COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS total_errors,
			COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
		FROM usage_logs
		WHERE created_at >= ?`,
	)
		.bind(recentSince)
		.first();

	// Per-model last 15 minutes (fills recent_success_rate / recent_avg_latency_ms)
	const recentModelRows = await c.env.DB.prepare(
		`SELECT
			COALESCE(model, 'unknown') AS model,
			COUNT(*) AS total_requests,
			COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS success_count,
			COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
		FROM usage_logs
		WHERE created_at >= ?
		GROUP BY model`,
	)
		.bind(recentSince)
		.all();

	// Same allowlist semantics as GET /models (null = unrestricted)
	const userRecord = c.get("userRecord") as UserRecord;
	const allowlist = parseAllowlist(userRecord.allowed_models);

	return c.json(
		buildModelMonitoring({
			modelRows,
			trendRows,
			globalRow,
			recentRow: recentRow ?? null,
			recentModelRows: recentModelRows.results ?? [],
			allowlist,
			range,
		}),
	);
});

/**
 * Lists the current user's tokens.
 */
userApi.get("/tokens", async (c) => {
	const userId = c.get("userId") as string;
	const result = await c.env.DB.prepare(
		"SELECT id, name, key_prefix, quota_total, quota_used, status, allowed_channels, allowed_models, expires_at, rpm_limit, created_at, updated_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC",
	)
		.bind(userId)
		.all();
	const rows = (result.results ?? []) as Array<{
		id: string;
		name: string;
		key_prefix: string;
		quota_total: number | null;
		quota_used: number;
		status: string;
		allowed_channels: string | null;
		allowed_models: string | null;
		expires_at: string | null;
		rpm_limit: number | null;
		created_at: string;
		updated_at: string;
	}>;
	return c.json({
		tokens: rows.map((row) => ({
			...row,
			// Expose the parsed array (or null) so the frontend can consume it directly
			allowed_models: parseAllowlist(row.allowed_models),
		})),
	});
});

/**
 * Creates a new token for the current user.
 */
userApi.post("/tokens", async (c) => {
	const userId = c.get("userId") as string;
	const body = await c.req.json().catch(() => null);
	if (!body?.name) {
		return jsonError(c, 400, "name_required", "name_required");
	}

	const rawToken = generateToken("sk-", 32);
	const tokenHash = await sha256Hex(rawToken);
	const id = crypto.randomUUID();
	const now = nowIso();
	const keyPrefix = rawToken.slice(0, 8);

	const allowedModels = serializeAllowlist(body.allowed_models ?? null);
	if (!allowedModels.ok) {
		return jsonError(
			c,
			400,
			"invalid_allowed_models",
			"invalid_allowed_models",
		);
	}

	// Optional expiry: missing/null/"" → permanent; must otherwise be a future
	// ISO-8601 timestamp (normalized on write) — same gate as the admin route
	const expiresAt = resolveExpiresAtValue(body.expires_at);
	if (!expiresAt.ok) {
		return jsonError(c, 400, expiresAt.error, expiresAt.error);
	}

	// Optional RPM limit — same gate as the admin route (missing/null/"" →
	// follow the global default; 0 = explicitly unlimited; positive = cap)
	const rpmLimit = resolveRpmLimitValue(body.rpm_limit);
	if (!rpmLimit.ok) {
		return jsonError(c, 400, rpmLimit.error, rpmLimit.error);
	}

	await c.env.DB.prepare(
		"INSERT INTO tokens (id, name, key_hash, key_prefix, token_plain, quota_total, quota_used, status, allowed_channels, allowed_models, expires_at, rpm_limit, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			body.name,
			tokenHash,
			keyPrefix,
			rawToken,
			null,
			0,
			"active",
			null,
			allowedModels.value,
			expiresAt.value,
			rpmLimit.value,
			userId,
			now,
			now,
		)
		.run();

	return c.json({ id, token: rawToken });
});

/**
 * Updates a user's token (name / status / model allowlist).
 */
userApi.patch("/tokens/:id", async (c) => {
	const userId = c.get("userId") as string;
	const tokenId = c.req.param("id");
	const body = await c.req.json().catch(() => null);
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}

	// Quota / channel fields are admin-only; users may edit name, status and
	// allowed_models (design.md D4)
	const forbiddenFields = ["quota_total", "quota_used", "allowed_channels"];
	if (
		typeof body === "object" &&
		forbiddenFields.some((field) => field in body)
	) {
		return jsonError(c, 400, "field_not_editable", "field_not_editable");
	}

	const existing = await c.env.DB.prepare(
		"SELECT id, name, status, allowed_models, expires_at, rpm_limit FROM tokens WHERE id = ? AND user_id = ?",
	)
		.bind(tokenId, userId)
		.first<{
			id: string;
			name: string;
			status: string;
			allowed_models: string | null;
			expires_at: string | null;
			rpm_limit: number | null;
		}>();

	if (!existing) {
		return jsonError(c, 404, "token_not_found", "token_not_found");
	}

	// Three-state resolution (undefined = keep, null = clear where meaningful,
	// invalid values → 400 instead of silently falling back to the old value)
	const resolved = resolveUserTokenUpdate(body, existing);
	if (!resolved.ok) {
		return jsonError(c, 400, resolved.error, resolved.error);
	}
	const values = resolved.values;

	await c.env.DB.prepare(
		"UPDATE tokens SET name = ?, status = ?, allowed_models = ?, expires_at = ?, rpm_limit = ?, updated_at = ? WHERE id = ? AND user_id = ?",
	)
		.bind(
			values.name,
			values.status,
			values.allowed_models,
			values.expires_at,
			values.rpm_limit,
			nowIso(),
			tokenId,
			userId,
		)
		.run();

	return c.json({ ok: true });
});

/**
 * Deletes a user's token.
 */
userApi.delete("/tokens/:id", async (c) => {
	const userId = c.get("userId") as string;
	const tokenId = c.req.param("id");

	const existing = await c.env.DB.prepare(
		"SELECT id FROM tokens WHERE id = ? AND user_id = ?",
	)
		.bind(tokenId, userId)
		.first();

	if (!existing) {
		return jsonError(c, 404, "token_not_found", "token_not_found");
	}

	await c.env.DB.prepare("DELETE FROM tokens WHERE id = ? AND user_id = ?")
		.bind(tokenId, userId)
		.run();

	return c.json({ ok: true });
});

/**
 * Reveals a user's token.
 */
userApi.get("/tokens/:id/reveal", async (c) => {
	const userId = c.get("userId") as string;
	const tokenId = c.req.param("id");

	const record = await c.env.DB.prepare(
		"SELECT token_plain FROM tokens WHERE id = ? AND user_id = ?",
	)
		.bind(tokenId, userId)
		.first<{ token_plain?: string | null }>();

	if (!record) {
		return jsonError(c, 404, "token_not_found", "token_not_found");
	}

	return c.json({ token: record.token_plain ?? null });
});

/**
 * Returns usage logs for the current user's tokens.
 */
userApi.get("/usage", async (c) => {
	const userId = c.get("userId") as string;
	const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

	const result = await c.env.DB.prepare(
		`SELECT u.id, u.model, u.channel_id, u.token_id, u.total_tokens, u.prompt_tokens, u.completion_tokens, u.cost, u.latency_ms, u.first_token_latency_ms, u.stream, u.reasoning_effort, u.status, u.created_at,
		t.name as token_name
		FROM usage_logs u
		LEFT JOIN tokens t ON u.token_id = t.id
		WHERE t.user_id = ?
		ORDER BY u.created_at DESC
		LIMIT ?`,
	)
		.bind(userId, limit)
		.all();

	return c.json({ logs: result.results ?? [] });
});

/**
 * Daily check-in to receive balance reward.
 */
userApi.post("/checkin", async (c) => {
	const userId = c.get("userId") as string;
	const today = new Date().toISOString().slice(0, 10);

	const existing = await c.env.DB.prepare(
		"SELECT id FROM user_checkins WHERE user_id = ? AND checkin_date = ?",
	)
		.bind(userId, today)
		.first();

	if (existing) {
		return c.json({ already_checked_in: true });
	}

	const reward = await getCheckinReward(c.env.DB);
	const id = crypto.randomUUID();
	const now = nowIso();

	await c.env.DB.prepare(
		"INSERT INTO user_checkins (id, user_id, checkin_date, reward, created_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(id, userId, today, reward, now)
		.run();

	await c.env.DB.prepare(
		"UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?",
	)
		.bind(reward, now, userId)
		.run();

	const updated = await c.env.DB.prepare(
		"SELECT balance FROM users WHERE id = ?",
	)
		.bind(userId)
		.first<{ balance: number }>();

	return c.json({ ok: true, reward, new_balance: updated?.balance ?? 0 });
});

/**
 * Cache hit rate: SUM(cached_input_tokens) / SUM(prompt_tokens where
 * cached_input_tokens IS NOT NULL). Rows without cache data are excluded
 * from the denominator (NULL ≠ 0); no data → null.
 */
function computeCacheRate(
	cachedTokens: number,
	cachePromptBase: number,
): number | null {
	return cachePromptBase > 0 ? cachedTokens / cachePromptBase : null;
}

/**
 * Returns dashboard data for the current user. Full-history aggregates read
 * complete past days from usage_stats_daily by the rollup's redundant
 * user_id column (no tokens JOIN — attribution survives token deletion) and
 * merge today's raw rows attributed via the live tokens JOIN.
 */
userApi.get("/dashboard", async (c) => {
	const userId = c.get("userId") as string;
	const user = c.get("userRecord") as UserRecord;
	const split = splitWindow(null, null);

	const summaryRow = await loadUserUsageTotals(c.env.DB, userId, split);
	const recentUsage = await loadUserDailyUsage(c.env.DB, userId, split);

	const checkinReward = await getCheckinReward(c.env.DB);
	const ldcPaymentEnabled = await getLdcPaymentEnabled(c.env.DB);
	const ldcExchangeRate = await getLdcExchangeRate(c.env.DB);
	const todayStr = new Date().toISOString().slice(0, 10);
	const checkinRow = await c.env.DB.prepare(
		"SELECT id FROM user_checkins WHERE user_id = ? AND checkin_date = ?",
	)
		.bind(userId, todayStr)
		.first();
	const checkedInToday = Boolean(checkinRow);

	return c.json({
		balance: user.balance,
		total_requests: summaryRow.total_requests,
		total_tokens: summaryRow.total_tokens,
		total_cost: summaryRow.total_cost,
		cached_tokens: summaryRow.cached_tokens,
		cache_creation_tokens: summaryRow.cache_creation_tokens,
		cache_rate: computeCacheRate(
			summaryRow.cached_tokens,
			summaryRow.cache_prompt_base,
		),
		recent_usage: recentUsage.map((row) => ({
			day: row.day,
			requests: row.requests,
			cost: row.cost,
			cached_tokens: row.cached_tokens,
			cache_rate: computeCacheRate(row.cached_tokens, row.cache_prompt_base),
		})),
		checked_in_today: checkedInToday,
		checkin_reward: checkinReward,
		ldc_payment_enabled: ldcPaymentEnabled,
		ldc_exchange_rate: ldcExchangeRate,
	});
});

export default userApi;
