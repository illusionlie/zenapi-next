import { safeJsonParse } from "../utils/json";
import type { ChannelRow } from "./channel-types";

export type ModelPricing = {
	id: string;
	input_price?: number; // per million tokens, USD
	output_price?: number; // per million tokens, USD
	/** 缓存读绝对价覆盖（USD/1M）；缺省回落全局 cache_read_ratio */
	cache_read_price?: number;
	/** 缓存写绝对价覆盖（USD/1M）；缺省回落全局 cache_write_ratio */
	cache_write_price?: number;
	enabled?: boolean; // undefined/true = enabled, false = disabled
};

export type ModelEntry = {
	id: string;
	label: string;
	channelId: string;
	channelName: string;
	inputPrice?: number;
	outputPrice?: number;
};

type ModelLike = {
	id?: unknown;
	input_price?: unknown;
	output_price?: unknown;
	cache_read_price?: unknown;
	cache_write_price?: unknown;
	enabled?: unknown;
};

function toModelId(item: unknown): string {
	if (item && typeof item === "object" && "id" in item) {
		const value = (item as ModelLike).id;
		return value === undefined || value === null ? "" : String(value);
	}
	if (item === undefined || item === null) {
		return "";
	}
	return String(item);
}

export function normalizeModelsInput(input: unknown): string[] {
	if (!input) {
		return [];
	}
	if (Array.isArray(input)) {
		return input
			.map((item) => toModelId(item))
			.filter((item) => item.length > 0);
	}
	if (typeof input === "string") {
		return input
			.split(",")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
	}
	if (typeof input === "object") {
		const raw = input as { data?: unknown[] };
		if (Array.isArray(raw.data)) {
			return raw.data
				.map((item) => toModelId(item))
				.filter((item) => item.length > 0);
		}
	}
	return [];
}

export function modelsToJson(models: string[] | ModelPricing[]): string {
	if (models.length === 0) return "[]";
	if (typeof models[0] === "string") {
		const normalized = (models as string[])
			.map((model) => String(model).trim())
			.filter((model) => model.length > 0);
		return JSON.stringify(normalized.map((id) => ({ id })));
	}
	return JSON.stringify(
		(models as ModelPricing[]).map((m) => {
			const entry: ModelPricing = { id: m.id };
			if (m.input_price != null) entry.input_price = m.input_price;
			if (m.output_price != null) entry.output_price = m.output_price;
			if (m.cache_read_price != null) {
				entry.cache_read_price = m.cache_read_price;
			}
			if (m.cache_write_price != null) {
				entry.cache_write_price = m.cache_write_price;
			}
			if (m.enabled != null) entry.enabled = m.enabled;
			return entry;
		}),
	);
}

export function extractModelIds(
	channel: Pick<ChannelRow, "models_json">,
): string[] {
	return extractModelPricings(channel)
		.filter((m) => m.enabled !== false)
		.map((m) => m.id);
}

export function extractModels(
	channel: Pick<ChannelRow, "id" | "name" | "models_json">,
): ModelEntry[] {
	const pricings = extractModelPricings(channel).filter(
		(p) => p.enabled !== false,
	);
	return pricings.map((p) => ({
		id: p.id,
		label: p.id,
		channelId: channel.id,
		channelName: channel.name,
		inputPrice: p.input_price,
		outputPrice: p.output_price,
	}));
}

export function extractModelPricings(
	channel: Pick<ChannelRow, "models_json">,
): ModelPricing[] {
	const raw = safeJsonParse<ModelLike[] | { data?: ModelLike[] } | null>(
		channel.models_json,
		null,
	);
	const models = Array.isArray(raw)
		? raw
		: Array.isArray(raw?.data)
			? raw.data
			: [];
	return models
		.map((model) => {
			const id = toModelId(model);
			if (!id) return null;
			const entry: ModelPricing = { id };
			if (model && typeof model === "object") {
				const ip = (model as ModelLike).input_price;
				const op = (model as ModelLike).output_price;
				const crp = (model as ModelLike).cache_read_price;
				const cwp = (model as ModelLike).cache_write_price;
				const en = (model as ModelLike).enabled;
				if (ip != null && Number(ip) > 0) entry.input_price = Number(ip);
				if (op != null && Number(op) > 0) entry.output_price = Number(op);
				if (crp != null && Number(crp) > 0) {
					entry.cache_read_price = Number(crp);
				}
				if (cwp != null && Number(cwp) > 0) {
					entry.cache_write_price = Number(cwp);
				}
				if (en != null) entry.enabled = Boolean(en);
			}
			return entry;
		})
		.filter((m): m is ModelPricing => m !== null);
}

export function collectUniqueModelIds(
	channels: Array<Pick<ChannelRow, "models_json">>,
): string[] {
	const models = new Set<string>();
	for (const channel of channels) {
		for (const id of extractModelIds(channel)) {
			models.add(id);
		}
	}
	return Array.from(models);
}
