# 新增 Claude Code 客户端伪装预设

## Goal

在现有客户端伪装预设体系（`apps/ui/src/core/client-presets.ts` 的 `CLIENT_PRESETS`）中新增「Claude Code」预设，使渠道对上游呈现 Claude Code CLI（2.1.226 / sdk-cli 形态）的请求指纹。范围为**预设级**：请求头快照 + systemPrompt 注入，与既有 7 个预设同构。

证据来源与完整指纹快照见 [research/claude-code-fingerprint.md](./research/claude-code-fingerprint.md)（基于 `C:\Users\NINGMEI\.pi\agent\git\github.com\phy-zhangzl\pi-anaouter-cc` @ `d46b8f3` 的实现，其值锚定真实 Claude Code 抓包）。

## Requirements

- 新增预设条目：id `claude-code`，展示名含版本锚点（如 `Claude Code 2.1.226`），加入 `CLIENT_PRESETS` 尾部（与 opencode 之后）。
- **headers 快照**：与参考实现 `getClaudeCodeHeaders` 逐值一致，做以下省略并在 note 记录原因：
  - 省略 `authorization` / `x-api-key`（由渠道密钥体系管理，预设不得覆盖内置鉴权头）；
  - 省略 `content-type`（传输层头，由代理按实际请求体设置）；
  - 保留 `accept: application/json`（真实 CC 流式请求也保持此值，属稳定静态指纹）；
  - 保留 `anthropic-version` / `anthropic-beta`（9-flag 有序串原文）/ `anthropic-dangerous-direct-browser-access` / `user-agent: claude-cli/2.1.226 (external, sdk-cli)` / `x-app: cli`；
  - 保留 `x-stainless-*` 全家（timeout/lang/package-version/os/arch/runtime/runtime-version）与 `x-stainless-retry-count: 0`；
  - `x-claude-code-session-id` 用现成占位符 `{{uuid}}`（每请求新鲜，与参考实现每请求 `randomUUID()` 语义一致）。
- **systemPrompt**：注入参考实现 system 三块结构中可承载的前两块文本（billing 行 + SDK 身份行），格式：
  - `x-anthropic-billing-header: cc_version=2.1.226.b94; cc_entrypoint=sdk-cli;`
  - `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
  - 两行以空行分隔（注入函数会将其作为单个 text block 前置）。
- **note** 必须记录：证据来源（pi-anaouter-cc @ d46b8f3，其值来自真实 CC 抓包管线）、版本锚点（CC 2.1.226 / build 2.1.226.b94 / stainless 0.94.0 / node v26.3.0）、逐项省略原因、以及 body 级校验限制（`metadata.user_id` JSON 字符串、`context_management.edits`、`?beta=true` 查询参数、system 三块 cache_control 结构、工具名 PascalCase 映射均超出现有伪装体系，同 opencode 预设 note 先例）。
- 预设标 `testing: true`（指纹来自第三方逆向仓库，未经本项目自有抓包验证——同 zcode / codex 先例）。
- 管理台「客户端伪装」预设下拉出现新条目，选中即填充 `disguise_headers`（JSON 序列化）与 `disguise_system_prompt`，展示 note 提示。

## Out of Scope

- body 级伪装（metadata.user_id 注入、context_management、`?beta=true`、system 多块 cache_control 结构、工具名映射）——现有伪装体系能力边界之外，如确有需要另立任务。
- 新增占位符（`{{uuid}}` 已满足会话 ID 需求；device_id 持久化语义只影响 body，预设级不涉及）。
- 后端 / schema / 迁移 / 测试改动（预设为纯前端数据，零后端感知）。
- ChannelsView 占位符说明文案与 AGENTS.md / spec 的占位符清单（占位符集合不变）。

## Acceptance Criteria

- [ ] `CLIENT_PRESETS` 含 `claude-code` 条目，headers 与 research 文档快照逐值一致（省略项仅限 Requirements 列举的 authorization / x-api-key / content-type）。
- [ ] `x-claude-code-session-id` 值为 `{{uuid}}`，经既有 `resolveDisguiseTemplate` 每请求解析（复用既有测试覆盖，无需新增用例）。
- [ ] systemPrompt 与 Requirements 规定的两行文本一致。
- [ ] note 含证据来源、版本锚点、省略原因、body 级限制四要素；条目标 `testing: true`（展示名带「（测试）」后缀）。
- [ ] 管理台渠道表单：预设下拉可选 Claude Code，应用后 headers JSON 与提示词字段填充正确，保存后渠道记录 `disguise_headers_json` / `disguise_system_prompt` 正确落库（复用既有链路）。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿；无后端文件改动。
