import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	type DashboardSummaryAgg,
	loadDashboardByChannel,
	loadDashboardByModel,
	loadDashboardByToken,
	loadDashboardDaily,
	loadDashboardSummary,
	rollupBackfill,
	rollupDate,
	splitWindow,
} from "../services/usage-stats";
import { jsonError } from "../utils/http";

const dashboard = new Hono<AppEnv>();

/**
 * Cache hit rate: SUM(cached_input_tokens) / SUM(prompt_tokens where
 * cached_input_tokens IS NOT NULL). Rows without cache data are excluded
 * from the denominator (NULL ≠ 0); no data → null. The rollup segment keeps
 * the same denominator in cache_prompt_base (migration 0026), so the merged
 * result holds the §3.4 contract on both segments.
 */
function computeCacheRate(
	cachedTokens: number,
	cachePromptBase: number,
): number | null {
	return cachePromptBase > 0 ? cachedTokens / cachePromptBase : null;
}

/** Avg latency from merged sums; rows are the denominator (raw latency_ms is never null). */
function avgLatency(row: DashboardSummaryAgg): number {
	return row.total_requests > 0 ? row.latency_sum / row.total_requests : 0;
}

/**
 * Returns aggregated usage metrics. Windows starting before today's UTC
 * midnight read complete past days from usage_stats_daily (rollup) and merge
 * today's raw rows on top (splitWindow two-segment assembly).
 */
dashboard.get("/", async (c) => {
	const query = c.req.query();
	const split = splitWindow(query.from ?? null, query.to ?? null);

	const summary = await loadDashboardSummary(c.env.DB, split);
	const byDay = await loadDashboardDaily(c.env.DB, split);
	const byModel = await loadDashboardByModel(c.env.DB, split);
	const byChannel = await loadDashboardByChannel(c.env.DB, split);
	const byToken = await loadDashboardByToken(c.env.DB, split);

	return c.json({
		summary: {
			total_requests: summary.total_requests,
			total_tokens: summary.total_tokens,
			avg_latency: avgLatency(summary),
			total_errors: summary.total_errors,
			cached_tokens: summary.cached_tokens,
			cache_creation_tokens: summary.cache_creation_tokens,
			cache_rate: computeCacheRate(
				summary.cached_tokens,
				summary.cache_prompt_base,
			),
		},
		byDay: byDay.map((row) => ({
			day: row.day,
			requests: row.requests,
			tokens: row.tokens,
			cached_tokens: row.cached_tokens,
			cache_rate: computeCacheRate(row.cached_tokens, row.cache_prompt_base),
		})),
		byModel: byModel.map((row) => ({
			model: row.model,
			requests: row.requests,
			tokens: row.tokens,
		})),
		byChannel: byChannel.map((row) => ({
			channel_id: row.channel_id,
			channel_name: row.channel_name,
			requests: row.requests,
			tokens: row.tokens,
		})),
		byToken: byToken.map((row) => ({
			token_id: row.token_id,
			token_name: row.token_name,
			requests: row.requests,
			tokens: row.tokens,
		})),
	});
});

/**
 * Manual rollup trigger (admin): POST { date: "YYYY-MM-DD" } rolls one date;
 * an empty body backfills every date with raw logs but no rollup rows yet
 * (first-deploy full backfill). Idempotent either way.
 */
dashboard.post("/rollup", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		date?: unknown;
	} | null;
	if (
		!body ||
		body.date === undefined ||
		body.date === null ||
		body.date === ""
	) {
		const rolled = await rollupBackfill(c.env.DB);
		return c.json({ rolled });
	}
	if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
		return jsonError(c, 400, "date must be YYYY-MM-DD", "invalid_date");
	}
	await rollupDate(c.env.DB, body.date);
	return c.json({ rolled: [body.date] });
});

export default dashboard;
