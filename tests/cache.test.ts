import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ALIAS_CACHE_TTL_MS,
	CHANNEL_CACHE_TTL_MS,
	PROXY_SETTINGS_CACHE_TTL_MS,
	createTtlCache,
	getTtlCache,
	type TtlCache,
} from "../apps/worker/src/utils/cache";

afterEach(() => {
	vi.useRealTimers();
});

describe("createTtlCache", () => {
	it("returns set values on hit and undefined on miss", () => {
		const cache = createTtlCache<string>(10_000);
		expect(cache.get("missing")).toBeUndefined();
		cache.set("k", "v");
		expect(cache.get("k")).toBe("v");
	});

	it("serves hits before the TTL and lazily drops the entry at expiry", () => {
		vi.useFakeTimers();
		const cache = createTtlCache<string>(10_000);
		cache.set("k", "v");

		vi.advanceTimersByTime(9_999);
		expect(cache.get("k")).toBe("v");

		// Boundary: Date.now() >= expiresAt counts as expired (10s TTL).
		vi.advanceTimersByTime(1);
		expect(cache.get("k")).toBeUndefined();
		expect(cache.get("k")).toBeUndefined(); // stays gone (lazy delete)

		// A fresh set after expiry is readable again.
		cache.set("k", "v2");
		expect(cache.get("k")).toBe("v2");
	});

	it("clear() empties every entry", () => {
		const cache = createTtlCache<number>(10_000);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.clear();
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBeUndefined();
	});

	it("max cap clears the whole table when a new key exceeds it", () => {
		const cache = createTtlCache<number>(10_000, { max: 2 });
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("c")).toBe(3);
	});

	it("max cap does not evict when re-setting an existing key", () => {
		const cache = createTtlCache<number>(10_000, { max: 2 });
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("a", 10);
		expect(cache.get("a")).toBe(10);
		expect(cache.get("b")).toBe(2);
	});

	it("TTL constants match the documented staleness bounds", () => {
		expect(CHANNEL_CACHE_TTL_MS).toBe(10_000);
		expect(ALIAS_CACHE_TTL_MS).toBe(10_000);
		expect(PROXY_SETTINGS_CACHE_TTL_MS).toBe(30_000);
	});
});

describe("getTtlCache", () => {
	it("returns the same cache per holder and independent caches across holders", () => {
		const registry = new WeakMap<object, TtlCache<string>>();
		const holderA = { label: "a" };
		const holderB = { label: "b" };

		const a1 = getTtlCache(registry, holderA, 10_000);
		const a2 = getTtlCache(registry, holderA, 10_000);
		const b1 = getTtlCache(registry, holderB, 10_000);

		expect(a1).toBe(a2);
		expect(b1).not.toBe(a1);

		// Holder-scoped isolation: distinct db bindings never share state.
		a1.set("k", "va");
		b1.set("k", "vb");
		expect(a1.get("k")).toBe("va");
		expect(b1.get("k")).toBe("vb");
	});
});
