import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	type AlertMessage,
	isWebhookType,
	sendWebhook,
} from "../services/webhook-senders";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";

/**
 * Webhook notification-endpoint CRUD (design §6). Mounted at /api/webhooks
 * WITHOUT an adminAuth bypass-list entry — every endpoint is admin-only,
 * matching the monitoring route's posture (webhook URLs embed bot tokens).
 */

const webhookRoutes = new Hono<AppEnv>();

type WebhookBody = {
	name?: unknown;
	type?: unknown;
	url?: unknown;
	enabled?: unknown;
	id?: unknown;
};

type WebhookRow = {
	id: string;
	name: string;
	type: string;
	url: string;
	enabled: number;
	created_at: string;
	updated_at: string;
};

/** Webhook endpoints carry bot tokens — https only. */
function isHttpsUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "https:";
	} catch {
		return false;
	}
}

const toPayload = (row: WebhookRow) => ({
	id: row.id,
	name: row.name,
	type: row.type,
	url: row.url,
	enabled: Number(row.enabled) === 1,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

/** Lists every webhook (creation order). */
webhookRoutes.get("/", async (c) => {
	const result = await c.env.DB.prepare(
		"SELECT id, name, type, url, enabled, created_at, updated_at FROM webhooks ORDER BY created_at ASC, id ASC",
	).all<WebhookRow>();
	return c.json({ webhooks: (result.results ?? []).map(toPayload) });
});

/** Creates a webhook (name + whitelisted type + https url). */
webhookRoutes.post("/", async (c) => {
	const body = (await c.req.json().catch(() => null)) as WebhookBody | null;
	if (!body) {
		return jsonError(c, 400, "invalid_body", "invalid_body");
	}
	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!name) {
		return jsonError(c, 400, "invalid_name", "invalid_name");
	}
	if (!isWebhookType(body.type)) {
		return jsonError(c, 400, "invalid_type", "invalid_type");
	}
	const url = typeof body.url === "string" ? body.url.trim() : "";
	if (!isHttpsUrl(url)) {
		return jsonError(c, 400, "invalid_url", "invalid_url");
	}
	const id = crypto.randomUUID();
	const timestamp = nowIso();
	await c.env.DB.prepare(
		"INSERT INTO webhooks (id, name, type, url, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
	)
		.bind(id, name, body.type, url, timestamp, timestamp)
		.run();
	return c.json({
		webhook: toPayload({
			id,
			name,
			type: body.type,
			url,
			enabled: 1,
			created_at: timestamp,
			updated_at: timestamp,
		}),
	});
});

/** Partial update: name / type / url / enabled (absent keys keep their value). */
webhookRoutes.patch("/:id", async (c) => {
	const id = c.req.param("id");
	const body = (await c.req.json().catch(() => null)) as WebhookBody | null;
	if (!body) {
		return jsonError(c, 400, "invalid_body", "invalid_body");
	}

	const assignments: string[] = [];
	const binds: unknown[] = [];
	if (body.name !== undefined) {
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			return jsonError(c, 400, "invalid_name", "invalid_name");
		}
		assignments.push("name = ?");
		binds.push(name);
	}
	if (body.type !== undefined) {
		if (!isWebhookType(body.type)) {
			return jsonError(c, 400, "invalid_type", "invalid_type");
		}
		assignments.push("type = ?");
		binds.push(body.type);
	}
	if (body.url !== undefined) {
		const url = typeof body.url === "string" ? body.url.trim() : "";
		if (!isHttpsUrl(url)) {
			return jsonError(c, 400, "invalid_url", "invalid_url");
		}
		assignments.push("url = ?");
		binds.push(url);
	}
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") {
			return jsonError(c, 400, "invalid_enabled", "invalid_enabled");
		}
		assignments.push("enabled = ?");
		binds.push(body.enabled ? 1 : 0);
	}
	if (assignments.length === 0) {
		return jsonError(c, 400, "webhooks_empty", "webhooks_empty");
	}

	assignments.push("updated_at = ?");
	binds.push(nowIso());
	binds.push(id);
	const result = await c.env.DB.prepare(
		`UPDATE webhooks SET ${assignments.join(", ")} WHERE id = ?`,
	)
		.bind(...binds)
		.run();
	if ((result.meta?.changes ?? 0) === 0) {
		return jsonError(c, 404, "webhook_not_found", "webhook_not_found");
	}
	return c.json({ ok: true });
});

/** Deletes a webhook (idempotent). */
webhookRoutes.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await c.env.DB.prepare("DELETE FROM webhooks WHERE id = ?").bind(id).run();
	return c.json({ ok: true });
});

/**
 * Sends a sample message for real. Body may carry an unsaved {type, url}
 * pair (test before saving) or an {id} of a stored webhook; returns the
 * adapter result ({ok, status}) — 2xx upstream reply is ok, anything else
 * surfaces as ok=false with the status (or null on transport failure).
 */
webhookRoutes.post("/test", async (c) => {
	const body = (await c.req.json().catch(() => null)) as WebhookBody | null;
	if (!body) {
		return jsonError(c, 400, "invalid_body", "invalid_body");
	}

	let type: string;
	let url: string;
	if (typeof body.id === "string" && body.id) {
		const row = await c.env.DB.prepare(
			"SELECT id, name, type, url, enabled, created_at, updated_at FROM webhooks WHERE id = ?",
		)
			.bind(body.id)
			.first<WebhookRow>();
		if (!row) {
			return jsonError(c, 404, "webhook_not_found", "webhook_not_found");
		}
		type = row.type;
		url = row.url;
	} else {
		if (!isWebhookType(body.type)) {
			return jsonError(c, 400, "invalid_type", "invalid_type");
		}
		type = body.type;
		url = typeof body.url === "string" ? body.url.trim() : "";
		if (!isHttpsUrl(url)) {
			return jsonError(c, 400, "invalid_url", "invalid_url");
		}
	}

	const message: AlertMessage = {
		title: "[ZenAPI Next] Webhook 测试",
		severity: "info",
		ts: nowIso(),
		lines: [
			"这是一条来自 ZenAPI Next 管理台的测试消息。",
			"收到即表示该通知通道配置可用。",
		],
	};
	const result = await sendWebhook(type, url, message);
	return c.json({ ok: result.ok, status: result.status ?? null });
});

export default webhookRoutes;
