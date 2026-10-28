import { extractModelPricings } from "./channel-models";

export type ModelPriceInfo = {
	input_price: number; // per million tokens
	output_price: number;
	/** 缓存读绝对价（USD/1M，每模型覆盖）；缺省 = input_price × 全局读倍率 */
	cache_read_price?: number;
	/** 缓存写绝对价（USD/1M，每模型覆盖）；缺省 = input_price × 全局写倍率 */
	cache_write_price?: number;
};

/** 全局缓存倍率（settings cache_read_ratio / cache_write_ratio，clamp [0,100]）。 */
export type CacheRatios = {
	readRatio: number;
	writeRatio: number;
};

export const DEFAULT_CACHE_RATIOS: CacheRatios = {
	readRatio: 1,
	writeRatio: 1,
};

/**
 * Looks up the price for a model from a channel's models_json.
 * Cache price fields ride along when present; the "has pricing" decision
 * stays input/output-only (a cache-price-only entry is still unpriced).
 */
export function getModelPrice(
	modelsJson: string | null | undefined,
	modelId: string,
): ModelPriceInfo | null {
	if (!modelsJson || !modelId) return null;
	const pricings = extractModelPricings({ models_json: modelsJson });
	const match = pricings.find((p) => p.id === modelId);
	if (!match || (match.input_price == null && match.output_price == null)) {
		return null;
	}
	const price: ModelPriceInfo = {
		input_price: match.input_price ?? 0,
		output_price: match.output_price ?? 0,
	};
	if (match.cache_read_price != null) {
		price.cache_read_price = match.cache_read_price;
	}
	if (match.cache_write_price != null) {
		price.cache_write_price = match.cache_write_price;
	}
	return price;
}

/**
 * Calculates cost for a single request.
 * When prompt/completion split is unavailable (both 0) but totalTokens > 0,
 * falls back to average of input/output price (cache tokens are not split
 * out on that path).
 *
 * Cache discount path (2026-10-28): cached ⊆ prompt (仓库口径 prompt 为含
 * 缓存总输入), so the non-cached remainder is prompt − cacheRead − cacheWrite
 * (floored at 0). Cache tokens price at the per-model absolute price when
 * configured, otherwise input_price × global ratio. With no cache tokens
 * reported (both null/0) the guard short-circuits into the legacy formula
 * verbatim — byte-identical results, zero regression by construction.
 */
export function calculateCost(
	price: ModelPriceInfo,
	promptTokens: number,
	completionTokens: number,
	totalTokens?: number,
	cachedInputTokens?: number | null,
	cacheCreationTokens?: number | null,
	ratios?: CacheRatios,
): number {
	if (
		promptTokens === 0 &&
		completionTokens === 0 &&
		totalTokens &&
		totalTokens > 0
	) {
		const avgPrice = (price.input_price + price.output_price) / 2;
		return (totalTokens / 1_000_000) * avgPrice;
	}
	const cacheRead = cachedInputTokens ?? 0;
	const cacheWrite = cacheCreationTokens ?? 0;
	// 短路守卫：无缓存 token 走原公式原路径（浮点结合序逐字节一致，零回归对照锚点）
	if (cacheRead === 0 && cacheWrite === 0) {
		const inputCost = (promptTokens / 1_000_000) * price.input_price;
		const outputCost = (completionTokens / 1_000_000) * price.output_price;
		return inputCost + outputCost;
	}
	const readRatio = ratios?.readRatio ?? DEFAULT_CACHE_RATIOS.readRatio;
	const writeRatio = ratios?.writeRatio ?? DEFAULT_CACHE_RATIOS.writeRatio;
	const readPrice = price.cache_read_price ?? price.input_price * readRatio;
	const writePrice = price.cache_write_price ?? price.input_price * writeRatio;
	const nonCachedTokens = Math.max(0, promptTokens - cacheRead - cacheWrite);
	const nonCachedCost = (nonCachedTokens / 1_000_000) * price.input_price;
	const cacheReadCost = (cacheRead / 1_000_000) * readPrice;
	const cacheWriteCost = (cacheWrite / 1_000_000) * writePrice;
	const outputCost = (completionTokens / 1_000_000) * price.output_price;
	return nonCachedCost + cacheReadCost + cacheWriteCost + outputCost;
}
