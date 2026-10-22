import { describe, expect, it } from "vitest";
import { buildChannelRequest } from "../apps/worker/src/routes/proxy";
import {
	applyClientPreset,
	ensureToolConformance,
} from "../apps/worker/src/services/client-presets";
import type { ChannelRecord } from "../apps/worker/src/services/channels";

/**
 * body 形状合规矩阵（design D5，AC6 + AC1）：
 * - AC6：非流 chat 入站 + 各目标 → 上游 body stream:true + tools 含 bash 且
 *   ≥2（chat 嵌套 function / anthropic input_schema / responses 扁平三形状）；
 *   流式客户端 body 不被改写 stream 字段；形状门禁未命中（embeddings 等）
 *   不注入不写 stream。
 * - AC1：disguise_preset 为 NULL 的渠道 buildChannelRequest 输出与入站
 *   requestText 逐字节一致；同输入两次构建逐字节一致（重试守护）。
 */

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

/** 工具名提取（chat 嵌套 function.name 优先，anthropic/responses 扁平 name）。 */
function toolNames(tools: unknown): string[] {
	if (!Array.isArray(tools)) return [];
	return tools.map((tool) => {
		const t = tool as Record<string, unknown>;
		const fn = t.function as Record<string, unknown> | undefined;
		return (fn?.name ?? t.name) as string;
	});
}

const CHAT_MESSAGES = [{ role: "user", content: "hi" }];

describe("ensureToolConformance — injection matrix (three protocol shapes)", () => {
	it("no tools key → bash + read + edit appended in the chat nested shape", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
		};
		expect(ensureToolConformance(body, "openai")).toBe(true);
		const names = toolNames(body.tools);
		expect(names).toEqual(["bash", "read", "edit"]);
		const bash = (body.tools as Array<Record<string, unknown>>)[0];
		expect(bash.type).toBe("function");
		const fn = bash.function as Record<string, unknown>;
		expect(fn.name).toBe("bash");
		expect(typeof fn.description).toBe("string");
		expect(fn.parameters).toMatchObject({ type: "object" });
	});

	it("≥2 tools with bash present → untouched, returns false (no re-serialization trigger)", () => {
		const existing = [
			{
				type: "function",
				function: { name: "bash", description: "mine", parameters: {} },
			},
			{
				type: "function",
				function: { name: "search", description: "d", parameters: {} },
			},
		];
		const body: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
			tools: existing,
		};
		expect(ensureToolConformance(body, "openai")).toBe(false);
		// 同一数组引用、内容不变
		expect(body.tools).toBe(existing);
	});

	it("≥2 tools without bash → only bash appended (no read/edit padding)", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
			tools: [
				{ name: "search", description: "d" },
				{ name: "fetch", description: "d" },
			],
		};
		expect(ensureToolConformance(body, "anthropic")).toBe(true);
		const tools = body.tools as Array<Record<string, unknown>>;
		expect(toolNames(tools)).toEqual(["search", "fetch", "bash"]);
		// anthropic 形状：parameters 改名 input_schema
		expect(tools[2].input_schema).toMatchObject({ type: "object" });
		expect(tools[2].parameters).toBeUndefined();
	});

	it("single tool without bash → bash appended, total reaches 2 so no read/edit padding", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
			tools: [{ name: "search", description: "d" }],
		};
		expect(ensureToolConformance(body, "responses")).toBe(true);
		const tools = body.tools as Array<Record<string, unknown>>;
		expect(toolNames(tools)).toEqual(["search", "bash"]);
		// responses 扁平形状：{type:"function", name, ...}
		expect(tools[1]).toMatchObject({ type: "function", name: "bash" });
		expect(tools[1].function).toBeUndefined();
	});

	it("non-array tools (dirty shape) → fail-open untouched", () => {
		const body: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
			tools: "not-an-array",
		};
		expect(ensureToolConformance(body, "openai")).toBe(false);
		expect(body.tools).toBe("not-an-array");
	});

	it("custom target → never touches the body (protocol unknown)", () => {
		const body: Record<string, unknown> = { model: "m" };
		expect(ensureToolConformance(body, "custom")).toBe(false);
		expect(body.tools).toBeUndefined();
	});
});

describe("applyClientPreset.transformBody — stream forcing and shape guard", () => {
	function preset(
		targetFormat: "openai" | "responses" | "anthropic" | "custom",
		isStream: boolean,
	) {
		const applied = applyClientPreset("opencode_zen_v1", {
			targetFormat,
			parsedBody: { model: "m", messages: CHAT_MESSAGES },
			isStream,
		});
		expect(applied).not.toBeNull();
		return applied!;
	}

	it("stream:true is written only when the client is non-stream (forceUpstreamStream)", () => {
		const clientStream = preset("openai", true);
		const streamingBody: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
		};
		// 已合规工具集（≥2 含 bash）→ 无任何修改，stream 字段不被写入
		streamingBody.tools = [
			{
				type: "function",
				function: { name: "bash", description: "d", parameters: {} },
			},
			{
				type: "function",
				function: { name: "search", description: "d", parameters: {} },
			},
		];
		expect(clientStream.transformBody(streamingBody)).toBe(false);
		expect(streamingBody.stream).toBeUndefined();

		const nonStreamBody: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
			tools: streamingBody.tools,
		};
		const clientNonStream = preset("openai", false);
		expect(clientNonStream.transformBody(nonStreamBody)).toBe(true);
		expect(nonStreamBody.stream).toBe(true);

		// 流式客户端已有 stream:true 保持不动（不重复写、不改值）
		const alreadyStreaming: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
			stream: true,
			tools: streamingBody.tools,
		};
		expect(clientStream.transformBody(alreadyStreaming)).toBe(false);
		expect(alreadyStreaming.stream).toBe(true);
	});

	it("shape guard: embeddings-like body (no messages array) is left untouched", () => {
		const applied = preset("openai", false);
	 const embeddings: Record<string, unknown> = {
			model: "e",
			input: "hello world",
		};
		const before = JSON.stringify(embeddings);
		expect(applied.transformBody(embeddings)).toBe(false);
		expect(JSON.stringify(embeddings)).toBe(before);
		expect(embeddings.tools).toBeUndefined();
		expect(embeddings.stream).toBeUndefined();
	});

	it("responses target shape gate: string or array input qualifies, other bodies do not", () => {
		const applied = preset("responses", false);
		const stringInput: Record<string, unknown> = { model: "m", input: "hi" };
		expect(applied.transformBody(stringInput)).toBe(true);
		expect(stringInput.stream).toBe(true);
		expect(toolNames(stringInput.tools)).toContain("bash");
	});

	it("custom target: transform no-op and never forces streaming", () => {
		const applied = applyClientPreset("opencode_zen_v1", {
			targetFormat: "custom",
			parsedBody: { model: "m", messages: CHAT_MESSAGES },
			isStream: false,
		});
		expect(applied).not.toBeNull();
		expect(applied?.forceUpstreamStream).toBe(false);
		const body: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
		};
		expect(applied?.transformBody(body)).toBe(false);
		expect(body.stream).toBeUndefined();
		expect(body.tools).toBeUndefined();
	});
});

describe("buildChannelRequest × preset — end-to-end body compliance", () => {
	const PRESET_CHANNEL = makeChannel({
		api_format: "openai",
		disguise_preset: "opencode_zen_v1",
	});

	it("AC1: no-preset channel keeps the raw requestText byte-for-byte", () => {
		const channel = makeChannel({ api_format: "openai" });
		// 双空格 + 紧凑键序：任何 JSON 往返都会改变字节
		const requestText =
			'{"model":"m",  "messages":[{"role":"user","content":"hi"}]}';
		const { body } = buildChannelRequest(
			channel,
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			JSON.parse(requestText) as Record<string, unknown>,
			false,
			"sk-call",
		);
		expect(body).toBe(requestText);
	});

	it("AC6: non-stream chat + openai target → upstream body stream:true + bash + ≥2 tools", () => {
		const parsedBody: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
		};
		const requestText = JSON.stringify(parsedBody);
		const { body } = buildChannelRequest(
			PRESET_CHANNEL,
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			parsedBody,
			false,
			"sk-call",
		);
		expect(body).not.toBe(requestText);
		const upstream = JSON.parse(body ?? "{}") as Record<string, unknown>;
		expect(upstream.stream).toBe(true);
		const names = toolNames(upstream.tools);
		expect(names).toContain("bash");
		expect(names.length).toBeGreaterThanOrEqual(2);
	});

	it("AC6: streaming client + preset → stream field untouched (stays client-controlled)", () => {
		const parsedBody: Record<string, unknown> = {
			model: "m",
			stream: true,
			messages: CHAT_MESSAGES,
		};
		const { body } = buildChannelRequest(
			PRESET_CHANNEL,
			"/v1/chat/completions",
			"",
			new Headers(),
			JSON.stringify(parsedBody),
			parsedBody,
			true,
			"sk-call",
		);
		const upstream = JSON.parse(body ?? "{}") as Record<string, unknown>;
		expect(upstream.stream).toBe(true);
		// 工具注入仍生效（门禁与流式无关），但 stream 字段值由客户端决定
		expect(toolNames(upstream.tools)).toContain("bash");
	});

	it("shape guard end-to-end: preset channel + embeddings body → byte-identical requestText", () => {
		const requestText = '{"model":"e",  "input":"hello"}';
		const { body } = buildChannelRequest(
			PRESET_CHANNEL,
			"/v1/embeddings",
			"",
			new Headers(),
			requestText,
			JSON.parse(requestText) as Record<string, unknown>,
			false,
			"sk-call",
		);
		expect(body).toBe(requestText);
	});

	it("retry guard: two builds with the shared parsedBody produce byte-identical bodies and no caller mutation", () => {
		const parsedBody: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
		};
		const requestText = JSON.stringify(parsedBody);
		const first = buildChannelRequest(
			PRESET_CHANNEL,
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			parsedBody,
			false,
			"sk-call",
		);
		const second = buildChannelRequest(
			PRESET_CHANNEL,
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			parsedBody,
			false,
			"sk-call",
		);
		expect(first.body).not.toBe(requestText);
		expect(second.body).toBe(first.body);
		// 共享 parsedBody 永不被 mutate（重试轮/换渠道安全）
		expect(parsedBody.tools).toBeUndefined();
		expect(parsedBody.stream).toBeUndefined();
		expect(
			(parsedBody.messages as unknown[]).length,
		).toBe(1);
	});

	it("AC6: responses inbound + openai target → converted chat body carries stream:true + tools", () => {
		const parsedBody: Record<string, unknown> = {
			model: "m",
			input: "hi",
		};
		const { body } = buildChannelRequest(
			PRESET_CHANNEL,
			"/v1/responses",
			"",
			new Headers(),
			JSON.stringify(parsedBody),
			parsedBody,
			false,
			"sk-call",
		);
		const upstream = JSON.parse(body ?? "{}") as Record<string, unknown>;
		expect(upstream.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(upstream.stream).toBe(true);
		// 强制流式的 chat 上游必须带 usage 尾 chunk 开关（上游真流式才有 usage
		// 可解析）——与 handler 层注入条件 isStream || presetForceStream 同源
		expect(upstream.stream_options).toEqual({ include_usage: true });
		const names = toolNames(upstream.tools);
		expect(names).toContain("bash");
		expect(names.length).toBeGreaterThanOrEqual(2);
	});

	it("AC6: anthropic target → converted body carries anthropic-shaped tools + stream:true", () => {
		const parsedBody: Record<string, unknown> = {
			model: "m",
			messages: [{ role: "system", content: "sys" }, ...CHAT_MESSAGES],
		};
		const { body } = buildChannelRequest(
			makeChannel({
				api_format: "anthropic",
				disguise_preset: "opencode_zen_v1",
			}),
			"/v1/chat/completions",
			"",
			new Headers(),
			JSON.stringify(parsedBody),
			parsedBody,
			false,
			"sk-call",
		);
		const upstream = JSON.parse(body ?? "{}") as Record<string, unknown>;
		expect(upstream.stream).toBe(true);
		const tools = upstream.tools as Array<Record<string, unknown>>;
		expect(toolNames(tools)).toEqual(["bash", "read", "edit"]);
		expect(tools[0].input_schema).toMatchObject({ type: "object" });
		// system 已由转换器 hoist（预设不改写 system 语义）
		expect(JSON.stringify(upstream.system)).toContain("sys");
	});

	it("AC6: responses target + chat inbound → converted body carries flat tools + stream:true", () => {
		const parsedBody: Record<string, unknown> = {
			model: "m",
			messages: CHAT_MESSAGES,
		};
		const { body } = buildChannelRequest(
			makeChannel({
				api_format: "responses",
				disguise_preset: "opencode_zen_v1",
			}),
			"/v1/chat/completions",
			"",
			new Headers(),
			JSON.stringify(parsedBody),
			parsedBody,
			false,
			"sk-call",
		);
		const upstream = JSON.parse(body ?? "{}") as Record<string, unknown>;
		expect(upstream.stream).toBe(true);
		const tools = upstream.tools as Array<Record<string, unknown>>;
		expect(toolNames(tools)).toContain("bash");
		expect(tools[0]).toMatchObject({ type: "function" });
		expect(tools[0].function).toBeUndefined();
	});

	it("custom target + preset: body byte-identical (headers-only effect, covered in headers suite)", () => {
		const requestText = "raw-custom-payload";
		const { body } = buildChannelRequest(
			makeChannel({
				api_format: "custom",
				base_url: "https://upstream.example/endpoint",
				disguise_preset: "opencode_zen_v1",
			}),
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			{ messages: CHAT_MESSAGES },
			false,
			"sk-call",
		);
		expect(body).toBe(requestText);
	});
});
