import type { D1Database } from "@cloudflare/workers-types";
import {
	CHANNEL_CACHE_TTL_MS,
	getTtlCache,
	type TtlCache,
} from "../utils/cache";
import { extractModels } from "./channel-models";
import type { ChannelRecord } from "./channel-types";

export type { ModelEntry } from "./channel-models";
export type { ChannelRecord } from "./channel-types";
export { extractModels };

const ACTIVE_CHANNELS_CACHE_KEY = "active";

/** Per-db cache registry (one D1Database binding object per isolate). */
const activeChannelsCaches = new WeakMap<
	D1Database,
	TtlCache<ChannelRecord[]>
>();

/**
 * Active channel rows for the proxy hot path, memoized CHANNEL_CACHE_TTL_MS
 * per db binding (management CRUD changes become visible within that window —
 * documented staleness bound, AGENTS §8). Rows are shared across requests and
 * must stay read-only downstream: routing copies each channel with
 * `{ ...ch, api_format: target }` before overriding, weight normalization
 * happens on a copy in createWeightedOrder.
 */
export async function getActiveChannelsCached(
	db: D1Database,
): Promise<ChannelRecord[]> {
	const cache = getTtlCache(activeChannelsCaches, db, CHANNEL_CACHE_TTL_MS);
	const hit = cache.get(ACTIVE_CHANNELS_CACHE_KEY);
	if (hit !== undefined) {
		return hit;
	}
	const result = await db
		.prepare("SELECT * FROM channels WHERE status = ?")
		.bind("active")
		.all();
	const channels = (result.results ?? []) as ChannelRecord[];
	cache.set(ACTIVE_CHANNELS_CACHE_KEY, channels);
	return channels;
}

/**
 * Returns channels in a weighted random order.
 */
export function createWeightedOrder(
	channels: ChannelRecord[],
): ChannelRecord[] {
	const pool = channels.map((channel) => ({
		...channel,
		weight: Math.max(0, Number(channel.weight) || 0),
	}));
	const ordered: ChannelRecord[] = [];
	while (pool.length > 0) {
		const total = pool.reduce((sum, channel) => sum + channel.weight, 0);
		let roll = Math.random() * total;
		const index = pool.findIndex((channel) => {
			roll -= channel.weight;
			return roll <= 0;
		});
		const [selected] = pool.splice(index < 0 ? 0 : index, 1);
		ordered.push(selected);
	}
	return ordered;
}
