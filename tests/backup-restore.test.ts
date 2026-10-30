import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import backupApp from "../apps/worker/src/routes/backup";
import {
	resolveEndpointBaseUrl,
	selectTargetFormat,
} from "../apps/worker/src/services/channel-routing";
import {
	parseApiFormats,
	parseEndpointOverrides,
} from "../apps/worker/src/services/channel-types";

/**
 * 配置一键备份导出/导入（task 10-26-config-backup-restore）：
 * - 导出形状：文件头字段、渠道明文 key、settings 排除清单键不出现；
 * - round-trip：导出 → 导入，渠道 / 别名 / 设置逐字段等价，JSON 列原串
 *   回写（字节保真），代理路由字段可解析可用；
 * - 校验失败零写入（batch 未执行）、version 拒绝、超限 413、settings
 *   选择性替换（只删载荷内键）。
 */

type CapturedStatement = { sql: string; args: unknown[] };

function makeBackupDb(
	options: {
		channels?: Record<string, unknown>[];
		modelAliases?: Record<string, unknown>[];
		channelModelAliases?: Record<string, unknown>[];
		settings?: { key: string; value: string | null }[];
		batchError?: Error;
	} = {},
) {
	const batches: CapturedStatement[][] = [];
	const db = {
		prepare(sql: string) {
			const stmt = {
				sql,
				boundArgs: [] as unknown[],
				bind: (...args: unknown[]) => {
					stmt.boundArgs = args;
					return stmt;
				},
				all: async () => {
					if (sql.includes("FROM channels")) {
						return { results: options.channels ?? [] };
					}
					if (sql.includes("FROM model_aliases")) {
						return { results: options.modelAliases ?? [] };
					}
					if (sql.includes("FROM channel_model_aliases")) {
						return { results: options.channelModelAliases ?? [] };
					}
					if (sql.includes("FROM settings")) {
						return { results: options.settings ?? [] };
					}
					return { results: [] };
				},
				first: async () => null,
				run: async () => ({}),
			};
			return stmt;
		},
		batch: async (stmts: Array<{ sql: string; boundArgs: unknown[] }>) => {
			if (options.batchError) {
				throw options.batchError;
			}
			batches.push(
				stmts.map((s) => ({ sql: s.sql, args: s.boundArgs ?? [] })),
			);
			return [];
		},
	};
	return {
		// Test-boundary cast: mock only implements the statement methods used.
		db: db as unknown as D1Database,
		batches,
	};
}

type RequestEnv = Parameters<typeof backupApp.request>[2];

function makeEnv(options?: Parameters<typeof makeBackupDb>[0]): {
	env: RequestEnv;
	batches: CapturedStatement[][];
} {
	const { db, batches } = makeBackupDb(options);
	return { env: { DB: db } as unknown as RequestEnv, batches };
}

function postInit(body: string): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	};
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

/** 多格式 + 端点覆盖 + 伪装字段齐全的渠道行（DB 存储形态，TEXT JSON 串）。 */
function makeRichChannel(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: "ch_rich",
		name: "rich-channel",
		base_url: "https://rich.example.com/v1",
		api_key: "sk-rich-plaintext-secret",
		weight: 3,
		status: "active",
		rate_limit: 100,
		models_json: '[{"id":"gpt-4o"},{"id":"claude-x"}]',
		type: 1,
		group_name: null,
		priority: 5,
		metadata_json: null,
		test_time: 1729900000000,
		response_time_ms: 421,
		api_format: "openai",
		api_formats: '["openai","anthropic"]',
		endpoint_overrides: '{"anthropic":"https://rich.example.com/anthropic"}',
		custom_headers_json: '{"x-custom":"1"}',
		disguise_headers_json: '{"x-disg":"{{uuid}}"}',
		disguise_system_prompt: "You are OpenCode, a helpful assistant.",
		disguise_preset: null,
		stream_only: 0,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		...overrides,
	};
}

const RICH_SETTINGS_ROWS = [
	{ key: "announcement", value: "hello" },
	{ key: "log_retention_days", value: "7" },
	{ key: "proxy_retry_rounds", value: "3" },
	{ key: "ldc_epay_key", value: "epay-secret-visible-in-admin-ui" },
	// 排除清单内的键存在于库中，导出必须过滤
	{ key: "admin_password_hash", value: "sha256hash" },
	{ key: "turnstile_secret_key", value: "0xturnstile-secret" },
	// 白名单外的未知键不导出
	{ key: "some_future_key", value: "future" },
];

const RICH_MODEL_ALIASES = [
	{
		id: "al_1",
		model_id: "gpt-4o",
		alias: "gpt-4o-latest",
		is_primary: 0,
		alias_only: 1,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	},
];

const RICH_CHANNEL_ALIASES = [
	{
		id: "cal_1",
		channel_id: "ch_rich",
		model_id: "gpt-4o",
		alias: "gpt-four-o",
		is_primary: 1,
		alias_only: 0,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	},
];

async function exportRichBackup() {
	const { env } = makeEnv({
		channels: [makeRichChannel()],
		modelAliases: RICH_MODEL_ALIASES,
		channelModelAliases: RICH_CHANNEL_ALIASES,
		settings: RICH_SETTINGS_ROWS,
	});
	const res = await backupApp.request("/export", { method: "GET" }, env);
	return { res, payload: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/backup/export", () => {
	it("returns attachment headers with version/exportedAt envelope", async () => {
		const { res, payload } = await exportRichBackup();
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("content-disposition")).toMatch(
			/^attachment; filename="zenapi-next-backup-\d{4}-\d{2}-\d{2}\.json"$/,
		);
		expect(payload.version).toBe(1);
		expect(typeof payload.exportedAt).toBe("string");
		expect(Number.isNaN(Date.parse(payload.exportedAt as string))).toBe(false);
	});

	it("exports channels with plaintext api_key and verbatim JSON columns", async () => {
		const { payload } = await exportRichBackup();
		const channels = payload.channels as Record<string, unknown>[];
		expect(channels).toHaveLength(1);
		const channel = channels[0];
		// 明文 key 导出（下载警示由 UI 文案承担）
		expect(channel.api_key).toBe("sk-rich-plaintext-secret");
		// JSON 列保持存储字符串形态（round-trip 字节保真优先）
		expect(channel.api_formats).toBe('["openai","anthropic"]');
		expect(channel.endpoint_overrides).toBe(
			'{"anthropic":"https://rich.example.com/anthropic"}',
		);
		expect(channel.models_json).toBe('[{"id":"gpt-4o"},{"id":"claude-x"}]');
		expect(channel.disguise_headers_json).toBe('{"x-disg":"{{uuid}}"}');
		expect(channel.disguise_preset).toBeNull();
		expect(channel.stream_only).toBe(0);
	});

	it("exports both alias tables as rows", async () => {
		const { payload } = await exportRichBackup();
		expect(payload.model_aliases).toEqual(RICH_MODEL_ALIASES);
		expect(payload.channel_model_aliases).toEqual(RICH_CHANNEL_ALIASES);
	});

	it("excludes secret settings keys and unknown keys from the export", async () => {
		const { payload } = await exportRichBackup();
		const settings = payload.settings as Record<string, string>;
		// 管理台可见键导出
		expect(settings.announcement).toBe("hello");
		expect(settings.log_retention_days).toBe("7");
		expect(settings.proxy_retry_rounds).toBe("3");
		expect(settings.ldc_epay_key).toBe("epay-secret-visible-in-admin-ui");
		// 排除清单（管理员密码哈希 / Turnstile secret）绝不出现
		expect(settings.admin_password_hash).toBeUndefined();
		expect(settings.turnstile_secret_key).toBeUndefined();
		// 白名单外的未知键不出现
		expect(settings.some_future_key).toBeUndefined();
		// 序列化全文双保险：排除键名不得出现在导出载荷任何位置
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("admin_password_hash");
		expect(serialized).not.toContain("turnstile_secret_key");
	});
});

describe("POST /api/backup/import — guards", () => {
	it("rejects invalid JSON with 400 invalid_backup_payload", async () => {
		const { env, batches } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit("{not-json"),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("invalid_backup_payload");
		expect(batches).toHaveLength(0);
	});

	it("rejects non-object payloads with 400", async () => {
		const { env, batches } = makeEnv();
		const res = await backupApp.request("/import", postInit("[1,2]"), env);
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).code).toBe("invalid_backup_payload");
		expect(batches).toHaveLength(0);
	});

	it("rejects mismatched version with 400 unsupported_backup_version", async () => {
		const { env, batches } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(JSON.stringify({ version: 2, channels: [] })),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("unsupported_backup_version");
		expect(batches).toHaveLength(0);
	});

	it("rejects bodies over 2MB with 413 payload_too_large", async () => {
		const { env, batches } = makeEnv();
		const oversized = `{"version":1,"padding":"${"x".repeat(2 * 1024 * 1024)}"}`;
		const res = await backupApp.request("/import", postInit(oversized), env);
		expect(res.status).toBe(413);
		expect((await jsonBody(res)).code).toBe("payload_too_large");
		expect(batches).toHaveLength(0);
	});

	it("rejects payload containing excluded settings keys with 400", async () => {
		const { env, batches } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(
				JSON.stringify({
					version: 1,
					channels: [],
					model_aliases: [],
					channel_model_aliases: [],
					settings: { admin_password_hash: "evil" },
				}),
			),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("forbidden_settings_key");
		expect(String(body.error)).toContain("admin_password_hash");
		expect(batches).toHaveLength(0);
	});
});

describe("POST /api/backup/import — per-channel validation", () => {
	function payloadWithChannels(channels: unknown[]): string {
		return JSON.stringify({
			version: 1,
			channels,
			model_aliases: [],
			channel_model_aliases: [],
			settings: {},
		});
	}

	it("rejects an invalid api_formats with located message and zero writes", async () => {
		const { env, batches } = makeEnv();
		const bad = makeRichChannel({ id: "ch_ok", name: "ok-one" });
		const broken = makeRichChannel({
			id: "ch_broken",
			name: "broken-one",
			api_formats: "not-json",
		});
		const res = await backupApp.request(
			"/import",
			postInit(payloadWithChannels([bad, broken])),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("invalid_api_formats");
		expect(String(body.error)).toContain("channels[1]");
		expect(String(body.error)).toContain("broken-one");
		// 校验失败零写入：batch 未执行
		expect(batches).toHaveLength(0);
	});

	it("rejects custom-combined api_formats with the CRUD error code", async () => {
		const { env } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(
				payloadWithChannels([
					makeRichChannel({
						api_formats: '["custom","openai"]',
						api_format: "custom",
					}),
				]),
			),
			env,
		);
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).code).toBe("invalid_api_formats");
	});

	it("rejects an invalid endpoint_overrides value with located message", async () => {
		const { env } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(
				payloadWithChannels([
					makeRichChannel({
						endpoint_overrides: '{"anthropic":"ftp://not-http"}',
					}),
				]),
			),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("invalid_endpoint_overrides");
		expect(String(body.error)).toContain("anthropic");
	});

	it("rejects an unknown disguise_preset with the CRUD error code", async () => {
		const { env } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(
				payloadWithChannels([makeRichChannel({ disguise_preset: "nope" })]),
			),
			env,
		);
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).code).toBe("invalid_disguise_preset");
	});

	it("rejects missing name / base_url with missing_fields", async () => {
		const { env } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(payloadWithChannels([makeRichChannel({ name: "" })])),
			env,
		);
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).code).toBe("missing_fields");
	});

	it("rejects missing or duplicate channel ids", async () => {
		const { env } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(payloadWithChannels([makeRichChannel({ id: "" })])),
			env,
		);
		expect(res.status).toBe(400);
		expect((await jsonBody(res)).code).toBe("invalid_backup_channel");

		const dup = makeEnv();
		const dupRes = await backupApp.request(
			"/import",
			postInit(
				payloadWithChannels([
					makeRichChannel({ id: "ch_dup" }),
					makeRichChannel({ id: "ch_dup", name: "other" }),
				]),
			),
			dup.env,
		);
		expect(dupRes.status).toBe(400);
		expect((await jsonBody(dupRes)).code).toBe("invalid_backup_channel");
	});

	it("rejects channel alias rows referencing unknown channels", async () => {
		const { env } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(
				JSON.stringify({
					version: 1,
					channels: [makeRichChannel()],
					model_aliases: [],
					channel_model_aliases: [
						{
							id: "cal_x",
							channel_id: "ch_missing",
							model_id: "gpt-4o",
							alias: "a",
							is_primary: 0,
							alias_only: 0,
						},
					],
					settings: {},
				}),
			),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("invalid_backup_payload");
		expect(String(body.error)).toContain("ch_missing");
	});
});

describe("POST /api/backup/import — round-trip and batch shape", () => {
	it("restores channels/aliases/settings equivalently with verbatim JSON columns", async () => {
		const { payload } = await exportRichBackup();
		const { env, batches } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(JSON.stringify(payload)),
			env,
		);
		expect(res.status).toBe(200);
		const body = await jsonBody(res);
		expect(body.ok).toBe(true);
		expect(body.imported).toEqual({
			channels: 1,
			model_aliases: 1,
			channel_model_aliases: 1,
			settings: 4,
		});
		expect(body.cache_staleness).toEqual({
			channels_seconds: 10,
			settings_seconds: 30,
		});

		// 单次 batch = 单事务（先清后写原子替换）
		expect(batches).toHaveLength(1);
		const statements = batches[0];
		const sqls = statements.map((s) => s.sql);
		// 先清：三张配置域表全清；settings 只删载荷内键（见替换语义用例）
		expect(sqls[0]).toBe("DELETE FROM channels");
		expect(sqls[1]).toBe("DELETE FROM model_aliases");
		expect(sqls[2]).toBe("DELETE FROM channel_model_aliases");

		// 渠道 INSERT：原 id + 明文 key + JSON 列原串回写（字节保真）
		const channelInsert = statements.find((s) =>
			s.sql.startsWith("INSERT INTO channels"),
		);
		expect(channelInsert).toBeDefined();
		const args = channelInsert?.args ?? [];
		expect(args[0]).toBe("ch_rich");
		expect(args[1]).toBe("rich-channel");
		expect(args[2]).toBe("https://rich.example.com/v1");
		expect(args[3]).toBe("sk-rich-plaintext-secret");
		expect(args[7]).toBe('[{"id":"gpt-4o"},{"id":"claude-x"}]');
		// api_format 镜像 / api_formats / endpoint_overrides 原串
		expect(args[14]).toBe("openai");
		expect(args[15]).toBe('["openai","anthropic"]');
		expect(args[16]).toBe(
			'{"anthropic":"https://rich.example.com/anthropic"}',
		);
		expect(args[17]).toBe('{"x-custom":"1"}');
		expect(args[18]).toBe('{"x-disg":"{{uuid}}"}');
		expect(args[19]).toBe("You are OpenCode, a helpful assistant.");
		expect(args[21]).toBe(0);
		expect(args[22]).toBe("2026-01-01T00:00:00.000Z");

		// 别名行原样恢复
		const modelAliasInsert = statements.find((s) =>
			s.sql.startsWith("INSERT INTO model_aliases"),
		);
		expect(modelAliasInsert?.args).toEqual([
			"al_1",
			"gpt-4o",
			"gpt-4o-latest",
			0,
			1,
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
		]);
		const channelAliasInsert = statements.find((s) =>
			s.sql.startsWith("INSERT INTO channel_model_aliases"),
		);
		expect(channelAliasInsert?.args[0]).toBe("cal_1");
		expect(channelAliasInsert?.args[1]).toBe("ch_rich");

		// settings 恢复 4 条（排除键不进载荷）
		const settingsInserts = statements.filter((s) =>
			s.sql.startsWith("INSERT INTO settings"),
		);
		expect(settingsInserts).toHaveLength(4);
		expect(settingsInserts.map((s) => s.args[0]).sort()).toEqual([
			"announcement",
			"ldc_epay_key",
			"log_retention_days",
			"proxy_retry_rounds",
		]);
	});

	it("round-tripped channel feeds the proxy routing stack identically", async () => {
		const { payload } = await exportRichBackup();
		const { env, batches } = makeEnv();
		await backupApp.request(
			"/import",
			postInit(JSON.stringify(payload)),
			env,
		);
		const channelInsert = batches[0].find((s) =>
			s.sql.startsWith("INSERT INTO channels"),
		);
		const row = {
			base_url: String(channelInsert?.args[2]),
			api_formats: String(channelInsert?.args[15]),
			api_format: String(channelInsert?.args[14]),
			endpoint_overrides: channelInsert?.args[16] as string | null,
		};
		// 代理可路由：声明集解析、chat 目标格式选择、每格式端点解析与备份前一致
		expect(parseApiFormats(row)).toEqual(["openai", "anthropic"]);
		expect(selectTargetFormat(parseApiFormats(row), "chat")).toBe("openai");
		expect(selectTargetFormat(parseApiFormats(row), "anthropic")).toBe(
			"anthropic",
		);
		expect(
			resolveEndpointBaseUrl(row, "anthropic"),
		).toBe("https://rich.example.com/anthropic");
		expect(resolveEndpointBaseUrl(row, "openai")).toBe(
			"https://rich.example.com/v1",
		);
		expect(parseEndpointOverrides(row)).toEqual({
			anthropic: "https://rich.example.com/anthropic",
		});
	});

	it("replaces only the settings keys present in the payload", async () => {
		const { env, batches } = makeEnv();
		const res = await backupApp.request(
			"/import",
			postInit(
				JSON.stringify({
					version: 1,
					channels: [],
					model_aliases: [],
					channel_model_aliases: [],
					settings: { announcement: "new", model_test_prompt: "ping" },
				}),
			),
			env,
		);
		expect(res.status).toBe(200);
		const statements = batches[0];
		const settingsDeletes = statements.filter(
			(s) => s.sql === "DELETE FROM settings WHERE key = ?",
		);
		expect(settingsDeletes.map((s) => s.args[0]).sort()).toEqual([
			"announcement",
			"model_test_prompt",
		]);
		// 不允许全表清空 settings（载荷没有的键保留现值）
		expect(
			statements.some(
				(s) =>
					s.sql.startsWith("DELETE FROM settings") &&
					s.sql !== "DELETE FROM settings WHERE key = ?",
			),
		).toBe(false);
		// 载荷外的键无对应 DELETE
		expect(
			settingsDeletes.some((s) => s.args[0] === "proxy_retry_rounds"),
		).toBe(false);
	});

	it("returns 500 import_failed and writes nothing when the batch fails", async () => {
		const { env, batches } = makeEnv({
			batchError: new Error("UNIQUE constraint failed"),
		});
		const res = await backupApp.request(
			"/import",
			postInit(
				JSON.stringify({
					version: 1,
					channels: [makeRichChannel()],
					model_aliases: [],
					channel_model_aliases: [],
					settings: {},
				}),
			),
			env,
		);
		expect(res.status).toBe(500);
		expect((await jsonBody(res)).code).toBe("import_failed");
		// 失败的 batch 不算已提交写入（D1 batch 单事务整体回滚）
		expect(batches).toHaveLength(0);
	});
});
