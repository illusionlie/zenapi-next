import { describe, expect, it } from "vitest";
import {
	normalizeChatDeveloperRole,
	normalizeResponsesDeveloperRole,
} from "../apps/worker/src/services/format-converter";

/**
 * developer 角色透传归一化纯函数矩阵（design.md D2 / AC2 / AC3）：
 * 原位改名（保序、保内容、不合并）——与 openaiToAnthropicRequest /
 * convertResponsesInputItem 的「hoist + 拼接 + 消息消失」语义刻意不同。
 */

describe("normalizeChatDeveloperRole", () => {
	it("renames a single developer message in place, order and content preserved", () => {
		const developer = { role: "developer", content: "coding rules" };
		const user = { role: "user", content: "hi" };
		const body: Record<string, unknown> = {
			model: "m",
			messages: [developer, user],
		};

		expect(normalizeChatDeveloperRole(body)).toBe(true);
		expect(body.messages).toEqual([
			{ role: "system", content: "coding rules" },
			{ role: "user", content: "hi" },
		]);
	});

	it("renames multiple developer messages without merging, interleaved roles keep positions", () => {
		const body: Record<string, unknown> = {
			messages: [
				{ role: "developer", content: "d1" },
				{ role: "user", content: "u1" },
				{ role: "developer", content: "d2" },
				{ role: "assistant", content: "a1" },
				{ role: "developer", content: "d3" },
			],
		};

		expect(normalizeChatDeveloperRole(body)).toBe(true);
		expect(body.messages).toEqual([
			{ role: "system", content: "d1" },
			{ role: "user", content: "u1" },
			{ role: "system", content: "d2" },
			{ role: "assistant", content: "a1" },
			{ role: "system", content: "d3" },
		]);
	});

	it("preserves multimodal content parts untouched (same reference, zero-touch)", () => {
		const multimodalContent = [
			{ type: "text", text: "see this" },
			{ type: "image_url", image_url: { url: "https://example.com/a.png" } },
		];
		const developer = { role: "developer", content: multimodalContent };
		const body: Record<string, unknown> = { messages: [developer] };

		expect(normalizeChatDeveloperRole(body)).toBe(true);
		const renamed = (body.messages as Array<Record<string, unknown>>)[0];
		expect(renamed.role).toBe("system");
		// content object passed through by reference — parts never rebuilt
		expect(renamed.content).toBe(multimodalContent);
	});

	it("keeps empty-content developer messages (rename only)", () => {
		const body: Record<string, unknown> = {
			messages: [
				{ role: "developer", content: "" },
				{ role: "developer", content: null },
			],
		};

		expect(normalizeChatDeveloperRole(body)).toBe(true);
		expect(body.messages).toEqual([
			{ role: "system", content: "" },
			{ role: "system", content: null },
		]);
	});

	it("never touches tool / other roles", () => {
		const tool = { role: "tool", tool_call_id: "t1", content: "result" };
		const body: Record<string, unknown> = {
			messages: [tool, { role: "user", content: "q" }],
		};

		const changed = normalizeChatDeveloperRole(body);
		expect(changed).toBe(false);
		expect((body.messages as unknown[])[0]).toBe(tool);
	});

	it("returns false and leaves the body alone when no developer message exists (caller falls back to byte passthrough)", () => {
		const body: Record<string, unknown> = {
			messages: [
				{ role: "system", content: "s" },
				{ role: "user", content: "u" },
			],
		};

		expect(normalizeChatDeveloperRole(body)).toBe(false);
		expect(body.messages).toEqual([
			{ role: "system", content: "s" },
			{ role: "user", content: "u" },
		]);
	});

	it("returns false for missing / non-array messages without crashing", () => {
		expect(normalizeChatDeveloperRole({ model: "m" })).toBe(false);
		expect(normalizeChatDeveloperRole({ messages: "not-an-array" })).toBe(
			false,
		);
		// non-object entries are skipped, not fatal
		const body: Record<string, unknown> = { messages: [null, 42, "x"] };
		expect(normalizeChatDeveloperRole(body)).toBe(false);
	});
});

describe("normalizeResponsesDeveloperRole", () => {
	it("renames message items with developer role, order preserved", () => {
		const body: Record<string, unknown> = {
			model: "m",
			input: [
				{ type: "message", role: "developer", content: "rules" },
				{ type: "message", role: "user", content: "hi" },
				{ type: "message", role: "developer", content: "more rules" },
			],
		};

		expect(normalizeResponsesDeveloperRole(body)).toBe(true);
		expect(body.input).toEqual([
			{ type: "message", role: "system", content: "rules" },
			{ type: "message", role: "user", content: "hi" },
			{ type: "message", role: "system", content: "more rules" },
		]);
	});

	it("never touches function_call / function_call_output / reasoning items", () => {
		const functionCall = {
			type: "function_call",
			name: "get_weather",
			call_id: "call_1",
			arguments: "{}",
		};
		const functionCallOutput = {
			type: "function_call_output",
			call_id: "call_1",
			output: "sunny",
		};
		const reasoning = {
			type: "reasoning",
			summary: [{ type: "summary_text", text: "thinking" }],
		};
		const body: Record<string, unknown> = {
			input: [
				{ type: "message", role: "developer", content: "rules" },
				functionCall,
				functionCallOutput,
				reasoning,
			],
		};

		expect(normalizeResponsesDeveloperRole(body)).toBe(true);
		const input = body.input as unknown[];
		expect(input[1]).toBe(functionCall);
		expect(input[2]).toBe(functionCallOutput);
		expect(input[3]).toBe(reasoning);
	});

	it("developer role on non-message item types is NOT renamed (type gate)", () => {
		const body: Record<string, unknown> = {
			input: [{ type: "function_call", role: "developer", name: "f" }],
		};

		expect(normalizeResponsesDeveloperRole(body)).toBe(false);
		expect((body.input as Array<Record<string, unknown>>)[0].role).toBe(
			"developer",
		);
	});

	it("returns false and passes through when input is missing or non-array", () => {
		expect(normalizeResponsesDeveloperRole({ model: "m" })).toBe(false);
		expect(
			normalizeResponsesDeveloperRole({ input: "plain string input" }),
		).toBe(false);

		// missing input on an otherwise valid body: caller keeps requestText
		const body: Record<string, unknown> = { model: "m", stream: true };
		const before = JSON.stringify(body);
		normalizeResponsesDeveloperRole(body);
		expect(JSON.stringify(body)).toBe(before);
	});

	it("skips non-object entries without crashing", () => {
		const body: Record<string, unknown> = {
			input: [null, "text", { type: "message", role: "developer" }],
		};

		expect(normalizeResponsesDeveloperRole(body)).toBe(true);
		expect((body.input as Array<Record<string, unknown>>)[2].role).toBe(
			"system",
		);
	});
});
