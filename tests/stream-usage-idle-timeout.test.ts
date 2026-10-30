/**
 * 流式 usage 解析的有界终止（任务 10-30-stream-usage-idle-timeout）。
 *
 * 背景：`parseUsageFromSse` 在 waitUntil 域解析 clone 流；客户端断开后
 * tee 出的 clone 分支可能永远 pending，原 `while(true) reader.read()` 无界
 * 挂起 → waitUntil 窗口耗尽被 CF 取消 → 计费链整段不执行 → usage 行静默
 * 丢失（线上 2026-10-26 起系统性复现，见任务 prd.md）。
 *
 * 锁定契约：
 * - `data: [DONE]` 是 OpenAI 形态协议级流尾：收到即返回，不等流关闭；
 * - 单次 read() 闲置超过 idleTimeoutMs 视为流终止，按已收数据返回；
 * - 正常完整流（发送方规范 close）行为零变化。
 */
import { describe, expect, it } from "vitest";
import { parseUsageFromSse } from "../apps/worker/src/utils/usage";

const encoder = new TextEncoder();

/** chunks 依次入队；close=false 时流永不关闭（模拟客户端断开后的 clone 悬挂）。 */
function sseResponse(chunks: string[], close = true): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			if (close) {
				controller.close();
			}
		},
	});
	return new Response(stream);
}

const USAGE_CHUNK =
	'data: {"id":"x","choices":[{"delta":{"content":"hi"}}]}\n\n';

const FINAL_USAGE_CHUNK =
	'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n';

describe("parseUsageFromSse bounded termination", () => {
	it("returns immediately on [DONE] without waiting for stream close", async () => {
		// [DONE] 之后流永不关闭 —— 旧实现会挂在这里。
		const started = Date.now();
		const result = await parseUsageFromSse(
			sseResponse([USAGE_CHUNK, FINAL_USAGE_CHUNK, "data: [DONE]\n\n"], false),
		);
		const elapsed = Date.now() - started;

		expect(result.usage).not.toBeNull();
		expect(result.usage?.totalTokens).toBe(15);
		expect(result.usage?.promptTokens).toBe(10);
		expect(result.usage?.completionTokens).toBe(5);
		// 提前返回：不得消耗任何人为等待（宽松上界防 CI 抖动）。
		expect(elapsed).toBeLessThan(1000);
	});

	it("idle timeout returns partial usage when stream stalls mid-way", async () => {
		// 发了 usage chunk 后永久静默且不关闭 —— 闲置超时兜底。
		const started = Date.now();
		const result = await parseUsageFromSse(
			sseResponse([FINAL_USAGE_CHUNK], false),
			undefined,
			{ idleTimeoutMs: 50 },
		);
		const elapsed = Date.now() - started;

		expect(result.usage?.totalTokens).toBe(15);
		expect(elapsed).toBeGreaterThanOrEqual(40);
		expect(elapsed).toBeLessThan(5000);
	});

	it("idle timeout yields null usage for a stream that never sends data", async () => {
		const result = await parseUsageFromSse(sseResponse([], false), undefined, {
			idleTimeoutMs: 30,
		});
		expect(result.usage).toBeNull();
		expect(result.firstTokenLatencyMs).toBeNull();
	});

	it("well-formed closed stream keeps legacy behavior", async () => {
		const result = await parseUsageFromSse(
			sseResponse([USAGE_CHUNK, FINAL_USAGE_CHUNK, "data: [DONE]\n\n"], true),
		);
		expect(result.usage?.totalTokens).toBe(15);
		expect(result.firstTokenLatencyMs).not.toBeNull();
		expect(result.elapsedMs).not.toBeNull();
	});
});
