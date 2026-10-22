import {
	genOpencodeRequestId,
	genOpencodeSessionId,
} from "../utils/client-disguise";
import type { ChannelApiFormat } from "./channel-types";

/**
 * 服务端客户端预设引擎 —— 纯函数模块。
 *
 * 预设是代码常量而非配置：上游指纹（UA 版本 / 头表 / 工具集）随客户端发布
 * 漂移，本质是「随发版手工刷新的代码」；渠道行只存预设 ID 指针
 * （channels.disguise_preset，白名单 CLIENT_PRESET_IDS），指纹数据随代码
 * 发版刷新。本模块不读 DB / settings——唯一输入是 (presetId, ctx)。
 *
 * fail-open 契约：未知 / NULL 预设 ID → null（预设关闭，零回归）；body 无
 * 可用信号 → ID 派生回退 utils/client-disguise 旧生成器（形状仍合规）。
 * applyClientPreset 每次构建上游请求求值一次：headers 已含当次派生的会话 /
 * 消息 ID，交 applyHeaderPolicy 注入；transformBody mutate 调用方副本并返回
 * 是否有修改（返回 false 且无其他动作时调用方可回退原始字节，守住零重序列化）。
 * 同一 body 两次求值产出逐字节一致的头（确定性 ID，design D3）——重试轮 /
 * 换渠道 / 换 Key 天然会话稳定。
 */

export const CLIENT_PRESET_IDS = ["opencode_zen_v1"] as const;

export type ClientPresetId = (typeof CLIENT_PRESET_IDS)[number];

/** 随上游发布漂移的活值，集中一处便于手工刷新（research §2）。 */
export const OPENCODE_V1_VERSIONS = {
	client: "1.19.3",
	bun: "1.3.14",
	sdkChat: "4.0.23",
	sdkResponses: "4.0.40",
	sdkAnthropic: "4.0.46",
} as const;

export type PresetRequestContext = {
	targetFormat: ChannelApiFormat;
	parsedBody: Record<string, unknown> | null;
	// 客户端侧流式意图（入站 body stream === true）
	isStream: boolean;
};

export type AppliedPreset = {
	// 已求值（ID 已生成），交 applyHeaderPolicy 注入（D4 第 5 参，预设层不解释模板）
	headers: Record<string, string>;
	// 客户端非流但预设要求上游流式（body 合规的 stream 规则）
	forceUpstreamStream: boolean;
	// mutate 调用方副本（bodyCopy / 转换产物，绝不接收共享 parsedBody 本体），
	// 返回是否有修改
	transformBody(body: Record<string, unknown>): boolean;
};

/**
 * 按渠道行的预设 ID 求值当次请求的预设应用结果。
 * 未知 ID / NULL / 空白 → null（fail-open 关闭）。
 */
export function applyClientPreset(
	presetId: string | null | undefined,
	ctx: PresetRequestContext,
): AppliedPreset | null {
	if (typeof presetId !== "string") {
		return null;
	}
	const id = presetId.trim();
	if (id === "opencode_zen_v1") {
		return applyOpencodeZenV1(ctx);
	}
	return null;
}

/**
 * 该预设是否会在客户端非流式时强制上游流式（proxy handler 层
 * stream_options.include_usage 预注入判定用，design D5）：上游真流式才有
 * usage 尾 chunk 可解析。只认会置 forceUpstreamStream 的已知预设；NULL /
 * 未知 ID → false。custom 目标的例外（不强制流式）由调用方结合渠道目标
 * 格式自行排除——本函数只看预设身份，不含请求上下文。新增会强制流式的
 * 预设时同步更新此处。
 */
export function isStreamForcingPreset(
	presetId: string | null | undefined,
): boolean {
	return typeof presetId === "string" && presetId.trim() === "opencode_zen_v1";
}

function noopTransformBody(): boolean {
	return false;
}

function applyOpencodeZenV1(ctx: PresetRequestContext): AppliedPreset {
	const identity = deriveIdentity(ctx.parsedBody);
	// custom 目标：协议未知不解释 body —— headers 照发（与伪装头对 custom
	// 生效的现状一致），不强制流式、transform no-op（D2/D5）
	if (ctx.targetFormat === "custom") {
		return {
			headers: buildOpencodeV1Headers("custom", identity, ctx.parsedBody),
			forceUpstreamStream: false,
			transformBody: noopTransformBody,
		};
	}
	const forceUpstreamStream = !ctx.isStream;
	return {
		headers: buildOpencodeV1Headers(ctx.targetFormat, identity, ctx.parsedBody),
		forceUpstreamStream,
		transformBody: (body: Record<string, unknown>): boolean => {
			// 协议形状门禁（Gate B 修订）：门禁语义按对话体形状采集——chat /
			// anthropic 目标要求 messages 数组，responses 目标要求 input（string
			// 或数组）。embeddings 等无对话形状的 body 不适用：不做工具注入，更
			// 不写 stream:true（否则「强制流式」标记指向从未被改写的 body，响应
			// 侧聚合的 SSE 前提随之失真）。形状不符原样返回 false，调用方回退
			// 原始字节（零重序列化）。
			const shapeOk =
				ctx.targetFormat === "responses"
					? typeof body.input === "string" || Array.isArray(body.input)
					: Array.isArray(body.messages);
			if (!shapeOk) {
				return false;
			}
			let changed = ensureToolConformance(body, ctx.targetFormat);
			// stream 字段只在强制流式（客户端非流）时写入；流式客户端 body 不动
			if (forceUpstreamStream && body.stream !== true) {
				body.stream = true;
				changed = true;
			}
			return changed;
		},
	};
}

// —— 身份 ID 派生（同步、确定性；design D3 / research §3-§4）——
//
// 门禁只验形状（ses 降序 + counter 窗口 1–63 / msg 升序）与稳定性，不验 hash
// 算法；crypto.subtle 是异步接口，禁入同步签名 —— 用 FNV-1a（8 字节分块，
// BigInt 常量乘）+ splitmix64 finalizer 的 64-bit 混合代替。无随机段、无
// memo、跨 isolate 一致：同一 body 两次构建产出逐字节一致的 ID。

const MASK_36 = (1n << 36n) - 1n;
const MASK_48 = (1n << 48n) - 1n;
const MASK_64 = (1n << 64n) - 1n;
const FNV_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const SPLITMIX_GOLDEN = 0x9e3779b97f4a7c15n;
// opencode ID 的 base62 字母表（与 utils/client-disguise.ts B62 同表；彼处未导出）
const BASE62_ALPHABET =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** splitmix64 finalizer：64-bit 输入雪崩扩散。 */
function splitmix64(value: bigint): bigint {
	let x = value & MASK_64;
	x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
	x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
	return (x ^ (x >> 31n)) & MASK_64;
}

/** FNV-1a（8 字节分块）+ splitmix64 finalizer + 长度掺混 → 64-bit 混合值。 */
function mix64(input: string): bigint {
	const bytes = new TextEncoder().encode(input);
	let h = FNV_BASIS;
	const whole = bytes.length - (bytes.length % 8);
	for (let i = 0; i < whole; i += 8) {
		let chunk = 0n;
		for (let j = 0; j < 8; j++) {
			chunk = (chunk << 8n) | BigInt(bytes[i + j]);
		}
		h = ((h ^ chunk) * FNV_PRIME) & MASK_64;
	}
	if (whole < bytes.length) {
		let tail = 0n;
		for (let i = whole; i < bytes.length; i++) {
			tail = (tail << 8n) | BigInt(bytes[i]);
		}
		// 哨兵位：尾部全零字节与更短输入可区分
		tail |= 1n << BigInt(8 * (bytes.length - whole));
		h = ((h ^ tail) * FNV_PRIME) & MASK_64;
	}
	return splitmix64(h ^ BigInt(bytes.length));
}

/** 由种子派生的确定性 base62 尾段（splitmix64 输出流模 62，14 字符）。 */
function base62Tail(seed: bigint): string {
	let state = seed & MASK_64;
	let tail = "";
	for (let i = 0; i < 14; i++) {
		state = (state + SPLITMIX_GOLDEN) & MASK_64;
		tail += BASE62_ALPHABET[Number(splitmix64(state) % 62n)];
	}
	return tail;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** content 文本拼接：string 直取；数组取 type ∈ kinds 且带 string text 的块。 */
function joinBlockText(content: unknown, kinds: readonly string[]): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || typeof block.text !== "string") {
			continue;
		}
		const type = typeof block.type === "string" ? block.type : "";
		if (kinds.includes(type)) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** user 消息是否携带 tool_result 块（agent 循环回灌，不计回合，research §4）。 */
function carriesToolResult(content: unknown): boolean {
	if (!Array.isArray(content)) {
		return false;
	}
	return content.some(
		(block) => isRecord(block) && block.type === "tool_result",
	);
}

/** responses input 的首条真用户消息文本；string input 直取（本身即用户内容）。 */
function firstRealUserTextFromInput(input: unknown): string | null {
	if (typeof input === "string") {
		return input;
	}
	if (!Array.isArray(input)) {
		return null;
	}
	for (const item of input) {
		if (!isRecord(item) || item.role !== "user") {
			continue;
		}
		const type = typeof item.type === "string" ? item.type : undefined;
		if (type === undefined || type === "message") {
			// responses 用户内容 part：input_text（text 兜底防御）
			return joinBlockText(item.content, ["input_text", "text"]);
		}
	}
	return null;
}

/**
 * 会话信号：system 侧（chat 首条 user 之前的 role:"system" 消息 / anthropic
 * system 字段 string·text blocks / responses instructions）+ 首条真用户消息
 * 内容（chat/anthropic messages、responses input）。无任何真用户消息 → null
 * （调用方回退旧生成器）。
 */
function conversationSignal(body: Record<string, unknown>): string | null {
	const parts: string[] = [];
	const systemField = body.system;
	if (typeof systemField === "string") {
		if (systemField !== "") {
			parts.push(systemField);
		}
	} else if (Array.isArray(systemField)) {
		const text = joinBlockText(systemField, ["text"]);
		if (text !== "") {
			parts.push(text);
		}
	}
	if (typeof body.instructions === "string" && body.instructions !== "") {
		parts.push(body.instructions);
	}
	const messages = Array.isArray(body.messages) ? body.messages : null;
	let firstUserText: string | null = null;
	if (messages !== null) {
		for (const message of messages) {
			if (!isRecord(message)) {
				continue;
			}
			if (message.role === "user") {
				if (!carriesToolResult(message.content)) {
					firstUserText = joinBlockText(message.content, ["text"]);
				}
				// system 侧只收首条 user 之前的 role:"system"（含 user 全为
				// tool_result 回灌的消息——此时信号退回 responses input 兜底）
				break;
			}
			if (message.role === "system") {
				const text = joinBlockText(message.content, ["text"]);
				if (text !== "") {
					parts.push(text);
				}
			}
		}
	}
	if (firstUserText === null) {
		firstUserText = firstRealUserTextFromInput(body.input);
	}
	if (firstUserText === null) {
		return null;
	}
	parts.push(firstUserText);
	const signal = parts.join("\n");
	return signal.trim() === "" ? null : signal;
}

/**
 * 回合指纹：真用户回合计数（跳过携带 tool_result 的 user 消息）+ 末条真用户
 * 消息内容——同一用户回合内的所有请求（agent 循环 tool 步骤）派生同一消息 ID
 * （research §4）。仅在 conversationSignal 非空的路径调用（回合计数 ≥ 1）。
 */
function turnFingerprint(body: Record<string, unknown>): string {
	let turns = 0;
	let last = "";
	const messages = Array.isArray(body.messages) ? body.messages : null;
	if (messages !== null) {
		for (const message of messages) {
			if (
				!isRecord(message) ||
				message.role !== "user" ||
				carriesToolResult(message.content)
			) {
				continue;
			}
			turns += 1;
			last = joinBlockText(message.content, ["text"]);
		}
	} else if (Array.isArray(body.input)) {
		for (const item of body.input) {
			if (!isRecord(item) || item.role !== "user") {
				continue;
			}
			const type = typeof item.type === "string" ? item.type : undefined;
			if (type !== undefined && type !== "message") {
				continue;
			}
			turns += 1;
			last = joinBlockText(item.content, ["input_text", "text"]);
		}
	} else if (typeof body.input === "string") {
		turns = 1;
		last = body.input;
	}
	return `${turns}\x00${last}`;
}

/**
 * `ses_` 会话 ID：12 hex 降序时间部 + 14 base62 派生尾。36-bit 伪时间戳取自
 * 混合值（不用当前时间——同一对话跨请求会话稳定，保 prompt-cache 亲和），
 * `<<12 | 1`（counter 恒 1，落 1–63 活体窗口）后按位取反 ⇒ 低 12 hex 恒
 * `ffe`（research §3 CanonicalSessionID 同构）。body 无信号 → 旧生成器。
 */
export function deriveOpencodeSessionId(
	body: Record<string, unknown> | null,
): string {
	if (body === null) {
		return genOpencodeSessionId();
	}
	const signal = conversationSignal(body);
	if (signal === null) {
		return genOpencodeSessionId();
	}
	const mixed = mix64(`ses\x00${signal}`);
	const value = ((mixed & MASK_36) << 12n) | 1n;
	const time = (~value & MASK_48).toString(16).padStart(12, "0");
	return `ses_${time}${base62Tail(mixed)}`;
}

/**
 * `msg_` 消息 ID：12 hex 升序时间部（低 48 位混合值，升序侧无 counter 窗口
 * 门禁）+ 14 base62 派生尾；混合输入含回合指纹 ⇒ 同回合同 ID（research §4）。
 * body 无信号 → 旧生成器。
 */
export function deriveOpencodeMessageId(
	body: Record<string, unknown> | null,
): string {
	if (body === null) {
		return genOpencodeRequestId();
	}
	const signal = conversationSignal(body);
	if (signal === null) {
		return genOpencodeRequestId();
	}
	const mixed = mix64(`msg\x00${signal}\x00${turnFingerprint(body)}`);
	const time = (mixed & MASK_48).toString(16).padStart(12, "0");
	return `msg_${time}${base62Tail(mixed)}`;
}

type PresetIdentity = { sessionId: string; messageId: string };

function deriveIdentity(body: Record<string, unknown> | null): PresetIdentity {
	return {
		sessionId: deriveOpencodeSessionId(body),
		messageId: deriveOpencodeMessageId(body),
	};
}

// —— v1 头表（research §2 setV1Headers 全量；auth 头不在预设层，由既有
//    buildChannelRequest / 鉴权基建按渠道 Key 注入） ——

/**
 * anthropic-beta 按 body 派生（research §5，jasonxu114514/opencode2api
 * upstream.go v1AnthropicBetas 逐条移植，MIT）：AI SDK anthropic provider
 * 无固定旗标，从 body 特征（先）与工具 type（后）按序派生，无命中不设。
 */
const ANTHROPIC_TOOL_BETAS: Record<string, string> = {
	code_execution_20250522: "code-execution-2025-05-22",
	code_execution_20250825: "code-execution-2025-08-25",
	computer_20241022: "computer-use-2024-10-22",
	computer_20250124: "computer-use-2025-01-24",
	computer_20251124: "computer-use-2025-11-24",
	text_editor_20241022: "computer-use-2024-10-22",
	text_editor_20250124: "computer-use-2025-01-24",
	text_editor_20250429: "computer-use-2025-01-24",
	bash_20241022: "computer-use-2024-10-22",
	bash_20250124: "computer-use-2025-01-24",
	memory_20250818: "context-management-2025-06-27",
	web_fetch_20250910: "web-fetch-2025-09-10",
	web_fetch_20260209: "code-execution-web-tools-2026-02-09",
	web_search_20260209: "code-execution-web-tools-2026-02-09",
	advisor_20260301: "advisor-tool-2026-03-01",
};

// AI SDK anthropic provider 的模型能力表（有 structured output 的 Claude 4.x
// 已知清单），检查顺序与 Go 移植源一致
const STRUCTURED_OUTPUT_MODELS = [
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-fable-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-opus-4-6",
	"claude-sonnet-4-5",
	"claude-opus-4-5",
	"claude-haiku-4-5",
	"claude-opus-4-1",
];

const CLAUDE3_OR_OLDER = /claude-(?:instant(?:-|$)|v?2(?:$|[-.:])|3(?:$|[-.]))/;

function anthropicSupportsStructuredOutput(model: string): boolean {
	for (const supported of STRUCTURED_OUTPUT_MODELS) {
		if (model.includes(supported)) {
			return true;
		}
	}
	if (
		model.includes("claude-sonnet-4-") ||
		model.includes("claude-opus-4-") ||
		model.includes("claude-3-haiku") ||
		CLAUDE3_OR_OLDER.test(model)
	) {
		return false;
	}
	return model.includes("claude-");
}

function isPresent(value: unknown): boolean {
	return value !== undefined && value !== null;
}

function deriveAnthropicBetas(body: Record<string, unknown>): string {
	const betas: string[] = [];
	const add = (beta: string) => {
		if (!betas.includes(beta)) {
			betas.push(beta);
		}
	};
	if (Array.isArray(body.mcp_servers) && body.mcp_servers.length > 0) {
		add("mcp-client-2025-04-04");
	}
	if (isRecord(body.context_management)) {
		add("context-management-2025-06-27");
		if (Array.isArray(body.context_management.edits)) {
			for (const edit of body.context_management.edits) {
				if (isRecord(edit) && edit.type === "compact_20260112") {
					add("compact-2026-01-12");
				}
			}
		}
	}
	if (isRecord(body.container)) {
		const skills = body.container.skills;
		if (Array.isArray(skills) && skills.length > 0) {
			add("code-execution-2025-08-25");
			add("skills-2025-10-02");
			add("files-api-2025-04-14");
		}
	}
	if (
		isRecord(body.output_config) &&
		isPresent(body.output_config.task_budget)
	) {
		add("task-budgets-2026-03-13");
	}
	if (body.speed === "fast") {
		add("fast-mode-2026-02-01");
	}
	if (body.fallbacks === "default") {
		add("server-side-fallback-2026-07-01");
	} else if (Array.isArray(body.fallbacks) && body.fallbacks.length > 0) {
		add("server-side-fallback-2026-06-01");
	}
	if (isRecord(body.thinking) && isPresent(body.thinking.block_binding)) {
		add("thinking-binding-controls-2026-08-01");
	}
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const model = typeof body.model === "string" ? body.model : "";
	for (const tool of tools) {
		if (!isRecord(tool)) {
			continue;
		}
		const type = typeof tool.type === "string" ? tool.type : "";
		if (type === "" || type === "custom") {
			if (anthropicSupportsStructuredOutput(model)) {
				add("structured-outputs-2025-11-13");
			}
			if (isPresent(tool.input_examples) || isPresent(tool.allowed_callers)) {
				add("advanced-tool-use-2025-11-20");
			}
		} else {
			const beta = ANTHROPIC_TOOL_BETAS[type];
			if (beta !== undefined) {
				add(beta);
			}
		}
	}
	return betas.join(",");
}

function buildOpencodeV1Headers(
	targetFormat: PresetRequestContext["targetFormat"],
	identity: PresetIdentity,
	parsedBody: Record<string, unknown> | null,
): Record<string, string> {
	// UA 的 SDK 段按目标协议选择；custom 目标沿用 chat 段（research §2）
	let sdk: string = OPENCODE_V1_VERSIONS.sdkChat;
	if (targetFormat === "responses") {
		sdk = OPENCODE_V1_VERSIONS.sdkResponses;
	} else if (targetFormat === "anthropic") {
		sdk = OPENCODE_V1_VERSIONS.sdkAnthropic;
	}
	const headers: Record<string, string> = {
		Accept: "*/*",
		"User-Agent": `opencode/${OPENCODE_V1_VERSIONS.client} ai-sdk/provider-utils/${sdk} runtime/bun/${OPENCODE_V1_VERSIONS.bun}`,
		"x-opencode-client": "cli",
		"x-opencode-session": identity.sessionId,
		// v1 双头同值（research §2）
		"x-opencode-session-id": identity.sessionId,
		"x-opencode-request": identity.messageId,
		// 上游只验形状不验值；不用 prj_ 形状（v2 拒收，稳妥同避）
		"x-opencode-project": "global",
	};
	// anthropic-beta 仅 anthropic 协议按 body 派生，无命中不设
	if (targetFormat === "anthropic" && parsedBody !== null) {
		const betas = deriveAnthropicBetas(parsedBody);
		if (betas !== "") {
			headers["anthropic-beta"] = betas;
		}
	}
	return headers;
}

// —— body 工具合规（design D5；research §6 stream:true + bash + tools≥2）——
//
// 工具定义出处（逐字移植，非杜撰）：
// - sst/opencode v1.19.3 tag（MIT）packages/core/src/tool/{bash,read,edit}.ts
//   的 Tool.make 注册 description 与 Input Schema——即本预设伪装的 1.19.3
//   客户端本体；源码模板插值（timeout 默认/上限 120000/600000ms）按常量展开。
// - 指定源 jasonxu114514/opencode2api（MIT）internal/gateway/opencode_tools.json
//   经核实为 OpenCode 2.x 工具集（shell/patch/question 等，无 bash 条目，其
//   v1 lane 亦不注入 bash），与 1.19.3 指纹不同代，故未采用。
// - 裁剪到 ensureToolConformance 实际注入的三个名字：bash（恒注入）+
//   read/edit（总数 <2 时补齐）；glob/grep/write 无注入路径，不留死数据。
// - 存 chat 嵌套 function 形状（description/parameters）；anthropic 运行时
//   改名 parameters → input_schema，responses 用扁平 {type:"function",...}。

type PresetToolName = "bash" | "read" | "edit";

const OPENCODE_TOOLS: Record<
	PresetToolName,
	{ description: string; parameters: Record<string, unknown> }
> = {
	bash: {
		description:
			"Execute one shell command string with the host user's filesystem, process, and network authority. The active Location is the default working directory. Relative workdir values resolve from that Location. External workdir values require external_directory approval; best-effort command-argument path warnings are advisory only. Timeout values are milliseconds (default: 120000; maximum: 600000). Uses the configured shell when set; otherwise uses /bin/sh on POSIX and COMSPEC or cmd.exe on Windows.",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Shell command string to execute",
				},
				workdir: {
					type: "string",
					description:
						"Working directory. Defaults to the active Location; relative paths resolve from that Location.",
				},
				timeout: {
					type: "integer",
					description:
						"Timeout in milliseconds. Defaults to 120000 and may not exceed 600000.",
				},
			},
			required: ["command"],
		},
	},
	read: {
		description:
			"Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page. Relative paths resolve from the current location; absolute paths inside it are accepted, while external absolute paths require external_directory approval.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				offset: {
					type: "integer",
					description:
						"The 1-based directory entry or text line offset to start reading from",
				},
				limit: {
					type: "integer",
					description:
						"The maximum number of directory entries or text lines to read",
				},
			},
			required: ["path"],
		},
	},
	edit: {
		description:
			"Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
				},
				oldString: {
					type: "string",
					description: "Exact text to replace",
				},
				newString: {
					type: "string",
					description: "Replacement text, which must differ from oldString",
				},
				replaceAll: {
					type: "boolean",
					description:
						"Replace all exact occurrences of oldString (default false)",
				},
			},
			required: ["path", "oldString", "newString"],
		},
	},
};

/** 工具名检测：chat 嵌套 function.name 优先，anthropic/responses 扁平 name。 */
function toolName(tool: unknown): string | null {
	if (!isRecord(tool)) {
		return null;
	}
	if (isRecord(tool.function) && typeof tool.function.name === "string") {
		return tool.function.name;
	}
	return typeof tool.name === "string" ? tool.name : null;
}

function toPresetTool(
	name: PresetToolName,
	targetFormat: ChannelApiFormat,
): Record<string, unknown> {
	const definition = OPENCODE_TOOLS[name];
	if (targetFormat === "anthropic") {
		// anthropic 形状：parameters → input_schema 改名（字段一一对应）
		return {
			name,
			description: definition.description,
			input_schema: definition.parameters,
		};
	}
	if (targetFormat === "responses") {
		return {
			type: "function",
			name,
			description: definition.description,
			parameters: definition.parameters,
		};
	}
	return {
		type: "function",
		function: {
			name,
			description: definition.description,
			parameters: definition.parameters,
		},
	};
}

/**
 * 工具合规（mutate 传入 body，返回是否有修改）：bash 命中判定 + 总数 <2 补
 * read/edit，bash 恒注入。检测名兼容 chat 嵌套与扁平形状。追加进**拷贝后的
 * tools 数组**（调用方副本可能是浅拷贝，原地 push 会污染跨重试轮共享的
 * parsedBody）；tools 非数组脏形态 fail-open 不动；custom 目标协议未知不调用。
 */
export function ensureToolConformance(
	body: Record<string, unknown>,
	targetFormat: ChannelApiFormat,
): boolean {
	if (targetFormat === "custom") {
		return false;
	}
	const existing = body.tools;
	if (existing !== undefined && !Array.isArray(existing)) {
		return false;
	}
	// 拷贝后再追加：调用方副本可能是浅拷贝，原地 push 会污染跨重试轮共享的
	// parsedBody 内的同一 tools 数组
	const tools: Array<unknown> = existing === undefined ? [] : [...existing];
	let changed = false;
	let hasBash = false;
	for (const tool of tools) {
		if (toolName(tool) === "bash") {
			hasBash = true;
			break;
		}
	}
	if (!hasBash) {
		tools.push(toPresetTool("bash", targetFormat));
		changed = true;
	}
	if (tools.length < 2) {
		tools.push(toPresetTool("read", targetFormat));
		tools.push(toPresetTool("edit", targetFormat));
		changed = true;
	}
	if (!changed) {
		return false;
	}
	body.tools = tools;
	return true;
}
