/**
 * Isolate-local per-key cooldown tracker (task 10-26-key-cooldown-stats,
 * design.md §1 — same family as services/channel-cooldown.ts).
 *
 * A channel may hold many API keys (channels.api_key, newline-separated).
 * When one key starts failing (401/403 = credential dead, 429/5xx/network =
 * upstream pressure) the key — not the channel — is the sick unit: the proxy
 * key loop cools the failing key down and fails over to the next key instead
 * of abandoning the channel.
 *
 * Known boundaries (mirrors channel-cooldown.ts): the state is a per-isolate
 * in-memory view — multiple isolates do not share it, and a redeploy resets
 * it. fail-open is built into filterCoolingKeys: when every key of a channel
 * is cooling down the full list is returned, so cooldown can never starve a
 * channel of keys (better to eat one more failure than to refuse service).
 *
 * Failure/success semantics (callers, proxy.ts / anthropic-proxy.ts key loop):
 * - recordKeyAuthFailure — upstream answered 401/403: the credential is very
 *   likely dead → long cooldown. Single failure triggers (no streak): one 401
 *   on a valid request is already proof enough at key granularity.
 * - recordKeyRetryableFailure — 408/429/5xx response or the fetch itself
 *   threw: short cooldown, same family as the channel-level retryable set.
 * - recordKeySuccess — the key served an ok response: clears the cooling
 *   window immediately.
 * - Attribution split: 401/403 key failures never advance the CHANNEL
 *   cooldown streak — a live upstream that rejects a key is alive-proof, and
 *   the abandonment-point accounting already treats it that way (design §0).
 *
 * Counters (authFails / retryableFails / successes, lastFailureAt /
 * lastSuccessAt) accumulate for the isolate's lifetime — the monitoring UI
 * must label them as such, they are not a rolling window. The persisted
 * usage_logs.key_tag column (24h raw queries) is the durable counterpart.
 */

/** 401/403 cools a key for 10 minutes — the credential is very likely dead. */
export const KEY_AUTH_COOLDOWN_MS = 600_000;

/**
 * 408/429/5xx (isRetryableStatus set) or a fetch-level network error cools a
 * key for 60 seconds.
 */
export const KEY_RETRYABLE_COOLDOWN_MS = 60_000;

/**
 * Growth fuse: once more than this many distinct channelId:key entries exist,
 * reads/writes sweep entries whose cooling window has expired. Memory is
 * naturally bounded by channels × keys; the fuse only guards pathological
 * churn (e.g. keys being rotated faster than they expire).
 */
const KEY_STATE_MAX_ENTRIES = 10_000;

type KeyState = {
	/** Epoch ms; 0 = not cooling. */
	coolingUntil: number;
	/** Cumulative since isolate start (documented boundary above). */
	authFails: number;
	retryableFails: number;
	successes: number;
	/** Epoch ms of the latest failure; 0 = never failed. */
	lastFailureAt: number;
	/** Epoch ms of the latest success; 0 = never succeeded. */
	lastSuccessAt: number;
};

// Module-level isolate-local view (documented boundary above). Tests reset it
// via resetKeyCooldownsForTest.
const keyStates = new Map<string, KeyState>();

/**
 * FNV-1a 32-bit hash, hex-encoded and zero-padded to 8 chars. Sync, no
 * crypto.subtle — the proxy key loop needs it per attempt. 8 hex chars is
 * plenty: collisions only matter within a single channel's key pool, and the
 * full key string is still what gets sent upstream (this is a label, not a
 * secret). Deliberately NOT the client-presets 64-bit mixed hash — different
 * contract, different fingerprint domain.
 */
function fnv1a32(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/**
 * Stable 8-hex fingerprint of an API key: identical across restarts and
 * independent of the key's row position in channels.api_key (admin reordering
 * keys must not shift identities), and safe to expose in the monitoring UI
 * (never the plaintext key).
 */
export function keyFingerprint(apiKey: string): string {
	return fnv1a32(apiKey).toString(16).padStart(8, "0");
}

function emptyState(): KeyState {
	return {
		coolingUntil: 0,
		authFails: 0,
		retryableFails: 0,
		successes: 0,
		lastFailureAt: 0,
		lastSuccessAt: 0,
	};
}

function recordKeyFailure(
	channelId: string,
	apiKey: string,
	durationMs: number,
	kind: "auth" | "retryable",
	now?: number,
): void {
	const nowMs = now ?? Date.now();
	const mapKey = `${channelId}:${keyFingerprint(apiKey)}`;
	const state = keyStates.get(mapKey) ?? emptyState();
	state.coolingUntil = nowMs + durationMs;
	if (kind === "auth") {
		state.authFails += 1;
	} else {
		state.retryableFails += 1;
	}
	state.lastFailureAt = nowMs;
	keyStates.set(mapKey, state);
	if (keyStates.size > KEY_STATE_MAX_ENTRIES) {
		sweepExpiredStates(nowMs);
	}
}

/** Records an upstream 401/403 for this key → KEY_AUTH_COOLDOWN_MS window. */
export function recordKeyAuthFailure(
	channelId: string,
	apiKey: string,
	now?: number,
): void {
	recordKeyFailure(channelId, apiKey, KEY_AUTH_COOLDOWN_MS, "auth", now);
}

/**
 * Records a retryable key failure (408/429/5xx response or fetch throw) →
 * KEY_RETRYABLE_COOLDOWN_MS window.
 */
export function recordKeyRetryableFailure(
	channelId: string,
	apiKey: string,
	now?: number,
): void {
	recordKeyFailure(
		channelId,
		apiKey,
		KEY_RETRYABLE_COOLDOWN_MS,
		"retryable",
		now,
	);
}

/**
 * Records that this key served an ok response. Clears the cooling window
 * immediately (a recovered key serves again without waiting it out);
 * cumulative counters stay — they feed the monitoring snapshot.
 */
export function recordKeySuccess(
	channelId: string,
	apiKey: string,
	now?: number,
): void {
	const nowMs = now ?? Date.now();
	const mapKey = `${channelId}:${keyFingerprint(apiKey)}`;
	const state = keyStates.get(mapKey) ?? emptyState();
	state.coolingUntil = 0;
	state.successes += 1;
	state.lastSuccessAt = nowMs;
	keyStates.set(mapKey, state);
}

/**
 * Whether the key is currently cooling down. `coolingUntil > now` is cooling;
 * expired windows are clamped lazily on read (no background sweep) while the
 * cumulative counters survive for the monitoring snapshot.
 */
export function isKeyCoolingDown(
	channelId: string,
	apiKey: string,
	now?: number,
): boolean {
	const state = keyStates.get(`${channelId}:${keyFingerprint(apiKey)}`);
	if (!state) {
		return false;
	}
	const nowMs = now ?? Date.now();
	if (state.coolingUntil > nowMs) {
		return true;
	}
	if (state.coolingUntil !== 0) {
		state.coolingUntil = 0;
	}
	return false;
}

/**
 * Filters cooling-down keys out of a channel's shuffled key list, preserving
 * the input order. fail-open: when every key is cooling down the full list is
 * returned unchanged (better to retry a dead key than to have no key at all),
 * so callers never need an empty-result guard.
 */
export function filterCoolingKeys(
	channelId: string,
	keys: string[],
	now?: number,
): string[] {
	const nowMs = now ?? Date.now();
	const active: string[] = [];
	let coolingCount = 0;
	for (const apiKey of keys) {
		if (isKeyCoolingDown(channelId, apiKey, nowMs)) {
			coolingCount += 1;
		} else {
			active.push(apiKey);
		}
	}
	if (coolingCount === 0 || coolingCount === keys.length) {
		return keys;
	}
	return active;
}

/** One per-key entry of the monitoring snapshot (design.md §4a). */
export type KeyStatsSnapshotEntry = {
	channelId: string;
	/** 8-hex key fingerprint — same value stored in usage_logs.key_tag. */
	keyTag: string;
	cooling: boolean;
	/** Epoch ms; 0 = not cooling. */
	coolingUntil: number;
	/** Cumulative since isolate start (UI copy must label it as such). */
	authFails: number;
	retryableFails: number;
	successes: number;
	/** Epoch ms; 0 = never. */
	lastFailureAt: number;
	/** Epoch ms; 0 = never. */
	lastSuccessAt: number;
};

export type KeyStatsSnapshot = {
	/** Epoch ms the snapshot was taken (injected now when provided). */
	generatedAt: number;
	keys: KeyStatsSnapshotEntry[];
};

/**
 * Live per-key health view for the monitoring endpoint (zero D1 writes).
 * Entries whose cooling window has expired report cooling: false; counters
 * are isolate-lifetime accumulators (documented boundary).
 */
export function getKeyStatsSnapshot(now?: number): KeyStatsSnapshot {
	const nowMs = now ?? Date.now();
	const keys: KeyStatsSnapshotEntry[] = [];
	for (const [mapKey, state] of keyStates) {
		// mapKey = `${channelId}:${8-hex}` — the fingerprint is a fixed-width
		// hex suffix, so split by offset and channel ids containing ':' stay
		// intact.
		keys.push({
			channelId: mapKey.slice(0, mapKey.length - 9),
			keyTag: mapKey.slice(-8),
			cooling: state.coolingUntil > nowMs,
			coolingUntil: state.coolingUntil,
			authFails: state.authFails,
			retryableFails: state.retryableFails,
			successes: state.successes,
			lastFailureAt: state.lastFailureAt,
			lastSuccessAt: state.lastSuccessAt,
		});
	}
	return { generatedAt: nowMs, keys };
}

/** Test isolation: clears all key cooldown state (call in beforeEach). */
export function resetKeyCooldownsForTest(): void {
	keyStates.clear();
}

/**
 * Growth-fuse sweep: drops entries whose cooling window has expired. Only
 * reached past KEY_STATE_MAX_ENTRIES; in that pathological regime losing the
 * cumulative counters of cold keys is acceptable (isolate memory is an
 * approximate view anyway). Actively-cooling entries always survive.
 */
function sweepExpiredStates(nowMs: number): void {
	for (const [mapKey, state] of keyStates) {
		if (state.coolingUntil <= nowMs) {
			keyStates.delete(mapKey);
		}
	}
}
