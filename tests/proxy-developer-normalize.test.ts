import { describe, expect, it } from "vitest";
import { buildChannelRequest } from "../apps/worker/src/routes/proxy";
import type { ChannelRecord } from "../apps/worker/src/services/channels";

/**
 * buildChannelRequest × normalizeDeveloperRole 接线矩阵（design.md D3/D4、
 * AC1 / AC4）：flag off 时出站 body 与入站 requestText 字节一致（零回归）；
 * flag on 仅命中 openai 协议族两处裸透传；anthropic / responses 转换 /
 * custom 分支不受 flag 影响；与 disguisePrompt 组合共享单次重序列化
 * （先归一化后注入），且调用方共享的 parsedBody 保持原样（跨重试轮安全）。
 */

const PROMPT = "DISGUISE-PROMPT";

function makeChannel(
	overrides: Partial<ChannelRecord> & Pick<ChannelRecord, "api_format">,
): ChannelRecord {
	return {
		id: "ch1",
		name: "test-channel",
		base_url: "https://upstream.example/v1",
		api_key: "sk-channel",
		weight: 1,
		status: "active",
		...overrides,
	};
}

function call(
	channel: ChannelRecord,
	args: {
		targetPath: string;
		requestText: string;
		parsedBody: Record<string, unknown> | null;
		isStream?: boolean;
		disguisePrompt?: string | null;
		normalizeDeveloperRole?: boolean;
	},
): { target: string; body: string | undefined } {
	const { target, body } = buildChannelRequest(
		channel,
		args.targetPath,
		"",
		new Headers({ "content-type": "application/json" }),
		args.requestText,
		args.parsedBody,
		args.isStream ?? false,
		"sk-call",
		null,
		args.disguisePrompt ?? null,
		args.normalizeDeveloperRole,
	);
	return { target, body };
}

describe("flag off — byte-identical passthrough (AC1)", () => {
	it("openai chat passthrough keeps the raw requestText byte-for-byte (no re-parse, no re-serialize)", () => {
		const channel = makeChannel({ api_format: "openai" });
		// 双空格 + 紧凑键序：任何 JSON 往返都会改变字节
		const requestText =
			'{"model":"m",  "messages":[{"role":"developer","content":"dev"}]}';

		const omitted = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText,
			parsedBody: JSON.parse(requestText) as Record<string, unknown>,
		});
		const explicitFalse = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText,
			parsedBody: JSON.parse(requestText) as Record<string, unknown>,
			normalizeDeveloperRole: false,
		});

		expect(omitted.body).toBe(requestText);
		expect(explicitFalse.body).toBe(requestText);
	});

	it("responses native passthrough keeps the raw requestText byte-for-byte", () => {
		const channel = makeChannel({ api_format: "responses" });
		const requestText =
			'{"model":"m",  "input":[{"type":"message","role":"developer","content":"dev"}]}';

		const { body } = call(channel, {
			targetPath: "/v1/responses",
			requestText,
			parsedBody: JSON.parse(requestText) as Record<string, unknown>,
		});

		expect(body).toBe(requestText);
	});
});

describe("flag on — openai chat passthrough normalization", () => {
	it("renames developer messages in place; other roles and order untouched", () => {
		const channel = makeChannel({ api_format: "openai" });
		const parsedBody = {
			model: "m",
			messages: [
				{ role: "developer", content: "d1" },
				{ role: "user", content: "u1" },
				{ role: "developer", content: "d2" },
				{ role: "tool", tool_call_id: "t1", content: "r" },
			],
		};
		const requestText = JSON.stringify(parsedBody);

		const { body } = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText,
			parsedBody,
			normalizeDeveloperRole: true,
		});

		const parsed = JSON.parse(body as string) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(parsed.messages).toEqual([
			{ role: "system", content: "d1" },
			{ role: "user", content: "u1" },
			{ role: "system", content: "d2" },
			{ role: "tool", tool_call_id: "t1", content: "r" },
		]);
	});

	it("no developer message → falls back to byte-identical requestText (no re-serialization, AC2)", () => {
		const channel = makeChannel({ api_format: "openai" });
		const requestText =
			'{"model":"m",  "messages":[{"role":"user","content":"u1"}]}';

		const { body } = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText,
			parsedBody: JSON.parse(requestText) as Record<string, unknown>,
			normalizeDeveloperRole: true,
		});

		expect(body).toBe(requestText);
	});

	it("bodies without a messages array (embeddings etc.) pass through untouched", () => {
		const channel = makeChannel({ api_format: "openai" });
		const requestText = '{"model":"e","input":"hello"}';

		const { body } = call(channel, {
			targetPath: "/v1/embeddings",
			requestText,
			parsedBody: JSON.parse(requestText) as Record<string, unknown>,
			normalizeDeveloperRole: true,
		});

		expect(body).toBe(requestText);
	});
});

describe("flag on — responses native passthrough normalization", () => {
	it("renames message+developer items only; function_call / output / reasoning untouched", () => {
		const channel = makeChannel({ api_format: "responses" });
		const functionCall = {
			type: "function_call",
			name: "f",
			call_id: "call_1",
			arguments: "{}",
		};
		const functionCallOutput = {
			type: "function_call_output",
			call_id: "call_1",
			output: "ok",
		};
		const reasoning = { type: "reasoning", summary: [] };
		const parsedBody = {
			model: "m",
			input: [
				{ type: "message", role: "developer", content: "d1" },
				functionCall,
				functionCallOutput,
				reasoning,
				{ type: "message", role: "user", content: "u1" },
			],
		};

		const { body } = call(channel, {
			targetPath: "/v1/responses",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
			normalizeDeveloperRole: true,
		});

		const parsed = JSON.parse(body as string) as {
			input: Array<Record<string, unknown>>;
		};
		expect(parsed.input[0]).toEqual({
			type: "message",
			role: "system",
			content: "d1",
		});
		expect(parsed.input[1]).toEqual(functionCall);
		expect(parsed.input[2]).toEqual(functionCallOutput);
		expect(parsed.input[3]).toEqual(reasoning);
		expect(parsed.input[4]).toEqual({
			type: "message",
			role: "user",
			content: "u1",
		});
	});

	it("no input / non-array input / no developer → byte-identical requestText", () => {
		const channel = makeChannel({ api_format: "responses" });

		const noInput = call(channel, {
			targetPath: "/v1/responses",
			requestText: '{"model":"m","stream":true}',
			parsedBody: { model: "m", stream: true },
			normalizeDeveloperRole: true,
		});
		const stringInput = call(channel, {
			targetPath: "/v1/responses",
			requestText: '{"model":"m","input":"hi"}',
			parsedBody: { model: "m", input: "hi" },
			normalizeDeveloperRole: true,
		});
		const noDeveloper = call(channel, {
			targetPath: "/v1/responses",
			requestText: '{"model":"m","input":[{"type":"message","role":"user"}]}',
			parsedBody: {
				model: "m",
				input: [{ type: "message", role: "user" }],
			},
			normalizeDeveloperRole: true,
		});

		expect(noInput.body).toBe('{"model":"m","stream":true}');
		expect(stringInput.body).toBe('{"model":"m","input":"hi"}');
		expect(noDeveloper.body).toBe(
			'{"model":"m","input":[{"type":"message","role":"user"}]}',
		);
	});
});

describe("flag on + disguise combined — single rewrite, normalize first (AC4)", () => {
	it("openai chat: renamed developer + disguise system first, one body, caller pristine", () => {
		const channel = makeChannel({ api_format: "openai" });
		const parsedBody = {
			model: "m",
			messages: [
				{ role: "developer", content: "d1" },
				{ role: "user", content: "u1" },
			],
		};

		const { body } = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
			disguisePrompt: PROMPT,
			normalizeDeveloperRole: true,
		});

		const parsed = JSON.parse(body as string) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(parsed.messages).toEqual([
			{ role: "system", content: PROMPT },
			{ role: "system", content: "d1" },
			{ role: "user", content: "u1" },
		]);
		// caller's shared parsed body stays pristine (retry rounds reuse it)
		const callerMessages = parsedBody.messages as Array<
			Record<string, unknown>
		>;
		expect(callerMessages).toHaveLength(2);
		expect(callerMessages[0].role).toBe("developer");
	});

	it("responses passthrough: renamed input + injected instructions, caller pristine", () => {
		const channel = makeChannel({ api_format: "responses" });
		const parsedBody = {
			model: "m",
			input: [{ type: "message", role: "developer", content: "d1" }],
		};

		const { body } = call(channel, {
			targetPath: "/v1/responses",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
			disguisePrompt: PROMPT,
			normalizeDeveloperRole: true,
		});

		const parsed = JSON.parse(body as string) as {
			instructions?: string;
			input: Array<Record<string, unknown>>;
		};
		expect(parsed.instructions).toBe(PROMPT);
		expect(parsed.input).toEqual([
			{ type: "message", role: "system", content: "d1" },
		]);
		const callerInput = parsedBody.input as Array<Record<string, unknown>>;
		expect(callerInput[0].role).toBe("developer");
	});

	it("disguise alone still rewrites (flag on, no developer): single stringify output equals flag-off disguise output", () => {
		const channel = makeChannel({ api_format: "openai" });
		const parsedBody = {
			model: "m",
			messages: [{ role: "user", content: "u1" }],
		};

		const withFlag = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
			disguisePrompt: PROMPT,
			normalizeDeveloperRole: true,
		});
		const withoutFlag = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
			disguisePrompt: PROMPT,
		});

		expect(withFlag.body).toBe(withoutFlag.body);
		expect(withFlag.body).not.toBe(JSON.stringify(parsedBody));
	});
});

describe("caller parsedBody isolation across retry rounds (two shared calls)", () => {
	// Real retry shape: the handler parses requestText once and reuses BOTH the
	// raw text and the parsed object for every round/channel. A rename leaking
	// into the shared parsedBody would make round 2 find no developer left and
	// silently fall back to the un-normalized requestText — reintroducing the
	// upstream 400 the flag exists to prevent. Mirrors client-disguise.test.ts
	// "#1 ... no retry accumulation" (first + second byte-identical).
	it("openai chat: two consecutive calls with shared parsedBody produce the identical normalized body", () => {
		const channel = makeChannel({ api_format: "openai" });
		const parsedBody = {
			model: "m",
			messages: [
				{ role: "developer", content: "d1" },
				{ role: "user", content: "u1" },
			],
		};
		const requestText = JSON.stringify(parsedBody);
		const args = {
			targetPath: "/v1/chat/completions",
			requestText,
			parsedBody,
			normalizeDeveloperRole: true,
		};

		const first = call(channel, args);
		const second = call(channel, args);

		expect(first.body).not.toBe(requestText); // round 1 normalized
		expect(second.body).toBe(first.body); // round 2 identical, no fallback
		const parsed = JSON.parse(first.body as string) as {
			messages: Array<{ role: string }>;
		};
		expect(parsed.messages[0].role).toBe("system");
		// shared parsed body never mutated — a third round would behave the same
		expect(
			(parsedBody.messages as Array<Record<string, unknown>>)[0].role,
		).toBe("developer");
	});

	it("responses passthrough: two consecutive calls with shared parsedBody produce the identical normalized body", () => {
		const channel = makeChannel({ api_format: "responses" });
		const parsedBody = {
			model: "m",
			input: [{ type: "message", role: "developer", content: "d1" }],
		};
		const requestText = JSON.stringify(parsedBody);
		const args = {
			targetPath: "/v1/responses",
			requestText,
			parsedBody,
			normalizeDeveloperRole: true,
		};

		const first = call(channel, args);
		const second = call(channel, args);

		expect(first.body).not.toBe(requestText);
		expect(second.body).toBe(first.body);
		const parsed = JSON.parse(first.body as string) as {
			input: Array<{ role: string }>;
		};
		expect(parsed.input[0].role).toBe("system");
		expect(
			(parsedBody.input as Array<Record<string, unknown>>)[0].role,
		).toBe("developer");
	});
});

describe("flag isolation — branches that must NOT normalize (design D3 matrix)", () => {
	it("anthropic target: flag on/off produce byte-identical bodies (converter already hoists)", () => {
		const channel = makeChannel({ api_format: "anthropic" });
		const parsedBody = {
			model: "m",
			messages: [
				{ role: "developer", content: "d1" },
				{ role: "user", content: "u1" },
			],
		};
		const args = {
			targetPath: "/v1/chat/completions",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
		};

		const on = call(channel, { ...args, normalizeDeveloperRole: true });
		const off = call(channel, { ...args });

		expect(on.body).toBe(off.body);
		const parsed = JSON.parse(on.body as string) as {
			system: unknown;
			messages: Array<{ role: string }>;
		};
		// converter hoists developer into the top-level system string either way
		expect(JSON.stringify(parsed.system)).toContain("d1");
		expect(
			parsed.messages.every((m) => m.role !== "developer"),
		).toBe(true);
	});

	it("responses target + chat inbound conversion: flag has no effect (hoists into instructions)", () => {
		const channel = makeChannel({ api_format: "responses" });
		const parsedBody = {
			model: "m",
			messages: [
				{ role: "developer", content: "d1" },
				{ role: "user", content: "u1" },
			],
		};
		const args = {
			targetPath: "/v1/chat/completions",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
		};

		const on = call(channel, { ...args, normalizeDeveloperRole: true });
		const off = call(channel, { ...args });

		expect(on.body).toBe(off.body);
		expect((JSON.parse(on.body as string) as { instructions?: string }).instructions).toContain(
			"d1",
		);
	});

	it("openai target + /v1/responses inbound conversion: flag has no effect (converter collects developer)", () => {
		const channel = makeChannel({ api_format: "openai" });
		const parsedBody = {
			model: "m",
			input: [{ type: "message", role: "developer", content: "d1" }],
		};
		const args = {
			targetPath: "/v1/responses",
			requestText: JSON.stringify(parsedBody),
			parsedBody,
		};

		const on = call(channel, { ...args, normalizeDeveloperRole: true });
		const off = call(channel, { ...args });

		expect(on.body).toBe(off.body);
	});

	it("custom target: body is never interpreted — byte-identical passthrough even with flag on", () => {
		const channel = makeChannel({ api_format: "custom" });
		const requestText =
			'{"model":"m","messages":[{"role":"developer","content":"d1"}]}';

		const { body } = call(channel, {
			targetPath: "/v1/chat/completions",
			requestText,
			parsedBody: JSON.parse(requestText) as Record<string, unknown>,
			normalizeDeveloperRole: true,
		});

		expect(body).toBe(requestText);
	});

	it("responses target + non-chat passthrough: byte-identical passthrough with flag on", () => {
		const channel = makeChannel({ api_format: "responses" });
		const requestText = '{"whatever":"payload"}';

		const { body } = call(channel, {
			targetPath: "/v1/embeddings",
			requestText,
			parsedBody: JSON.parse(requestText) as Record<string, unknown>,
			normalizeDeveloperRole: true,
		});

		expect(body).toBe(requestText);
	});
});
