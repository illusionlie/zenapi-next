import type {
	ChannelApiFormat,
	ChannelEndpointOverrideKey,
	ChannelEndpointOverrides,
} from "./types";

/**
 * Formats a datetime string for display.
 *
 * Args:
 *   value: ISO datetime string or nullable value.
 *
 * Returns:
 *   A human-friendly datetime string or "-".
 */
const pad2 = (value: number) => String(value).padStart(2, "0");

export const formatDateTime = (value?: string | null) => {
	if (!value) {
		return "-";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "-";
	}
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
		date.getDate(),
	)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
		date.getSeconds(),
	)}`;
};

/**
 * Toggles channel or token status between active and disabled.
 *
 * Args:
 *   value: Current status value.
 *
 * Returns:
 *   Next status value.
 */
export const toggleStatus = (value: string) =>
	value === "active" ? "disabled" : "active";

const API_FORMAT_WHITELIST: readonly string[] = [
	"openai",
	"anthropic",
	"custom",
	"responses",
];

/**
 * Parses a channel's declared API formats from the wire form.
 * Fallback chain mirrors the worker's parseApiFormats read side:
 * api_formats JSON array string (raw TEXT column) -> legacy mirror
 * api_format single value -> default ["openai"].
 *
 * Args:
 *   channel: Channel-like row carrying api_formats / api_format.
 *
 * Returns:
 *   Deduplicated whitelist-filtered format array (never empty).
 */
export const parseChannelApiFormats = (channel: {
	api_formats?: string | null;
	api_format?: string | null;
}): ChannelApiFormat[] => {
	if (
		typeof channel.api_formats === "string" &&
		channel.api_formats.trim() !== ""
	) {
		try {
			const parsed: unknown = JSON.parse(channel.api_formats);
			if (Array.isArray(parsed)) {
				const formats = parsed.filter(
					(value): value is ChannelApiFormat =>
						typeof value === "string" && API_FORMAT_WHITELIST.includes(value),
				);
				const deduped = [...new Set(formats)];
				if (deduped.length > 0) {
					return deduped;
				}
			}
		} catch {
			/* 畸形 JSON 落到下一级兜底 */
		}
	}
	if (
		typeof channel.api_format === "string" &&
		API_FORMAT_WHITELIST.includes(channel.api_format)
	) {
		return [channel.api_format as ChannelApiFormat];
	}
	return ["openai"];
};

const ENDPOINT_OVERRIDE_KEYS: readonly ChannelEndpointOverrideKey[] = [
	"openai",
	"responses",
	"anthropic",
];

/**
 * Parses a channel's per-format endpoint overrides from the wire form
 * (TEXT column carrying a raw JSON object string). Fallback philosophy
 * mirrors the worker's parseEndpointOverrides: any dirty data degrades to
 * "no override" instead of throwing.
 *   - NULL / empty / non-string -> all empty strings
 *   - JSON.parse failure / top-level non-object -> all empty strings
 *   - key whitelist {openai, responses, anthropic}; blank / non-string
 *     values degrade to empty string (blank override = no override)
 *
 * Args:
 *   channel: Channel-like row carrying the raw endpoint_overrides column.
 *
 * Returns:
 *   Flat form-shape overrides (empty string = not overridden).
 */
export const parseEndpointOverrides = (channel: {
	endpoint_overrides?: string | null;
}): ChannelEndpointOverrides => {
	const result: ChannelEndpointOverrides = {
		openai: "",
		responses: "",
		anthropic: "",
	};
	if (
		typeof channel.endpoint_overrides !== "string" ||
		channel.endpoint_overrides.trim() === ""
	) {
		return result;
	}
	try {
		const parsed: unknown = JSON.parse(channel.endpoint_overrides);
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			return result;
		}
		const source = parsed as Record<string, unknown>;
		for (const key of ENDPOINT_OVERRIDE_KEYS) {
			const value = source[key];
			if (typeof value === "string" && value.trim() !== "") {
				result[key] = value;
			}
		}
		return result;
	} catch {
		/* 畸形 JSON → 视为无覆盖 */
		return result;
	}
};

export type PageItem = number | "ellipsis";

export const buildPageItems = (current: number, total: number): PageItem[] => {
	if (total <= 6) {
		return Array.from({ length: total }, (_, index) => index + 1);
	}
	const items: PageItem[] = [1, 2, 3];
	if (current > 3 && current < total - 1) {
		items.push("ellipsis", current);
	}
	items.push("ellipsis", total - 1, total);
	return items.filter((item, index, array) => {
		if (item === "ellipsis" && array[index - 1] === "ellipsis") {
			return false;
		}
		if (typeof item === "number") {
			return array.indexOf(item) === index;
		}
		return true;
	});
};

/**
 * Formats a cache hit rate (fraction 0–1) for display. Null/undefined means
 * upstream never reported cache tokens — renders as "—", never 0%.
 *
 * Args:
 *   rate: Cache hit rate fraction or null.
 *
 * Returns:
 *   Percentage string or "—".
 */
export const formatCacheRate = (rate: number | null | undefined) =>
	rate === null || rate === undefined ? "—" : `${Math.round(rate * 100)}%`;

/**
 * Bar color for cache hit rates, following monitoring-shared.ts band style.
 *
 * Args:
 *   rate: Cache hit rate fraction or null.
 *
 * Returns:
 *   Hex color string.
 */
export const cacheRateColor = (rate: number | null | undefined) => {
	if (rate === null || rate === undefined) return "#e7e5e4"; // stone-200
	if (rate >= 0.7) return "#22c55e"; // green-500
	if (rate >= 0.3) return "#eab308"; // yellow-500
	return "#ef4444"; // red-500
};
