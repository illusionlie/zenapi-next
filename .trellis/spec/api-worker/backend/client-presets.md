# Client Presets — 服务端客户端预设引擎契约

> 来自任务 `10-21-opencode-zen-disguise`。新增/修改服务端客户端预设、刷新上游指纹常量、
> 改动 `applyClientPreset` / `stream-aggregate.ts` / 五层头顺序 / transformBody 接线分支之前必读。
> 头注入侧契约（第 5 参应用顺序）见 [proxy-headers.md](./proxy-headers.md)，本文件管引擎本体。

---

## Scenario: 服务端客户端预设（渠道级指纹伪装 + body 合规 + 强制流式响应聚合）

### 1. Scope / Trigger

- 任何触碰 `services/client-presets.ts`（预设引擎）或 `services/stream-aggregate.ts`（强制流式的响应侧聚合器）的工作。
- 上游 OpenCode 客户端新版本发布后刷新指纹常量（版本漂移责任在本代码库，见 §3 第一条）。
- 渠道 CRUD 触碰 `channels.disguise_preset` 字段，或代理链路新增 `applyHeaderPolicy` 调用点。

### 2. Signatures

```ts
// apps/worker/src/services/client-presets.ts —— 预设引擎（纯函数模块，不读 DB/settings）
export const CLIENT_PRESET_IDS = ["opencode_zen_v1"] as const;
export type ClientPresetId = (typeof CLIENT_PRESET_IDS)[number];
export const OPENCODE_V1_VERSIONS = {
	client: "1.19.3", bun: "1.3.14",
	sdkChat: "4.0.23", sdkResponses: "4.0.40", sdkAnthropic: "4.0.46",
} as const; // 随上游发布漂移的活值，集中一处便于手工刷新（research §2）
export type PresetRequestContext = {
	targetFormat: ChannelApiFormat;
	parsedBody: Record<string, unknown> | null;
	isStream: boolean; // 客户端侧流式意图（入站 body stream === true）
};
export type AppliedPreset = {
	headers: Record<string, string>; // 已求值（ID 已生成），交 applyHeaderPolicy 第 5 参注入
	forceUpstreamStream: boolean; // 客户端非流但预设要求上游流式
	transformBody(body: Record<string, unknown>): boolean; // mutate 调用方副本，返回是否有修改
};
export function applyClientPreset(
	presetId: string | null | undefined,
	ctx: PresetRequestContext,
): AppliedPreset | null; // NULL / 空白 / 未知 ID → null（fail-open 关闭，零回归）
export function isStreamForcingPreset(presetId: string | null | undefined): boolean;
//   handler 层专用（stream_options 预注入候选池判定 + 聚合 gate）；只看预设身份不含
//   请求上下文，custom 目标的排除由调用方做。新增会强制流式的预设时同步更新此处。
export function ensureToolConformance(body: Record<string, unknown>, targetFormat: ChannelApiFormat): boolean;
export function deriveOpencodeSessionId(body: Record<string, unknown> | null): string;
export function deriveOpencodeMessageId(body: Record<string, unknown> | null): string;

// apps/worker/src/services/stream-aggregate.ts —— 强制流式的响应侧配套
export type AggregateProtocol = "chat" | "anthropic" | "responses";
export function protocolForTargetFormat(format: ChannelApiFormat): AggregateProtocol;
//   anthropic→anthropic、responses→responses、其余（含 custom）兜底 chat；custom 不可达
//   （调用方守卫排除——协议未知不解释响应）
export async function aggregateUpstreamStream(
	protocol: AggregateProtocol,
	response: Response, // 预期 200 且 body 为 SSE
): Promise<Response>; // 合成非流 Response（application/json 标准协议形状）
```

接线面（零新增 `buildChannelRequest` 参数，channel 行自带 `disguise_preset`）：
`proxy.ts` 的 `buildChannelRequest` 函数开头求值一次 → 各 `applyHeaderPolicy` 调用点透传
`preset?.headers`、各 body 分支调用 `preset.transformBody`；`anthropic-proxy.ts` 三分支
（anthropic 目标 / openai 目标 / custom）各自求值同模式；Playground 与 test-model 调用方
传 channel 行自动生效；`channel-testing.ts` 连通性探针**不接**预设（GET 无 body、无 ID 可派生）。

### 3. Contracts

- **预设是代码常量，不是配置**：上游指纹（UA 版本 / 头表 / 工具集 / beta 旗标）随客户端发布
  漂移，本质是「随发版手工刷新的代码」。渠道行只存预设 ID 指针（`channels.disguise_preset`，
  NULL = 关闭），指纹数据**不进 settings/DB**；版本活值集中在 `OPENCODE_V1_VERSIONS`，上游
  发版后的刷新责任在本仓库（改常量 → 跑门禁 → 发版）。引擎唯一输入是 `(presetId, ctx)`，
  热路径零新增查询。
- **fail-open 链**：`applyClientPreset` 对 NULL / 空白 / 未知 ID 返回 null（预设关闭，行为与
  无预设渠道完全一致）；ID 派生对 body null / 无真用户消息回退 `utils/client-disguise` 旧
  生成器（形状仍合规）；工具合规对 `tools` 非数组脏形态不动。
- **确定性同步 ID 派生**（opencode_zen_v1 专用路径，不动旧占位符模板）：
  - 为什么同步且确定：`buildChannelRequest` 是同步签名，`crypto.subtle.digest` 异步**禁入**；
    同一对话跨请求会话 ID 稳定保 prompt-cache 亲和，同回合同消息 ID。混合函数用 FNV-1a
    （8 字节分块，BigInt 常量乘）+ splitmix64 finalizer 的 64-bit 混合——**无 crypto.subtle、
    无随机段、无 memo、跨 isolate 一致**，同一 body 两次构建产出逐字节一致的 ID（重试轮 /
    换渠道 / 换 Key 天然会话稳定）。
  - 信号：`conversationSignal` = system 侧（chat 首条 user 之前的 `role:"system"` 消息 /
    anthropic `system` 字段 string·text blocks / responses `instructions`）+ 首条真用户消息
    文本（messages 或 `input`；string input 本身即用户内容）。
  - `ses_` 降序：36-bit 伪时间（取自混合值，**不用当前时间**）`<<12 | 1`（counter 恒 1，落
    1–63 活体窗口）后按位取反 ⇒ 低 12 hex 恒 `ffe`（research §3 CanonicalSessionID 同构；
    门禁只验形状正则 + counter 窗口，不验 hash 算法）+ 14 base62 派生尾。
  - `msg_` 升序：低 48 位混合值（升序侧无 counter 窗口门禁），混合输入含 `turnFingerprint`
    （真用户回合计数、**跳过携带 tool_result 的 user 消息**——agent 循环回灌不计回合 + 末条
    真用户消息文本）⇒ 同一用户回合内的所有请求派生同一消息 ID + 14 base62 派生尾。
- **头表**（research §2 全量；auth 头不在预设层，由既有鉴权基建按渠道 Key 注入）：
  `Accept: */*`；UA `opencode/{client} ai-sdk/provider-utils/{sdk} runtime/bun/{bun}`，SDK 段
  按目标协议选（chat 4.0.23 / responses 4.0.40 / anthropic 4.0.46，**custom 用 chat 段**）；
  身份头组 `x-opencode-client: cli`、`x-opencode-session` 与 `x-opencode-session-id` 双头
  同值、`x-opencode-request`、`x-opencode-project: global`（不用 `prj_` 形状——v2 拒收，
  稳妥同避）；`anthropic-beta` 仅 anthropic 目标按 body 特征派生（mcp_servers /
  context_management / container.skills / output_config.task_budget / speed / fallbacks /
  thinking.block_binding / 工具 type 与模型结构化输出能力，无命中不设）。
- **body 合规**（`transformBody`，mutate 调用方副本——bodyCopy 或转换产物，**绝不接收共享
  parsedBody 本体**；返回 false 且无其他动作时调用方可回退原始字节，守住零重序列化）：
  - 形状守卫先行：chat/anthropic 目标要求 `messages` 数组、responses 要求 `input`
    （string 或数组）；非对话形状 body（embeddings 等）**不动**——不注工具、更不写
    `stream:true`（否则「强制流式」标记指向从未被改写的 body，响应侧聚合的 SSE 前提失真），
    原样返回 false。
  - 工具合规：bash **恒注入**（无则追加）；总工具数 <2 补 read、edit。定义**逐字移植**
    sst/opencode v1.19.3 tag `packages/core/src/tool/{bash,read,edit}.ts` 的 `Tool.make` 注册
    （模板插值按常量展开）——存 chat 嵌套 function 形状（`description/parameters`），anthropic
    运行时改名 `parameters`→`input_schema`（字段一一对应），responses 用扁平
    `{type:"function",...}`。追加前**拷贝 tools 数组**（调用方副本可能是浅拷贝，原地 push 会
    污染跨重试轮共享的 parsedBody 内同一数组）。
  - `stream:true` 仅在 `forceUpstreamStream`（客户端非流）且 `body.stream !== true` 时写入；
    流式客户端 body 不动 stream 字段。custom 目标 transform no-op、不强制流式（协议未知不
    解释 body，headers 照发）。
- **强制流式响应侧**：客户端非流 × 预设强制 → 上游以 SSE 回包，`aggregateUpstreamStream`
  全量消费后合成该协议标准非流 JSON 再喂 `convertResponse`（其非流分支本就
  `await response.json()`，**本体零改动**；usage 记录路径不动）。聚合协议按
  `protocolForTargetFormat`（custom 不可达）。chat：首 chunk 元数据、`delta.content` /
  `delta.reasoning_content` 拼接、tool_calls 按 index 合并（id/type/name 首见、arguments 追加）、
  终止 chunk 取 finish_reason 与 usage、`[DONE]` 仅终止信号；anthropic：`message_start` 基线 +
  content_block 重组（text/thinking/signature delta 拼接、`input_json_delta` 累积后整体
  `JSON.parse` 定稿）+ `message_delta` 的 usage 是**累计值直取**，经导出的
  `utils/usage mergeRawUsage` 按非 null 覆盖合并、**绝不二次累加**（format-conversion §3.5
  红线）；responses：`response.completed.response` 直取即产物（`response.failed` 兜底）。
  产物组装「缺席可选字段直接省略」。
- **头应用顺序**（proxy-headers.md §3 同源）：剔除 → 全局注入 → 预设头（已求值字面值，不解释
  模板）→ 伪装头（模板）→ custom，后应用者赢；全局剔除清单对预设头保持裁决权（清单内头名
  预设层跳过注入，大小写不敏感），全局注入因先行不能覆盖预设头；`policy === null` 豁免只跳
  全局两步。
- `stream_options.include_usage` 预注入条件扩为 `isStream || 候选池含强制流式预设渠道`
  （`isStreamForcingPreset`，custom 目标排除）——上游真流式才有 usage 尾 chunk 可解析。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| `disguise_preset` 非白名单值（CRUD） | 400 `invalid_disguise_preset`（空 / NULL = 关闭放行） |
| `applyClientPreset` 收到 NULL / 空白 / 未知 ID | 返回 null，预设关闭零回归 |
| body null / 无任何真用户消息 | ID 派生回退 `genOpencodeSessionId/RequestId` 旧生成器 |
| chat/anthropic 无 `messages` 数组 / responses 无 `input` | `transformBody` 原样返回 false（不注工具、不写 stream） |
| `tools` 非数组脏形态 | 工具合规 fail-open 不动 |
| custom 目标 | headers 照发；transform no-op、不强制流式 |
| 聚合入口：非 2xx / 无 body / content-type 非 `text/event-stream` | 原样返回（覆盖形状守卫未命中、上游未真流式的场景） |
| 聚合逐事件：畸形 JSON / 未知事件 / 非 JSON data | 跳过 + 单条 `console.warn("[stream-aggregate]", …)` |
| 截断流（干净 EOF 无终止事件） | 产出已聚合部分 + warn（显式降级优于抛错——上游已 200） |
| 读取中途流错误 | 不吞，向上抛给调用方 catch → 重试路径裁决（与干净截断不同类） |

### 5. Good/Base/Bad Cases

- **Good**：`applyClientPreset` 每次构建上游请求求值一次，结果贯穿该次构建的所有
  `applyHeaderPolicy` 调用点与 body 分支；同输入两次构建逐字节一致（重试不累积断言锚定）。
- **Base**：`disguise_preset` NULL（部署默认态）⇒ 零行为变化；预设关闭即回滚，无需代码回退
  （运行期生效受 10s 渠道缓存窗口约束）。
- **Bad**：把指纹常量搬进 settings/DB（制造脏值问题）；在预设层解析 `{{...}}` 模板（冻结
  动态值、破坏域界定）；用 `crypto.subtle` 异步化 ID 派生（污染 `buildChannelRequest` 同步
  签名）；`transformBody` 接收共享 parsedBody 本体（跨重试轮累积污染）。

### 6. Tests Required

六个测试文件（断言对应 PRD AC1–AC11）：

- `tests/client-preset-identity.test.ts`（15 用例）：信号提取矩阵（system string/blocks/
  instructions、首条 user、tool_result 不计回合）、同输入同输出确定性、黄金布局正则（ses
  降序 `ffe` 尾 / msg 升序）、null body 回退旧生成器。
- `tests/client-preset-headers.test.ts`（16 用例）：三目标 UA 分段与全头矩阵；`applyHeaderPolicy`
  五参顺序（全局剔除删预设头 / 全局注入不覆盖 / disguise 覆盖预设 / custom 再覆盖）；preset
  null 零回归；预设字面值域界定（不解析模板）。
- `tests/client-preset-body.test.ts`（19 用例）：三协议工具注入矩阵（缺/少/有 bash/≥2 不动）、
  stream 强制仅非流、形状守卫、转换产物分支、stringify 判定。
- `tests/stream-aggregate.test.ts`（16 用例）：三协议聚合矩阵 + 畸形事件 + 截断流降级 +
  anthropic usage 累计直取。
- `tests/proxy-preset-wiring.test.ts`（4 用例）：`buildChannelRequest` preset null 字节级基线；
  非流 × 预设上游 body 断言；attempt 循环聚合响应端到端（mock fetch SSE）。
- `tests/channels-crud-preset.test.ts`（7 用例）：`disguise_preset` POST/PATCH 三态 + 400
  白名单。

### 7. Wrong vs Correct

#### Wrong

```ts
// ① 随机段/异步 hash 破坏确定性 —— 同对话会话漂移、同步签名被污染
const id = `ses_${crypto.getRandomValues(new Uint8Array(6))}`;
const digest = await crypto.subtle.digest("SHA-256", bytes);
// ② transformBody 直接吃共享 parsedBody —— 跨重试轮累积污染
preset.transformBody(parsedBody);
```

#### Correct

```ts
// buildChannelRequest 开头求值一次；副本上 transform；头交第 5 参
const preset = applyClientPreset(channel.disguise_preset ?? null, {
	targetFormat: apiFormat,
	parsedBody,
	isStream,
});
if (preset && parsedBody !== null) {
	preset.transformBody(anthropicBody as Record<string, unknown>); // 转换产物 = fresh body
}
applyHeaderPolicy(
	headers,
	headerPolicy,
	channel.custom_headers_json,
	channel.disguise_headers_json,
	preset?.headers,
);
```

---

## Gotchas（踩过的坑）

> **Warning：工具集移植来源核对过，别想当然。**
> 指定的 jasonxu114514/opencode2api（MIT）`opencode_tools.json` 经核实是 OpenCode **2.x 代**
> 工具集（shell/patch/question，无 bash 条目，其 v1 lane 亦不注入 bash），与预设伪装的
> 1.19.3 指纹**不同代，未采用**。真源是 sst/opencode v1.19.3 tag 的 `Tool.make` 注册
> （bash/read/edit 三条，源码模板插值按常量展开）；glob/grep/write 无注入路径，不留死数据。

> **Warning：工具注入有真实副作用。**
> 模型可能真实调用注入的 bash/read/edit，无工具能力的下游客户端会收到 tool_calls / tool_use
> 载荷——这是「上游判定像不像 agent 客户端」门禁的必然代价；聚合产物如实透传 tool_calls，
> **不做模拟执行**。

> **Warning：anthropic tool_use 定稿守卫按 partial_json 累积判定，不看 `input === undefined`。**
> 真实 Anthropic 流的 `content_block_start` 对 tool_use **恒携带 `input:{}`**（协议形状）——
> 用 input 判空会让 `input_json_delta` 的累积整体丢失。有累积（start 首片或 delta）即定稿；
> 截断兜底同判定，定稿后清理防重复解析。

> **Warning：anthropic 流式 usage 是累计值不是增量。**
> `message_delta.usage` 直取合并（`mergeRawUsage` 非 null 覆盖语义），二次累加会把总量翻倍
> ——与 format-conversion §3.5 同一条红线，聚合器必须遵守。

> **Warning：v2 通道范围外。**
> OpenCode v2 通道（`/inference`、`/zen/go`，2.x CLI / 匿名凭证）**拒收** `x-opencode-request`
> 头与 `prj_*` project——预设只服务 v1 真身指纹（`x-opencode-request` 恰是 v1 必备、project
> 用 `global` 避开 `prj_` 形状）；v2 通道与匿名凭证见 PRD R8，勿在本引擎里顺手实现。
