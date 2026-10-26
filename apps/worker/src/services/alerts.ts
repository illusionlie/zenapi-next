import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "../utils/time";
import { loadAlertConfigDirect, loadDailyReportFlagDirect } from "./settings";
import {
	type AlertMessage,
	type SendResult,
	sendWebhook,
} from "./webhook-senders";

/**
 * Channel failure-rate alerting (design §2) + optional daily usage report
 * (design §4). The evaluator runs on the every-5-minutes cron entry ("*\/5
 * * * * *" in wrangler.toml) and is the ONLY consumer of the
 * `alert_state:{channelId}` settings keys — those JSON blobs
 * ({lastAlertAt, lastRecoverAt}) are the cross-isolate silence / recovery
 * memory (isolate-local maps would double-alert across isolates; a settings
 * write per channel per silence window is bounded and consistent).
 */

/** settings-key prefix of the per-channel alert state blobs. */
export const ALERT_STATE_KEY_PREFIX = "alert_state:";

type AlertState = {
	lastAlertAt: string | null;
	lastRecoverAt: string | null;
};

type EnabledWebhook = { id: string; name: string; type: string; url: string };

type ChannelFailureRow = {
	channel_id: string;
	channel_name: string | null;
	total: number;
	errors: number;
};

const ENABLED_WEBHOOKS_SQL =
	"SELECT id, name, type, url FROM webhooks WHERE enabled = 1 ORDER BY created_at ASC, id ASC";

/**
 * Per-channel window aggregate (design §2 step 2, one query). Error side
 * follows the codebase-wide monitoring convention `status != 'ok'` (write
 * side records "ok"/"error"); the LEFT JOIN resolves the channel name for
 * the notification text (PRD acceptance: 渠道名/指标/时间), deleted channels
 * fall back to their id.
 */
const CHANNEL_FAILURE_AGG_SQL = `SELECT l.channel_id AS channel_id,
	c.name AS channel_name,
	COUNT(*) AS total,
	COALESCE(SUM(CASE WHEN l.status != 'ok' THEN 1 ELSE 0 END), 0) AS errors
FROM usage_logs l
LEFT JOIN channels c ON c.id = l.channel_id
WHERE l.created_at >= ? AND l.channel_id IS NOT NULL
GROUP BY l.channel_id, c.name`;

async function listEnabledWebhooks(db: D1Database): Promise<EnabledWebhook[]> {
	const result = await db.prepare(ENABLED_WEBHOOKS_SQL).all<EnabledWebhook>();
	return result.results ?? [];
}

function parseAlertState(raw: string | null): AlertState | null {
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as {
			lastAlertAt?: unknown;
			lastRecoverAt?: unknown;
		};
		if (typeof parsed !== "object" || parsed === null) {
			return null;
		}
		return {
			lastAlertAt:
				typeof parsed.lastAlertAt === "string" ? parsed.lastAlertAt : null,
			lastRecoverAt:
				typeof parsed.lastRecoverAt === "string" ? parsed.lastRecoverAt : null,
		};
	} catch {
		return null;
	}
}

/** Batch-reads the alert states of the aggregated channels (one key IN query). */
async function readAlertStates(
	db: D1Database,
	channelIds: string[],
): Promise<Map<string, AlertState | null>> {
	const placeholders = channelIds.map(() => "?").join(", ");
	const result = await db
		.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
		.bind(...channelIds.map((id) => ALERT_STATE_KEY_PREFIX + id))
		.all<{ key: string; value: string | null }>();
	const map = new Map<string, AlertState | null>();
	for (const row of result.results ?? []) {
		map.set(String(row.key), parseAlertState(row.value));
	}
	return map;
}

async function writeAlertState(
	db: D1Database,
	channelId: string,
	state: AlertState,
): Promise<void> {
	await db
		.prepare(
			"INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		)
		.bind(ALERT_STATE_KEY_PREFIX + channelId, JSON.stringify(state), nowIso())
		.run();
}

/**
 * Fans the message out to every enabled webhook concurrently. A rejected or
 * non-ok send is logged and swallowed — no retry queue, the next evaluation
 * cycle re-judges from fresh data.
 */
async function broadcast(
	webhooks: EnabledWebhook[],
	message: AlertMessage,
): Promise<void> {
	const results = await Promise.allSettled(
		webhooks.map((webhook) => sendWebhook(webhook.type, webhook.url, message)),
	);
	for (const [index, result] of results.entries()) {
		const webhook = webhooks[index];
		if (webhook === undefined) {
			continue;
		}
		if (result.status === "rejected") {
			console.warn("[alerts] webhook send rejected", {
				webhook: webhook.name,
				reason: String(result.reason),
			});
		} else {
			const value: SendResult = result.value;
			if (!value.ok) {
				console.warn("[alerts] webhook send failed", {
					webhook: webhook.name,
					type: webhook.type,
					status: value.status ?? null,
				});
			}
		}
	}
}

/**
 * The every-5-minutes cron entry point. Default zero behavior: with no
 * enabled webhook the call returns after the very first query. Per
 * evaluation: one aggregate query over the alert window, one batched state
 * read, then per breaching channel an allSettled broadcast + a state write
 * (alert refreshes lastAlertAt; recovery below the threshold/2 hysteresis
 * band clears it and stamps lastRecoverAt).
 */
export async function evaluateAlerts(
	db: D1Database,
	now: Date = new Date(),
): Promise<void> {
	const webhooks = await listEnabledWebhooks(db);
	if (webhooks.length === 0) {
		return;
	}
	const config = await loadAlertConfigDirect(db);
	const threshold = config.failureRatePct;
	if (threshold <= 0) {
		// Alerting switched off — drop stale state so re-enabling starts clean.
		await db
			.prepare("DELETE FROM settings WHERE key LIKE ?")
			.bind(`${ALERT_STATE_KEY_PREFIX}%`)
			.run();
		return;
	}

	const windowStartIso = new Date(
		now.getTime() - config.windowMinutes * 60_000,
	).toISOString();
	const aggResult = await db
		.prepare(CHANNEL_FAILURE_AGG_SQL)
		.bind(windowStartIso)
		.all<ChannelFailureRow>();
	const channelRows = aggResult.results ?? [];
	if (channelRows.length === 0) {
		return;
	}

	const states = await readAlertStates(
		db,
		channelRows.map((row) => row.channel_id),
	);
	const timestamp = now.toISOString();
	const silenceMs = config.silenceMinutes * 60_000;

	for (const row of channelRows) {
		const rate = (row.errors / row.total) * 100;
		const channelLabel = row.channel_name ?? row.channel_id;
		const state = states.get(ALERT_STATE_KEY_PREFIX + row.channel_id) ?? null;
		const breach = rate >= threshold && row.total >= config.minSamples;

		if (breach) {
			// Silence window: same channel re-alerts are suppressed until it
			// elapses (the state blob, not isolate memory, is the source of
			// truth — see module docstring).
			const lastAlertMs = state?.lastAlertAt
				? Date.parse(state.lastAlertAt)
				: null;
			if (lastAlertMs !== null && now.getTime() - lastAlertMs < silenceMs) {
				continue;
			}
			await broadcast(webhooks, {
				title: "[ZenAPI] 渠道故障报警",
				severity: "warning",
				ts: timestamp,
				lines: [
					`渠道: ${channelLabel}`,
					`失败率: ${rate.toFixed(1)}%（${row.errors}/${row.total} 次请求失败）`,
					`阈值: 失败率 ≥ ${threshold}%`,
					`窗口: 最近 ${config.windowMinutes} 分钟`,
				],
			});
			await writeAlertState(db, row.channel_id, {
				lastAlertAt: timestamp,
				lastRecoverAt: state?.lastRecoverAt ?? null,
			});
		} else if (state?.lastAlertAt && rate < threshold / 2) {
			// Recovery with hysteresis: only below threshold/2 (not merely below
			// threshold) so a flapping channel right at the line doesn't ping-pong.
			await broadcast(webhooks, {
				title: "[ZenAPI] 渠道故障恢复",
				severity: "info",
				ts: timestamp,
				lines: [
					`渠道: ${channelLabel}`,
					`当前失败率: ${rate.toFixed(1)}%（${row.errors}/${row.total} 次请求）`,
					`窗口: 最近 ${config.windowMinutes} 分钟`,
				],
			});
			await writeAlertState(db, row.channel_id, {
				lastAlertAt: null,
				lastRecoverAt: timestamp,
			});
		}
	}
}

type ReportTotalsRow = {
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
};

type ReportChannelRow = {
	channel_name: string | null;
	channel_id: string | null;
	requests: number;
	tokens: number;
	cost: number;
};

type ReportModelRow = {
	model: string;
	requests: number;
	tokens: number;
	cost: number;
};

/** Site-wide totals of one stat_date (design §4: requests/tokens/cost). */
const REPORT_TOTALS_SQL = `SELECT COALESCE(SUM(requests), 0) AS requests,
	COALESCE(SUM(error_count), 0) AS errors,
	COALESCE(SUM(total_tokens), 0) AS tokens,
	COALESCE(SUM(cost), 0) AS cost
FROM usage_stats_daily WHERE stat_date = ?`;

/** Top-5 channels of one stat_date by request volume. */
const REPORT_TOP_CHANNELS_SQL = `SELECT c.name AS channel_name,
	usd.channel_id AS channel_id,
	SUM(usd.requests) AS requests,
	COALESCE(SUM(usd.total_tokens), 0) AS tokens,
	COALESCE(SUM(usd.cost), 0) AS cost
FROM usage_stats_daily usd
LEFT JOIN channels c ON c.id = usd.channel_id
WHERE usd.stat_date = ?
GROUP BY usd.channel_id, c.name
ORDER BY requests DESC
LIMIT 5`;

/** Top-5 models of one stat_date by request volume. */
const REPORT_TOP_MODELS_SQL = `SELECT COALESCE(model, 'unknown') AS model,
	SUM(requests) AS requests,
	COALESCE(SUM(total_tokens), 0) AS tokens,
	COALESCE(SUM(cost), 0) AS cost
FROM usage_stats_daily
WHERE stat_date = ?
GROUP BY COALESCE(model, 'unknown')
ORDER BY requests DESC
LIMIT 5`;

const formatMoney = (cost: number): string => `$${cost.toFixed(4)}`;

const formatChannelRow = (row: ReportChannelRow): string =>
	`- ${row.channel_name ?? row.channel_id ?? "unknown"}：${row.requests} 次 / ${row.tokens} tokens / ${formatMoney(row.cost)}`;

const formatModelRow = (row: ReportModelRow): string =>
	`- ${row.model}：${row.requests} 次 / ${row.tokens} tokens / ${formatMoney(row.cost)}`;

/**
 * Daily usage report appended to the 03:17 maintenance chain tail (design
 * §4). Strict-boolean flag off → single settings read and return (zero
 * webhook/aggregation work); empty webhook table → nothing sent; aggregation
 * reads yesterday's usage_stats_daily only (the rollup ran moments earlier in
 * the same chain). All failures bubble to the chain's own fault isolation.
 */
export async function maybeSendDailyReport(
	db: D1Database,
	now: Date = new Date(),
): Promise<void> {
	if (!(await loadDailyReportFlagDirect(db))) {
		return;
	}
	const webhooks = await listEnabledWebhooks(db);
	if (webhooks.length === 0) {
		return;
	}
	// Yesterday's UTC date; computed locally (no usage-stats import) so the
	// maintenance chain keeps a single-direction dependency graph.
	const statDate = new Date(now.getTime() - 86_400_000)
		.toISOString()
		.slice(0, 10);

	const totals = await db
		.prepare(REPORT_TOTALS_SQL)
		.bind(statDate)
		.first<ReportTotalsRow>();
	const topChannels = await db
		.prepare(REPORT_TOP_CHANNELS_SQL)
		.bind(statDate)
		.all<ReportChannelRow>();
	const topModels = await db
		.prepare(REPORT_TOP_MODELS_SQL)
		.bind(statDate)
		.all<ReportModelRow>();

	const totalsRow: ReportTotalsRow = totals ?? {
		requests: 0,
		errors: 0,
		tokens: 0,
		cost: 0,
	};
	const errorRate =
		totalsRow.requests > 0
			? `${((totalsRow.errors / totalsRow.requests) * 100).toFixed(1)}%`
			: "N/A";
	const lines = [
		`统计日期: ${statDate}（UTC）`,
		`请求: ${totalsRow.requests} 次（错误 ${totalsRow.errors} 次，错误率 ${errorRate}）`,
		`Tokens: ${totalsRow.tokens}`,
		`消费: ${formatMoney(totalsRow.cost)}`,
		`Top 渠道:`,
		...(topChannels.results ?? []).map(formatChannelRow),
		`Top 模型:`,
		...(topModels.results ?? []).map(formatModelRow),
	];

	await broadcast(webhooks, {
		title: "[ZenAPI] 用量日报",
		severity: "info",
		ts: now.toISOString(),
		lines,
	});
}
