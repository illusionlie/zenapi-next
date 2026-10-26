import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	resolveExpiresAtValue,
	resolveRpmLimitValue,
	resolveTokenUpdate,
} from "../services/token-update";
import { generateToken, sha256Hex } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { parseAllowlist, serializeAllowlist } from "../utils/model-allowlist";
import { nowIso } from "../utils/time";

const tokens = new Hono<AppEnv>();

type TokenRow = {
	id: string;
	name: string;
	key_prefix: string;
	quota_total: number | null;
	quota_used: number;
	status: string;
	allowed_channels: string | null;
	allowed_models: string | null;
	expires_at: string | null;
	/** Per-token RPM cap: null = follow the global default, 0 = unlimited, positive = cap. */
	rpm_limit: number | null;
	token_plain?: string | null;
};

/**
 * Lists API tokens.
 */
tokens.get("/", async (c) => {
	const result = await c.env.DB.prepare(
		"SELECT tokens.id, tokens.name, tokens.key_prefix, tokens.quota_total, tokens.quota_used, tokens.status, tokens.allowed_channels, tokens.allowed_models, tokens.expires_at, tokens.rpm_limit, tokens.user_id, tokens.created_at, tokens.updated_at, users.name as user_name, users.email as user_email FROM tokens LEFT JOIN users ON users.id = tokens.user_id ORDER BY tokens.created_at DESC",
	).all();
	const rows = (result.results ?? []) as (TokenRow & {
		user_id: string | null;
		user_name: string | null;
		user_email: string | null;
		created_at: string;
		updated_at: string;
	})[];
	return c.json({
		tokens: rows.map((row) => ({
			...row,
			// Expose the parsed array (or null) so the frontend can consume it directly
			allowed_models: parseAllowlist(row.allowed_models),
		})),
	});
});

/**
 * Creates a new API token.
 */
tokens.post("/", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body?.name) {
		return jsonError(c, 400, "name_required", "name_required");
	}

	const rawToken = generateToken("sk-", 32);
	const tokenHash = await sha256Hex(rawToken);
	const id = crypto.randomUUID();
	const now = nowIso();
	const keyPrefix = rawToken.slice(0, 8);
	const quotaTotal =
		body.quota_total === null || body.quota_total === undefined
			? null
			: Number(body.quota_total);

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
	// ISO-8601 timestamp (normalized on write)
	const expiresAt = resolveExpiresAtValue(body.expires_at);
	if (!expiresAt.ok) {
		return jsonError(c, 400, expiresAt.error, expiresAt.error);
	}

	// Optional RPM limit: missing/null/"" → follow the global default;
	// 0 = explicitly unlimited; positive integer = per-minute cap
	const rpmLimit = resolveRpmLimitValue(body.rpm_limit);
	if (!rpmLimit.ok) {
		return jsonError(c, 400, rpmLimit.error, rpmLimit.error);
	}

	// Missing/null allowed_channels stores a SQL NULL (not the literal "null"
	// string); only newly created tokens are affected
	const allowedChannels =
		body.allowed_channels === undefined || body.allowed_channels === null
			? null
			: JSON.stringify(body.allowed_channels);

	await c.env.DB.prepare(
		"INSERT INTO tokens (id, name, key_hash, key_prefix, token_plain, quota_total, quota_used, status, allowed_channels, allowed_models, expires_at, rpm_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			id,
			body.name,
			tokenHash,
			keyPrefix,
			rawToken,
			Number.isNaN(quotaTotal) ? null : quotaTotal,
			0,
			body.status ?? "active",
			allowedChannels,
			allowedModels.value,
			expiresAt.value,
			rpmLimit.value,
			now,
			now,
		)
		.run();

	return c.json({
		id,
		token: rawToken,
	});
});

/**
 * Updates an API token.
 */
tokens.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json().catch(() => null);

	const existing = await c.env.DB.prepare("SELECT * FROM tokens WHERE id = ?")
		.bind(id)
		.first<TokenRow>();
	if (!existing) {
		return jsonError(c, 404, "token_not_found", "token_not_found");
	}

	// Three-state resolution (design.md D5.2): undefined = keep, null = clear,
	// invalid values → 400 instead of silently falling back to the old value
	const resolved = resolveTokenUpdate(body, existing);
	if (!resolved.ok) {
		return jsonError(c, 400, resolved.error, resolved.error);
	}
	const values = resolved.values;

	await c.env.DB.prepare(
		"UPDATE tokens SET name = ?, quota_total = ?, quota_used = ?, status = ?, allowed_channels = ?, allowed_models = ?, expires_at = ?, rpm_limit = ?, updated_at = ? WHERE id = ?",
	)
		.bind(
			values.name,
			values.quota_total,
			values.quota_used,
			values.status,
			values.allowed_channels,
			values.allowed_models,
			values.expires_at,
			values.rpm_limit,
			nowIso(),
			id,
		)
		.run();

	return c.json({ ok: true });
});

/**
 * Reveals a stored API token.
 */
tokens.get("/:id/reveal", async (c) => {
	const id = c.req.param("id");
	const record = await c.env.DB.prepare(
		"SELECT token_plain FROM tokens WHERE id = ?",
	)
		.bind(id)
		.first<{ token_plain?: string | null }>();
	if (!record) {
		return jsonError(c, 404, "token_not_found", "token_not_found");
	}
	return c.json({ token: record.token_plain ?? null });
});

/**
 * Deletes an API token.
 */
tokens.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await c.env.DB.prepare("DELETE FROM tokens WHERE id = ?").bind(id).run();
	return c.json({ ok: true });
});

export default tokens;
