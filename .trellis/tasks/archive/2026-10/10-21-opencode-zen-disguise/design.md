# 技术设计 — OpenCode Zen 免费额度真身伪装

> 行号锚点基于侦察时点（proxy.ts 1111 行 / anthropic-proxy.ts 609 行 / client-disguise.ts 158 行 / channel-repo.ts、channels.ts、ChannelsView.tsx 见各节）。门禁证据与算法出处：`research/opencode-zen-fingerprint.md`（下称 research §n）。

## 1. 决策记录

### D1 存储：`channels.disguise_preset` 列 + 白名单校验

- 迁移 `apps/worker/migrations/0027_channel_disguise_preset.sql`：`ALTER TABLE channels ADD COLUMN disguise_preset TEXT;`（NULL = 关闭）；`schema.sql` channels 表同步（紧邻 disguise_headers_json / disguise_system_prompt，schema.sql:26-28 区域）。
- `channel-types.ts` `ChannelRecord` + 字段 `disguise_preset: string | null`；`channel-repo.ts` insert（:182-216）/ update（:238-271）两处接线（绑定参数追加到语句尾部，SELECT * 无需改读侧）。
- `routes/channels.ts`：POST（:277-279 模式）`body.disguise_preset?.trim() || null`；PATCH（:371-378 模式）三态 `undefined` 保留 / 值（含空串）覆盖。**白名单校验**：值 ∈ `CLIENT_PRESET_IDS`（从预设模块导入常量）或空，非法 400 `invalid_disguise_preset`（snake_case 错误码先例一致）；payload 类型（:64-66 / :499-501）+字段。
- newapi 兼容层（newapiChannels.ts）**不写**该字段（保持 NULL，范围外）；`channels.ts` 的渠道测试路径自动经行内字段生效。

### D2 预设引擎：`apps/worker/src/services/client-presets.ts`（新文件，纯函数模块）

预设是代码常量而非配置——上游指纹随客户端版本漂移，本质是「随发版手工刷新的代码」，进 settings/DB 反而制造脏值问题。结构：

```ts
export const CLIENT_PRESET_IDS = ["opencode_zen_v1"] as const;
export type ClientPresetId = (typeof CLIENT_PRESET_IDS)[number];

// 随上游发布漂移的活值，集中一处便于手工刷新（research §2）
export const OPENCODE_V1_VERSIONS = {
	client: "1.19.3", bun: "1.3.14",
	sdkChat: "4.0.23", sdkResponses: "4.0.40", sdkAnthropic: "4.0.46",
} as const;

export type PresetRequestContext = {
	targetFormat: "openai" | "responses" | "anthropic" | "custom";
	parsedBody: Record<string, unknown> | null;
	isStream: boolean; // 客户端侧流式意图
};

export type AppliedPreset = {
	headers: Record<string, string>; // 已求值（ID 已生成），交 applyHeaderPolicy 注入
	forceUpstreamStream: boolean;    // 客户端非流但门禁要求流
	transformBody(body: Record<string, unknown>): boolean; // mutate 调用方副本，返回是否有修改
};

export function applyClientPreset(
	presetId: string | null | undefined,
	ctx: PresetRequestContext,
): AppliedPreset | null; // 未知 ID / NULL → null（fail-open 关闭）
```

- `opencode_zen_v1` 实现：headers 按 research §2 全量表（UA 按 targetFormat 选 SDK 段；session/message ID 见 D3）；`forceUpstreamStream = !ctx.isStream`；`transformBody` = 工具合规（D5）+ `body.stream = true`（仅 forceUpstreamStream 时）。
- custom 目标：headers 照发（与伪装头现状对 custom 生效一致），`transformBody` no-op、不强制流式（协议未知不解释 body）。
- 工具集常量 `OPENCODE_TOOLS`：从 jasonxu114514/opencode2api（MIT）`internal/gateway/opencode_tools.json` 移植裁剪（bash 全文 + read/edit/glob/grep/write 等所需条目），以 chat 嵌套 function 形状存 `description/parameters`，anthropic 形状运行时转换（`parameters` → `input_schema` 改名即可，字段一一对应）。

### D3 身份 ID：无状态 hash 派生（预设专用路径，不动旧占位符）

新纯函数放 `services/client-presets.ts`（旧 `utils/client-disguise.ts` 的 `genOpencodeRequestId/SessionId` 与 `TEMPLATE_RESOLVERS` **原样保留**——`{{...}}` 模板语义不变，AC 兼容）：

```ts
// 信号指纹：system（string / blocks 拼接 text / instructions）+ 首条真用户消息内容
function conversationSignal(body: Record<string, unknown>): string;
// 带 tool_result 的 user 消息不计回合计数（research §4）
function turnFingerprint(body: Record<string, unknown>): string;

export function deriveOpencodeSessionId(body: Record<string, unknown> | null): string;
// = "ses_" + desc48(sha256("ses\x00" + signal)) + base62_14(sha256 字节)
// desc48: hash 前 5 字节构造 36-bit 伪时间戳 <<12 | 1 后按位取反（低 12 hex 恒 ffe，research §3）
export function deriveOpencodeMessageId(body: Record<string, unknown> | null): string;
// = "msg_" + asc48(sha256("msg\x00" + signal + "\x00" + turnFingerprint)) + base62_14
// asc48: hash 前 6 字节取低 48 位（升序侧无 counter 窗口门禁，形状正则即可，research §4）
```

- **确定性** ⇒ 同对话同会话、同回合同消息 ID，无 memo、跨 isolate 一致——比 Go 项目的内存 store 更契合 Workers 无状态模型（Go 需要 store 是因其要保留客户端真实 ID 与真实时间语义；ZenAPI 纯伪造，hash 伪时间即可）。
- body 为 null / 无法提取信号（无任何 user 消息）→ 回退旧生成器（`genOpencodeSessionId()` 等），fail-open。
- `crypto.subtle.digest` 是异步——模块内用同步实现：Workers 无 `node:crypto` sync sha256？**备选**：用 `crypto.subtle` 则 ID 生成须异步化。决策：`deriveOpencode*` 保持同步，hash 用轻量 FNV-1a/xorshift 混合（64-bit 混淆即可，门禁只验形状与稳定性，不验 hash 算法）——**不引异步**污染 buildChannelRequest 同步签名。base62 段同样由混合值 + `crypto.getRandomValues` 随机填充？不行——随机段会破坏确定性。全段由混合值派生（36-bit 伪时间 + 14 base62 由 84-bit 混合输出编码，确定性完整保留）。

### D4 头注入：`applyHeaderPolicy` 第 5 参

```ts
export function applyHeaderPolicy(
	headers: Headers,
	policy: ProxyHeaderPolicy | null,
	channelCustomJson: string | null | undefined,
	disguiseJson?: string | null,
	presetHeaders?: Record<string, string> | null, // 新增，末位可选
): void;
```

应用顺序：剔除 → 全局注入 → **预设头（不解释模板，值已在预设层求值）** → 伪装头（模板照旧）→ custom（spec `proxy-headers.md` §3 契约更新）。该位置保证：全局剔除可删预设头；全局注入**不**覆盖预设头（注入先应用）；用户 disguise / custom 可覆盖预设（AC5）。

`buildChannelRequest`（proxy.ts:160-172）内部各分支在现有 `applyHeaderPolicy` 调用点（:189/:292/:308/:354）透传 `preset?.headers`；preset 由函数开头 `applyClientPreset(channel.disguise_preset, { targetFormat, parsedBody, isStream })` 求值一次。**签名不变**（channel 行已携带 preset 字段，零新增参数）。

- `channel-testing.ts` 探针（:87-101 手工 merge 处）**不加**预设（GET 无 body、无 ID 可派生，现有伪装头行为保持）。
- `anthropic-proxy.ts` 三个 `applyHeaderPolicy` 调用点（:281/:328/:396）同模式透传（preset 在各分支开头求值）。

### D5 body 合规（请求侧）：`transformBody` 接入点与单次 stringify

工具合规 `ensureToolConformance(body, targetFormat)`（预设模块内纯函数）：

- 检测：chat 形状 `tools[i].function?.name ?? tools[i].name`；anthropic `tools[i].name`；responses `tools[i].name`（type=function）。计数 + bash 命中判定。
- 不满足 → append：bash 恒注入；总数 <2 补 read、edit。转换分支在**转换产物**上调用（anthropic 目标 = `openaiToAnthropicRequest` 产物；responses/chat 互转产物）；透传分支在 bodyCopy 上调用。
- `body.stream = true` 仅当 `forceUpstreamStream`（client 非流）；流式客户端 body 不动 stream 字段。

接线（与 disguisePrompt / normalizeDeveloperRole 共享 bodyCopy gate 的既有模式）：

| 分支 | 位置 | 动作 |
|------|------|------|
| openai 目标 / chat 裸透传 | proxy.ts:382-409 gate | gate 条件扩为 `(disguisePrompt…) || shouldNormalize \|\| (preset && preset.transformBody)`；bodyCopy 内先 transform 后注入伪装；「transform 返回 false 且无其他动作」回退 `requestText`（守住零重序列化） |
| openai 目标 / responses 入站→chat 转换 | proxy.ts:342-347 | 转换产物 chatBody 上 transform（新增动作，该分支本就重序列化） |
| anthropic 目标（chat 入站转换） | proxy.ts:205-210 | 转换产物 anthropicBody 上 transform |
| responses 目标 / 原生透传 | proxy.ts:236-263 | bodyCopy 模式同透传 gate |
| responses 目标 / chat→responses 转换 | proxy.ts:269-283 | 转换产物上 transform |
| custom 目标 | proxy.ts:306-315 | 不解释 body |
| `stream_options.include_usage` 注入 | proxy.ts:678-696 | 条件从 `isStream` 扩为 `isStream \|\| presetForceStream`（上游实际流式才需要） |

**anthropic-proxy.ts**（独立 attempt 循环 :261-418，不经过 buildChannelRequest）：anthropic 目标透传（:292-302 bodyCopy）与 openai 目标（:341-347 channelOpenaiBody 拷贝）两分支同模式接 transform；headers 经 D4 第 5 参。此文件是工作量大头，逐分支对照上表。

### D6 响应侧聚合：`apps/worker/src/services/stream-aggregate.ts`（新文件）

```ts
export async function aggregateUpstreamStream(
	protocol: "chat" | "anthropic" | "responses",
	response: Response, // 200 且 body 为 SSE
): Promise<Response>; // 合成非流 Response（application/json 标准协议形状）
```

- **chat**：解析 `data:` 行 → 首 chunk 取 `id/model/created`；`delta.content` 字符串拼接、`delta.reasoning_content` 拼接、`tool_calls[]` 按 index 合并（id/name 首见，arguments 追加）；终止 chunk 取 `finish_reason` + `usage`；`[DONE]` 终止。产物 `chat.completion` 标准形状（`choices[0].message` 含 content / reasoning_content / tool_calls）。
- **anthropic**：`message_start` 取 id/model/usage.input；`content_block_start/delta/stop` 重组 blocks（text_delta 拼接 / thinking_delta 拼接 / input_json_delta 拼接后 `JSON.parse` 为 tool_use.input，start 的 partial_json 首片兜底）；`message_delta` 取 stop_reason + `usage`（**累计值直取**，spec format-conversion §3.5 红线）+ output token；`message_stop` 终止。产物标准 Message JSON。
- **responses**：`response.completed` 事件内 `response` 对象直接采用（research §8：终事件携带完整 response）。
- fail-open：畸形 JSON 行 / 未知事件跳过 + `console.warn("[stream-aggregate]", …)`；截断流（无终止事件）产出已聚合部分 + warn（显式降级优于抛错——上游已 200）。
- 解析器**复用现有 SSE 行解析工具**（`parseSseData` 家族若不可导出则在本模块实现等价解析，tests 有 `parseSseData` 先例）。

接线（attempt 循环，proxy.ts:872-894）：

```ts
const preset = applyClientPreset(channel.disguise_preset, …); // buildChannelRequest 外再求值一次或复用其返回
const upstreamForcedStream = preset?.forceUpstreamStream === true && !isStream;
// fetch 后、convertResponse 前：
let upstreamResponse = response;
if (upstreamForcedStream && response.ok && response.body) {
	upstreamResponse = await aggregateUpstreamStream(presetProtocol(channel.api_format), response);
}
lastResponse = await convertResponse(channel, upstreamResponse, isStream, targetPath);
```

聚合喂入后 `convertResponse` 语义不变（非流分支本就 `await response.json()`）——**convertResponse 本体零改动**。usage 记录路径不动（最终 Response 是标准非流 JSON，现有解析生效，AC8）。Playground / test-model 响应侧同样插入（playground.ts 响应消费点、channels.ts test-model 消费点，各一行判断）。anthropic-proxy 的 openai 目标分支同模式（其 anthropic→chat 转换已有非流函数，聚合后喂入）。

### D7 UI：ChannelsView 服务端预设分组

- `core/types.ts` `ChannelForm` + `disguise_preset: string`（""=无）；POST/PATCH payload 透传（三态语义：编辑表单仅在该字段变化时携带，空串=清除）。
- `ChannelsView.tsx` 预设下拉（:1239-1257）：optgroup「服务端预设（网关实时渲染）」= `opencode_zen_v1`；选中 → `form.disguise_preset` 置值，**不**灌 textareas，提示文案「指纹由网关每请求实时渲染（会话稳定 ID / 按协议 UA / body 合规），下方伪装头与提示词可叠加覆盖」；optgroup「快照预设（填入下方可编辑）」= 既有 7 颗，`applyPreset`（:544-552）行为不变且同时清空 `disguise_preset`（互斥：快照应用 = 关闭服务端预设）。
- UI 侧 opencode 快照预设（ui client-presets.ts:621-638）保留但 note 追加「服务端预设 opencode_zen_v1 已取代本快照的 zen 免费额场景」指引。

### D8 测试设计

| 文件 | 内容 | 参照 |
|------|------|------|
| `tests/client-preset-identity.test.ts`（新） | AC2/AC3：信号提取矩阵（system string/blocks/instructions、首条 user、tool_result 不计回合）、确定性（同输入同输出）、黄金布局正则、null body 回退旧生成器 | tests/client-disguise.test.ts 风格 |
| `tests/client-preset-headers.test.ts`（新） | AC4/AC5：三目标 UA 分段与全头矩阵；applyHeaderPolicy 五参顺序（全局剔除可删预设头 / 全局注入不覆盖 / disguise 覆盖预设 / custom 再覆盖）；preset null 零回归 | tests/proxy-headers.test.ts |
| `tests/client-preset-body.test.ts`（新） | AC6：三协议形状工具注入矩阵（缺/少/有 bash/≥2 不动）、stream 强制仅非流、转换产物分支、stringify 判定 | tests/proxy-developer-normalize.test.ts |
| `tests/stream-aggregate.test.ts`（新） | AC7：三协议聚合矩阵 + 畸形事件 + 截断流降级 | tests/format-converter-*.test.ts 的 runStreamTransform/parseSseData 样板 |
| `tests/proxy-preset-wiring.test.ts`（新） | AC1/AC8/AC11：buildChannelRequest preset null 字节级基线；非流×预设 上游 body 断言；attempt 循环层聚合响应端到端（mock fetch SSE） | tests/client-disguise.test.ts 接线用例 #1-#5 模式 |
| `tests/channels-crud.test.ts`（改，若无则并入 wiring） | AC10：disguise_preset 三态 + 400 白名单 | 既有 channels CRUD 断言 |

### D9 文档同步（Phase 3.3）

- `AGENTS.md` §8 增补：服务端预设条目（存储、应用顺序、opencode_zen_v1 指纹要点、强制流式与聚合、custom 例外、范围外 v2）。
- `.trellis/spec/api-worker/backend/proxy-headers.md`：§2 签名 + §3 应用顺序 + Gotchas 增预设层。
- 新沉淀 `.trellis/spec/api-worker/backend/client-presets.md`（预设引擎契约：ID 派生、版本常量刷新责任、工具集移植来源）。

## 2. 兼容性 / 回滚

- `disguise_preset` NULL（默认）⇒ 部署后零行为变化；渠道级关闭即回滚，无需代码回退。
- 迁移为纯加列（NULL 缺省），旧代码读写不受影响；回滚迁移不需要（列闲置无害）。
- `applyHeaderPolicy` 第 5 参末位可选，既有调用编译期兼容；`buildChannelRequest` 签名不变。
- 旧占位符与快照预设全保留，UI 老用法不受影响。

## 3. 已知边界（不做的事 + 明示风险）

- **工具注入副作用**：模型可能真实调用注入的工具（如 bash），无工具能力的下游客户端会收到 tool_calls / tool_use 载荷。这是门禁要求的必然代价（上游判定「像不像 agent 客户端」）；聚合产物如实透传 tool_calls，不做模拟执行。
- **body 规则证据陈旧**：stream/tools 规则来自 1.18.31 抓包（research §6），现行门禁以会话形状 + UA 为主。实现顺序上头/ID 先行可独立验证；若真实验证（AC13）显示 body 规则已移除，聚合与注入保留（无害且为未来门禁回摆兜底）。
- 降序会话 ID 的时间部是 hash 伪时间（非当前毫秒）——与 Go `CanonicalSessionID` 同构，活体探测结论「形状正则 + counter 窗口」下不可区分。
- v2 通道、匿名凭证、其他预设服务端化见 PRD R8。
