import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getRetentionDays } from "../services/settings";
import { pruneUsageLogs } from "../services/usage";
import {
	pruneUsageLogsBatched,
	retentionCutoffIso,
} from "../services/usage-stats";

const usage = new Hono<AppEnv>();

/**
 * Lists usage logs with filters.
 */
usage.get("/", async (c) => {
	const query = c.req.query();
	const params: Array<string | number> = [];
	let sql =
		"SELECT usage_logs.*, channels.name as channel_name, tokens.name as token_name, users.name as user_name, users.email as user_email FROM usage_logs LEFT JOIN channels ON channels.id = usage_logs.channel_id LEFT JOIN tokens ON tokens.id = usage_logs.token_id LEFT JOIN users ON users.id = tokens.user_id WHERE 1=1";

	if (query.from) {
		sql += " AND usage_logs.created_at >= ?";
		params.push(query.from);
	}
	if (query.to) {
		sql += " AND usage_logs.created_at <= ?";
		params.push(query.to);
	}
	if (query.model) {
		sql += " AND usage_logs.model = ?";
		params.push(query.model);
	}
	if (query.channel_id) {
		sql += " AND usage_logs.channel_id = ?";
		params.push(query.channel_id);
	}
	if (query.token_id) {
		sql += " AND usage_logs.token_id = ?";
		params.push(query.token_id);
	}

	const limit = Math.min(Number(query.limit ?? 50), 200);
	sql += " ORDER BY usage_logs.created_at DESC LIMIT ?";
	params.push(Number.isNaN(limit) ? 50 : limit);

	const retention = await getRetentionDays(c.env.DB);
	await pruneUsageLogs(c.env.DB, retention);

	const result = await c.env.DB.prepare(sql)
		.bind(...params)
		.all();
	return c.json({ logs: result.results ?? [] });
});

/**
 * Manual retention prune (admin): deletes raw usage logs older than the
 * configured retention in bounded batches behind the same round fuse as the
 * daily cron (minus rollup / session cleanup). Useful for testing and
 * one-off big cleanups. complete=false means the fuse tripped with rows
 * left — re-run the endpoint to continue.
 */
usage.post("/prune", async (c) => {
	const retention = await getRetentionDays(c.env.DB);
	const cutoff = retentionCutoffIso(new Date(), retention);
	const { deleted, complete } = await pruneUsageLogsBatched(c.env.DB, cutoff);
	return c.json({ deleted, complete });
});

export default usage;
