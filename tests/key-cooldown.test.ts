import { beforeEach, describe, expect, it } from "vitest";
import {
	type KeyStatsSnapshotEntry,
	KEY_AUTH_COOLDOWN_MS,
	KEY_RETRYABLE_COOLDOWN_MS,
	filterCoolingKeys,
	getKeyStatsSnapshot,
	isKeyCoolingDown,
	keyFingerprint,
	recordKeyAuthFailure,
	recordKeyRetryableFailure,
	recordKeySuccess,
	resetKeyCooldownsForTest,
} from "../apps/worker/src/services/key-cooldown";

/**
 * Key-level cooldown state machine (design.md §1/§6). All time is injected
 * via the `now` parameter — no fake timers, no real-clock dependency.
 */

const CH = "ch1";
const K1 = "sk-key-one";
const K2 = "sk-key-two";

beforeEach(() => {
	resetKeyCooldownsForTest();
});

describe("fingerprints", () => {
	it("is a stable pure function of the key string", () => {
		expect(keyFingerprint(K1)).toBe(keyFingerprint(K1));
		expect(keyFingerprint(K1)).toBe(keyFingerprint(`x\n${K1}`.slice(2)));
	});

	it("differs across keys and is 8 hex chars", () => {
		expect(keyFingerprint(K1)).not.toBe(keyFingerprint(K2));
		expect(keyFingerprint("")).toMatch(/^[0-9a-f]{8}$/);
		expect(keyFingerprint(K1)).toMatch(/^[0-9a-f]{8}$/);
	});

	it("does not leak the plaintext key", () => {
		expect(keyFingerprint(K1)).not.toContain(K1);
	});
});

describe("auth failure → 10 minute cooldown", () => {
	it("exposes the design constants", () => {
		expect(KEY_AUTH_COOLDOWN_MS).toBe(600_000);
		expect(KEY_RETRYABLE_COOLDOWN_MS).toBe(60_000);
	});

	it("cools the key for exactly KEY_AUTH_COOLDOWN_MS (injected now)", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		expect(isKeyCoolingDown(CH, K1, 1_000)).toBe(true);
		expect(isKeyCoolingDown(CH, K1, 1_000 + KEY_AUTH_COOLDOWN_MS - 1)).toBe(
			true,
		);
		// At exactly cooldownUntil the key is back in service.
		expect(isKeyCoolingDown(CH, K1, 1_000 + KEY_AUTH_COOLDOWN_MS)).toBe(false);
	});

	it("tracks keys (and channels) independently", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		expect(isKeyCoolingDown(CH, K1, 2_000)).toBe(true);
		expect(isKeyCoolingDown(CH, K2, 2_000)).toBe(false);
		// Same key string on another channel is an independent identity.
		expect(isKeyCoolingDown("ch2", K1, 2_000)).toBe(false);
	});

	it("a single 401 triggers the long cooldown (no streak threshold)", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		expect(isKeyCoolingDown(CH, K1, 1_001)).toBe(true);
	});
});

describe("retryable failure → 60s cooldown", () => {
	it("cools the key for exactly KEY_RETRYABLE_COOLDOWN_MS", () => {
		recordKeyRetryableFailure(CH, K1, 1_000);
		expect(isKeyCoolingDown(CH, K1, 1_000)).toBe(true);
		expect(
			isKeyCoolingDown(CH, K1, 1_000 + KEY_RETRYABLE_COOLDOWN_MS - 1),
		).toBe(true);
		expect(isKeyCoolingDown(CH, K1, 1_000 + KEY_RETRYABLE_COOLDOWN_MS)).toBe(
			false,
		);
	});

	it("an auth failure re-arms a longer window over a short one", () => {
		recordKeyRetryableFailure(CH, K1, 1_000);
		recordKeyAuthFailure(CH, K1, 2_000);
		expect(isKeyCoolingDown(CH, K1, 2_000 + KEY_RETRYABLE_COOLDOWN_MS + 1)).toBe(
			true,
		);
		expect(isKeyCoolingDown(CH, K1, 2_000 + KEY_AUTH_COOLDOWN_MS)).toBe(false);
	});
});

describe("success clears the cooling window", () => {
	it("a success readmits a cooling key immediately", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		expect(isKeyCoolingDown(CH, K1, 1_001)).toBe(true);
		recordKeySuccess(CH, K1, 1_002);
		expect(isKeyCoolingDown(CH, K1, 1_003)).toBe(false);
	});

	it("counters survive the success (isolate-lifetime accumulators)", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		recordKeyRetryableFailure(CH, K1, 2_000);
		recordKeySuccess(CH, K1, 3_000);
		const snap = getKeyStatsSnapshot(4_000);
		const entry = snap.keys.find((k) => k.channelId === CH);
		expect(entry?.authFails).toBe(1);
		expect(entry?.retryableFails).toBe(1);
		expect(entry?.successes).toBe(1);
		expect(entry?.cooling).toBe(false);
	});
});

describe("filterCoolingKeys", () => {
	it("returns the pool untouched when nothing is cooling", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		recordKeySuccess(CH, K1, 2_000);
		expect(filterCoolingKeys(CH, [K1, K2], 3_000)).toEqual([K1, K2]);
	});

	it("drops only the cooling keys, preserving order", () => {
		recordKeyAuthFailure(CH, K2, 1_000);
		expect(filterCoolingKeys(CH, [K1, K2, `${K1}-alt`], 2_000)).toEqual([
			K1,
			`${K1}-alt`,
		]);
	});

	it("fail-open: returns the full pool when every key is cooling", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		recordKeyAuthFailure(CH, K2, 1_000);
		const pool = [K1, K2];
		expect(filterCoolingKeys(CH, pool, 2_000)).toBe(pool);
	});

	it("fail-open also applies to a single fully-cooling key", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		expect(filterCoolingKeys(CH, [K1], 2_000)).toEqual([K1]);
	});

	it("re-admits keys whose window expired by the injected now", () => {
		recordKeyRetryableFailure(CH, K1, 1_000);
		expect(filterCoolingKeys(CH, [K1, K2], 1_500)).toEqual([K2]);
		expect(filterCoolingKeys(CH, [K1, K2], 1_000 + KEY_RETRYABLE_COOLDOWN_MS)).toEqual([
			K1,
			K2,
		]);
	});

	it("handles an empty key list", () => {
		expect(filterCoolingKeys(CH, [], 1_000)).toEqual([]);
	});
});

describe("getKeyStatsSnapshot", () => {
	it("reports the full per-key shape", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		recordKeyRetryableFailure(CH, K2, 2_000);
		recordKeySuccess(CH, K2, 3_000);
		const snap = getKeyStatsSnapshot(4_000);
		expect(snap.generatedAt).toBe(4_000);

		const byTag = new Map<string, KeyStatsSnapshotEntry>(
			snap.keys.map((k) => [k.keyTag, k]),
		);
		const k1 = byTag.get(keyFingerprint(K1));
		const k2 = byTag.get(keyFingerprint(K2));
		expect(k1).toMatchObject({
			channelId: CH,
			keyTag: keyFingerprint(K1),
			cooling: true,
			authFails: 1,
			retryableFails: 0,
			successes: 0,
			lastFailureAt: 1_000,
			lastSuccessAt: 0,
		});
		expect(k1?.coolingUntil).toBe(1_000 + KEY_AUTH_COOLDOWN_MS);
		expect(k2).toMatchObject({
			channelId: CH,
			keyTag: keyFingerprint(K2),
			cooling: false,
			authFails: 0,
			retryableFails: 1,
			successes: 1,
			lastFailureAt: 2_000,
			lastSuccessAt: 3_000,
		});
	});

	it("splits channels and matches the stored key_tag value", () => {
		recordKeyAuthFailure("ch-a", K1, 1_000);
		recordKeyAuthFailure("ch-b", K1, 1_000);
		const snap = getKeyStatsSnapshot(2_000);
		expect(snap.keys.filter((k) => k.channelId === "ch-a")).toHaveLength(1);
		expect(snap.keys.filter((k) => k.channelId === "ch-b")).toHaveLength(1);
		// The snapshot keyTag is byte-identical to what usage_logs.key_tag stores.
		expect(snap.keys[0].keyTag).toBe(keyFingerprint(K1));
	});

	it("is empty after reset", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		resetKeyCooldownsForTest();
		expect(getKeyStatsSnapshot(2_000).keys).toHaveLength(0);
		expect(isKeyCoolingDown(CH, K1, 2_000)).toBe(false);
	});
});

describe("growth fuse (KEY_STATE_MAX_ENTRIES sweep)", () => {
	it("sweeps expired entries once the map outgrows the fuse", () => {
		// 10_000 distinct keys stay under the fuse (no sweep fires).
		for (let i = 0; i < 10_000; i++) {
			recordKeyRetryableFailure(CH, `sk-bulk-${i}`, 1_000);
		}
		expect(getKeyStatsSnapshot(1_000).keys).toHaveLength(10_000);
		// Entry 10_001 trips the fuse; everything recorded at t=1_000 has a
		// 60s window, so a record at t=100_000 sweeps them all — only the
		// fresh entry survives.
		recordKeyRetryableFailure(CH, "sk-fresh", 100_000);
		const snap = getKeyStatsSnapshot(100_000);
		expect(snap.keys).toHaveLength(1);
		expect(snap.keys[0].keyTag).toBe(keyFingerprint("sk-fresh"));
	});

	it("keeps actively-cooling entries through a sweep", () => {
		for (let i = 0; i < 10_000; i++) {
			recordKeyRetryableFailure(CH, `sk-bulk-${i}`, 1_000);
		}
		// This one has a 10-minute window from t=1_000 — still cooling at
		// t=100_000, so the sweep must not drop it.
		recordKeyAuthFailure(CH, "sk-long", 1_000);
		expect(getKeyStatsSnapshot(1_000).keys).toHaveLength(10_001);
		recordKeyRetryableFailure(CH, "sk-fresh", 100_000);
		const snap = getKeyStatsSnapshot(100_000);
		const tags = snap.keys.map((k) => k.keyTag);
		expect(snap.keys).toHaveLength(2);
		expect(tags).toContain(keyFingerprint("sk-fresh"));
		expect(tags).toContain(keyFingerprint("sk-long"));
	});
});

describe("lazy expiry keeps counters", () => {
	it("an expired window is clamped but the stats row stays", () => {
		recordKeyAuthFailure(CH, K1, 1_000);
		// Read past the window: not cooling, entry retained for monitoring.
		expect(isKeyCoolingDown(CH, K1, 1_000 + KEY_AUTH_COOLDOWN_MS)).toBe(false);
		const snap = getKeyStatsSnapshot(1_000 + KEY_AUTH_COOLDOWN_MS);
		const entry = snap.keys.find((k) => k.channelId === CH);
		expect(entry?.authFails).toBe(1);
		expect(entry?.cooling).toBe(false);
	});
});
