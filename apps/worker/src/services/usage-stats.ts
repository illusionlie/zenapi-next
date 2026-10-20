import type { D1Database } from "@cloudflare/workers-types";
import { getRetentionDays } from "./settings";

/**
 * Daily usage pre-aggregation (usage_stats_daily) and retention helpers.
 *
 * The rollup table keeps one row per (stat_date, model, channel_id, token_id)
 * with user_id as a redundant attribution column (resolved via LEFT JOIN
 * tokens at rollup time, so ownership survives token deletion). Aggregation
 * endpoints read complete past days from this small table and today's rows
 * from usage_logs, merged by splitWindow. See migration 0026 for column
 * semantics (cache_prompt_base keeps the NULL≠0 cache-rate denominator of
 * usage-accounting §3.4 intact on the rollup side).
 */

/** Rollup rows older than this many UTC dates are pruned by the daily cron. */
export const ROLLUP_RETENTION_DAYS = 180;

const DAY_MS = 86_400_000;

/** UTC calendar date string, "YYYY-MM-DD". */
export type UtcDate = string;

/** Returns the UTC calendar date part ("YYYY-MM-DD") of an ISO timestamp. */
export function utcDateOf(iso: string): UtcDate {
	return iso.slice(0, 10);
}

/** Shifts a UTC calendar date by whole days (month/year boundaries included). */
export function addUtcDays(date: UtcDate, days: number): UtcDate {
	const shifted = new Date(`${date}T00:00:00.000Z`);
	shifted.setUTCDate(shifted.getUTCDate() + days);
	return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Window splitting (rollup segment × raw segment)
// ---------------------------------------------------------------------------

export type UsageWindowSplit = {
	/**
	 * Rollup segment lower bound, `stat_date >= ?` (inclusive). null = the
	 * window starts today (or later) or fits within a single UTC day — either
	 * way the rollup table has nothing to offer.
	 */
	rollupFrom: UtcDate | null;
	/** Rollup segment upper bound, `stat_date <= ?` (inclusive). */
	rollupTo: UtcDate;
	/**
	 * Raw segment lower bound, `created_at >= ?` (inclusive). null = the window
	 * ends before today's midnight, so no raw rows can qualify.
	 */
	rawFrom: string | null;
	/** Raw segment upper bound, `created_at <= ?` (inclusive). null = unbounded. */
	rawTo: string | null;
};

/**
 * Splits a usage window into a rollup segment (complete past days, served
 * from usage_stats_daily) and a raw segment (today's rows, served from
 * usage_logs). Two thresholds decide the shape: windows starting at or after
 * today's midnight go to raw alone, and so do windows whose effective span is
 * at most one UTC day (exact boundaries — a rolling 15m/1h/24h window
 * crossing the day cut must not eat the day-granularity approximation);
 * anything reaching further back takes complete days [date(from), yesterday]
 * from the rollup plus raw rows from today's midnight onward. When the window
 * ends before today there is no raw segment.
 *
 * Boundary note (documented approximation, spans > 1 day only): the day
 * containing `from` is counted at day granularity from the rollup, so a
 * multi-day window spanning the day cut includes that boundary day in full
 * (error ≤ 1/window-days).
 */
export function splitWindow(
	fromIso: string | null | undefined,
	toIso: string | null | undefined,
	now: Date = new Date(),
): UsageWindowSplit {
	const todayUtc = utcDateOf(now.toISOString());
	const todayStart = `${todayUtc}T00:00:00.000Z`;
	const from = fromIso ?? "";
	const to = toIso ?? "";
	if (from !== "" && from >= todayStart) {
		// Pure current-day window: rollup rows only exist for complete days.
		return {
			rollupFrom: null,
			rollupTo: "",
			rawFrom: from,
			rawTo: to === "" ? null : to,
		};
	}
	// Sub-day windows must not eat the day-granularity approximation: the
	// rollup only knows whole UTC days, so a rolling 15m/1h/24h window that
	// crosses the day cut would otherwise count its boundary day in full (a
	// 24h monitoring range would report up to ~47h of data). Span is judged
	// at second granularity — monitoring-style callers floor `from` via
	// toISOString().slice(0, 19) while `now` carries milliseconds, so the raw
	// millisecond delta of a rolling 24h window is DAY_MS + <1s and a plain
	// `<= DAY_MS` on the raw values would miss it.
	const toMs = to === "" ? now.getTime() : parseUtcIsoMs(to);
	const fromMs = parseUtcIsoMs(from);
	if (
		fromMs !== null &&
		toMs !== null &&
		Math.floor(toMs / 1000) - Math.floor(fromMs / 1000) <= DAY_MS / 1000
	) {
		return {
			rollupFrom: null,
			rollupTo: "",
			rawFrom: from,
			rawTo: to === "" ? null : to,
		};
	}
	const yesterday = addUtcDays(todayUtc, -1);
	const rollupFrom = from.slice(0, 10);
	const rollupTo = to === "" ? yesterday : minDate(yesterday, to.slice(0, 10));
	const rawTo = to === "" ? null : to;
	const hasRaw = rawTo === null || todayStart <= rawTo;
	return {
		rollupFrom: rollupFrom > rollupTo ? null : rollupFrom,
		rollupTo,
		rawFrom: hasRaw ? todayStart : null,
		rawTo,
	};
}

/**
 * Parses the two timestamp shapes splitWindow receives — full toISOString()
 * (`2026-10-20T03:17:00.000Z`) or its 19-char slice(0, 19) truncation without
 * the Z suffix — into UTC epoch milliseconds. The truncated form must never
 * reach bare Date.parse: a no-Z string is read in the host's local time zone.
 * Returns null for anything else (date-only strings, garbage): the caller
 * then keeps the legacy string-comparison path.
 */
function parseUtcIsoMs(s: string): number | null {
	if (s.length === 19) {
		const ms = Date.parse(`${s}Z`);
		return Number.isNaN(ms) ? null : ms;
	}
	if (s.length >= 20 && /(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
		const ms = Date.parse(s);
		return Number.isNaN(ms) ? null : ms;
	}
	return null;
}

function minDate(a: UtcDate, b: UtcDate): UtcDate {
	return a <= b ? a : b;
}

// ---------------------------------------------------------------------------
// Rollup writes
// ---------------------------------------------------------------------------

const ROLLUP_INSERT_SQL = `INSERT INTO usage_stats_daily (
	id, stat_date, model, channel_id, token_id, user_id,
	requests, error_count,
	prompt_tokens, completion_tokens, total_tokens,
	cached_input_tokens, cache_creation_tokens, cache_prompt_base,
	cost, latency_ms_sum, last_seen_at
)
SELECT
	lower(hex(randomblob(16))),
	?,
	usage_logs.model,
	usage_logs.channel_id,
	usage_logs.token_id,
	tokens.user_id,
	COUNT(*),
	COALESCE(SUM(CASE WHEN usage_logs.status != 'ok' THEN 1 ELSE 0 END), 0),
	COALESCE(SUM(usage_logs.prompt_tokens), 0),
	COALESCE(SUM(usage_logs.completion_tokens), 0),
	COALESCE(SUM(usage_logs.total_tokens), 0),
	COALESCE(SUM(usage_logs.cached_input_tokens), 0),
	COALESCE(SUM(usage_logs.cache_creation_tokens), 0),
	COALESCE(SUM(CASE WHEN usage_logs.cached_input_tokens IS NOT NULL THEN usage_logs.prompt_tokens ELSE 0 END), 0),
	COALESCE(SUM(usage_logs.cost), 0),
	COALESCE(SUM(usage_logs.latency_ms), 0),
	MAX(usage_logs.created_at)
FROM usage_logs
LEFT JOIN tokens ON tokens.id = usage_logs.token_id
WHERE usage_logs.created_at >= ? AND usage_logs.created_at < ?
GROUP BY usage_logs.model, usage_logs.channel_id, usage_logs.token_id`;

/**
 * Rebuilds the rollup rows of one UTC date: DELETE then INSERT SELECT inside
 * a single batch (= one transaction), so re-running the same date is
 * idempotent — no duplicate rows, values recomputed from the raw logs.
 *
 * Anti-loss guard: when the raw logs of this date were already pruned by
 * retention while its rollup rows still exist, DELETE-INSERT would wipe the
 * rollup rows permanently (the INSERT SELECT finds nothing to rebuild from).
 * In that case the call is a no-op and the existing rollup is preserved.
 * An empty raw set with no rollup rows yet falls through to the batch, which
 * simply writes nothing (unchanged behavior).
 */
export async function rollupDate(db: D1Database, date: UtcDate): Promise<void> {
	const dayStart = `${date}T00:00:00.000Z`;
	const rawCount = await db
		.prepare(
			"SELECT COUNT(*) AS c FROM usage_logs WHERE created_at >= ? AND created_at < ?",
		)
		.bind(dayStart, `${addUtcDays(date, 1)}T00:00:00.000Z`)
		.first<{ c: number }>();
	if ((rawCount?.c ?? 0) === 0) {
		const existing = await db
			.prepare(
				"SELECT COUNT(*) AS c FROM usage_stats_daily WHERE stat_date = ?",
			)
			.bind(date)
			.first<{ c: number }>();
		if ((existing?.c ?? 0) > 0) {
			return; // raw source is gone — never destroy the surviving rollup
		}
	}
	await db.batch([
		db.prepare("DELETE FROM usage_stats_daily WHERE stat_date = ?").bind(date),
		db
			.prepare(ROLLUP_INSERT_SQL)
			.bind(date, dayStart, `${addUtcDays(date, 1)}T00:00:00.000Z`),
	]);
}

/** Rollups every UTC date in the inclusive range (backfill / manual range). */
export async function rollupRange(
	db: D1Database,
	fromDate: UtcDate,
	toDate: UtcDate,
): Promise<void> {
	for (let date = fromDate; date <= toDate; date = addUtcDays(date, 1)) {
		await rollupDate(db, date);
	}
}

/** Lists UTC dates that have raw logs but no rollup rows yet. */
export async function rollupMissingDates(db: D1Database): Promise<UtcDate[]> {
	const result = await db
		.prepare(
			`SELECT DISTINCT substr(created_at, 1, 10) AS d FROM usage_logs
			WHERE substr(created_at, 1, 10) NOT IN (SELECT stat_date FROM usage_stats_daily)
			ORDER BY d`,
		)
		.all<{ d: UtcDate }>();
	return (result.results ?? []).map((row) => row.d);
}

/**
 * Backfills every date with raw logs but no rollup rows (first-deploy full
 * backfill). Dates already rolled are never touched — re-running is safe even
 * after raw logs were pruned, because such dates still have rollup rows.
 */
export async function rollupBackfill(db: D1Database): Promise<UtcDate[]> {
	const dates = await rollupMissingDates(db);
	for (const date of dates) {
		await rollupDate(db, date);
	}
	return dates;
}

// ---------------------------------------------------------------------------
// Retention prunes
// ---------------------------------------------------------------------------

/**
 * Deletes raw usage logs older than `beforeIso` in bounded batches
 * (D1-friendly: one small DELETE per loop instead of one giant statement).
 * Re-entrant: every batch is independent and the predicate is stable, so an
 * interrupted run can simply be re-run. Returns the number of deleted rows.
 */
export async function pruneUsageLogsBatched(
	db: D1Database,
	beforeIso: string,
	chunkSize = 500,
): Promise<number> {
	if (chunkSize <= 0) {
		return 0;
	}
	let deletedTotal = 0;
	for (;;) {
		const result = await db
			.prepare(
				"DELETE FROM usage_logs WHERE rowid IN (SELECT rowid FROM usage_logs WHERE created_at < ? LIMIT ?)",
			)
			.bind(beforeIso, chunkSize)
			.run();
		const changes = result.meta?.changes ?? 0;
		deletedTotal += changes;
		if (changes < chunkSize) {
			return deletedTotal;
		}
	}
}

/** Deletes expired admin and user sessions (small tables, single statements). */
export async function pruneExpiredSessions(
	db: D1Database,
	nowIso: string = new Date().toISOString(),
): Promise<{ adminDeleted: number; userDeleted: number }> {
	const adminResult = await db
		.prepare("DELETE FROM admin_sessions WHERE expires_at < ?")
		.bind(nowIso)
		.run();
	const userResult = await db
		.prepare("DELETE FROM user_sessions WHERE expires_at < ?")
		.bind(nowIso)
		.run();
	return {
		adminDeleted: adminResult.meta?.changes ?? 0,
		userDeleted: userResult.meta?.changes ?? 0,
	};
}

/** Deletes rollup rows older than the given UTC date (single statement). */
export async function pruneRollup(
	db: D1Database,
	beforeDate: UtcDate,
): Promise<number> {
	const result = await db
		.prepare("DELETE FROM usage_stats_daily WHERE stat_date < ?")
		.bind(beforeDate)
		.run();
	return result.meta?.changes ?? 0;
}

/**
 * The daily maintenance chain executed by the Workers cron (03:17 UTC):
 * rollup yesterday → batched prune of expired raw logs (retention read from
 * settings) → prune expired sessions → prune rollups past their own
 * retention. Every step is fault-isolated: a failing step logs and the rest
 * still run — a cron invocation has no response channel, console is the only
 * visibility (same posture as the post-response billing epilogue).
 */
export async function runDailyMaintenance(
	db: D1Database,
	now: Date = new Date(),
): Promise<void> {
	const todayUtc = utcDateOf(now.toISOString());

	const yesterday = addUtcDays(todayUtc, -1);
	try {
		await rollupDate(db, yesterday);
		console.log("[rollup] daily rollup done", { date: yesterday });
	} catch (e) {
		console.error("[rollup] daily rollup failed", {
			date: yesterday,
			error: String(e),
		});
	}

	try {
		const retentionDays = await getRetentionDays(db);
		const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
		const deleted = await pruneUsageLogsBatched(db, cutoff.toISOString());
		console.log("[retention] usage_logs pruned", { retentionDays, deleted });
	} catch (e) {
		console.error("[retention] usage_logs prune failed", { error: String(e) });
	}

	try {
		const { adminDeleted, userDeleted } = await pruneExpiredSessions(
			db,
			now.toISOString(),
		);
		console.log("[retention] sessions pruned", {
			admin: adminDeleted,
			user: userDeleted,
		});
	} catch (e) {
		console.error("[retention] session prune failed", { error: String(e) });
	}

	try {
		const pruned = await pruneRollup(
			db,
			addUtcDays(todayUtc, -ROLLUP_RETENTION_DAYS),
		);
		console.log("[retention] usage_stats_daily pruned", { pruned });
	} catch (e) {
		console.error("[retention] rollup prune failed", { error: String(e) });
	}
}

// ---------------------------------------------------------------------------
// Two-segment aggregation loaders
// ---------------------------------------------------------------------------

type SegmentQuery = { sql: string; params: unknown[] };

async function firstRow<T extends object>(
	db: D1Database,
	query: SegmentQuery | null,
): Promise<T | null> {
	if (!query) {
		return null;
	}
	const row = await db
		.prepare(query.sql)
		.bind(...query.params)
		.first<T>();
	return row ?? null;
}

async function allRows<T extends object>(
	db: D1Database,
	query: SegmentQuery | null,
): Promise<T[]> {
	if (!query) {
		return [];
	}
	const result = await db
		.prepare(query.sql)
		.bind(...query.params)
		.all<T>();
	return result.results ?? [];
}

const rollupSegment = (
	split: UsageWindowSplit,
	sql: string,
): SegmentQuery | null =>
	split.rollupFrom === null
		? null
		: { sql, params: [split.rollupFrom, split.rollupTo] };

const rawSegment = (
	split: UsageWindowSplit,
	sql: string,
): SegmentQuery | null =>
	split.rawFrom === null ? null : { sql, params: buildRawParams(split) };

function buildRawParams(split: UsageWindowSplit): unknown[] {
	// Unbounded upper edge keeps the two-placeholder shape: the sentinel is
	// above any realistic ISO timestamp, so the range stays semantically open.
	return split.rawTo === null
		? [split.rawFrom, "9999-12-31T23:59:59.999Z"]
		: [split.rawFrom, split.rawTo];
}

/**
 * Inclusive created_at range. Takes an optional column qualifier — JOINed
 * queries (usage_logs × channels/tokens) must qualify both edges or SQLite
 * raises "ambiguous column name".
 */
const rawDateRange = (column = "created_at") =>
	`${column} >= ? AND ${column} <= ?`;

/** Sentinel map key for a NULL grouping column (distinct from any real value). */
const NULL_KEY = "\u0000";

/**
 * Adds the numeric fields of `source` into `target`. Both rows must share the
 * same additive shape (the two-segment output-column alignment contract).
 */
function addNumeric<T extends object>(target: T, source: T | null): T {
	if (!source) {
		return target;
	}
	for (const key of Object.keys(target) as Array<keyof T & string>) {
		const value = source[key];
		if (typeof value === "number") {
			target[key] = ((target[key] as number) + value) as T[typeof key];
		}
	}
	return target;
}

function emptySummary(): DashboardSummaryAgg {
	return {
		total_requests: 0,
		total_tokens: 0,
		latency_sum: 0,
		total_errors: 0,
		cached_tokens: 0,
		cache_creation_tokens: 0,
		cache_prompt_base: 0,
	};
}

export type DashboardSummaryAgg = {
	total_requests: number;
	total_tokens: number;
	latency_sum: number;
	total_errors: number;
	cached_tokens: number;
	cache_creation_tokens: number;
	cache_prompt_base: number;
};

/**
 * Dashboard summary totals across the window. avg latency is derived by the
 * caller as latency_sum / total_requests (rows are the denominator; raw rows
 * always carry a non-null latency_ms per recordUsage).
 */
export async function loadDashboardSummary(
	db: D1Database,
	split: UsageWindowSplit,
): Promise<DashboardSummaryAgg> {
	const rollupRow = await firstRow<DashboardSummaryAgg>(
		db,
		rollupSegment(
			split,
			`SELECT COALESCE(SUM(requests), 0) AS total_requests,
				COALESCE(SUM(total_tokens), 0) AS total_tokens,
				COALESCE(SUM(latency_ms_sum), 0) AS latency_sum,
				COALESCE(SUM(error_count), 0) AS total_errors,
				COALESCE(SUM(cached_input_tokens), 0) AS cached_tokens,
				COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
				COALESCE(SUM(cache_prompt_base), 0) AS cache_prompt_base
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?`,
		),
	);
	const rawRow = await firstRow<DashboardSummaryAgg>(
		db,
		rawSegment(
			split,
			`SELECT COUNT(*) AS total_requests,
				COALESCE(SUM(total_tokens), 0) AS total_tokens,
				COALESCE(SUM(latency_ms), 0) AS latency_sum,
				COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS total_errors,
				COALESCE(SUM(cached_input_tokens), 0) AS cached_tokens,
				COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
				COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END), 0) AS cache_prompt_base
			FROM usage_logs WHERE ${rawDateRange()}`,
		),
	);
	return addNumeric(addNumeric(emptySummary(), rollupRow), rawRow);
}

export type DashboardDailyRow = {
	day: UtcDate;
	requests: number;
	tokens: number;
	cached_tokens: number;
	cache_prompt_base: number;
};

/**
 * Per-day dashboard totals, most recent first (`LIMIT 30` semantics kept by
 * slicing after the JS-side merge of both segments).
 */
export async function loadDashboardDaily(
	db: D1Database,
	split: UsageWindowSplit,
	limit = 30,
): Promise<DashboardDailyRow[]> {
	const rollupRows = await allRows<DashboardDailyRow>(
		db,
		rollupSegment(
			split,
			`SELECT stat_date AS day,
				SUM(requests) AS requests,
				COALESCE(SUM(total_tokens), 0) AS tokens,
				SUM(cached_input_tokens) AS cached_tokens,
				SUM(cache_prompt_base) AS cache_prompt_base
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?
			GROUP BY stat_date`,
		),
	);
	const rawRows = await allRows<DashboardDailyRow>(
		db,
		rawSegment(
			split,
			`SELECT substr(created_at, 1, 10) AS day,
				COUNT(*) AS requests,
				COALESCE(SUM(total_tokens), 0) AS tokens,
				COALESCE(SUM(cached_input_tokens), 0) AS cached_tokens,
				COALESCE(SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END), 0) AS cache_prompt_base
			FROM usage_logs WHERE ${rawDateRange()}
			GROUP BY day`,
		),
	);
	const byDay = new Map<UtcDate, DashboardDailyRow>();
	for (const row of [...rollupRows, ...rawRows]) {
		const current = byDay.get(row.day);
		if (current) {
			addNumeric(current, row);
		} else {
			byDay.set(row.day, { ...row });
		}
	}
	return [...byDay.values()]
		.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
		.slice(0, limit);
}

export type DashboardModelRow = {
	model: string | null;
	requests: number;
	tokens: number;
};

/** Per-model dashboard totals (null model keeps its own group, as raw does). */
export async function loadDashboardByModel(
	db: D1Database,
	split: UsageWindowSplit,
	limit = 20,
): Promise<DashboardModelRow[]> {
	const rollupRows = await allRows<DashboardModelRow>(
		db,
		rollupSegment(
			split,
			`SELECT model,
				SUM(requests) AS requests,
				COALESCE(SUM(total_tokens), 0) AS tokens
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?
			GROUP BY model`,
		),
	);
	const rawRows = await allRows<DashboardModelRow>(
		db,
		rawSegment(
			split,
			`SELECT model,
				COUNT(*) AS requests,
				COALESCE(SUM(total_tokens), 0) AS tokens
			FROM usage_logs WHERE ${rawDateRange()}
			GROUP BY model`,
		),
	);
	const byModel = new Map<string, DashboardModelRow>();
	for (const row of [...rollupRows, ...rawRows]) {
		const key = row.model === null ? NULL_KEY : row.model;
		const current = byModel.get(key);
		if (current) {
			addNumeric(current, row);
		} else {
			byModel.set(key, { ...row });
		}
	}
	return [...byModel.values()]
		.sort((a, b) => b.requests - a.requests)
		.slice(0, limit);
}

export type DashboardChannelRow = {
	channel_id: string | null;
	channel_name: string | null;
	requests: number;
	tokens: number;
};

/** Per-channel dashboard totals (channel meta joined on both segments). */
export async function loadDashboardByChannel(
	db: D1Database,
	split: UsageWindowSplit,
	limit = 20,
): Promise<DashboardChannelRow[]> {
	const rollupRows = await allRows<DashboardChannelRow>(
		db,
		rollupSegment(
			split,
			`SELECT usd.channel_id AS channel_id,
				channels.name AS channel_name,
				SUM(usd.requests) AS requests,
				COALESCE(SUM(usd.total_tokens), 0) AS tokens
			FROM usage_stats_daily usd
			LEFT JOIN channels ON channels.id = usd.channel_id
			WHERE usd.stat_date >= ? AND usd.stat_date <= ?
			GROUP BY usd.channel_id, channels.name`,
		),
	);
	const rawRows = await allRows<DashboardChannelRow>(
		db,
		rawSegment(
			split,
			`SELECT usage_logs.channel_id AS channel_id,
				channels.name AS channel_name,
				COUNT(*) AS requests,
				COALESCE(SUM(usage_logs.total_tokens), 0) AS tokens
			FROM usage_logs
			LEFT JOIN channels ON channels.id = usage_logs.channel_id
			WHERE ${rawDateRange("usage_logs.created_at")}
			GROUP BY usage_logs.channel_id, channels.name`,
		),
	);
	return mergeNamedRows(
		[...rollupRows, ...rawRows],
		(row) => (row.channel_id === null ? NULL_KEY : row.channel_id),
		limit,
	);
}

export type DashboardTokenRow = {
	token_id: string | null;
	token_name: string | null;
	requests: number;
	tokens: number;
};

/** Per-token dashboard totals (token meta joined on both segments). */
export async function loadDashboardByToken(
	db: D1Database,
	split: UsageWindowSplit,
	limit = 20,
): Promise<DashboardTokenRow[]> {
	const rollupRows = await allRows<DashboardTokenRow>(
		db,
		rollupSegment(
			split,
			`SELECT usd.token_id AS token_id,
				tokens.name AS token_name,
				SUM(usd.requests) AS requests,
				COALESCE(SUM(usd.total_tokens), 0) AS tokens
			FROM usage_stats_daily usd
			LEFT JOIN tokens ON tokens.id = usd.token_id
			WHERE usd.stat_date >= ? AND usd.stat_date <= ?
			GROUP BY usd.token_id, tokens.name`,
		),
	);
	const rawRows = await allRows<DashboardTokenRow>(
		db,
		rawSegment(
			split,
			`SELECT usage_logs.token_id AS token_id,
				tokens.name AS token_name,
				COUNT(*) AS requests,
				COALESCE(SUM(usage_logs.total_tokens), 0) AS tokens
			FROM usage_logs
			LEFT JOIN tokens ON tokens.id = usage_logs.token_id
			WHERE ${rawDateRange("usage_logs.created_at")}
			GROUP BY usage_logs.token_id, tokens.name`,
		),
	);
	return mergeNamedRows(
		[...rollupRows, ...rawRows],
		(row) => (row.token_id === null ? NULL_KEY : row.token_id),
		limit,
	);
}

/**
 * Merges keyed rows by summation and returns them sorted by requests desc,
 * truncated to `limit` (legacy `ORDER BY requests DESC LIMIT n` semantics).
 */
function mergeNamedRows<T extends { requests: number }>(
	rows: T[],
	keyOf: (row: T) => string,
	limit: number,
): T[] {
	const byKey = new Map<string, T>();
	for (const row of rows) {
		const key = keyOf(row);
		const current = byKey.get(key);
		if (current) {
			addNumeric(current, row);
		} else {
			byKey.set(key, { ...row });
		}
	}
	return [...byKey.values()]
		.sort((a, b) => b.requests - a.requests)
		.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Monitoring-style loaders (per-channel / per-model / window totals)
// ---------------------------------------------------------------------------

export type WindowTotalsAgg = {
	total_requests: number;
	total_errors: number;
	latency_sum: number;
};

/** Window-wide request/error/latency totals; success derives as requests − errors. */
export async function loadWindowTotals(
	db: D1Database,
	split: UsageWindowSplit,
): Promise<WindowTotalsAgg> {
	const rollupRow = await firstRow<WindowTotalsAgg>(
		db,
		rollupSegment(
			split,
			`SELECT COALESCE(SUM(requests), 0) AS total_requests,
				COALESCE(SUM(error_count), 0) AS total_errors,
				COALESCE(SUM(latency_ms_sum), 0) AS latency_sum
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?`,
		),
	);
	const rawRow = await firstRow<WindowTotalsAgg>(
		db,
		rawSegment(
			split,
			`SELECT COUNT(*) AS total_requests,
				COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS total_errors,
				COALESCE(SUM(latency_ms), 0) AS latency_sum
			FROM usage_logs WHERE ${rawDateRange()}`,
		),
	);
	const totals: WindowTotalsAgg = {
		total_requests: 0,
		total_errors: 0,
		latency_sum: 0,
	};
	return addNumeric(addNumeric(totals, rollupRow), rawRow);
}

export type ChannelHealthAgg = {
	channel_id: string;
	channel_name: string | null;
	channel_status: string;
	api_format: string;
	api_formats: string | null;
	total_requests: number;
	success_count: number;
	error_count: number;
	latency_sum: number;
	last_seen: string | null;
};

/** Rollup-side channel aggregate (channel_id can be null for unattributed rows). */
type ChannelRollupAgg = {
	channel_id: string | null;
	total_requests: number;
	error_count: number;
	latency_sum: number;
	last_seen: string | null;
};

/**
 * Per-channel health rows over the window. Raw rows anchor on the channels
 * table (zero-traffic channels included, legacy LEFT JOIN shape); rollup rows
 * merge into their channel by id. Rollup rows of channels deleted since are
 * dropped — matching the legacy anchor (deleted channels never appeared).
 */
export async function loadChannelHealthRows(
	db: D1Database,
	split: UsageWindowSplit,
): Promise<ChannelHealthAgg[]> {
	const rawRows = await allRows<ChannelHealthAgg>(
		db,
		rawSegment(
			split,
			`SELECT c.id AS channel_id,
				c.name AS channel_name,
				c.status AS channel_status,
				c.api_format,
				c.api_formats,
				COUNT(u.id) AS total_requests,
				COALESCE(SUM(CASE WHEN u.status = 'ok' THEN 1 ELSE 0 END), 0) AS success_count,
				COALESCE(SUM(CASE WHEN u.status != 'ok' THEN 1 ELSE 0 END), 0) AS error_count,
				COALESCE(SUM(u.latency_ms), 0) AS latency_sum,
				MAX(u.created_at) AS last_seen
			FROM channels c
			LEFT JOIN usage_logs u ON u.channel_id = c.id AND ${rawDateRange("u.created_at")}
			GROUP BY c.id, c.name, c.status, c.api_format, c.api_formats`,
		),
	);
	// Raw anchor must exist even without a raw segment (short windows still
	// list every channel); fall back to a bare channels listing.
	if (split.rawFrom === null) {
		const listed = await allRows<
			Pick<
				ChannelHealthAgg,
				| "channel_id"
				| "channel_name"
				| "channel_status"
				| "api_format"
				| "api_formats"
			>
		>(db, {
			sql: "SELECT id AS channel_id, name AS channel_name, status AS channel_status, api_format, api_formats FROM channels",
			params: [],
		});
		rawRows.push(
			...listed.map((row) => ({
				...row,
				total_requests: 0,
				success_count: 0,
				error_count: 0,
				latency_sum: 0,
				last_seen: null,
			})),
		);
	}
	const rollupRows = await allRows<ChannelRollupAgg>(
		db,
		rollupSegment(
			split,
			`SELECT channel_id,
				SUM(requests) AS total_requests,
				SUM(error_count) AS error_count,
				SUM(latency_ms_sum) AS latency_sum,
				MAX(last_seen_at) AS last_seen
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?
			GROUP BY channel_id`,
		),
	);
	const byChannel = new Map(
		rawRows.map((row) => [String(row.channel_id), row]),
	);
	for (const row of rollupRows) {
		if (row.channel_id === null) {
			continue;
		}
		const target = byChannel.get(String(row.channel_id));
		if (!target) {
			continue;
		}
		target.total_requests += row.total_requests;
		target.error_count += row.error_count;
		target.success_count = target.total_requests - target.error_count;
		target.latency_sum += row.latency_sum;
		if (row.last_seen !== null && row.last_seen > (target.last_seen ?? "")) {
			target.last_seen = row.last_seen;
		}
	}
	return rawRows;
}

export type ChannelDailyTrendAgg = {
	channel_id: string | null;
	day: string;
	requests: number;
	errors: number;
	latency_sum: number;
};

/**
 * Per-channel × slot trends. Slots are hour/minute/... via substr length
 * (`sqlSlice`); only day slots (`sqlSlice === 10`) can be served from the
 * day-granularity rollup, so other ranges keep the raw-only query bound at
 * `since`. Success derives as requests − errors downstream.
 */
export async function loadChannelDailyTrends(
	db: D1Database,
	since: string,
	split: UsageWindowSplit,
	sqlSlice: number,
): Promise<ChannelDailyTrendAgg[]> {
	const slotExpr = `substr(created_at, 1, ${sqlSlice})`;
	if (sqlSlice !== 10 || split.rollupFrom === null) {
		const rows = await allRows<ChannelDailyTrendAgg>(db, {
			sql: `SELECT channel_id,
					${slotExpr} AS day,
					COUNT(*) AS requests,
					SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
					COALESCE(SUM(latency_ms), 0) AS latency_sum
				FROM usage_logs
				WHERE created_at >= ?
				GROUP BY channel_id, day`,
			params: [since],
		});
		return rows;
	}
	const rollupRows = await allRows<ChannelDailyTrendAgg>(db, {
		sql: `SELECT channel_id,
				stat_date AS day,
				SUM(requests) AS requests,
				SUM(error_count) AS errors,
				SUM(latency_ms_sum) AS latency_sum
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?
			GROUP BY channel_id, stat_date`,
		params: [split.rollupFrom, split.rollupTo],
	});
	const rawRows = await allRows<ChannelDailyTrendAgg>(db, {
		sql: `SELECT channel_id,
				${slotExpr} AS day,
				COUNT(*) AS requests,
				SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
				COALESCE(SUM(latency_ms), 0) AS latency_sum
			FROM usage_logs
			WHERE ${rawDateRange()}
			GROUP BY channel_id, day`,
		params: buildRawParams(split),
	});
	const byKey = new Map<string, ChannelDailyTrendAgg>();
	for (const row of [...rollupRows, ...rawRows]) {
		const key = `${row.channel_id === null ? NULL_KEY : row.channel_id}|${row.day}`;
		const current = byKey.get(key);
		if (current) {
			addNumeric(current, row);
		} else {
			byKey.set(key, { ...row });
		}
	}
	return [...byKey.values()].sort((a, b) =>
		a.day < b.day ? 1 : a.day > b.day ? -1 : 0,
	);
}

export type ModelRequestAgg = {
	model: string;
	total_requests: number;
	error_count: number;
	latency_sum: number;
	last_seen: string | null;
};

/** Per-model request/error/latency totals (model monitoring rows). */
export async function loadModelRequestStats(
	db: D1Database,
	split: UsageWindowSplit,
): Promise<ModelRequestAgg[]> {
	const rollupRows = await allRows<ModelRequestAgg>(
		db,
		rollupSegment(
			split,
			`SELECT COALESCE(model, 'unknown') AS model,
				SUM(requests) AS total_requests,
				SUM(error_count) AS error_count,
				SUM(latency_ms_sum) AS latency_sum,
				MAX(last_seen_at) AS last_seen
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?
			GROUP BY COALESCE(model, 'unknown')`,
		),
	);
	const rawRows = await allRows<ModelRequestAgg>(
		db,
		rawSegment(
			split,
			`SELECT COALESCE(model, 'unknown') AS model,
				COUNT(*) AS total_requests,
				COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS error_count,
				COALESCE(SUM(latency_ms), 0) AS latency_sum,
				MAX(created_at) AS last_seen
			FROM usage_logs WHERE ${rawDateRange()}
			GROUP BY COALESCE(model, 'unknown')`,
		),
	);
	const byModel = new Map<string, ModelRequestAgg>();
	for (const row of [...rollupRows, ...rawRows]) {
		const current = byModel.get(row.model);
		if (current) {
			current.total_requests += row.total_requests;
			current.error_count += row.error_count;
			current.latency_sum += row.latency_sum;
			if (row.last_seen !== null && row.last_seen > (current.last_seen ?? "")) {
				current.last_seen = row.last_seen;
			}
		} else {
			byModel.set(row.model, { ...row });
		}
	}
	return [...byModel.values()].sort(
		(a, b) => b.total_requests - a.total_requests,
	);
}

export type ModelDailyTrendAgg = {
	model: string;
	day: string;
	requests: number;
	errors: number;
	latency_sum: number;
};

/**
 * Per-model × slot trends (user monitoring). Day slots use the rollup when
 * the window spans past days; other slot sizes stay raw-only at `since`.
 */
export async function loadModelDailyTrends(
	db: D1Database,
	since: string,
	split: UsageWindowSplit,
	sqlSlice: number,
): Promise<ModelDailyTrendAgg[]> {
	const slotExpr = `substr(created_at, 1, ${sqlSlice})`;
	if (sqlSlice !== 10 || split.rollupFrom === null) {
		return allRows<ModelDailyTrendAgg>(db, {
			sql: `SELECT COALESCE(model, 'unknown') AS model,
					${slotExpr} AS day,
					COUNT(*) AS requests,
					SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
					COALESCE(SUM(latency_ms), 0) AS latency_sum
				FROM usage_logs
				WHERE created_at >= ?
				GROUP BY model, day`,
			params: [since],
		});
	}
	const rollupRows = await allRows<ModelDailyTrendAgg>(db, {
		sql: `SELECT COALESCE(model, 'unknown') AS model,
				stat_date AS day,
				SUM(requests) AS requests,
				SUM(error_count) AS errors,
				SUM(latency_ms_sum) AS latency_sum
			FROM usage_stats_daily WHERE stat_date >= ? AND stat_date <= ?
			GROUP BY COALESCE(model, 'unknown'), stat_date`,
		params: [split.rollupFrom, split.rollupTo],
	});
	const rawRows = await allRows<ModelDailyTrendAgg>(db, {
		sql: `SELECT COALESCE(model, 'unknown') AS model,
				${slotExpr} AS day,
				COUNT(*) AS requests,
				SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
				COALESCE(SUM(latency_ms), 0) AS latency_sum
			FROM usage_logs
			WHERE ${rawDateRange()}
			GROUP BY COALESCE(model, 'unknown'), day`,
		params: buildRawParams(split),
	});
	const byKey = new Map<string, ModelDailyTrendAgg>();
	for (const row of [...rollupRows, ...rawRows]) {
		const key = `${row.model}|${row.day}`;
		const current = byKey.get(key);
		if (current) {
			addNumeric(current, row);
		} else {
			byKey.set(key, { ...row });
		}
	}
	return [...byKey.values()].sort((a, b) =>
		a.day < b.day ? 1 : a.day > b.day ? -1 : 0,
	);
}

// ---------------------------------------------------------------------------
// Model plaza loaders (routes/models.ts 30d / 7d aggregates)
// ---------------------------------------------------------------------------

export type ModelUsageTotalsAgg = {
	model: string;
	total_requests: number;
	total_tokens: number;
	total_cost: number;
	latency_sum: number;
};

/** Per-model 30d-style totals for the model plaza (model IS NOT NULL filter kept). */
export async function loadModelUsageTotals(
	db: D1Database,
	split: UsageWindowSplit,
): Promise<ModelUsageTotalsAgg[]> {
	const rollupRows = await allRows<ModelUsageTotalsAgg>(
		db,
		rollupSegment(
			split,
			`SELECT model,
				SUM(requests) AS total_requests,
				COALESCE(SUM(total_tokens), 0) AS total_tokens,
				COALESCE(SUM(cost), 0) AS total_cost,
				COALESCE(SUM(latency_ms_sum), 0) AS latency_sum
			FROM usage_stats_daily
			WHERE stat_date >= ? AND stat_date <= ? AND model IS NOT NULL
			GROUP BY model`,
		),
	);
	const rawRows = await allRows<ModelUsageTotalsAgg>(
		db,
		rawSegment(
			split,
			`SELECT model,
				COUNT(*) AS total_requests,
				COALESCE(SUM(total_tokens), 0) AS total_tokens,
				COALESCE(SUM(cost), 0) AS total_cost,
				COALESCE(SUM(latency_ms), 0) AS latency_sum
			FROM usage_logs
			WHERE ${rawDateRange()} AND model IS NOT NULL
			GROUP BY model`,
		),
	);
	const byModel = new Map<string, ModelUsageTotalsAgg>();
	for (const row of [...rollupRows, ...rawRows]) {
		const current = byModel.get(row.model);
		if (current) {
			addNumeric(current, row);
		} else {
			byModel.set(row.model, { ...row });
		}
	}
	return [...byModel.values()];
}

export type ModelDailyUsageAgg = {
	model: string;
	day: UtcDate;
	requests: number;
	tokens: number;
};

/** Per-model per-day usage for the model plaza (7d window, day slots). */
export async function loadModelDailyUsage(
	db: D1Database,
	split: UsageWindowSplit,
): Promise<ModelDailyUsageAgg[]> {
	const rollupRows = await allRows<ModelDailyUsageAgg>(
		db,
		rollupSegment(
			split,
			`SELECT model,
				stat_date AS day,
				SUM(requests) AS requests,
				COALESCE(SUM(total_tokens), 0) AS tokens
			FROM usage_stats_daily
			WHERE stat_date >= ? AND stat_date <= ? AND model IS NOT NULL
			GROUP BY model, stat_date
			ORDER BY day`,
		),
	);
	const rawRows = await allRows<ModelDailyUsageAgg>(
		db,
		rawSegment(
			split,
			`SELECT model,
				DATE(created_at) AS day,
				COUNT(*) AS requests,
				COALESCE(SUM(total_tokens), 0) AS tokens
			FROM usage_logs
			WHERE ${rawDateRange()} AND model IS NOT NULL
			GROUP BY model, DATE(created_at)
			ORDER BY day`,
		),
	);
	const byKey = new Map<string, ModelDailyUsageAgg>();
	for (const row of [...rollupRows, ...rawRows]) {
		const key = `${row.model}|${row.day}`;
		const current = byKey.get(key);
		if (current) {
			addNumeric(current, row);
		} else {
			byKey.set(key, { ...row });
		}
	}
	return [...byKey.values()].sort((a, b) =>
		a.day < b.day ? -1 : a.day > b.day ? 1 : 0,
	);
}

export type ModelChannelLatencyAgg = {
	model: string;
	channel_id: string;
	requests: number;
	latency_sum: number;
};

/** Per-model × channel latency aggregates for the model plaza. */
export async function loadModelChannelLatency(
	db: D1Database,
	split: UsageWindowSplit,
): Promise<ModelChannelLatencyAgg[]> {
	const rollupRows = await allRows<ModelChannelLatencyAgg>(
		db,
		rollupSegment(
			split,
			`SELECT model,
				channel_id,
				SUM(requests) AS requests,
				COALESCE(SUM(latency_ms_sum), 0) AS latency_sum
			FROM usage_stats_daily
			WHERE stat_date >= ? AND stat_date <= ?
				AND model IS NOT NULL AND channel_id IS NOT NULL
			GROUP BY model, channel_id`,
		),
	);
	const rawRows = await allRows<ModelChannelLatencyAgg>(
		db,
		rawSegment(
			split,
			`SELECT model,
				channel_id,
				COUNT(*) AS requests,
				COALESCE(SUM(latency_ms), 0) AS latency_sum
			FROM usage_logs
			WHERE ${rawDateRange()} AND model IS NOT NULL AND channel_id IS NOT NULL
			GROUP BY model, channel_id`,
		),
	);
	const byKey = new Map<string, ModelChannelLatencyAgg>();
	for (const row of [...rollupRows, ...rawRows]) {
		const key = `${row.model}:${row.channel_id}`;
		const current = byKey.get(key);
		if (current) {
			addNumeric(current, row);
		} else {
			byKey.set(key, { ...row });
		}
	}
	return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// User dashboard loaders (per-user, via the rollup's redundant user_id)
// ---------------------------------------------------------------------------

export type UserUsageTotalsAgg = {
	total_requests: number;
	total_tokens: number;
	total_cost: number;
	cached_tokens: number;
	cache_creation_tokens: number;
	cache_prompt_base: number;
};

/**
 * Full-history per-user totals. Rollup rows carry the redundant user_id
 * (resolved at rollup time), so no JOIN to tokens is needed for complete
 * past days; today's rows keep the live JOIN-to-tokens attribution.
 */
export async function loadUserUsageTotals(
	db: D1Database,
	userId: string,
	split: UsageWindowSplit,
): Promise<UserUsageTotalsAgg> {
	const rollupRow = await firstRow<UserUsageTotalsAgg>(
		db,
		split.rollupFrom === null
			? null
			: {
					sql: `SELECT COALESCE(SUM(requests), 0) AS total_requests,
				COALESCE(SUM(total_tokens), 0) AS total_tokens,
				COALESCE(SUM(cost), 0) AS total_cost,
				COALESCE(SUM(cached_input_tokens), 0) AS cached_tokens,
				COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
				COALESCE(SUM(cache_prompt_base), 0) AS cache_prompt_base
			FROM usage_stats_daily WHERE user_id = ?
				AND stat_date >= ? AND stat_date <= ?`,
					params: [userId, split.rollupFrom, split.rollupTo],
				},
	);
	const rawRow = await firstRow<UserUsageTotalsAgg>(
		db,
		split.rawFrom === null
			? null
			: {
					sql: `SELECT COUNT(*) AS total_requests,
				COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
				COALESCE(SUM(u.cost), 0) AS total_cost,
				COALESCE(SUM(u.cached_input_tokens), 0) AS cached_tokens,
				COALESCE(SUM(u.cache_creation_tokens), 0) AS cache_creation_tokens,
				COALESCE(SUM(CASE WHEN u.cached_input_tokens IS NOT NULL THEN u.prompt_tokens ELSE 0 END), 0) AS cache_prompt_base
			FROM usage_logs u
			JOIN tokens t ON u.token_id = t.id
			WHERE t.user_id = ? AND ${rawDateRange("u.created_at")}`,
					params: [userId, ...buildRawParams(split)],
				},
	);
	const totals: UserUsageTotalsAgg = {
		total_requests: 0,
		total_tokens: 0,
		total_cost: 0,
		cached_tokens: 0,
		cache_creation_tokens: 0,
		cache_prompt_base: 0,
	};
	return addNumeric(addNumeric(totals, rollupRow), rawRow);
}

export type UserDailyUsageAgg = {
	day: UtcDate;
	requests: number;
	cost: number;
	cached_tokens: number;
	cache_prompt_base: number;
};

/** Per-day per-user usage, most recent first (`limit` days). */
export async function loadUserDailyUsage(
	db: D1Database,
	userId: string,
	split: UsageWindowSplit,
	limit = 30,
): Promise<UserDailyUsageAgg[]> {
	const rollupRows = await allRows<UserDailyUsageAgg>(
		db,
		split.rollupFrom === null
			? null
			: {
					sql: `SELECT stat_date AS day,
				SUM(requests) AS requests,
				COALESCE(SUM(cost), 0) AS cost,
				SUM(cached_input_tokens) AS cached_tokens,
				SUM(cache_prompt_base) AS cache_prompt_base
			FROM usage_stats_daily WHERE user_id = ?
				AND stat_date >= ? AND stat_date <= ?
			GROUP BY stat_date`,
					params: [userId, split.rollupFrom, split.rollupTo],
				},
	);
	const rawRows = await allRows<UserDailyUsageAgg>(
		db,
		split.rawFrom === null
			? null
			: {
					sql: `SELECT DATE(u.created_at) AS day,
				COUNT(*) AS requests,
				COALESCE(SUM(u.cost), 0) AS cost,
				COALESCE(SUM(u.cached_input_tokens), 0) AS cached_tokens,
				COALESCE(SUM(CASE WHEN u.cached_input_tokens IS NOT NULL THEN u.prompt_tokens ELSE 0 END), 0) AS cache_prompt_base
			FROM usage_logs u
			JOIN tokens t ON u.token_id = t.id
			WHERE t.user_id = ? AND ${rawDateRange("u.created_at")}
			GROUP BY DATE(u.created_at)`,
					params: [userId, ...buildRawParams(split)],
				},
	);
	const byDay = new Map<UtcDate, UserDailyUsageAgg>();
	for (const row of [...rollupRows, ...rawRows]) {
		const current = byDay.get(row.day);
		if (current) {
			addNumeric(current, row);
		} else {
			byDay.set(row.day, { ...row });
		}
	}
	return [...byDay.values()]
		.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
		.slice(0, limit);
}
