import { describe, expect, it } from "vitest";
import {
	type InboundProtocol,
	inboundProtocolForPath,
	selectTargetFormat,
} from "../apps/worker/src/services/channel-routing";
import type { ChannelApiFormat } from "../apps/worker/src/services/channel-types";

const PROTOCOLS: InboundProtocol[] = [
	"chat",
	"responses",
	"anthropic",
	"passthrough",
];

describe("inboundProtocolForPath", () => {
	it("classifies chat completions inbound", () => {
		expect(inboundProtocolForPath("/v1/chat/completions")).toBe("chat");
	});

	it("classifies responses inbound", () => {
		expect(inboundProtocolForPath("/v1/responses")).toBe("responses");
	});

	it("classifies anthropic inbound by /anthropic/v1 prefix", () => {
		expect(inboundProtocolForPath("/anthropic/v1/messages")).toBe("anthropic");
		expect(inboundProtocolForPath("/anthropic/v1")).toBe("anthropic");
	});

	it("classifies other /v1/* paths as passthrough", () => {
		expect(inboundProtocolForPath("/v1/embeddings")).toBe("passthrough");
		expect(inboundProtocolForPath("/v1/models")).toBe("passthrough");
		expect(inboundProtocolForPath("/v1/moderation")).toBe("passthrough");
	});

	it("is case-insensitive and prefix-based, matching legacy routing", () => {
		expect(inboundProtocolForPath("/V1/CHAT/COMPLETIONS")).toBe("chat");
		expect(inboundProtocolForPath("/v1/responses/extra")).toBe("responses");
		expect(inboundProtocolForPath("/ANTHROPIC/V1/messages")).toBe("anthropic");
	});

	it("defaults unknown paths to passthrough", () => {
		expect(inboundProtocolForPath("/")).toBe("passthrough");
		expect(inboundProtocolForPath("/api/channels")).toBe("passthrough");
	});
});

describe("selectTargetFormat — single-format behavior-preservation matrix", () => {
	/**
	 * 4 格式 × 4 协议 = 16 格逐一断言。每格等价于既有路由结果（任务
	 * 10-27-responses-anthropic-pivot 起 16 格中仅 2 格翻转：斜边从
	 * 「无转换排除」变为经 chat 枢纽的 pivot 兜底目标，其余 14 格不变）：
	 *   - chat 入站全格式可服务（openai 直通 / responses·anthropic 转换 /
	 *     custom 原样）；
	 *   - responses 入站：responses·openai 单跳、anthropic 经 chat pivot、
	 *     custom 防御；
	 *   - anthropic 入站对称（responses 经 chat pivot）；
	 *   - passthrough 与旧 allowedFormatsForPath 非 chat 分支一致（anthropic
	 *     仍排除——透传域无转换边）。
	 */
	const EXPECTED: Record<ChannelApiFormat, Record<InboundProtocol, ChannelApiFormat | null>> = {
		openai: {
			chat: "openai",
			responses: "openai",
			anthropic: "openai",
			passthrough: "openai",
		},
		responses: {
			chat: "responses",
			responses: "responses",
			anthropic: "responses",
			passthrough: "responses",
		},
		anthropic: {
			chat: "anthropic",
			responses: "anthropic",
			anthropic: "anthropic",
			passthrough: null,
		},
		custom: {
			chat: "custom",
			responses: "custom",
			anthropic: "custom",
			passthrough: "custom",
		},
	};

	for (const format of Object.keys(EXPECTED) as ChannelApiFormat[]) {
		for (const inbound of PROTOCOLS) {
			it(`${format} channel × ${inbound} inbound → ${EXPECTED[format][inbound] ?? "null (excluded)"}`, () => {
				expect(selectTargetFormat([format], inbound)).toBe(
					EXPECTED[format][inbound],
				);
			});
		}
	}
});

describe("selectTargetFormat — multi-format preference matrix", () => {
	it("prefers openai for chat and passthrough, anthropic natively for anthropic inbound", () => {
		const declared: ChannelApiFormat[] = ["openai", "anthropic"];
		expect(selectTargetFormat(declared, "chat")).toBe("openai");
		expect(selectTargetFormat(declared, "responses")).toBe("openai");
		expect(selectTargetFormat(declared, "anthropic")).toBe("anthropic");
		expect(selectTargetFormat(declared, "passthrough")).toBe("openai");
	});

	it("prefers native responses when declared", () => {
		const declared: ChannelApiFormat[] = ["openai", "responses"];
		expect(selectTargetFormat(declared, "chat")).toBe("openai");
		expect(selectTargetFormat(declared, "responses")).toBe("responses");
		expect(selectTargetFormat(declared, "anthropic")).toBe("openai");
		expect(selectTargetFormat(declared, "passthrough")).toBe("openai");
	});

	it("routes chat to responses conversion when openai is not declared", () => {
		const declared: ChannelApiFormat[] = ["responses", "anthropic"];
		expect(selectTargetFormat(declared, "chat")).toBe("responses");
		expect(selectTargetFormat(declared, "responses")).toBe("responses");
		expect(selectTargetFormat(declared, "anthropic")).toBe("anthropic");
		expect(selectTargetFormat(declared, "passthrough")).toBe("responses");
	});

	it("pivot is last-resort: single-hop targets always win over the two-hop path (AC4)", () => {
		// responses 入站：仅声明 anthropic → anthropic pivot 兜底目标
		expect(selectTargetFormat(["anthropic"], "responses")).toBe("anthropic");
		// 声明 [openai, anthropic]：openai 单跳优先于 anthropic pivot
		expect(
			selectTargetFormat(["anthropic", "openai"] as ChannelApiFormat[], "responses"),
		).toBe("openai");
		// anthropic 入站对称：仅声明 responses → responses pivot；
		// 声明 [openai, responses] → openai 单跳优先于 responses pivot
		expect(selectTargetFormat(["responses"], "anthropic")).toBe("responses");
		expect(
			selectTargetFormat(["responses", "openai"] as ChannelApiFormat[], "anthropic"),
		).toBe("openai");
	});

	it("is independent of declaration order — preference order always wins", () => {
		const declared: ChannelApiFormat[] = ["anthropic", "openai"];
		expect(selectTargetFormat(declared, "chat")).toBe("openai");
		expect(selectTargetFormat(declared, "responses")).toBe("openai");
		expect(selectTargetFormat(declared, "anthropic")).toBe("anthropic");
	});

	it("falls through to the next preferred declared format (preference order, not exclusion)", () => {
		// responses 入站偏好序 responses > openai > anthropic：声明无 responses
		// → 落到 openai（anthropic pivot 仅在 openai 也不在声明集时兜底）
		expect(
			selectTargetFormat(["anthropic", "openai"] as ChannelApiFormat[], "responses"),
		).toBe("openai");
		// anthropic 入站对称：声明无 anthropic → 落到 openai
		expect(
			selectTargetFormat(["responses", "openai"] as ChannelApiFormat[], "anthropic"),
		).toBe("openai");
	});

	it("returns null when nothing declared is serviceable", () => {
		for (const inbound of PROTOCOLS) {
			expect(selectTargetFormat([], inbound)).toBeNull();
		}
		// 仅声明 anthropic：passthrough 入站排除（透传域无转换边）；
		// responses 入站自 pivot 起可服务（见上方偏好序用例）
		expect(selectTargetFormat(["anthropic"], "passthrough")).toBeNull();
		// 仅声明 responses：anthropic 入站自 pivot 起可服务
		expect(selectTargetFormat(["responses"], "anthropic")).toBe("responses");
		expect(selectTargetFormat(["responses"], "passthrough")).toBe("responses");
	});

	it("defensively prefers openai over custom if a custom combination ever leaked through", () => {
		// normalizeApiFormats 已禁 custom 组合；此处仅验证偏好序兜底语义
		const leaked = ["custom", "openai"] as ChannelApiFormat[];
		expect(selectTargetFormat(leaked, "chat")).toBe("openai");
		expect(selectTargetFormat(["custom"], "responses")).toBe("custom");
	});
});
