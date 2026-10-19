/**
 * Minimal isolate-memory TTL cache for low-churn hot-path data (active
 * channels, alias maps, proxy settings). Zero dependencies, no background
 * sweep: expired entries are dropped lazily on read.
 */

/** Active channel rows (services/channels.ts getActiveChannelsCached). */
export const CHANNEL_CACHE_TTL_MS = 10_000;
/** Per-channel alias resolution + alias-only map (services/model-aliases.ts). */
export const ALIAS_CACHE_TTL_MS = 10_000;
/** Proxy runtime settings snapshot (services/settings.ts loadProxySettingsCached). */
export const PROXY_SETTINGS_CACHE_TTL_MS = 30_000;

export type TtlCache<T> = {
	get(key: string): T | undefined;
	set(key: string, value: T): void;
	clear(): void;
};

/**
 * Creates a TTL cache. `opts.max` is a coarse anti-bloat cap: when exceeded,
 * the whole table is cleared before the new entry lands (simple beats LRU —
 * value domains here are bounded by channel/alias counts, so the cap is a
 * defensive floor, not a tuned limit).
 */
export function createTtlCache<T>(
	ttlMs: number,
	opts?: { max?: number },
): TtlCache<T> {
	const store = new Map<string, { value: T; expiresAt: number }>();
	return {
		get(key: string): T | undefined {
			const entry = store.get(key);
			if (!entry) {
				return undefined;
			}
			if (Date.now() >= entry.expiresAt) {
				store.delete(key);
				return undefined;
			}
			return entry.value;
		},
		set(key: string, value: T): void {
			const max = opts?.max;
			if (
				max !== undefined &&
				max > 0 &&
				store.size >= max &&
				!store.has(key)
			) {
				store.clear();
			}
			store.set(key, { value, expiresAt: Date.now() + ttlMs });
		},
		clear(): void {
			store.clear();
		},
	};
}

/**
 * Returns the per-holder cache from `registry`, creating it on first use.
 * Production holders are long-lived binding objects (one D1Database per
 * isolate), so entries persist across requests; tests get isolation for free
 * by passing distinct mock holders.
 */
export function getTtlCache<K extends object, T>(
	registry: WeakMap<K, TtlCache<T>>,
	holder: K,
	ttlMs: number,
	opts?: { max?: number },
): TtlCache<T> {
	let cache = registry.get(holder);
	if (!cache) {
		cache = createTtlCache<T>(ttlMs, opts);
		registry.set(holder, cache);
	}
	return cache;
}
