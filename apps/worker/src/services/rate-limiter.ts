/**
 * Isolate-local client-side rate limiting (design.md §3): a token-RPM sliding
 * window plus an IP auth-failure throttle, both built on the same 60s
 * timestamp-window primitive.
 *
 * Known boundaries (AGENTS §8 客户端限流): the state is a per-isolate
 * in-memory view — multiple isolates do not share it, so the effective limit
 * is approximate (≈ configured value × active isolates). Pure memory means no
 * external dependency and therefore no failure path: fail-open is a
 * structural property, not a catch-based fallback (services/channel-cooldown
 * precedent).
 *
 * Arrival-rate semantics: `checkTokenRpm` appends the current timestamp on
 * the ALLOWED path too — the window limits how fast requests ARRIVE, not how
 * many succeed. A denied request does not occupy the window.
 *
 * Lazy-settings contract (tokenAuth wiring): the middleware resolves the
 * global defaults from settings only when it cannot decide without them.
 * - IP gate: an IP with zero recorded failures can never be throttled under
 *   any limit, so `ipAuthFailureCount === 0` short-circuits before any
 *   settings read.
 * - RPM gate with a NULL token rpm_limit: an empty window is allowed under
 *   any default (0 = off or any positive limit), so the first arrival is
 *   recorded via `noteTokenRpmArrival` and only later requests (non-empty
 *   window) consult settings. That keeps the all-default configuration at
 *   the exact pre-feature D1 query profile (token-auth test anchor).
 */

/** Sliding window length (ms) for both limiter domains. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Map-size guard: once a domain tracks more than this many keys, the next
 * touch sweeps the whole store and drops keys whose windows are fully
 * expired (best-effort anti-bloat; live windows always survive).
 */
const MAX_TRACKED_KEYS = 10_000;

export type SlidingWindowResult = {
	allowed: boolean;
	/** Seconds until the window frees a slot (ceil; 0 on the allowed path). */
	retryAfterSec: number;
};

// Module-level isolate-local views (documented boundary above). Tests reset
// them via resetRateLimiterState.
const tokenRpmWindows = new Map<string, number[]>();
const ipAuthFailures = new Map<string, number[]>();

/**
 * Returns the key's pruned window without inserting anything (a peek on an
 * unknown key must not allocate state, or probe traffic itself would grow
 * the map). Timestamps strictly older than the 60s window are dropped
 * in place; `ts > now - WINDOW` survives (a ts exactly 60s old is expired).
 */
function peekWindow(
	store: Map<string, number[]>,
	key: string,
	nowMs: number,
): number[] | null {
	const timestamps = store.get(key);
	if (!timestamps) {
		return null;
	}
	const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
	while (timestamps.length > 0 && timestamps[0] <= cutoff) {
		timestamps.shift();
	}
	return timestamps;
}

/**
 * Returns the key's pruned window, inserting an empty one for unknown keys,
 * and enforces the MAX_TRACKED_KEYS sweep: when the store grew past the cap,
 * every entry is pruned and keys with fully-expired windows are deleted.
 * The sweep runs BEFORE the insert so a brand-new key can never be reclaimed
 * by its own insertion (its empty window would look expired).
 */
function touchWindow(
	store: Map<string, number[]>,
	key: string,
	nowMs: number,
): number[] {
	const existing = peekWindow(store, key, nowMs);
	if (existing) {
		sweepIfOversized(store, nowMs);
		return existing;
	}
	sweepIfOversized(store, nowMs);
	const timestamps: number[] = [];
	store.set(key, timestamps);
	return timestamps;
}

function sweepIfOversized(store: Map<string, number[]>, nowMs: number): void {
	if (store.size <= MAX_TRACKED_KEYS) {
		return;
	}
	const cutoff = nowMs - RATE_LIMIT_WINDOW_MS;
	for (const [key, timestamps] of store) {
		const kept = timestamps.filter((ts) => ts > cutoff);
		if (kept.length === 0) {
			store.delete(key);
		} else if (kept.length !== timestamps.length) {
			store.set(key, kept);
		}
	}
}

/** ceil(remaining window ms / 1000), floored at 1s (Retry-After is >= 1). */
function retryAfterSeconds(oldestTs: number, nowMs: number): number {
	const remainingMs = oldestTs + RATE_LIMIT_WINDOW_MS - nowMs;
	return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Token RPM gate: allows while the 60s window holds fewer than
 * `limitPerMin` arrivals, appending the current timestamp on the allowed
 * path (arrival-rate semantics); a denied request does not occupy the window
 * and Retry-After reports when the OLDEST entry ages out. A limit <= 0 means
 * the limiter is off — always allowed, no state touched.
 */
export function checkTokenRpm(
	tokenId: string,
	limitPerMin: number,
	now?: number,
): SlidingWindowResult {
	const nowMs = now ?? Date.now();
	if (!Number.isFinite(limitPerMin) || limitPerMin <= 0) {
		return { allowed: true, retryAfterSec: 0 };
	}
	const timestamps = touchWindow(tokenRpmWindows, tokenId, nowMs);
	if (timestamps.length < limitPerMin) {
		timestamps.push(nowMs);
		return { allowed: true, retryAfterSec: 0 };
	}
	return {
		allowed: false,
		retryAfterSec: retryAfterSeconds(timestamps[0], nowMs),
	};
}

/**
 * Whether the token has any in-window arrival recorded. Read-only peek used
 * by the lazy-settings wiring: an empty window is allowed under any limit,
 * so the caller can skip resolving the global default entirely.
 */
export function hasTokenRpmRequests(tokenId: string, now?: number): boolean {
	const timestamps = peekWindow(tokenRpmWindows, tokenId, now ?? Date.now());
	return timestamps !== null && timestamps.length > 0;
}

/**
 * Records one arrival without any allow/deny decision (the lazy-settings
 * counterpart of checkTokenRpm's allowed-path append).
 */
export function noteTokenRpmArrival(tokenId: string, now?: number): void {
	const nowMs = now ?? Date.now();
	touchWindow(tokenRpmWindows, tokenId, nowMs).push(nowMs);
}

/** Records one auth failure for the IP (called at the four 401/403 exits). */
export function recordIpAuthFailure(ip: string, now?: number): void {
	const nowMs = now ?? Date.now();
	touchWindow(ipAuthFailures, ip, nowMs).push(nowMs);
}

/**
 * Failures currently in the IP's 60s window. Read-only peek: an IP at zero
 * can never be throttled, letting the caller skip the settings read.
 */
export function ipAuthFailureCount(ip: string, now?: number): number {
	const timestamps = peekWindow(ipAuthFailures, ip, now ?? Date.now());
	return timestamps?.length ?? 0;
}

/**
 * Whether the IP is throttled: in-window failures >= limit. A limit <= 0
 * means the throttle is off (never throttled).
 */
export function isIpThrottled(
	ip: string,
	limit: number,
	now?: number,
): boolean {
	if (!Number.isFinite(limit) || limit <= 0) {
		return false;
	}
	return ipAuthFailureCount(ip, now) >= limit;
}

/** Seconds until the IP's oldest in-window failure ages out (throttle lift). */
export function ipThrottleRetryAfterSec(ip: string, now?: number): number {
	const nowMs = now ?? Date.now();
	const timestamps = peekWindow(ipAuthFailures, ip, nowMs);
	if (timestamps === null || timestamps.length === 0) {
		return 0;
	}
	return retryAfterSeconds(timestamps[0], nowMs);
}

/** Test isolation: clears both limiter domains (call in beforeEach). */
export function resetRateLimiterState(): void {
	tokenRpmWindows.clear();
	ipAuthFailures.clear();
}
