import { describe, expect, it } from "vitest";
import { buildChannelRequest } from "../apps/worker/src/routes/proxy";
import type { ChannelRecord } from "../apps/worker/src/services/channels";
import type { ProxyHeaderPolicy } from "../apps/worker/src/utils/proxy-headers";

function makeChannel(overrides: Partial<ChannelRecord> = {}): ChannelRecord {
	return {
		id: "ch1",
		name: "test-channel",
		base_url: "https://main.example/v1",
		api_key: "sk-channel",
		weight: 1,
		status: "active",
		api_format: "openai",
		api_formats: JSON.stringify(["openai"]),
		endpoint_overrides: null,
		models_json: JSON.stringify([{ id: "test-model" }]),
		...overrides,
	};
}

function buildWithHeaders(incoming: Headers, policy?: ProxyHeaderPolicy | null) {
	return buildChannelRequest(
		makeChannel(),
		"/v1/chat/completions",
		"",
		incoming,
		JSON.stringify({ model: "m", messages: [] }),
		{ model: "m", messages: [] },
		false,
		"sk-call",
		policy,
	);
}

describe("buildChannelRequest privacy header strip", () => {
	it("strips CF identity / forwarding headers and cookie from the upstream request", () => {
		const incoming = new Headers({
			// CF 边缘注入的身份/转发头（大小写变体一并命中——Headers 名大小写不敏感）
			"CF-Connecting-IP": "1.2.3.4",
			"cf-ipcountry": "CN",
			"cf-visitor": '{"scheme":"https"}',
			"cf-ray": "abc123",
			"cf-worker": "true",
			"true-client-ip": "1.2.3.4",
			"X-Forwarded-For": "1.2.3.4, 10.0.0.1",
			"x-forwarded-proto": "https",
			"x-forwarded-host": "gw.example",
			"X-Real-IP": "1.2.3.4",
			"cdn-loop": "cloudflare",
			cookie: "session=secret",
		});
		const { headers } = buildWithHeaders(incoming);
		for (const name of [
			"cf-connecting-ip",
			"cf-ipcountry",
			"cf-visitor",
			"cf-ray",
			"cf-worker",
			"true-client-ip",
			"x-forwarded-for",
			"x-forwarded-proto",
			"x-forwarded-host",
			"x-real-ip",
			"cdn-loop",
			"cookie",
		]) {
			expect(headers.get(name), name).toBeNull();
		}
	});

	it("keeps host / content-length stripping intact and passes through unlisted headers", () => {
		const incoming = new Headers({
			host: "gw.example",
			"content-length": "123",
			"anthropic-beta": "context-1m",
			"x-stainless-lang": "js",
			"x-custom-app": "keep-me",
			authorization: "Bearer sk-call",
		});
		const { headers } = buildWithHeaders(incoming);
		expect(headers.get("host")).toBeNull();
		expect(headers.get("content-length")).toBeNull();
		// 未列清单的头继续透传（blocklist 哲学）
		expect(headers.get("anthropic-beta")).toBe("context-1m");
		expect(headers.get("x-stainless-lang")).toBe("js");
		expect(headers.get("x-custom-app")).toBe("keep-me");
	});

	it("global inject (settings extra headers) can explicitly re-add a stripped header", () => {
		const incoming = new Headers({
			"cf-connecting-ip": "1.2.3.4",
			"x-forwarded-for": "1.2.3.4",
		});
		const { headers } = buildWithHeaders(incoming, {
			extraHeaders: { "x-forwarded-for": "9.9.9.9" },
			removeHeaders: [],
		});
		// 剥离先行，全局注入后应用——管理员显式意图优先
		expect(headers.get("x-forwarded-for")).toBe("9.9.9.9");
		// 未被注入回的剥离头保持剥离
		expect(headers.get("cf-connecting-ip")).toBeNull();
	});

	it("anthropic target branch strips the same list (shared choke point)", () => {
		const incoming = new Headers({
			"cf-connecting-ip": "1.2.3.4",
			cookie: "session=secret",
			"anthropic-beta": "tools-2024",
		});
		const { headers } = buildChannelRequest(
			makeChannel({ api_format: "anthropic", api_formats: JSON.stringify(["anthropic"]) }),
			"/v1/chat/completions",
			"",
			incoming,
			JSON.stringify({ model: "m", messages: [] }),
			{ model: "m", messages: [] },
			false,
			"sk-call",
		);
		expect(headers.get("cf-connecting-ip")).toBeNull();
		expect(headers.get("cookie")).toBeNull();
		expect(headers.get("anthropic-beta")).toBe("tools-2024");
	});
});
