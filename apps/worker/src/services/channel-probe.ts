/**
 * Channel active health probes (task 10-26-channel-probe, default OFF).
 *
 * The every-10-minutes cron tick calls runChannelProbes: channels with the
 * per-channel probe_enabled switch on are probed once their last_probe_at is
 * older than (global interval − random jitter). The probe itself is a plain
 * GET {resolved endpoint}/models per declared API format — zero tokens, zero
 * prompts — reusing fetchChannelModels so URL resolution, headers, disguise
 * templates and the "any response counts as reachable" semantics are
 * byte-identical to the manual connectivity test.
 *
 * ROUTING ISOLATION (PRD R5, hard constraint): probe results are display-only.
 * This file MUST NOT import anything from channel-cooldown / key-cooldown and
 * never touches usage_logs, weights or any routing-relevant channel field
 * (last_probe_at is the single column it writes). A probe marking a channel
 * "down" must leave the routing candidate pool and the cooldown tracker
 * untouched — locked by tests/channel-probe.test.ts.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { parseApiKeys } from "../utils/keys";
import type { ChannelFormatProbe } from "./channel-testing";
import { fetchChannelModels } from "./channel-testing";
import { type ChannelApiFormat, parseApiFormats } from "./channel-types";
import { loadProbeIntervalMinutesDirect } from "./settings";

/** Upper bound on channels probed at once (batched fan-out, be gentle upstream). */
export const PROBE_CONCURRENCY = 5;

/** All formats reachable but slower than this → degraded instead of healthy. */
export const PROBE_DEGRADED_LATENCY_MS = 5000;

/** Jitter window cap in minutes (anti-clock-fingerprinting, PRD R2). */
export const PROBE_MAX_JITTER_MINUTES = 5;

/** Probe-history retention (days), pruned by the 03:17 cron chain tail. */
export const PROBE_RETENTION_DAYS = 7;

/** Error message truncation for the per-format detail blob. */
const PROBE_DETAIL_ERROR_MAX_CHARS = 200;

export type ProbeStatus = "healthy" | "degraded" | "down";

/** Injectable randomness so tests can pin the jitter anywhere in its window. */
export type RandomSource = () => number;

/**
 * The channel columns the probe scheduler reads (explicit list — the probe
 * chain never relies on SELECT *).
 */
export type ProbeableChannelRow = {
	id: string;
	base_url: string;
	api_key: string;
	api_format: ChannelApiFormat;
	api_formats: string | null;
	endpoint_overrides: string | null;
	custom_headers_json: string | null;
	disguise_headers_json: string | null;
	last_probe_at: string | null;
};

/**
 * The jitter draw for one due-check, in minutes: uniform over
 * [0, min(PROBE_MAX_JITTER_MINUTES, interval/4)] — an interval-proportional
 * window capped at 5 minutes, re-drawn per channel per tick so probing never
 * lands on a fixed schedule. `rand` is injectable (tests pin 0 or 1 to hit
 * the window edges); out-of-range draws are clamped defensively.
 */
export function probeJitterMinutes(
	intervalMinutes: number,
	rand: RandomSource,
): number {
	const window = Math.min(PROBE_MAX_JITTER_MINUTES, intervalMinutes / 4);
	const draw = Math.min(1, Math.max(0, rand()));
	return draw * window;
}

/**
 * Due check with jitter (design §2.3): a channel is due when
 * `last_probe_at < now − (interval − jitter)` — with jitter re-drawn per
 * tick, a channel becomes due somewhere in the 0–window stretch *before* its
 * full interval elapses, so consecutive probe timestamps do not form a fixed
 * cadence. NULL / unparseable last_probe_at = never probed → immediately due.
 */
export function isChannelProbeDue(
	lastProbeAt: string | null | undefined,
	intervalMinutes: number,
	nowMs: number,
	rand: RandomSource = Math.random,
): boolean {
	if (!lastProbeAt) {
		return true;
	}
	const lastMs = Date.parse(lastProbeAt);
	if (Number.isNaN(lastMs)) {
		return true;
	}
	const jitter = probeJitterMinutes(intervalMinutes, rand);
	return lastMs < nowMs - (intervalMinutes - jitter) * 60_000;
}

/**
 * Classification (design §2.5, aligned with the "any response = reachable"
 * connectivity-test semantics): zero reachable formats → down; some formats
 * failing → degraded; everything reachable but slower than
 * PROBE_DEGRADED_LATENCY_MS → degraded; otherwise healthy.
 * Exported pure so the slow-degraded branch is testable without a real 5s wait.
 */
export function classifyChannelProbe(
	results: readonly ChannelFormatProbe[],
	elapsedMs: number,
): ProbeStatus {
	let okCount = 0;
	let failCount = 0;
	for (const entry of results) {
		if (entry.ok) {
			okCount++;
		} else {
			failCount++;
		}
	}
	if (okCount === 0) {
		return "down";
	}
	if (failCount > 0 || elapsedMs >= PROBE_DEGRADED_LATENCY_MS) {
		return "degraded";
	}
	return "healthy";
}

/**
 * Per-format detail blob: `{format: "ok" | "err: <truncated message>"}` —
 * the shape design §2.5 fixes for the channel_probes.detail column.
 */
function buildProbeDetail(results: readonly ChannelFormatProbe[]): string {
	const detail: Record<string, string> = {};
	for (const entry of results) {
		detail[entry.api_format] = entry.ok
			? "ok"
			: `err: ${(entry.error ?? "unknown").slice(0, PROBE_DETAIL_ERROR_MAX_CHARS)}`;
	}
	return JSON.stringify(detail);
}

/**
 * One cron tick (design §2). Early-exit order (default-zero-behavior
 * contract): the global gate is read FIRST (one settings SELECT) so
 * probe_interval_minutes = 0 returns without ever touching the channels
 * table; only then the single enabled-channels SELECT runs — with every
 * channel switch off (the shipped default) a tick costs exactly 1–2 read-only
 * queries, zero writes, zero fetches. Due channels are probed in batches of
 * PROBE_CONCURRENCY; each channel is independent — a fetch or write failure
 * on one channel is logged and never blocks the others.
 */
export async function runChannelProbes(
	db: D1Database,
	now: Date = new Date(),
	rand: RandomSource = Math.random,
): Promise<void> {
	const intervalMinutes = await loadProbeIntervalMinutesDirect(db);
	if (intervalMinutes <= 0) {
		return; // global gate off — not even the channels query is spent
	}
	const enabled = await db
		.prepare(
			"SELECT id, base_url, api_key, api_format, api_formats, endpoint_overrides, custom_headers_json, disguise_headers_json, last_probe_at FROM channels WHERE probe_enabled = 1",
		)
		.all<ProbeableChannelRow>();
	const rows = enabled.results ?? [];
	if (rows.length === 0) {
		return;
	}

	const nowMs = now.getTime();
	const checkedAt = now.toISOString();
	const due = rows.filter((row) =>
		isChannelProbeDue(row.last_probe_at, intervalMinutes, nowMs, rand),
	);
	for (let i = 0; i < due.length; i += PROBE_CONCURRENCY) {
		const batch = due.slice(i, i + PROBE_CONCURRENCY);
		await Promise.all(
			batch.map((row) => probeChannelAndRecord(db, row, checkedAt)),
		);
	}
}

/**
 * Probes one channel (reusing fetchChannelModels — per declared format, same
 * endpoint resolution / headers / disguise templates as the manual test) and
 * records the outcome: one channel_probes row + one channels.last_probe_at
 * UPDATE in a single per-channel batch (both statements succeed or fail
 * together). Display-only by contract: no cooldown calls, no usage rows.
 */
async function probeChannelAndRecord(
	db: D1Database,
	row: ProbeableChannelRow,
	checkedAt: string,
): Promise<void> {
	try {
		const result = await fetchChannelModels(
			String(row.base_url),
			parseApiKeys(String(row.api_key))[0] ?? String(row.api_key),
			parseApiFormats(row),
			row.custom_headers_json,
			row.disguise_headers_json ?? null,
			row.endpoint_overrides ?? null,
		);
		const results = result.results ?? [];
		const status = classifyChannelProbe(results, result.elapsed);
		await db.batch([
			db
				.prepare(
					"INSERT INTO channel_probes (channel_id, checked_at, status, latency_ms, detail) VALUES (?, ?, ?, ?, ?)",
				)
				.bind(
					row.id,
					checkedAt,
					status,
					result.elapsed,
					buildProbeDetail(results),
				),
			db
				.prepare("UPDATE channels SET last_probe_at = ? WHERE id = ?")
				.bind(checkedAt, row.id),
		]);
	} catch (error) {
		console.error("[channel-probe] probe failed", {
			channel_id: row.id,
			error: String(error),
		});
	}
}

/**
 * Deletes probe history older than `beforeIso` (single statement; the
 * checked_at index carries both this prune and the monitoring window query).
 * Wired into runDailyMaintenance's fault-isolated retention steps.
 */
export async function pruneChannelProbes(
	db: D1Database,
	beforeIso: string,
): Promise<number> {
	const result = await db
		.prepare("DELETE FROM channel_probes WHERE checked_at < ?")
		.bind(beforeIso)
		.run();
	return result.meta?.changes ?? 0;
}
