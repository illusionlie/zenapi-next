# Claude Code 客户端指纹快照（伪装证据）

> 来源：`C:\Users\NINGMEI\.pi\agent\git\github.com\phy-zhangzl\pi-anaouter-cc` @ `d46b8f3`（"feat: sync current Claude Code wrapper"，2026-08-08）。
> 该仓库是 pi 扩展，把请求伪装成 Claude Code 2.1.226 / Claude Agent SDK CLI 形态发往 AnaRouter；其维护管线为「本地 capture server 抓真实 CC 请求 → diagnose diff → 刷新常量」，故以下值锚定真实 Claude Code 抓包，非凭空编造。
> 伪装常量集中在 `index.ts:51-58`；头构造 `getClaudeCodeHeaders`（`index.ts:256-277`）。

## 版本锚点（随 CC 版本漂移的活值，git 史 5 个月换 5 版）

| 常量 | 值 |
|---|---|
| CLAUDE_CODE_VERSION | `2.1.226` |
| CLAUDE_CODE_VERSION_BUILD | `2.1.226.b94` |
| STAINLESS_PACKAGE_VERSION | `0.94.0` |
| STAINLESS_OS | `MacOS` |
| STAINLESS_ARCH | `arm64` |
| STAINLESS_RUNTIME | `node` |
| STAINLESS_RUNTIME_VERSION | `v26.3.0` |
| ANTHROPIC_BETA | `claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advisor-tool-2026-03-01,effort-2025-11-24`（有序逗号拼接、无空格，共 9 flag） |

## 请求头完整清单（getClaudeCodeHeaders 原文）

| Header | 值 | 预设落地 |
|---|---|---|
| `content-type` | `application/json` | 省略（代理自设，同值） |
| `accept` | `application/json`（**SSE 流式也保持此值**） | 保留 |
| `authorization` | `Bearer <apiKey>` | 省略（渠道密钥体系管理） |
| `x-api-key` | `<apiKey>`（与 authorization 双发） | 省略（同上） |
| `anthropic-version` | `2023-06-01` | 保留 |
| `anthropic-dangerous-direct-browser-access` | `true` | 保留 |
| `anthropic-beta` | 上表 9-flag 串 | 保留 |
| `user-agent` | `claude-cli/2.1.226 (external, sdk-cli)` | 保留 |
| `x-app` | `cli` | 保留 |
| `x-claude-code-session-id` | 每请求 `randomUUID()` | 用 `{{uuid}}` |
| `x-stainless-retry-count` | `0`（重试第 n 轮为 `String(n)`） | 保留静态 `0` |
| `x-stainless-timeout` | `600` | 保留 |
| `x-stainless-lang` | `js` | 保留 |
| `x-stainless-package-version` | `0.94.0` | 保留 |
| `x-stainless-os` | `MacOS` | 保留 |
| `x-stainless-arch` | `arm64` | 保留 |
| `x-stainless-runtime` | `node` | 保留 |
| `x-stainless-runtime-version` | `v26.3.0` | 保留 |

UA 格式演变：2.1.2 为 `claude-cli/x (external, cli)`，2.1.74 起改 `(external, sdk-cli)`。端点 `POST {base}/v1/messages?beta=true`（`?beta=true` 是伪装的一部分）。

## system 三块结构（index.ts:289-295 原文）

```ts
function createClaudeCodeSystem(systemPrompt: string) {
  return [
    { type: "text", text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION_BUILD}; cc_entrypoint=sdk-cli;` },
    { type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: "ephemeral" } },
    { type: "text", text: sanitizeText(systemPrompt), cache_control: { type: "ephemeral" } },
  ];
}
```

- 第一块 billing 行**无** cache_control（早期版本带 `; cch=00000;` 后缀，2.1.118 后去掉）；
- 身份声明历史上曾是 `You are Claude Code, Anthropic's official CLI for Claude.`，当前为 Agent SDK 表述；
- 预设级落地：仅承载前两块文本（单 text block 前置，无 cache_control 差异与三块结构差异记入 note）。

## body 级指纹（现有伪装体系不覆盖，note 记为限制）

- `metadata.user_id` 为 **JSON 字符串**：`{"device_id":"<64hex>","account_uuid":"","session_id":"<uuid>"}`（device_id 进程级持久，三级回退：env → `~/.claude.json` userID → randomBytes(32).hex）；
- `context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }` 恒定注入；
- 可选 `thinking: {type:"adaptive",display:"omitted"}` + `output_config: {effort}`；
- 工具名映射 PascalCase（read→Read、bash→Bash、glob→Glob、ls→LS…）；
- 用户纯文本也发 content block 数组；最后一条 user 消息末 block 带 ephemeral cache_control。

## 维护工作流（刷新指纹的方法）

本地起 capture server（`scripts/capture-claude-code-request.ts`，监听 127.0.0.1:3458 落盘真实 CC 请求）→ `scripts/diagnose-anaouter.ts` diff 本项目发出的请求 → 按结论刷新版本常量与头清单。原则（docs/daily-troubleshooting-workflow.md）：**尽量只保留真实 Claude Code 会发送的头**。
