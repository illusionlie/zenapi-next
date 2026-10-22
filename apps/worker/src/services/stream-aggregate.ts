import { safeJsonParse } from "../utils/json";
import { mergeRawUsage } from "../utils/usage";
import type { ChannelApiFormat } from "./channel-types";

/**
 * 上游 SSE 聚合器 —— 强制流式预设（services/client-presets.ts 的
 * forceUpstreamStream）的响应侧配套：客户端非流式但预设把上游 body 改写为
 * stream:true 时，上游以 SSE 回包，而 convertResponse 的非流分支期望 JSON。
 * 本模块全量消费上游 SSE 后合成为该协议的标准非流对象（application/json 的
 * 合成 Response）——客户端视角始终拿到非流响应，流式客户端路径不经过这里。
 *
 * fail-open 两级：
 *  1. 入口：!response.ok / 无 body / content-type 非 text/event-stream →
 *     原样返回。同时覆盖形状门禁未命中（embeddings 等 body 未被改写、上游
 *     并未真流式）的场景——无预设与未改写路径零行为变化。
 *  2. 逐事件：畸形行 / 未知事件 / 非 JSON data → 跳过 + 单条
 *     console.warn("[stream-aggregate]", …)，绝不让单个脏事件毁掉整个产物。
 * 截断流（干净 EOF 但无终止事件）→ 产出已聚合部分 + warn：显式降级优于抛错
 * （上游已 200，抛错只会把已成功的上游响应变成 500/502）。读取中途的流错误
 * 不吞（向上抛给调用方的 catch → 重试路径裁决——与「干净截断」不同类）。
 */

export type AggregateProtocol = "chat" | "anthropic" | "responses";

/**
 * 目标格式 → 聚合协议映射。custom 不可达（调用方守卫排除——协议未知不解释
 * 响应），缺省兜底 chat（openai 是渠道格式的历史默认值）。
 */
export function protocolForTargetFormat(
	format: ChannelApiFormat,
): AggregateProtocol {
	if (format === "anthropic") {
		return "anthropic";
	}
	if (format === "responses") {
		return "responses";
	}
	return "chat";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(reason: string, detail?: unknown): void {
	if (detail === undefined) {
		console.warn("[stream-aggregate]", reason);
		return;
	}
	console.warn("[stream-aggregate]", reason, detail);
}

/**
 * 全量消费上游 SSE body，收集全部 data: 行载荷。event:/id:/retry:/注释行
 * 一律忽略——responses 的事件类型以 JSON 对象的 type 字段为准（source of
 * truth，event: 行只是冗余标注）。
 */
async function readSseDataPayloads(
	body: ReadableStream<Uint8Array>,
): Promise<string[]> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const payloads: string[] = [];
	let buffer = "";
	const handleLine = (rawLine: string) => {
		const line = rawLine.trim();
		if (!line.startsWith("data:")) {
			return;
		}
		const payload = line.slice(5).trim();
		if (payload !== "") {
			payloads.push(payload);
		}
	};
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			handleLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
			newlineIndex = buffer.indexOf("\n");
		}
	}
	// 流末尾无换行符收尾的残余行
	if (buffer.trim() !== "") {
		handleLine(buffer);
	}
	return payloads;
}

function jsonResponse(payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * 消费上游 SSE 并合成为 protocol 对应的标准非流对象。见模块头注释的
 * fail-open 契约；原 Response 的 body 由本函数消费，产物是新 Response
 * （后续 clone 的错误 / usage 路径不受单次消费影响）。
 */
export async function aggregateUpstreamStream(
	protocol: AggregateProtocol,
	response: Response,
): Promise<Response> {
	// 入口 fail-open：非 2xx / 无 body / 非 SSE content-type 原样返回。
	const contentType = response.headers.get("content-type") ?? "";
	if (
		!response.ok ||
		!response.body ||
		!contentType.includes("text/event-stream")
	) {
		return response;
	}
	const payloads = await readSseDataPayloads(response.body);
	try {
		if (protocol === "chat") {
			return jsonResponse(aggregateChat(payloads));
		}
		if (protocol === "anthropic") {
			return jsonResponse(aggregateAnthropic(payloads));
		}
		return jsonResponse(aggregateResponses(payloads));
	} catch (error) {
		// 防御性兜底：聚合器逐事件 fail-open，正常不会到这里；body 已被消费、
		// 原响应不可复用，必须仍返回一个带响应体的 Response。
		warn("unexpected aggregation failure", error);
		return jsonResponse({
			error: {
				message: "upstream stream aggregation failed",
				type: "upstream_error",
			},
		});
	}
}

// —— chat 协议：增量 chunk 流 → chat.completion 标准非流对象 ——

type ToolCallAccumulator = {
	id: string | null;
	type: string | null;
	name: string | null;
	arguments: string;
};

function aggregateChat(payloads: string[]): Record<string, unknown> {
	let id: string | null = null;
	let model: string | null = null;
	let created: number | null = null;
	let content = "";
	let reasoningContent = "";
	let finishReason: string | null = null;
	let usage: Record<string, unknown> | null = null;
	const toolCalls = new Map<number, ToolCallAccumulator>();
	let sawDone = false;

	for (const payload of payloads) {
		// [DONE] 仅作终止信号消费，绝不进入产物
		if (payload === "[DONE]") {
			sawDone = true;
			break;
		}
		const chunk = safeJsonParse<unknown>(payload, null);
		if (!isRecord(chunk)) {
			warn("chat: non-JSON data line skipped");
			continue;
		}
		// 元数据取首见（首个 chunk 携带 id/model/created，后续空缺不覆盖）
		if (id === null && typeof chunk.id === "string") {
			id = chunk.id;
		}
		if (model === null && typeof chunk.model === "string") {
			model = chunk.model;
		}
		if (created === null && typeof chunk.created === "number") {
			created = chunk.created;
		}
		// usage：最后一个携带 usage 对象的 chunk 生效（include_usage 尾 chunk）
		if (isRecord(chunk.usage)) {
			usage = chunk.usage;
		}
		// 产物是单 choice 形状（choices[0]，index 0），只聚合首个 choice——
		// 强制流式请求不带 n，跨 choice 拼接只会产出损坏的消息
		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
		if (!isRecord(choice)) {
			continue;
		}
		const delta = isRecord(choice.delta) ? choice.delta : null;
		if (delta) {
			if (typeof delta.content === "string") {
				content += delta.content;
			}
			if (typeof delta.reasoning_content === "string") {
				reasoningContent += delta.reasoning_content;
			}
			if (Array.isArray(delta.tool_calls)) {
				for (const entry of delta.tool_calls) {
					if (!isRecord(entry)) {
						continue;
					}
					const index =
						typeof entry.index === "number" ? entry.index : toolCalls.size;
					const acc = toolCalls.get(index) ?? {
						id: null,
						type: null,
						name: null,
						arguments: "",
					};
					// id/type/function.name 首见生效，arguments 逐段拼接
					if (acc.id === null && typeof entry.id === "string") {
						acc.id = entry.id;
					}
					if (acc.type === null && typeof entry.type === "string") {
						acc.type = entry.type;
					}
					if (isRecord(entry.function)) {
						if (acc.name === null && typeof entry.function.name === "string") {
							acc.name = entry.function.name;
						}
						if (typeof entry.function.arguments === "string") {
							acc.arguments += entry.function.arguments;
						}
					}
					toolCalls.set(index, acc);
				}
			}
		}
		if (typeof choice.finish_reason === "string" && choice.finish_reason) {
			// finish_reason 取最后一个非空值（终止 chunk 生效）
			finishReason = choice.finish_reason;
		}
	}

	if (finishReason === null) {
		warn("chat: stream ended without finish_reason, defaulting to stop");
		finishReason = "stop";
	}
	if (!sawDone) {
		warn("chat: stream truncated without [DONE], emitting partial aggregate");
	}

	// 产物按「缺席可选字段直接省略」组装：纯 tool_calls 响应无 content 键，
	// 纯文本响应无 tool_calls 键，上游未报 usage 则整个 usage 键省略
	const message: Record<string, unknown> = { role: "assistant" };
	if (content !== "") {
		message.content = content;
	}
	if (reasoningContent !== "") {
		message.reasoning_content = reasoningContent;
	}
	if (toolCalls.size > 0) {
		message.tool_calls = [...toolCalls.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, acc]) => ({
				id: acc.id ?? "",
				type: acc.type ?? "function",
				function: { name: acc.name ?? "", arguments: acc.arguments },
			}));
	}
	const result: Record<string, unknown> = {
		id: id ?? "chatcmpl-aggregated",
		object: "chat.completion",
		created: created ?? Math.floor(Date.now() / 1000),
		model: model ?? "",
		choices: [{ index: 0, message, finish_reason: finishReason }],
	};
	if (usage) {
		result.usage = usage;
	}
	return result;
}

// —— anthropic 协议：事件流 → Messages 标准非流对象 ——

/**
 * tool_use 块的 input 定稿：累积 partial_json 整体 JSON.parse，空串（无任何
 * 片段）直接空对象，解析失败回退 {} + warn——绝不让脏 JSON 毁掉整个产物。
 */
function finalizeToolUseInput(
	block: Record<string, unknown>,
	rawJson: string,
	index: number,
): void {
	const trimmed = rawJson.trim();
	if (trimmed === "") {
		block.input = {};
		return;
	}
	const parsed = safeJsonParse<unknown>(rawJson, null);
	if (isRecord(parsed)) {
		block.input = parsed;
		return;
	}
	warn(
		`anthropic: tool_use input JSON parse failed at block ${index}, falling back to empty object`,
	);
	block.input = {};
}

function aggregateAnthropic(payloads: string[]): Record<string, unknown> {
	// message_start 的 message 对象提供 id/model/usage 基线
	let baselineId: string | null = null;
	let baselineModel: string | null = null;
	let usage: Record<string, unknown> | null = null;
	const blocks = new Map<number, Record<string, unknown>>();
	const partialJson = new Map<number, string>();
	let stopReason: string | null = null;
	let sawStop = false;

	for (const payload of payloads) {
		// [DONE] 不是 anthropic 协议的标记，出现即外来噪音，静默跳过
		if (payload === "[DONE]") {
			continue;
		}
		const event = safeJsonParse<unknown>(payload, null);
		if (!isRecord(event) || typeof event.type !== "string") {
			warn("anthropic: non-JSON data line skipped");
			continue;
		}
		switch (event.type) {
			case "message_start": {
				const message = isRecord(event.message) ? event.message : null;
				if (!message) {
					warn("anthropic: message_start without message object skipped");
					break;
				}
				if (typeof message.id === "string") {
					baselineId = message.id;
				}
				if (typeof message.model === "string") {
					baselineModel = message.model;
				}
				if (isRecord(message.usage)) {
					usage = { ...message.usage };
				}
				break;
			}
			case "content_block_start": {
				const index =
					typeof event.index === "number" ? event.index : blocks.size;
				const block: Record<string, unknown> = isRecord(event.content_block)
					? { ...event.content_block }
					: { type: "text", text: "" };
				// start 携带的 partial_json 首片兜底（design D6）；partial_json
				// 是流式合并过程物，不进产物
				if (
					block.type === "tool_use" &&
					typeof block.partial_json === "string"
				) {
					partialJson.set(index, block.partial_json);
					delete block.partial_json;
				}
				blocks.set(index, block);
				break;
			}
			case "content_block_delta": {
				const index = typeof event.index === "number" ? event.index : -1;
				const delta = isRecord(event.delta) ? event.delta : null;
				const block = blocks.get(index);
				if (!delta || !block) {
					warn(
						"anthropic: delta without delta object or for unknown block skipped",
					);
					break;
				}
				switch (delta.type) {
					case "text_delta":
						block.text =
							(typeof block.text === "string" ? block.text : "") +
							(typeof delta.text === "string" ? delta.text : "");
						break;
					case "thinking_delta":
						block.thinking =
							(typeof block.thinking === "string" ? block.thinking : "") +
							(typeof delta.thinking === "string" ? delta.thinking : "");
						break;
					case "signature_delta":
						block.signature =
							(typeof block.signature === "string" ? block.signature : "") +
							(typeof delta.signature === "string" ? delta.signature : "");
						break;
					case "input_json_delta":
						partialJson.set(
							index,
							(partialJson.get(index) ?? "") +
								(typeof delta.partial_json === "string"
									? delta.partial_json
									: ""),
						);
						break;
					default:
						warn(`anthropic: unknown delta type ${String(delta.type)} skipped`);
				}
				break;
			}
			case "content_block_stop": {
				const index = typeof event.index === "number" ? event.index : -1;
				const block = blocks.get(index);
				// 定稿守卫按「是否累积过 partial_json」判定，而非 block.input ===
				// undefined——真实 Anthropic 流的 content_block_start 对 tool_use
				// 恒携带 input:{}（协议形状），input 判空会让 input_json_delta 的
				// 累积整体丢失。start 首片（partial_json）与 delta 累积都落在
				// partialJson 表，有累积即定稿；定稿后清理，截断兜底不重复解析。
				const raw = partialJson.get(index);
				if (block && block.type === "tool_use" && raw !== undefined) {
					finalizeToolUseInput(block, raw, index);
					partialJson.delete(index);
				}
				break;
			}
			case "message_delta": {
				if (
					isRecord(event.delta) &&
					typeof event.delta.stop_reason === "string"
				) {
					stopReason = event.delta.stop_reason;
				}
				// usage 是累计值非增量（spec format-conversion §3.5 红线）：直取
				// 并按非 null 覆盖语义合并进基线（utils/usage mergeRawUsage 同款），
				// 绝不二次累加
				if (isRecord(event.usage)) {
					usage = usage
						? mergeRawUsage(usage, event.usage)
						: { ...event.usage };
				}
				break;
			}
			case "message_stop":
				sawStop = true;
				break;
			case "ping":
				// 心跳保活，无载荷
				break;
			default:
				warn(`anthropic: unknown event ${event.type} skipped`);
		}
	}

	// 截断流：未收到 content_block_stop 的 tool_use 块以已累积的 partial_json
	// 兜底定稿——同样按 partial_json 累积判定（真实流的 start input:{} 不能
	// 阻断定稿）；无累积且 input 缺失（非标准 start）才回退空对象。
	for (const [index, block] of blocks) {
		if (
			block.type === "tool_use" &&
			(partialJson.has(index) || block.input === undefined)
		) {
			finalizeToolUseInput(block, partialJson.get(index) ?? "", index);
		}
	}
	if (!sawStop) {
		warn(
			"anthropic: stream truncated without message_stop, emitting partial aggregate",
		);
	}

	// 产物：标准 Message 对象（缺席 usage 时整键省略，下游解析链容错）
	const result: Record<string, unknown> = {
		id: baselineId ?? "msg_aggregated",
		type: "message",
		role: "assistant",
		model: baselineModel ?? "",
		content: [...blocks.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, block]) => block),
		stop_reason: stopReason,
		stop_sequence: null,
	};
	if (usage) {
		result.usage = usage;
	}
	return result;
}

// —— responses 协议：终事件携带完整 response 对象，直取即产物 ——

function aggregateResponses(payloads: string[]): Record<string, unknown> {
	let failed: Record<string, unknown> | null = null;

	for (const payload of payloads) {
		// [DONE] 不是 responses 协议的标记，静默跳过
		if (payload === "[DONE]") {
			continue;
		}
		const event = safeJsonParse<unknown>(payload, null);
		if (!isRecord(event)) {
			warn("responses: non-JSON data line skipped");
			continue;
		}
		// 事件类型以 JSON 的 type 字段为准（event: 行已在行解析层忽略）；
		// response.completed 自带完整 response（research §8），直取即产物
		if (event.type === "response.completed" && isRecord(event.response)) {
			return event.response;
		}
		if (event.type === "response.failed" && isRecord(event.response)) {
			// completed 未出现时的兜底（failed response 自带 error 载荷）
			failed = event.response;
		}
		// 其余事件（response.created / *.delta / ...）无需消费
	}
	if (failed) {
		warn(
			"responses: stream ended with response.failed, using failed response object",
		);
		return failed;
	}
	warn("responses: stream ended without response.completed");
	return {
		error: {
			message: "upstream stream ended without response.completed",
			type: "upstream_error",
		},
	};
}
