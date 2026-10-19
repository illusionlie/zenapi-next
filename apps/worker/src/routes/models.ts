import { Hono } from "hono";
import type { AppEnv } from "../env";
import {
	extractModelIds,
	extractModelPricings,
	modelsToJson,
} from "../services/channel-models";
import { listActiveChannels } from "../services/channel-repo";
import { loadAllChannelAliasesGrouped } from "../services/model-aliases";
import {
	loadModelChannelLatency,
	loadModelDailyUsage,
	loadModelUsageTotals,
	splitWindow,
} from "../services/usage-stats";
import { jsonError } from "../utils/http";

const models = new Hono<AppEnv>();

type ChannelInfo = {
	id: string;
	name: string;
	input_price: number | null;
	output_price: number | null;
	avg_latency_ms: number | null;
};

type DailyUsage = { day: string; requests: number; tokens: number };

type ModelResult = {
	id: string;
	real_model_id: string | null;
	channels: ChannelInfo[];
	total_requests: number;
	total_tokens: number;
	total_cost: number;
	avg_latency_ms: number | null;
	daily: DailyUsage[];
};

/**
 * Computes the effective model→channel mapping using per-channel aliases.
 *
 * For each channel C and each model M in C.models_json:
 *   aliases = channel_model_aliases WHERE channel_id=C AND model_id=M
 *   is_alias_only = any alias row has alias_only=1
 *
 *   if NOT is_alias_only:
 *     effectiveMap[M.id] += C    // original name routes to C
 *
 *   for each alias A in aliases:
 *     effectiveMap[A.alias] += C  // alias name routes to C
 */
function computeEffectiveMapping(
	channels: Array<{ id: string; name: string; models_json?: string | null }>,
	aliasGroups: Map<
		string,
		Map<string, { aliases: string[]; alias_only: boolean }>
	>,
	pricingMap: Map<
		string,
		Map<string, { input_price: number | null; output_price: number | null }>
	>,
): Map<
	string,
	{
		realModelId: string | null;
		channels: Map<
			string,
			{
				id: string;
				name: string;
				input_price: number | null;
				output_price: number | null;
			}
		>;
	}
> {
	const effectiveMap = new Map<
		string,
		{
			realModelId: string | null;
			channels: Map<
				string,
				{
					id: string;
					name: string;
					input_price: number | null;
					output_price: number | null;
				}
			>;
		}
	>();

	const getOrCreate = (name: string, realModelId: string | null) => {
		let entry = effectiveMap.get(name);
		if (!entry) {
			entry = { realModelId, channels: new Map() };
			effectiveMap.set(name, entry);
		}
		return entry;
	};

	for (const channel of channels) {
		const modelIds = extractModelIds(channel);
		const channelAliases = aliasGroups.get(channel.id);
		const channelPricing = pricingMap.get(channel.id);

		for (const modelId of modelIds) {
			const aliasInfo = channelAliases?.get(modelId);
			const isAliasOnly = aliasInfo?.alias_only ?? false;
			const pricing = channelPricing?.get(modelId);
			const chInfo = {
				id: channel.id,
				name: channel.name,
				input_price: pricing?.input_price ?? null,
				output_price: pricing?.output_price ?? null,
			};

			// Original name routes to this channel (unless alias_only)
			if (!isAliasOnly) {
				const entry = getOrCreate(modelId, null);
				entry.channels.set(channel.id, chInfo);
			}

			// Each alias routes to this channel
			if (aliasInfo) {
				for (const alias of aliasInfo.aliases) {
					const entry = getOrCreate(alias, modelId);
					entry.channels.set(channel.id, chInfo);
				}
			}
		}
	}

	return effectiveMap;
}

/**
 * Returns aggregated models with pricing, latency, and usage stats.
 */
models.get("/", async (c) => {
	const channels = await listActiveChannels(c.env.DB);

	// Build per-channel pricing maps
	const pricingMap = new Map<
		string,
		Map<string, { input_price: number | null; output_price: number | null }>
	>();
	for (const channel of channels) {
		const pricings = extractModelPricings(channel);
		const modelPriceMap = new Map<
			string,
			{ input_price: number | null; output_price: number | null }
		>();
		for (const p of pricings) {
			modelPriceMap.set(p.id, {
				input_price: p.input_price ?? null,
				output_price: p.output_price ?? null,
			});
		}
		pricingMap.set(channel.id, modelPriceMap);
	}

	// Load alias data
	const aliasGroups = await loadAllChannelAliasesGrouped(c.env.DB);

	// Compute effective mapping
	const effectiveMap = computeEffectiveMapping(
		channels,
		aliasGroups,
		pricingMap,
	);

	// Aggregate usage stats: complete past days from usage_stats_daily (30d
	// rollup + 7d rollup for the daily series), today's raw rows merged on top.
	const now = new Date();
	const DAY_MS = 86_400_000;
	const usageSplit = splitWindow(
		new Date(now.getTime() - 30 * DAY_MS).toISOString(),
		null,
		now,
	);
	const dailySplit = splitWindow(
		new Date(now.getTime() - 7 * DAY_MS).toISOString(),
		null,
		now,
	);

	const usageRows = await loadModelUsageTotals(c.env.DB, usageSplit);
	const usageMap = new Map<
		string,
		{
			total_requests: number;
			total_tokens: number;
			total_cost: number;
			avg_latency_ms: number | null;
		}
	>();
	for (const row of usageRows) {
		const avg =
			row.total_requests > 0 ? row.latency_sum / row.total_requests : 0;
		usageMap.set(row.model, {
			total_requests: row.total_requests,
			total_tokens: row.total_tokens,
			total_cost: row.total_cost,
			avg_latency_ms: avg > 0 ? avg : null,
		});
	}

	const dailyRows = await loadModelDailyUsage(c.env.DB, dailySplit);
	const dailyMap = new Map<string, DailyUsage[]>();
	for (const row of dailyRows) {
		const existing = dailyMap.get(row.model) ?? [];
		existing.push({
			day: row.day,
			requests: row.requests,
			tokens: row.tokens,
		});
		dailyMap.set(row.model, existing);
	}

	const latencyRows = await loadModelChannelLatency(c.env.DB, usageSplit);
	const channelLatencyMap = new Map<string, number>();
	for (const row of latencyRows) {
		channelLatencyMap.set(
			`${row.model}:${row.channel_id}`,
			row.requests > 0 ? row.latency_sum / row.requests : 0,
		);
	}

	// Build result from effective mapping
	const results: ModelResult[] = [];
	for (const [callableName, entry] of effectiveMap) {
		// Usage: look up by callable name first, then by real model id
		const usageKey = entry.realModelId ?? callableName;
		const usage = usageMap.get(callableName) ?? usageMap.get(usageKey);

		// Enrich channels with per-channel latency
		const enrichedChannels: ChannelInfo[] = [];
		for (const [, ch] of entry.channels) {
			const latencyKey = `${usageKey}:${ch.id}`;
			enrichedChannels.push({
				...ch,
				avg_latency_ms:
					channelLatencyMap.get(latencyKey) != null
						? Math.round(channelLatencyMap.get(latencyKey)!)
						: null,
			});
		}

		results.push({
			id: callableName,
			real_model_id: entry.realModelId,
			channels: enrichedChannels,
			total_requests: usage?.total_requests ?? 0,
			total_tokens: usage?.total_tokens ?? 0,
			total_cost: usage?.total_cost ?? 0,
			avg_latency_ms: usage?.avg_latency_ms
				? Math.round(usage.avg_latency_ms)
				: null,
			daily: dailyMap.get(callableName) ?? dailyMap.get(usageKey) ?? [],
		});
	}

	return c.json({ models: results });
});

/**
 * Batch-update prices for a single model across multiple channels.
 */
models.put("/prices/:modelId", async (c) => {
	const modelId = c.req.param("modelId");
	const body = await c.req.json().catch(() => null);
	if (!body || !Array.isArray(body.prices)) {
		return jsonError(c, 400, "body must contain prices array", "invalid_body");
	}

	const db = c.env.DB;
	const stmts: ReturnType<typeof db.prepare>[] = [];
	const now = new Date().toISOString();

	for (const item of body.prices) {
		if (!item.channel_id || typeof item.channel_id !== "string") {
			return jsonError(
				c,
				400,
				"each price entry must have a channel_id",
				"invalid_body",
			);
		}

		const row = await db
			.prepare("SELECT models_json FROM channels WHERE id = ?")
			.bind(item.channel_id)
			.first<{ models_json: string | null }>();

		if (!row) {
			return jsonError(
				c,
				404,
				`channel ${item.channel_id} not found`,
				"not_found",
			);
		}

		const pricings = extractModelPricings({ models_json: row.models_json });
		const entry = pricings.find((p) => p.id === modelId);
		if (!entry) {
			return jsonError(
				c,
				404,
				`model ${modelId} not found in channel ${item.channel_id}`,
				"not_found",
			);
		}

		entry.input_price =
			item.input_price != null ? Number(item.input_price) : entry.input_price;
		entry.output_price =
			item.output_price != null
				? Number(item.output_price)
				: entry.output_price;

		const updatedJson = modelsToJson(pricings);
		stmts.push(
			db
				.prepare(
					"UPDATE channels SET models_json = ?, updated_at = ? WHERE id = ?",
				)
				.bind(updatedJson, now, item.channel_id),
		);
	}

	if (stmts.length > 0) {
		await db.batch(stmts);
	}

	return c.json({ ok: true });
});

export default models;
