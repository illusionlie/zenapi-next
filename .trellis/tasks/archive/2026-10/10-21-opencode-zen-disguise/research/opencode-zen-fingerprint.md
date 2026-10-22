# OpenCode Zen 免费档门禁指纹调研（2026-10-21）

> 证据来源：
> 1. **jasonxu114514/opencode2api**（Go 网关，MIT）——`internal/identity/request.go`、`internal/identity/message.go`、`internal/gateway/upstream.go`、`internal/httpx/client.go`。该项目持续跟进 Zen 门禁演进（注释含 2026-09-16 与 2026-10-14 两个门禁变更日期），结论标注「活体端点探测验证」。
> 2. **ZenAPI 自身** `apps/ui/src/core/client-presets.ts:637` opencode 预设 note——前任务（09-17，linux.do 2912664 抓包）沉淀的 body 规则。
> 3. deepwiki(sst/opencode)：客户端设 `x-opencode-session/request/client/project` 头、Zen handler（`packages/console/app/src/routes/zen/util/handler.ts`）解析这些头与 UA；服务端**未发现**系统提示词指纹校验。
> 4. OpenClaw 官方文档：Zen 免费档限制非 OpenCode 客户端，违规返回 403 `FreeTierError`（付费模型不受限）。
> linux.do 原帖三种途径均未能直接抓取（tavily 429 / webReader 网络错 / Discourse JSON 403），但其抓包结论已内嵌于证据 2。

## 1. 通道（lane）划分

| 通道 | base_url | 指纹代际 | 备注 |
|------|----------|----------|------|
| v1 | `https://opencode.ai/zen` | OpenCode **1.19.3**（AI SDK 复合 UA） | 本任务目标；带 zen API key 的正式通道 |
| v2 | `https://opencode.ai/inference`、`https://opencode.ai/zen/go` | OpenCode **2.x CLI** | 匿名/新通道；**拒收** `x-opencode-request` 头与 `prj_*` project；范围外 |

匿名凭证：v2 匿名通道上游鉴权头是**字面量 `public`**（`Authorization: Bearer public`，大小写敏感，无头直接 401——2026-10-14 起）。范围外，仅记录。

## 2. v1 通道请求指纹（`setV1Headers`，upstream.go:1411-1441）

伪装的是「OpenCode 1.19.3 模型请求命中其 opencode provider」的完整形态：

| 头 | 值 | 来源锚点 |
|----|----|----------|
| `Accept` | `*/*` | upstream.go:1423 |
| `User-Agent` | `opencode/1.19.3 ai-sdk/provider-utils/{SDK} runtime/bun/1.3.14`，SDK **按目标协议**：chat=`4.0.23`、responses=`4.0.40`、anthropic=`4.0.46` | httpx/client.go:20-50 |
| `x-opencode-client` | `cli` | upstream.go:1424 |
| `x-opencode-session` | 规范会话 ID（见 §3） | upstream.go:1425 |
| `x-opencode-session-id` | **与 x-opencode-session 同值**（v1 双头同值） | upstream.go:1426 |
| `x-opencode-request` | `msg_` 升序消息 ID（见 §4），缺失时现造 | upstream.go:1429-1431 |
| `x-opencode-project` | git root commit（40 位小写 hex）或 `global`；上游**只验形状不验值**；`prj_*` 形状会被 v2 拒收（v1 未提及拒收，稳妥起见同样不用） | upstream.go:1432, projectID():1645 |
| `x-opencode-parent-session-id` + `x-parent-session-id` | 仅子代理场景，父会话规范 ID | upstream.go:1433-1435 |
| `anthropic-beta` | 仅 anthropic 协议：按 body 内工具类型派生（§5），无命中不设 | upstream.go:1436-1438 |
| 鉴权 | anthropic 协议：`x-api-key` + `anthropic-version: 2023-06-01`；其余：`Authorization: Bearer {key}` | upstream.go:1384-1393 |

v1 通道**不发** `x-session-affinity` / `X-Session-Id`（那是 v2 指纹）。

## 3. 会话 ID——门禁核心（identity/request.go）

- 形状正则：`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`（12 hex 时间部 + 14 base62 随机部）。**2026-09-16 起形状不对 → 403 FreeTierError**。
- 时间部必须为官方 `Identifier.descending()` 布局：48 位值 = `~(ts_ms<<12 | counter)`，按位取反 ⇒ 低 12 bit = `0xFFF - counter`。**活体探测：counter 仅接受 1–63**（低 12 bit 落 `0xFC0`–`0xFFF`），越界即 403。正则 `^[0-9a-f]{9}f[c-f][0-9a-f]$`。
- Go 的 `CanonicalSessionID(signal)`：**不使用当前时间**——`sha256("ses\x00" + signal)` 前 6 字节构造 36-bit 伪时间戳，`<<12 | 1` 后取反 ⇒ 低 12 hex 恒 `ffe`（恒过窗口），后 14 位 base62 取自 hash 字节。同一 signal 确定性同 ID ⇒ **同一对话跨请求会话稳定**（保 prompt-cache 亲和性）。
- 官方客户端真实会话（双重正则匹配）原样保留——网关场景专属，ZenAPI 从 body 派生无此场景。

## 4. 消息 ID（identity/message.go）

- 形状：`msg_` + 12 hex **升序**时间部（`(ts<<12|counter)`，不取反）+ 14 base62。正则 `^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`。升序侧**无** counter 窗口校验（仅 ses 降序侧有）。
- 真实语义：客户端在用户发消息时铸造，**同一用户回合内的所有请求**（agent 循环的 tool 步骤、标题请求）重复同一 ID；按（会话, 回合指纹）稳定，TTL 6h。
- 回合指纹（Go `userTurn`）：用户回合计数 + 末条「真用户」消息内容 hash；带 `tool_result` 的 user 消息是 agent 循环回灌，**不计新回合**。

## 5. v1 anthropic-beta 按工具派生（upstream.go:1493+）

AI SDK anthropic provider 从 Messages body 派生 beta 旗标。已见映射（工具 `type` → beta 旗标）：`code_execution_20250522`→`code-execution-2025-05-22`、`code_execution_20250825`→`code-execution-2025-08-25`、`computer_20241022`→`computer-use-2024-10-22`、`computer_20250124`→`computer-use-2025-01-24`（后续还有 web search 等，实现时全量移植）。另受 body 字段触发：`mcp_servers`、`context_management.edits`、`container`、`output_config.task_budget`、`speed`、`fallbacks`、`thinking.block_binding`。

## 6. body 形状规则（证据 2，1.18.31 抓包）

`stream:true` + bash tool + `tools ≥ 2`。注意：该结论早于 2026-09-16 门禁迭代，现行门禁以头/ID 为主（Go 项目仅强调会话+UA），**可能已弱化或仍并存**——按「保守全做 + 可验证」处理：头/ID 是确定项，body 合规实现后可用真Key A/B 验证（先只开头/ID 打免费模型，403 再开 body 合规）。

## 7. ZenAPI 现状盘点（2026-10-21 源码核实）

| 项 | 现状 | 判定 |
|----|------|------|
| `genOpencodeSessionId`（utils/client-disguise.ts:105-128） | `ses_` + **已按位取反**（`genOpencodeId(desc=true)`，counter 恒 1 ⇒ 尾 `ffe`），形状过门禁 | ✅ 布局正确 |
| 会话稳定性 | 每上游请求全新会话（模板占位符每次求值） | ❌ 真实客户端每对话稳定；每请求新会话在门禁若做会话级频控时可疑 |
| `genOpencodeRequestId` | `msg_` 升序，每请求新造 | ⚠️ 形状对；回合稳定性缺 |
| 预设形态 | UI 快照（client-presets.ts:621-638）：选预设=把字符串灌进表单，网关无预设概念 | ❌ 无法承载按协议 UA / body 转换 |
| 头套件 | 缺 `x-opencode-session-id`、`Accept`；UA 恒 `4.0.40` 不分协议；无 anthropic-beta 派生 | ❌ |
| body 合规 | 无（stream 强制、工具注入均无）；预设 note 自认「不适用于 zen 免费额度」 | ❌ |

## 8. 响应侧对照（ZenAPI 聚合设计输入）

- 三协议 SSE 终止携带完整信息的形态：chat=终止 chunk `usage` + `finish_reason`；anthropic=`message_delta.usage` 累计值 + `message_stop`；responses=`response.completed` 事件内含**整个 response 对象**（聚合最简）。
- `convertResponse`（proxy.ts:424-508）非流式分支已是「解析上游 JSON → 协议转换 → 重序列化」形态；聚合器产物可直接喂入。
- `isStream = parsedBody?.stream === true`（proxy.ts:626）；`stream_options.include_usage` 注入条件挂 `isStream`（:678-696）——强制流式时该注入条件须以上游实际流式为准。
- `stream_only` 渠道列先例：非流请求直接过滤渠道（proxy.ts:783-793）；预设强制流式是其对偶（渠道能服务非流客户端）。
