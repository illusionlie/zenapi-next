/**
 * Isolate-local channel cooldown tracker (P2, design.md §渠道冷却器).
 *
 * A channel that fails repeatedly (retryable 5xx / 429 / 408 or network
 * errors, same retryable set as utils/retry.ts) is excluded from the proxy
 * candidate pool for a fixed window, so an upstream outage stops burning the
 * rounds × channels × keys failure matrix on every concurrent request.
 *
 * Known boundaries (AGENTS §8): the state is a per-isolate in-memory view —
 * multiple isolates do not share it, so the picture is approximate but
 * directionally correct. fail-open is built into filterCoolingChannels: when
 * every candidate is cooling down the full pool is returned, so cooldown can
 * never cause an early no_available_channels.
 *
 * Failure/success semantics (callers, proxy.ts / anthropic-proxy.ts):
 * - recordChannelFailure — once per channel per request, at the channel
 *   abandonment point (key loop exhausted with the last failure retryable, or
 *   a network error). Not per key / per response, so one request cannot
 *   black-hole a hot channel by itself. Streaks decay over time: failures
 *   spaced more than COOLDOWN_STREAK_RESET_MS apart start a fresh streak.
 * - recordChannelSuccess — the channel returned any HTTP response that proves
 *   it is alive (an ok response, or a non-retryable 4xx). Clears the streak
 *   immediately: a recovered channel serves again without waiting out the
 *   window.
 */

/** Consecutive retryable failures before a channel enters cooldown. */
export const COOLDOWN_FAILURE_THRESHOLD = 3;

/** How long a channel stays out of the candidate pool once cooling. */
export const COOLDOWN_DURATION_MS = 60_000;

/**
 * Streak decay window: a failure arriving more than this long after the
 * previous one starts a fresh streak (consecutiveFailures reset to 1), so
 * "N consecutive failures" means failures clustered in time — not an
 * isolate-lifetime accumulator (2 flukes yesterday + 1 blip today must not
 * cool the channel). Independent of the 60s cooldown window.
 */
export const COOLDOWN_STREAK_RESET_MS = 300_000;

type CooldownState = {
	consecutiveFailures: number;
	/** Epoch ms of the streak's latest failure (decays the streak when stale). */
	lastFailureAt: number;
	/** Epoch ms; 0 = below threshold, never cooling. */
	cooldownUntil: number;
};

// Module-level isolate-local view (documented boundary above). Tests reset it
// via resetChannelCooldownsForTest.
const cooldownStates = new Map<string, CooldownState>();

/**
 * Records one retryable channel failure. When the consecutive-failure count
 * reaches COOLDOWN_FAILURE_THRESHOLD (or beyond — a fail-open retry of an
 * already-cooling channel that fails again) the channel cools down for
 * COOLDOWN_DURATION_MS from `now`. Failures spaced more than
 * COOLDOWN_STREAK_RESET_MS apart start a fresh streak (reset to 1); a
 * fail-open retry of a cooling channel always lands within its 60s window,
 * far inside the decay gap, so streak decay can never clear an active
 * cooldown.
 */
export function recordChannelFailure(channelId: string, now?: number): void {
	const nowMs = now ?? Date.now();
	const state = cooldownStates.get(channelId);
	const lastFailureAt = state?.lastFailureAt ?? 0;
	const streakExpired =
		lastFailureAt > 0 && nowMs - lastFailureAt > COOLDOWN_STREAK_RESET_MS;
	const consecutiveFailures = streakExpired
		? 1
		: (state?.consecutiveFailures ?? 0) + 1;
	const cooldownUntil =
		consecutiveFailures >= COOLDOWN_FAILURE_THRESHOLD
			? nowMs + COOLDOWN_DURATION_MS
			: 0;
	cooldownStates.set(channelId, {
		consecutiveFailures,
		lastFailureAt: nowMs,
		cooldownUntil,
	});
}

/**
 * Records a channel success (any alive-proving HTTP response). Clears the
 * failure streak and any active cooldown immediately.
 */
export function recordChannelSuccess(channelId: string): void {
	cooldownStates.delete(channelId);
}

/**
 * Whether the channel is currently cooling down. `cooldownUntil > now` is
 * cooling; expired entries are dropped lazily on read (no background sweep).
 */
export function isChannelCoolingDown(channelId: string, now?: number): boolean {
	const state = cooldownStates.get(channelId);
	if (!state) {
		return false;
	}
	const nowMs = now ?? Date.now();
	if (state.cooldownUntil > nowMs) {
		return true;
	}
	// Lazily drop only EXPIRED cooling windows (no background sweep).
	// Below-threshold counters (cooldownUntil === 0) must survive reads:
	// filterCoolingChannels runs on every request, so deleting them here would
	// reset the consecutive-failure streak before it can reach the threshold
	// and cooldown would never trigger through the wired proxy path.
	if (state.cooldownUntil !== 0) {
		cooldownStates.delete(channelId);
	}
	return false;
}

/**
 * Filters cooling-down channel ids out of the candidate pool, preserving the
 * input order. fail-open: when every candidate is cooling down the full pool
 * is returned unchanged (better to retry a cold channel than to have no
 * channel at all), so callers never need an empty-result guard.
 */
export function filterCoolingChannels(
	channelIds: string[],
	now?: number,
): string[] {
	const nowMs = now ?? Date.now();
	const active: string[] = [];
	let coolingCount = 0;
	for (const id of channelIds) {
		if (isChannelCoolingDown(id, nowMs)) {
			coolingCount += 1;
		} else {
			active.push(id);
		}
	}
	if (coolingCount === 0 || coolingCount === channelIds.length) {
		return channelIds;
	}
	return active;
}

/** Test isolation: clears all cooldown state (call in beforeEach). */
export function resetChannelCooldownsForTest(): void {
	cooldownStates.clear();
}
