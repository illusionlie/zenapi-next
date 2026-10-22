import { describe, expect, it } from "vitest";
import { buildChannelRequest } from "../apps/worker/src/routes/proxy";
import { applyClientPreset } from "../apps/worker/src/services/client-presets";
import type { ChannelRecord } from "../apps/worker/src/services/channels";
import {
	applyHeaderPolicy,
	type ProxyHeaderPolicy,
} from "../apps/worker/src/utils/proxy-headers";

/**
 * 服务端预设头矩阵与覆盖链（design D4，AC4/AC5）：
 * - AC4：opencode_zen_v1 × 四目标格式 → UA 按协议分段（custom 沿用 chat 段）、
 *   Accept / client / session 双头同值 / request / project 全量断言；
 *   anthropic-beta 仅 anthropic 目标且派生规则命中时出现。
 * - AC5：applyHeaderPolicy 五层顺序（剔除 → 全局注入 → 预设 → 伪装 → custom，
 *   后应用者赢）：全局剔除可删预设头、全局注入不覆盖预设头、伪装覆盖预设、
 *   custom 再覆盖；模板解析仍是伪装独占域（预设/全局/custom 字面值）。
 */

const SES_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const MSG_SHAPE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const CHAT_BODY: Record<string, unknown> = {
	model: "gpt-4o",
	messages: [{ role: "user", content: "hi" }],
};

// claude-sonnet-4-5 命中结构化输出能力表 + 无 type 工具 → structured-outputs 旗标
const ANTHROPIC_BODY: Record<string, unknown> = {
	model: "claude-sonnet-4-5",
	max_tokens: 1024,
	messages: [{ role: "user", content: "hi" }],
	tools: [{ name: "get_weather", input_schema: { type: "object" } }],
};

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

function presetHeaders(
	targetFormat: "openai" | "responses" | "anthropic" | "custom",
	parsedBody: Record<string, unknown> = CHAT_BODY,
): Record<string, string> {
	const preset = applyClientPreset("opencode_zen_v1", {
		targetFormat,
		parsedBody,
		isStream: false,
	});
	expect(preset).not.toBeNull();
	return preset?.headers ?? {};
}

describe("AC4 — UA segments per target format", () => {
	it("openai target carries the chat SDK segment (4.0.23)", () => {
		expect(presetHeaders("openai")["User-Agent"]).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
		);
	});

	it("responses target carries the responses SDK segment (4.0.40)", () => {
		expect(presetHeaders("responses")["User-Agent"]).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",
		);
	});

	it("anthropic target carries the anthropic SDK segment (4.0.46)", () => {
		expect(presetHeaders("anthropic")["User-Agent"]).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.46 runtime/bun/1.3.14",
		);
	});

	it("custom target falls back to the chat SDK segment (protocol unknown)", () => {
		expect(presetHeaders("custom")["User-Agent"]).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
		);
	});
});

describe("AC4 — full identity header matrix", () => {
	it("emits Accept/client/session dual/request/project for every target format", () => {
		for (const targetFormat of [
			"openai",
			"responses",
			"anthropic",
			"custom",
		] as const) {
			const headers = presetHeaders(targetFormat);
			expect(headers.Accept, `Accept for ${targetFormat}`).toBe("*/*");
			expect(
				headers["x-opencode-client"],
				`x-opencode-client for ${targetFormat}`,
			).toBe("cli");
			// v1 双头同值（research §2）
			expect(
				headers["x-opencode-session"],
				`x-opencode-session for ${targetFormat}`,
			).toMatch(SES_SHAPE);
			expect(
				headers["x-opencode-session-id"],
				`x-opencode-session-id for ${targetFormat}`,
			).toBe(headers["x-opencode-session"]);
			expect(
				headers["x-opencode-request"],
				`x-opencode-request for ${targetFormat}`,
			).toMatch(MSG_SHAPE);
			// 上游只验形状不验值；global 非 prj_ 形状
			expect(
				headers["x-opencode-project"],
				`x-opencode-project for ${targetFormat}`,
			).toBe("global");
			// 鉴权头不在预设层（渠道 Key 体系注入）
			expect(headers.Authorization).toBeUndefined();
			expect(headers["x-api-key"]).toBeUndefined();
		}
	});

	it("session IDs are deterministic for the same body across targets (hash-derived, not random)", () => {
		const openai = presetHeaders("openai");
		const anthropic = presetHeaders("anthropic");
		expect(anthropic["x-opencode-session"]).toBe(openai["x-opencode-session"]);
	});

	it("anthropic-beta appears only for the anthropic target when a derivation rule hits", () => {
		// claude-sonnet-4-5 + 无 type 工具 → structured-outputs 旗标（research §5）
		const headers = presetHeaders("anthropic", ANTHROPIC_BODY);
		expect(headers["anthropic-beta"]).toBe("structured-outputs-2025-11-13");

		// 同 body 的其他目标不携带 anthropic-beta
		for (const targetFormat of ["openai", "responses", "custom"] as const) {
			expect(presetHeaders(targetFormat, ANTHROPIC_BODY)["anthropic-beta"]).toBeUndefined();
		}
	});

	it("anthropic-beta stays absent when no rule hits (no claude model, no flagged tools)", () => {
		const noHit = presetHeaders("anthropic", {
			model: "gpt-4o",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "get_weather", input_schema: { type: "object" } }],
		});
		expect(noHit["anthropic-beta"]).toBeUndefined();
	});

	it("mcp_servers / typed tools map to their beta flags (research §5 table)", () => {
		const withMcp = presetHeaders("anthropic", {
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hi" }],
			mcp_servers: [{ name: "m", url: "https://m.example" }],
		});
		expect(withMcp["anthropic-beta"]).toContain("mcp-client-2025-04-04");

		const withTypedTool = presetHeaders("anthropic", {
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "code_execution_20250522", name: "run" }],
		});
		expect(withTypedTool["anthropic-beta"]).toBe("code-execution-2025-05-22");
	});
});

describe("AC5 — applyHeaderPolicy five-layer order (preset as layer 3)", () => {
	const policy: ProxyHeaderPolicy = {
		extraHeaders: { "User-Agent": "global-ua", "X-Trace-Id": "global" },
		removeHeaders: ["x-opencode-client"],
	};

	it("global remove deletes a preset header; global inject does NOT clobber preset values", () => {
		const headers = new Headers();
		applyHeaderPolicy(headers, policy, null, null, {
			"User-Agent": "preset-ua",
			"x-opencode-client": "cli",
			"X-Trace-Id": "preset-wins-over-inject",
		});
		// 剔除先于预设 → 预设头可被全局剔除删除
		expect(headers.get("x-opencode-client")).toBeNull();
		// 全局注入先应用 → 预设值不被覆盖（后应用者赢：预设 > 注入）
		expect(headers.get("user-agent")).toBe("preset-ua");
		expect(headers.get("x-trace-id")).toBe("preset-wins-over-inject");
	});

	it("disguise_headers_json overrides preset; custom_headers_json overrides both", () => {
		const headers = new Headers();
		applyHeaderPolicy(
			headers,
			null,
			'{"User-Agent":"channel-ua","X-Channel":"1"}',
			'{"User-Agent":"disguise-ua","X-Disguise":"1"}',
			{ "User-Agent": "preset-ua", "X-Preset": "1" },
		);
		expect(headers.get("user-agent")).toBe("channel-ua");
		expect(headers.get("x-preset")).toBe("1");
		expect(headers.get("x-disguise")).toBe("1");
		expect(headers.get("x-channel")).toBe("1");
	});

	it("disguise alone overrides preset when custom is absent (with null policy, Playground exemption)", () => {
		const headers = new Headers({ "user-agent": "client" });
		applyHeaderPolicy(
			headers,
			null,
			null,
			'{"User-Agent":"disguise-ua"}',
			{ "User-Agent": "preset-ua" },
		);
		expect(headers.get("user-agent")).toBe("disguise-ua");
		// policy null：预设与伪装仍生效，全局层跳过
	});

	it("template resolution stays a disguise-only domain (preset values are literal)", () => {
		const headers = new Headers();
		applyHeaderPolicy(
			headers,
			null,
			'{"X-Custom-Tpl":"{{uuid}}"}',
			'{"X-Disguise-Tpl":"{{uuid}}"}',
			{ "X-Preset-Tpl": "{{uuid}}" },
		);
		// 预设值已求值、字面注入——{{uuid}} 原样保留
		expect(headers.get("x-preset-tpl")).toBe("{{uuid}}");
		// 伪装值 call-time 渲染
		expect(headers.get("x-disguise-tpl")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		// custom 值字面发送
		expect(headers.get("x-custom-tpl")).toBe("{{uuid}}");
	});

	it("omitting the fifth param behaves exactly like the four-param contract (zero regression)", () => {
		const headers = new Headers();
		applyHeaderPolicy(
			headers,
			{ extraHeaders: { "X-Trace-Id": "global" }, removeHeaders: [] },
			'{"X-Channel":"1"}',
		);
		expect(headers.get("x-trace-id")).toBe("global");
		expect(headers.get("x-channel")).toBe("1");
	});
});

describe("AC5 — preset header chain through buildChannelRequest (wiring level)", () => {
	it("preset headers land on the upstream request; disguise can override the preset UA", () => {
		const presetOnly = makeChannel({
			api_format: "openai",
			disguise_preset: "opencode_zen_v1",
		});
		const requestText = JSON.stringify(CHAT_BODY);
		const withPreset = buildChannelRequest(
			presetOnly,
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			CHAT_BODY,
			false,
			"sk-call",
		);
		expect(withPreset.headers.get("x-opencode-client")).toBe("cli");
		expect(withPreset.headers.get("x-opencode-session")).toMatch(SES_SHAPE);
		expect(withPreset.headers.get("user-agent")).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
		);

		// 伪装头同名覆盖预设 UA（后应用者赢）
		const withDisguise = makeChannel({
			api_format: "openai",
			disguise_preset: "opencode_zen_v1",
			disguise_headers_json: '{"User-Agent":"disguise-ua"}',
		});
		const overridden = buildChannelRequest(
			withDisguise,
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			CHAT_BODY,
			false,
			"sk-call",
		);
		expect(overridden.headers.get("user-agent")).toBe("disguise-ua");
		// 非同名预设头不受影响
		expect(overridden.headers.get("x-opencode-client")).toBe("cli");

		// 渠道级 custom 再覆盖
		const withCustom = makeChannel({
			api_format: "openai",
			disguise_preset: "opencode_zen_v1",
			disguise_headers_json: '{"User-Agent":"disguise-ua"}',
			custom_headers_json: '{"User-Agent":"channel-ua"}',
		});
		const final = buildChannelRequest(
			withCustom,
			"/v1/chat/completions",
			"",
			new Headers(),
			requestText,
			CHAT_BODY,
			false,
			"sk-call",
		);
		expect(final.headers.get("user-agent")).toBe("channel-ua");
	});

	it("anthropic target: preset headers ride the anthropic branch alongside built-in auth headers", () => {
		const channel = makeChannel({
			api_format: "anthropic",
			disguise_preset: "opencode_zen_v1",
		});
		const { headers } = buildChannelRequest(
			channel,
			"/v1/chat/completions",
			"",
			new Headers(),
			JSON.stringify(ANTHROPIC_BODY),
			ANTHROPIC_BODY,
			false,
			"sk-call",
		);
		expect(headers.get("x-api-key")).toBe("sk-call");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(headers.get("user-agent")).toBe(
			"opencode/1.19.3 ai-sdk/provider-utils/4.0.46 runtime/bun/1.3.14",
		);
		expect(headers.get("x-opencode-session")).toMatch(SES_SHAPE);
		expect(headers.get("anthropic-beta")).toBe("structured-outputs-2025-11-13");
	});
});
