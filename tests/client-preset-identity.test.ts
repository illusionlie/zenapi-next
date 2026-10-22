import { describe, expect, it } from "vitest";
import {
	deriveOpencodeMessageId,
	deriveOpencodeSessionId,
} from "../apps/worker/src/services/client-presets";
import {
	genOpencodeRequestId,
	genOpencodeSessionId,
} from "../apps/worker/src/utils/client-disguise";

/**
 * 服务端预设身份 ID 派生矩阵（design D3，AC2/AC3）：
 * - AC2 会话 ID：同一 body 两次构建相同；首条用户消息不同则不同；黄金布局
 *   正则（`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` 且时间部落
 *   `^[0-9a-f]{9}f[c-f][0-9a-f]$` 活体窗口）。
 * - AC3 消息 ID：同一（会话信号，回合）两次构建相同；末条用户消息变化则
 *   变化；带 tool_result 的 user 消息不计新回合；布局黄金断言。
 * 另锚定：信号提取矩阵（system string/blocks/instructions）、确定性跨
 * 「历史增长」稳定、null / 无信号 body 回退旧生成器（fail-open，形状合规）。
 */

const SES_SHAPE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const SES_TIME_WINDOW = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
const MSG_SHAPE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function chatBody(
	messages: Array<Record<string, unknown>>,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { model: "m", messages, ...extra };
}

/** ses 12-hex 时间部解码：取反后低 12 bit 应为 counter（活体窗口 1–63）。 */
function sessionCounter(timeHex: string): bigint {
	const inverted = ~BigInt(`0x${timeHex}`) & 0xfffn;
	return inverted;
}

describe("AC2 — session ID layout goldens", () => {
	it("matches ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$ and the descending time-part window regex", () => {
		const body = chatBody([{ role: "user", content: "hello world" }]);
		const id = deriveOpencodeSessionId(body);
		expect(id).toMatch(SES_SHAPE);
		const timePart = id.slice(4, 16);
		// 2026-09-16 门禁活体窗口：counter 落 1–63（低 12 hex ∈ f[c-f][0-9a-f]）
		expect(timePart).toMatch(SES_TIME_WINDOW);
		// 降序布局 = ~(ts<<12 | counter)：本实现 counter 恒 1（CanonicalSessionID
		// 同构），取反可解出 counter === 1
		expect(sessionCounter(timePart)).toBe(1n);
	});

	it("time part is pure hex while the tail segment is base62", () => {
		const id = deriveOpencodeSessionId(
			chatBody([{ role: "user", content: "another" }]),
		);
		expect(id.slice(4, 16)).toMatch(/^[0-9a-f]{12}$/);
		expect(id.slice(16)).toMatch(/^[0-9A-Za-z]{14}$/);
	});
});

describe("AC2 — signal extraction matrix (same signal → same session)", () => {
	it("system as string + first user text drives the signal", () => {
		const a = chatBody(
			[{ role: "system", content: "sys-1" }, { role: "user", content: "u-1" }],
		);
		const b = chatBody(
			[{ role: "system", content: "sys-1" }, { role: "user", content: "u-1" }],
		);
		expect(deriveOpencodeSessionId(a)).toBe(deriveOpencodeSessionId(b));
	});

	it("system as text blocks joins block text; changing a block changes the ID", () => {
		const blocks = [
			{ type: "text", text: "be nice" },
			{ type: "text", text: "be terse" },
		];
		const a = chatBody(
			[{ role: "user", content: "u-1" }],
			{ system: blocks },
		);
		const b = chatBody(
			[{ role: "user", content: "u-1" }],
			{ system: blocks },
		);
		expect(deriveOpencodeSessionId(a)).toBe(deriveOpencodeSessionId(b));

		const changed = chatBody([{ role: "user", content: "u-1" }], {
			system: [blocks[0], { type: "text", text: "be verbose" }],
		});
		expect(deriveOpencodeSessionId(changed)).not.toBe(
			deriveOpencodeSessionId(a),
		);
	});

	it("non-text system blocks (images etc.) are ignored in the signal", () => {
		const a = chatBody([{ role: "user", content: "u-1" }], {
			system: [{ type: "image", source: { type: "base64", data: "AA" } }],
		});
		const b = chatBody([{ role: "user", content: "u-1" }]);
		expect(deriveOpencodeSessionId(a)).toBe(deriveOpencodeSessionId(b));
	});

	it("responses instructions + string input drive the signal", () => {
		const a = { model: "m", instructions: "resp-sys", input: "resp-user" };
		const b = { model: "m", instructions: "resp-sys", input: "resp-user" };
		expect(deriveOpencodeSessionId(a)).toBe(deriveOpencodeSessionId(b));

		const otherUser = { model: "m", instructions: "resp-sys", input: "other" };
		expect(deriveOpencodeSessionId(otherUser)).not.toBe(
			deriveOpencodeSessionId(a),
		);
	});

	it("first real user message counts; later messages do not affect the session", () => {
		const first = chatBody([{ role: "user", content: "first question" }]);
		const grown = chatBody([
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "second question" },
		]);
		// AC2：历史增长会话 ID 稳定（prompt-cache 亲和）
		expect(deriveOpencodeSessionId(grown)).toBe(
			deriveOpencodeSessionId(first),
		);

		const differentFirst = chatBody([
			{ role: "user", content: "different first question" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "second question" },
		]);
		// 首条用户消息不同 → 会话 ID 不同
		expect(deriveOpencodeSessionId(differentFirst)).not.toBe(
			deriveOpencodeSessionId(grown),
		);
	});
});

describe("AC2 — determinism", () => {
	it("the same body derives the identical session ID across calls (no randomness)", () => {
		const body = chatBody(
			[
				{ role: "system", content: "sys" },
				{ role: "user", content: "turn one" },
			],
			{ temperature: 0.7, stream: true },
		);
		expect(deriveOpencodeSessionId(body)).toBe(deriveOpencodeSessionId(body));
	});
});

describe("AC3 — message ID semantics", () => {
	it("matches ^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$ (ascending, no window regex)", () => {
		const id = deriveOpencodeMessageId(
			chatBody([{ role: "user", content: "hello world" }]),
		);
		expect(id).toMatch(MSG_SHAPE);
		expect(id.slice(4, 16)).toMatch(/^[0-9a-f]{12}$/);
		expect(id.slice(16)).toMatch(/^[0-9A-Za-z]{14}$/);
	});

	it("the same (session signal, turn) derives the identical message ID", () => {
		const body = chatBody([
			{ role: "system", content: "sys" },
			{ role: "user", content: "turn one" },
		]);
		expect(deriveOpencodeMessageId(body)).toBe(deriveOpencodeMessageId(body));
	});

	it("a new user turn changes the message ID while the session ID stays", () => {
		const turn1 = chatBody([{ role: "user", content: "q1" }]);
		const turn2 = chatBody([
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "q2" },
		]);
		expect(deriveOpencodeMessageId(turn2)).not.toBe(
			deriveOpencodeMessageId(turn1),
		);
		expect(deriveOpencodeSessionId(turn2)).toBe(deriveOpencodeSessionId(turn1));
	});

	it("tool_result-carrying user messages do not count as a new turn (agent-loop regurgitation)", () => {
		const turn1 = chatBody([{ role: "user", content: "run it" }]);
		const agentStep = chatBody([
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"ls"}' },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" },
				],
			},
		]);
		// 回灌消息不计新回合：同回合同消息 ID（research §4 userTurn 语义）
		expect(deriveOpencodeMessageId(agentStep)).toBe(
			deriveOpencodeMessageId(turn1),
		);
		expect(deriveOpencodeSessionId(agentStep)).toBe(
			deriveOpencodeSessionId(turn1),
		);

		// 回灌后用户再发言 → 新回合，消息 ID 变化
		const turn2 = chatBody([
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "bash", arguments: '{"command":"ls"}' },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_1", content: "file.txt" },
				],
			},
			{ role: "user", content: "thanks, now commit" },
		]);
		expect(deriveOpencodeMessageId(turn2)).not.toBe(
			deriveOpencodeMessageId(agentStep),
		);
	});
});

describe("null / signal-less bodies fall back to the legacy generators (fail-open)", () => {
	it("null body → legacy generator output, shape-valid and fresh per call", () => {
		const first = deriveOpencodeSessionId(null);
		const second = deriveOpencodeSessionId(null);
		expect(first).toMatch(SES_SHAPE);
		// 旧生成器 counter 恒 1 → 降序时间部同样落活体窗口
		expect(first.slice(4, 16)).toMatch(SES_TIME_WINDOW);
		expect(second).toMatch(SES_SHAPE);
		// 回退路径是每请求新造的旧生成器，非确定性 hash——两次结果不同证明
		// 走的不是派生分支
		expect(second).not.toBe(first);

		const msg = deriveOpencodeMessageId(null);
		expect(msg).toMatch(MSG_SHAPE);
		expect(deriveOpencodeMessageId(null)).not.toBe(msg);
	});

	it("bodies without any real user signal fall back with valid shapes", () => {
		const noUser = { model: "m", messages: [{ role: "assistant", content: "x" }] };
		expect(deriveOpencodeSessionId(noUser)).toMatch(SES_SHAPE);
		expect(deriveOpencodeMessageId(noUser)).toMatch(MSG_SHAPE);

		const empty = { model: "m" };
		expect(deriveOpencodeSessionId(empty)).toMatch(SES_SHAPE);
		expect(deriveOpencodeMessageId(empty)).toMatch(MSG_SHAPE);

		// 全为 tool_result 回灌、无任何真用户消息 → 信号不可用 → 回退
		const onlyToolResult = chatBody([
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "c1", content: "out" }],
			},
		]);
		expect(deriveOpencodeSessionId(onlyToolResult)).toMatch(SES_SHAPE);
		expect(deriveOpencodeMessageId(onlyToolResult)).toMatch(MSG_SHAPE);
	});

	it("fallback output stays distinct from the legacy generators' regex contract (zero drift)", () => {
		// 回退生成器即 utils/client-disguise 的旧函数，形状契约一致
		expect(genOpencodeSessionId()).toMatch(SES_SHAPE);
		expect(genOpencodeRequestId()).toMatch(MSG_SHAPE);
	});
});
