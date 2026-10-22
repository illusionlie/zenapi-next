import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import channelsApp from "../apps/worker/src/routes/channels";

/**
 * disguise_preset CRUD 三态与白名单（design D1，AC10）：
 * - POST trim-or-null（空白 = 关闭落 NULL），非法值 400 invalid_disguise_preset；
 * - PATCH 三态（patch-update-semantics）：undefined 保留现值 / 空串清除 /
 *   白名单值设置；绑定索引按 channel-repo INSERT（第 19 参）与 UPDATE
 *   （第 18 参）语句核对。
 */

function makeDb(options: { channelRow?: Record<string, unknown> | null } = {}) {
	const runs: Array<{ sql: string; args: unknown[] }> = [];
	const db = {
		prepare(sql: string) {
			const stmt = {
				sql,
				boundArgs: [] as unknown[],
				bind: (...args: unknown[]) => {
					stmt.boundArgs = args;
					return stmt;
				},
				all: async () => ({ results: [] }),
				first: async () => {
					if (sql.includes("SELECT * FROM channels")) {
						return options.channelRow ?? null;
					}
					if (sql.includes("SELECT id FROM channels")) {
						return options.channelRow
							? { id: (options.channelRow as { id?: string }).id }
							: null;
					}
					return null;
				},
				run: async () => {
					runs.push({ sql, args: stmt.boundArgs });
					return {};
				},
			};
			return stmt;
		},
	};
	return {
		// Test-boundary cast: mock only implements the statement methods used.
		db: db as unknown as D1Database,
		runs,
	};
}

type RequestEnv = Parameters<typeof channelsApp.request>[2];

function makeEnv(options: { channelRow?: Record<string, unknown> } = {}): {
	env: RequestEnv;
	runs: Array<{ sql: string; args: unknown[] }>;
} {
	const { db, runs } = makeDb({ channelRow: options.channelRow ?? null });
	return { env: { DB: db } as unknown as RequestEnv, runs };
}

function makeChannelRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ch1",
		name: "test-channel",
		base_url: "https://x.com/v1",
		api_key: "sk-test",
		weight: 1,
		status: "active",
		rate_limit: 0,
		models_json: "[]",
		type: 1,
		group_name: null,
		priority: 0,
		metadata_json: null,
		api_format: "openai",
		api_formats: '["openai"]',
		endpoint_overrides: null,
		custom_headers_json: null,
		disguise_headers_json: null,
		disguise_system_prompt: null,
		disguise_preset: null,
		...overrides,
	};
}

function postInit(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

function patchInit(body: unknown): RequestInit {
	return {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
	return (await res.json()) as Record<string, unknown>;
}

function insertRun(runs: Array<{ sql: string }>) {
	return runs.find((r) => r.sql.includes("INSERT INTO channels"));
}

function updateRun(runs: Array<{ sql: string }>) {
	return runs.find((r) => r.sql.includes("UPDATE channels SET"));
}

/** INSERT 语句中 disguise_preset 的绑定下标（channel-repo 列序第 19 位）。 */
const INSERT_PRESET_INDEX = 18;
/** UPDATE 语句中 disguise_preset 的绑定下标（channel-repo 列序第 18 位）。 */
const UPDATE_PRESET_INDEX = 17;

describe("POST /api/channels — disguise_preset trim-or-null + whitelist", () => {
	it("stores the whitelisted preset trimmed", async () => {
		const { env, runs } = makeEnv();
		const res = await channelsApp.request(
			"/",
			postInit({
				name: "c",
				base_url: "https://x.com/v1",
				disguise_preset: "  opencode_zen_v1  ",
			}),
			env,
		);
		expect(res.status).toBe(200);
		const insert = insertRun(runs);
		expect(insert).toBeDefined();
		expect(insert?.args[INSERT_PRESET_INDEX]).toBe("opencode_zen_v1");
	});

	it("absent or empty preset stores NULL (disabled)", async () => {
		const absent = makeEnv();
		await channelsApp.request(
			"/",
			postInit({ name: "c", base_url: "https://x.com/v1" }),
			absent.env,
		);
		expect(insertRun(absent.runs)?.args[INSERT_PRESET_INDEX]).toBeNull();

		const empty = makeEnv();
		await channelsApp.request(
			"/",
			postInit({
				name: "c",
				base_url: "https://x.com/v1",
				disguise_preset: "   ",
			}),
			empty.env,
		);
		expect(insertRun(empty.runs)?.args[INSERT_PRESET_INDEX]).toBeNull();
	});

	it("rejects a value outside CLIENT_PRESET_IDS with 400 invalid_disguise_preset", async () => {
		const { env, runs } = makeEnv();
		const res = await channelsApp.request(
			"/",
			postInit({
				name: "c",
				base_url: "https://x.com/v1",
				disguise_preset: "totally_unknown_preset",
			}),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("invalid_disguise_preset");
		// 校验失败不落库
		expect(insertRun(runs)).toBeUndefined();
	});
});

describe("PATCH /api/channels/:id — disguise_preset three-state", () => {
	it("undefined keeps the current preset", async () => {
		const { env, runs } = makeEnv({
			channelRow: makeChannelRow({ disguise_preset: "opencode_zen_v1" }),
		});
		const res = await channelsApp.request("/ch1", patchInit({}), env);
		expect(res.status).toBe(200);
		const update = updateRun(runs);
		expect(update).toBeDefined();
		expect(update?.args[UPDATE_PRESET_INDEX]).toBe("opencode_zen_v1");
		expect(update?.args[19]).toBe("ch1");
	});

	it("empty string clears the preset (NULL)", async () => {
		const { env, runs } = makeEnv({
			channelRow: makeChannelRow({ disguise_preset: "opencode_zen_v1" }),
		});
		const res = await channelsApp.request(
			"/ch1",
			patchInit({ disguise_preset: "" }),
			env,
		);
		expect(res.status).toBe(200);
		expect(updateRun(runs)?.args[UPDATE_PRESET_INDEX]).toBeNull();
	});

	it("a whitelisted value sets the preset on a row without one", async () => {
		const { env, runs } = makeEnv({
			channelRow: makeChannelRow({ disguise_preset: null }),
		});
		const res = await channelsApp.request(
			"/ch1",
			patchInit({ disguise_preset: "opencode_zen_v1" }),
			env,
		);
		expect(res.status).toBe(200);
		expect(updateRun(runs)?.args[UPDATE_PRESET_INDEX]).toBe(
			"opencode_zen_v1",
		);
	});

	it("an invalid value returns 400 invalid_disguise_preset and writes nothing", async () => {
		const { env, runs } = makeEnv({
			channelRow: makeChannelRow({ disguise_preset: "opencode_zen_v1" }),
		});
		const res = await channelsApp.request(
			"/ch1",
			patchInit({ disguise_preset: "nope" }),
			env,
		);
		expect(res.status).toBe(400);
		const body = await jsonBody(res);
		expect(body.code).toBe("invalid_disguise_preset");
		expect(updateRun(runs)).toBeUndefined();
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
