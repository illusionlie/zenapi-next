import { beforeEach, describe, expect, it } from "vitest";
import {
	COOLDOWN_DURATION_MS,
	COOLDOWN_FAILURE_THRESHOLD,
	filterCoolingChannels,
	isChannelCoolingDown,
	recordChannelFailure,
	recordChannelSuccess,
	resetChannelCooldownsForTest,
} from "../apps/worker/src/services/channel-cooldown";

/**
 * Channel cooldown state machine (P2 design.md §渠道冷却器). All time is
 * injected via the `now` parameter — no fake timers, no real-clock依赖.
 */

beforeEach(() => {
	resetChannelCooldownsForTest();
});

describe("cooldown state machine", () => {
	it("exposes the design constants (3 failures / 60s)", () => {
		expect(COOLDOWN_FAILURE_THRESHOLD).toBe(3);
		expect(COOLDOWN_DURATION_MS).toBe(60_000);
	});

	it("does not cool down below the failure threshold", () => {
		recordChannelFailure("ch1", 1_000);
		recordChannelFailure("ch1", 2_000);
		expect(isChannelCoolingDown("ch1", 2_000)).toBe(false);
		expect(isChannelCoolingDown("ch1", 999_999)).toBe(false);
	});

	it("cools down at the threshold and expires after the window (injected now)", () => {
		recordChannelFailure("ch1", 1_000);
		recordChannelFailure("ch1", 2_000);
		recordChannelFailure("ch1", 3_000);
		expect(isChannelCoolingDown("ch1", 3_000)).toBe(true);
		expect(isChannelCoolingDown("ch1", 3_000 + COOLDOWN_DURATION_MS - 1)).toBe(
			true,
		);
		// at exactly cooldownUntil the channel is back
		expect(isChannelCoolingDown("ch1", 3_000 + COOLDOWN_DURATION_MS)).toBe(
			false,
		);
	});

	it("lazily drops expired entries on read", () => {
		recordChannelFailure("ch1", 1_000);
		recordChannelFailure("ch1", 2_000);
		recordChannelFailure("ch1", 3_000);
		expect(isChannelCoolingDown("ch1", 3_000 + COOLDOWN_DURATION_MS + 1)).toBe(
			false,
		);
		// expired state is gone, not merely stale
		expect(isChannelCoolingDown("ch1", 3_000 + COOLDOWN_DURATION_MS + 1)).toBe(
			false,
		);
	});

	it("below-threshold failure counts survive filter reads across requests", () => {
		// Regression (P2 check): the lazy-expiry delete must never wipe
		// accumulating below-threshold streaks — filterCoolingChannels runs on
		// every request, so a read that deletes cooldownUntil === 0 state resets
		// the count each request and cooldown can never trigger. Simulates the
		// wired sequence with one persistently-5xx channel (chA; chB stays
		// healthy so fail-open never masks the result): filter candidates
		// first, then record 1 failure per request at the abandonment point.
		for (const t of [1_000, 2_000, 3_000]) {
			expect(filterCoolingChannels(["chA", "chB"], t)).toEqual([
				"chA",
				"chB",
			]);
			recordChannelFailure("chA", t);
		}
		// The third failure reaches the threshold — the channel leaves the pool.
		expect(filterCoolingChannels(["chA", "chB"], 3_500)).toEqual(["chB"]);
		expect(isChannelCoolingDown("chA", 3_500)).toBe(true);
		// Once the 60s window passes the channel is readmitted (fresh streak).
		expect(filterCoolingChannels(["chA", "chB"], 63_500)).toEqual([
			"chA",
			"chB",
		]);
	});

	it("any success clears the failure streak immediately", () => {
		recordChannelFailure("ch1", 1_000);
		recordChannelFailure("ch1", 2_000);
		recordChannelSuccess("ch1");
		recordChannelFailure("ch1", 3_000);
		recordChannelFailure("ch1", 4_000);
		expect(isChannelCoolingDown("ch1", 4_000)).toBe(false);
	});

	it("a success clears an active cooldown without waiting out the window", () => {
		for (const t of [1_000, 2_000, 3_000]) {
			recordChannelFailure("ch1", t);
		}
		expect(isChannelCoolingDown("ch1", 3_001)).toBe(true);
		recordChannelSuccess("ch1");
		expect(isChannelCoolingDown("ch1", 3_002)).toBe(false);
	});

	it("tracks channels independently", () => {
		recordChannelFailure("chA", 1_000);
		recordChannelFailure("chA", 2_000);
		recordChannelFailure("chA", 3_000);
		expect(isChannelCoolingDown("chA", 3_000)).toBe(true);
		expect(isChannelCoolingDown("chB", 3_000)).toBe(false);
	});

	it("a failure past the threshold refreshes the window (fail-open retry failed again)", () => {
		recordChannelFailure("ch1", 1_000);
		recordChannelFailure("ch1", 2_000);
		recordChannelFailure("ch1", 3_000);
		expect(isChannelCoolingDown("ch1", 3_000 + COOLDOWN_DURATION_MS - 1)).toBe(
			true,
		);
		// cooling channel retried via fail-open at t=10s and failed again
		recordChannelFailure("ch1", 10_000);
		expect(isChannelCoolingDown("ch1", 10_000 + COOLDOWN_DURATION_MS - 1)).toBe(
			true,
		);
		expect(isChannelCoolingDown("ch1", 3_000 + COOLDOWN_DURATION_MS)).toBe(
			true,
		);
	});

	it("defaults now to the real clock when not injected", () => {
		recordChannelFailure("ch-now");
		recordChannelFailure("ch-now");
		recordChannelFailure("ch-now");
		expect(isChannelCoolingDown("ch-now")).toBe(true);
		expect(isChannelCoolingDown("ch-other")).toBe(false);
	});
});

describe("filterCoolingChannels", () => {
	it("returns the pool untouched when nothing is cooling", () => {
		recordChannelFailure("ch1", 1_000);
		recordChannelFailure("ch1", 2_000); // below threshold
		expect(filterCoolingChannels(["ch1", "ch2", "ch3"], 2_000)).toEqual([
			"ch1",
			"ch2",
			"ch3",
		]);
	});

	it("drops only the cooling channels, preserving order", () => {
		for (const t of [1_000, 2_000, 3_000]) {
			recordChannelFailure("ch2", t);
		}
		expect(filterCoolingChannels(["ch1", "ch2", "ch3"], 3_500)).toEqual([
			"ch1",
			"ch3",
		]);
	});

	it("fail-open: returns the full pool when every candidate is cooling", () => {
		for (const id of ["ch1", "ch2"]) {
			for (const t of [1_000, 2_000, 3_000]) {
				recordChannelFailure(id, t);
			}
		}
		expect(filterCoolingChannels(["ch1", "ch2"], 3_500)).toEqual([
			"ch1",
			"ch2",
		]);
	});

	it("fail-open also applies to a single fully-cooling candidate", () => {
		for (const t of [1_000, 2_000, 3_000]) {
			recordChannelFailure("ch1", t);
		}
		expect(filterCoolingChannels(["ch1"], 3_500)).toEqual(["ch1"]);
	});

	it("re-admits channels whose window expired by the injected now", () => {
		for (const t of [1_000, 2_000, 3_000]) {
			recordChannelFailure("ch1", t);
		}
		expect(filterCoolingChannels(["ch1", "ch2"], 3_000)).toEqual(["ch2"]);
		expect(filterCoolingChannels(["ch1", "ch2"], 3_000 + COOLDOWN_DURATION_MS)).toEqual([
			"ch1",
			"ch2",
		]);
	});
});
