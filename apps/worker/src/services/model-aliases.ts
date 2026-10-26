import type { D1Database } from "@cloudflare/workers-types";
import { ALIAS_CACHE_TTL_MS, getTtlCache, type TtlCache } from "../utils/cache";
import { nowIso } from "../utils/time";

type AliasRow = {
	id: string;
	model_id: string;
	alias: string;
	is_primary: number;
	alias_only: number;
	created_at: string;
	updated_at: string;
};

export type AliasInput = {
	alias: string;
};

/**
 * Returns ALL real model IDs that a given name can route to.
 *
 * Example: user requests "claude-opus-4.6"
 *  - "claude-opus-4.6" itself is always included (may be a real model on some channel)
 *  - If "claude-opus-4.6" is an alias for "claude-opus-4-6", that is also included
 *
 * The result is deduplicated.
 */
export async function resolveModelNames(
	db: D1Database,
	name: string,
): Promise<string[]> {
	const names = [name];
	const row = await db
		.prepare("SELECT model_id FROM model_aliases WHERE alias = ?")
		.bind(name)
		.first<{ model_id: string }>();
	if (row && row.model_id !== name) {
		names.push(row.model_id);
	}
	return names;
}

/**
 * Returns a map of model_id → primary alias name (display name).
 */
export async function loadPrimaryNameMap(
	db: D1Database,
): Promise<Map<string, string>> {
	const result = await db
		.prepare("SELECT model_id, alias FROM model_aliases WHERE is_primary = 1")
		.all<{ model_id: string; alias: string }>();
	const map = new Map<string, string>();
	for (const row of result.results ?? []) {
		map.set(row.model_id, row.alias);
	}
	return map;
}

/**
 * Returns a map of alias → model_id for all aliases.
 */
export async function loadAliasMap(
	db: D1Database,
): Promise<Map<string, string>> {
	const result = await db
		.prepare("SELECT alias, model_id FROM model_aliases")
		.all<{ alias: string; model_id: string }>();
	const map = new Map<string, string>();
	for (const row of result.results ?? []) {
		map.set(row.alias, row.model_id);
	}
	return map;
}

/**
 * Returns the set of model_ids that are alias-only (original name hidden).
 */
export async function loadAliasOnlySet(db: D1Database): Promise<Set<string>> {
	const result = await db
		.prepare("SELECT DISTINCT model_id FROM model_aliases WHERE alias_only = 1")
		.all<{ model_id: string }>();
	return new Set((result.results ?? []).map((r) => r.model_id));
}

/**
 * Returns all aliases grouped by model_id.
 */
export async function listAllAliases(
	db: D1Database,
): Promise<
	Map<
		string,
		Array<{ alias: string; is_primary: boolean; alias_only: boolean }>
	>
> {
	const result = await db
		.prepare(
			"SELECT model_id, alias, is_primary, alias_only FROM model_aliases ORDER BY model_id, is_primary DESC, alias",
		)
		.all<AliasRow>();
	const map = new Map<
		string,
		Array<{ alias: string; is_primary: boolean; alias_only: boolean }>
	>();
	for (const row of result.results ?? []) {
		const existing = map.get(row.model_id) ?? [];
		existing.push({
			alias: row.alias,
			is_primary: row.is_primary === 1,
			alias_only: row.alias_only === 1,
		});
		map.set(row.model_id, existing);
	}
	return map;
}

/**
 * Returns all aliases for a specific model.
 */
export async function getAliasesForModel(
	db: D1Database,
	modelId: string,
): Promise<Array<{ alias: string; is_primary: boolean; alias_only: boolean }>> {
	const result = await db
		.prepare(
			"SELECT alias, is_primary, alias_only FROM model_aliases WHERE model_id = ? ORDER BY is_primary DESC, alias",
		)
		.bind(modelId)
		.all<{ alias: string; is_primary: number; alias_only: number }>();
	return (result.results ?? []).map((row) => ({
		alias: row.alias,
		is_primary: row.is_primary === 1,
		alias_only: row.alias_only === 1,
	}));
}

/**
 * Replaces all aliases for a model with the given list.
 * Uses batch delete + insert for atomicity.
 */
export async function saveAliasesForModel(
	db: D1Database,
	modelId: string,
	aliases: AliasInput[],
	aliasOnly = false,
): Promise<void> {
	const now = nowIso();
	const deleteStmt = db
		.prepare("DELETE FROM model_aliases WHERE model_id = ?")
		.bind(modelId);

	const insertStmts = aliases.map((a) =>
		db
			.prepare(
				"INSERT INTO model_aliases (id, model_id, alias, is_primary, alias_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				modelId,
				a.alias,
				0,
				aliasOnly ? 1 : 0,
				now,
				now,
			),
	);

	await db.batch([deleteStmt, ...insertStmts]);
}

/**
 * Deletes all aliases for a model.
 */
export async function deleteAliasesForModel(
	db: D1Database,
	modelId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM model_aliases WHERE model_id = ?")
		.bind(modelId)
		.run();
}

// ---------------------------------------------------------------------------
// Per-channel alias functions (channel_model_aliases table)
// ---------------------------------------------------------------------------

/**
 * Replaces all per-channel aliases for a specific channel + model pair.
 * Uses batch delete + insert for atomicity.
 */
export async function saveChannelAliases(
	db: D1Database,
	channelId: string,
	modelId: string,
	aliases: AliasInput[],
	aliasOnly = false,
): Promise<void> {
	const now = nowIso();
	const deleteStmt = db
		.prepare(
			"DELETE FROM channel_model_aliases WHERE channel_id = ? AND model_id = ?",
		)
		.bind(channelId, modelId);

	const insertStmts = aliases.map((a) =>
		db
			.prepare(
				"INSERT INTO channel_model_aliases (id, channel_id, model_id, alias, is_primary, alias_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				channelId,
				modelId,
				a.alias,
				0,
				aliasOnly ? 1 : 0,
				now,
				now,
			),
	);

	await db.batch([deleteStmt, ...insertStmts]);
}

/**
 * Returns per-channel alias hits for a given alias name.
 * Used by the proxy to find channels that have a per-channel alias for a model.
 * Memoized ALIAS_CACHE_TTL_MS per db binding (documented staleness bound,
 * AGENTS §8) — the only consumers are the two proxy hot paths, which treat
 * the returned array as read-only. `max` caps per-alias key growth: alias
 * keys come from request model names, so the coarse clear-all cap keeps a
 * hostile key space from bloating the isolate.
 */
export type ChannelAliasHit = {
	channel_id: string;
	model_id: string;
	alias_only: boolean;
};

const channelAliasHitsCaches = new WeakMap<
	D1Database,
	TtlCache<ChannelAliasHit[]>
>();

export async function loadChannelAliasesByAlias(
	db: D1Database,
	alias: string,
): Promise<ChannelAliasHit[]> {
	const cache = getTtlCache(channelAliasHitsCaches, db, ALIAS_CACHE_TTL_MS, {
		max: 500,
	});
	const hit = cache.get(alias);
	if (hit !== undefined) {
		return hit;
	}
	const result = await db
		.prepare(
			"SELECT channel_id, model_id, alias_only FROM channel_model_aliases WHERE alias = ?",
		)
		.bind(alias)
		.all<{ channel_id: string; model_id: string; alias_only: number }>();
	const hits: ChannelAliasHit[] = (result.results ?? []).map((r) => ({
		channel_id: r.channel_id,
		model_id: r.model_id,
		alias_only: r.alias_only === 1,
	}));
	cache.set(alias, hits);
	return hits;
}

/**
 * Returns a map of alias → Array<{channel_id, model_id}> across all channels.
 * Preserves channel info so model list endpoints can map aliases to their actual channels.
 */
export async function loadAllChannelAliasMap(
	db: D1Database,
): Promise<Map<string, Array<{ channel_id: string; model_id: string }>>> {
	const result = await db
		.prepare("SELECT alias, model_id, channel_id FROM channel_model_aliases")
		.all<{ alias: string; model_id: string; channel_id: string }>();
	const map = new Map<
		string,
		Array<{ channel_id: string; model_id: string }>
	>();
	for (const row of result.results ?? []) {
		const existing = map.get(row.alias) ?? [];
		existing.push({ channel_id: row.channel_id, model_id: row.model_id });
		map.set(row.alias, existing);
	}
	return map;
}

/**
 * Returns a map of model_id → primary alias name from per-channel aliases.
 * If multiple channels set different primaries for the same model, takes the first.
 * Used by model list endpoints to determine display names.
 */
export async function loadChannelPrimaryNameMap(
	db: D1Database,
): Promise<Map<string, string>> {
	const result = await db
		.prepare(
			"SELECT model_id, alias FROM channel_model_aliases WHERE is_primary = 1",
		)
		.all<{ model_id: string; alias: string }>();
	const map = new Map<string, string>();
	for (const row of result.results ?? []) {
		if (!map.has(row.model_id)) {
			map.set(row.model_id, row.alias);
		}
	}
	return map;
}

/**
 * Returns a map of channelId → Set<modelId> for models with alias_only=1.
 * Used by the proxy to check per-channel alias_only status.
 * Memoized ALIAS_CACHE_TTL_MS per db binding (documented staleness bound,
 * AGENTS §8) — the only consumers are the two proxy hot paths, which treat
 * the returned map as read-only.
 */
const aliasOnlyMapCaches = new WeakMap<
	D1Database,
	TtlCache<Map<string, Set<string>>>
>();

const ALIAS_ONLY_MAP_CACHE_KEY = "all";

export async function loadChannelAliasOnlyMap(
	db: D1Database,
): Promise<Map<string, Set<string>>> {
	const cache = getTtlCache(aliasOnlyMapCaches, db, ALIAS_CACHE_TTL_MS);
	const hit = cache.get(ALIAS_ONLY_MAP_CACHE_KEY);
	if (hit !== undefined) {
		return hit;
	}
	const result = await db
		.prepare(
			"SELECT DISTINCT channel_id, model_id FROM channel_model_aliases WHERE alias_only = 1",
		)
		.all<{ channel_id: string; model_id: string }>();
	const map = new Map<string, Set<string>>();
	for (const row of result.results ?? []) {
		const existing = map.get(row.channel_id) ?? new Set<string>();
		existing.add(row.model_id);
		map.set(row.channel_id, existing);
	}
	cache.set(ALIAS_ONLY_MAP_CACHE_KEY, map);
	return map;
}

/**
 * Returns all per-channel aliases grouped by channelId → modelId → { aliases, alias_only }.
 * Single query, used by model list endpoints for the effective mapping computation.
 */
export async function loadAllChannelAliasesGrouped(
	db: D1Database,
): Promise<
	Map<string, Map<string, { aliases: string[]; alias_only: boolean }>>
> {
	const result = await db
		.prepare(
			"SELECT channel_id, model_id, alias, alias_only FROM channel_model_aliases",
		)
		.all<{
			channel_id: string;
			model_id: string;
			alias: string;
			alias_only: number;
		}>();
	const map = new Map<
		string,
		Map<string, { aliases: string[]; alias_only: boolean }>
	>();
	for (const row of result.results ?? []) {
		let channelMap = map.get(row.channel_id);
		if (!channelMap) {
			channelMap = new Map();
			map.set(row.channel_id, channelMap);
		}
		let entry = channelMap.get(row.model_id);
		if (!entry) {
			entry = { aliases: [], alias_only: false };
			channelMap.set(row.model_id, entry);
		}
		entry.aliases.push(row.alias);
		if (row.alias_only === 1) {
			entry.alias_only = true;
		}
	}
	return map;
}

/**
 * Batch saves aliases for a model across all channels that have it in their models_json.
 * Used by the Models View batch editor.
 */
export async function batchSaveAliasesForModel(
	db: D1Database,
	modelId: string,
	aliases: string[],
	aliasOnly: boolean,
	channelIds: string[],
): Promise<void> {
	const now = nowIso();
	const stmts: ReturnType<typeof db.prepare>[] = [];

	for (const channelId of channelIds) {
		stmts.push(
			db
				.prepare(
					"DELETE FROM channel_model_aliases WHERE channel_id = ? AND model_id = ?",
				)
				.bind(channelId, modelId),
		);
		for (const alias of aliases) {
			stmts.push(
				db
					.prepare(
						"INSERT INTO channel_model_aliases (id, channel_id, model_id, alias, is_primary, alias_only, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.bind(
						crypto.randomUUID(),
						channelId,
						modelId,
						alias,
						0,
						aliasOnly ? 1 : 0,
						now,
						now,
					),
			);
		}
	}

	if (stmts.length > 0) {
		await db.batch(stmts);
	}
}
