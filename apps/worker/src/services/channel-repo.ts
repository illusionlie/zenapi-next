import type { D1Database } from "@cloudflare/workers-types";
import {
	type ChannelApiFormat,
	type ChannelRow,
	normalizeApiFormats,
} from "./channel-types";

type ChannelFilters = {
	status?: string | null;
	type?: number | null;
};

type ChannelOrderBy = "priority" | "created_at" | "id";

const ORDER_COLUMNS: Record<ChannelOrderBy, string> = {
	priority: "priority",
	created_at: "created_at",
	id: "id",
};

function bindIfNeeded<T>(
	stmt: { bind: (...args: Array<string | number>) => T } | T,
	bindings: Array<string | number>,
): T {
	if (bindings.length === 0) {
		return stmt as T;
	}
	return (stmt as { bind: (...args: Array<string | number>) => T }).bind(
		...bindings,
	);
}

function buildWhere(filters: ChannelFilters | undefined) {
	const where: string[] = [];
	const bindings: Array<string | number> = [];
	if (filters?.status) {
		where.push("status = ?");
		bindings.push(filters.status);
	}
	if (filters?.type !== undefined && filters?.type !== null) {
		where.push("type = ?");
		bindings.push(filters.type);
	}
	const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	return { whereSql, bindings };
}

export async function listChannels(
	db: D1Database,
	options: {
		filters?: ChannelFilters;
		orderBy?: ChannelOrderBy;
		order?: "ASC" | "DESC";
		limit?: number;
		offset?: number;
	} = {},
): Promise<ChannelRow[]> {
	const { whereSql, bindings } = buildWhere(options.filters);
	const orderBy = options.orderBy ?? "created_at";
	const order = options.order ?? "DESC";
	const orderSql = `ORDER BY ${ORDER_COLUMNS[orderBy]} ${order}`;
	const limitSql =
		options.limit !== undefined && options.offset !== undefined
			? "LIMIT ? OFFSET ?"
			: "";
	const limitBindings =
		options.limit !== undefined && options.offset !== undefined
			? [options.limit, options.offset]
			: [];

	const statement = db.prepare(
		`SELECT * FROM channels ${whereSql} ${orderSql} ${limitSql}`,
	);
	const rows = await bindIfNeeded(statement, [
		...bindings,
		...limitBindings,
	]).all<ChannelRow>();
	return rows.results ?? [];
}

export async function countChannels(
	db: D1Database,
	filters?: ChannelFilters,
): Promise<number> {
	const { whereSql, bindings } = buildWhere(filters);
	const statement = db.prepare(
		`SELECT COUNT(*) as count FROM channels ${whereSql}`,
	);
	const row = await bindIfNeeded(statement, bindings).first<{
		count: number;
	}>();
	return Number(row?.count ?? 0);
}

export async function countChannelsByType(
	db: D1Database,
	filters?: ChannelFilters,
): Promise<Record<string, number>> {
	const { whereSql, bindings } = buildWhere(filters);
	const statement = db.prepare(
		`SELECT type, COUNT(*) as count FROM channels ${whereSql} GROUP BY type`,
	);
	const counts = await bindIfNeeded(statement, bindings).all();
	const result: Record<string, number> = {};
	for (const entry of counts.results ?? []) {
		result[String((entry as { type?: unknown }).type)] = Number(
			(entry as { count?: unknown }).count ?? 0,
		);
	}
	return result;
}

export async function listActiveChannels(
	db: D1Database,
): Promise<ChannelRow[]> {
	const rows = await db
		.prepare("SELECT * FROM channels WHERE status = ?")
		.bind("active")
		.all<ChannelRow>();
	return rows.results ?? [];
}

export async function getChannelById(
	db: D1Database,
	id: string,
): Promise<ChannelRow | null> {
	const row = await db
		.prepare("SELECT * FROM channels WHERE id = ?")
		.bind(id)
		.first<ChannelRow>();
	return row ?? null;
}

export async function channelExists(
	db: D1Database,
	id: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT id FROM channels WHERE id = ?")
		.bind(id)
		.first<{ id: string }>();
	return Boolean(row?.id);
}

/**
 * api_formats 双写派生：api_formats 列存全量数组 JSON，镜像列 api_format
 * 存规范化数组首元素（保证旧代码回滚可读、monitoring GROUP BY 不变）。
 * 入参经 normalizeApiFormats 规范化；调用方应已校验，此处兜底回退
 * ["openai"]（历史默认值），绝不落脏值进镜像列。
 */
function toApiFormatColumns(apiFormats: ChannelApiFormat[]): {
	api_formats: string;
	api_format: ChannelApiFormat;
} {
	const normalized = normalizeApiFormats(apiFormats);
	const formats: ChannelApiFormat[] = normalized.ok
		? normalized.value
		: ["openai"];
	const first: ChannelApiFormat = formats[0] ?? "openai";
	return {
		api_formats: JSON.stringify(formats),
		api_format: first,
	};
}

export type ChannelInsertInput = {
	id: string;
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	status: string;
	rate_limit: number;
	models_json: string;
	type: number;
	group_name: string | null;
	priority: number;
	metadata_json: string | null;
	api_formats: ChannelApiFormat[];
	// 规范化后的 JSON 串（键白名单 openai/responses/anthropic）；repo 不做键校验
	endpoint_overrides: string | null;
	custom_headers_json: string | null;
	disguise_headers_json: string | null;
	disguise_system_prompt: string | null;
	// 白名单校验由调用方完成（CLIENT_PRESET_IDS）；repo 只落列
	disguise_preset: string | null;
	created_at: string;
	updated_at: string;
};

export async function insertChannel(
	db: D1Database,
	input: ChannelInsertInput,
): Promise<void> {
	const apiFormatColumns = toApiFormatColumns(input.api_formats);
	await db
		.prepare(
			"INSERT INTO channels (id, name, base_url, api_key, weight, status, rate_limit, models_json, type, group_name, priority, metadata_json, api_format, api_formats, endpoint_overrides, custom_headers_json, disguise_headers_json, disguise_system_prompt, disguise_preset, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			input.id,
			input.name,
			input.base_url,
			input.api_key,
			input.weight,
			input.status,
			input.rate_limit,
			input.models_json,
			input.type,
			input.group_name,
			input.priority,
			input.metadata_json,
			apiFormatColumns.api_format,
			apiFormatColumns.api_formats,
			input.endpoint_overrides,
			input.custom_headers_json,
			input.disguise_headers_json,
			input.disguise_system_prompt,
			input.disguise_preset,
			input.created_at,
			input.updated_at,
		)
		.run();
}

export type ChannelUpdateInput = {
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	status: string;
	rate_limit: number;
	models_json: string;
	type: number;
	group_name: string | null;
	priority: number;
	metadata_json: string | null;
	api_formats: ChannelApiFormat[];
	// 规范化后的 JSON 串；repo 不做键校验（三态语义由调用方解析）
	endpoint_overrides: string | null;
	custom_headers_json: string | null;
	disguise_headers_json: string | null;
	disguise_system_prompt: string | null;
	// 白名单校验与三态语义（undefined 保留）由调用方解析后传入终值
	disguise_preset: string | null;
	updated_at: string;
};

export async function updateChannel(
	db: D1Database,
	id: string,
	input: ChannelUpdateInput,
): Promise<void> {
	const apiFormatColumns = toApiFormatColumns(input.api_formats);
	await db
		.prepare(
			"UPDATE channels SET name = ?, base_url = ?, api_key = ?, weight = ?, status = ?, rate_limit = ?, models_json = ?, type = ?, group_name = ?, priority = ?, metadata_json = ?, api_format = ?, api_formats = ?, endpoint_overrides = ?, custom_headers_json = ?, disguise_headers_json = ?, disguise_system_prompt = ?, disguise_preset = ?, updated_at = ? WHERE id = ?",
		)
		.bind(
			input.name,
			input.base_url,
			input.api_key,
			input.weight,
			input.status,
			input.rate_limit,
			input.models_json,
			input.type,
			input.group_name,
			input.priority,
			input.metadata_json,
			apiFormatColumns.api_format,
			apiFormatColumns.api_formats,
			input.endpoint_overrides,
			input.custom_headers_json,
			input.disguise_headers_json,
			input.disguise_system_prompt,
			input.disguise_preset,
			input.updated_at,
			id,
		)
		.run();
}

export async function deleteChannel(db: D1Database, id: string): Promise<void> {
	await db.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
}
