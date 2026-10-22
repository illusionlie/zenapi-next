# OpenCode Zen 免费额度真身伪装（服务端预设引擎 + body 合规）

## Goal

让指向 OpenCode Zen v1 通道（`https://opencode.ai/zen`）的渠道在**免费模型**上通过上游的客户端校验（403 `FreeTierError` → 200）：把伪装体系从「UI 快照的头 + 提示词」升级为「网关侧每请求实时渲染的完整客户端指纹」——正确布局且会话稳定的身份 ID、按协议分段的 UA、全套身份头、body 形状合规（强制上游流式 + 工具集注入 + SSE 聚合还原）。

用户已拍板：完整 body 合规（含 SSE→非流聚合与工具注入）；v2 通道（`/inference`、`/zen/go`）范围外。门禁调研证据见 `research/opencode-zen-fingerprint.md`。

## Requirements

### R1 渠道级服务端预设

- `channels` 新增 `disguise_preset` 列（TEXT，NULL = 关闭）。首个内置预设 ID：`opencode_zen_v1`。
- 预设是**代码常量**（worker 侧模块），不进 settings、不进 DB 读取路径；启用与否只由渠道行决定。
- 头应用顺序扩展为：全局剔除 → 全局注入 → **预设头** → 伪装头（`disguise_headers_json`，含动态模板）→ 渠道级 `custom_headers_json`。后应用者赢 ⇒ **用户手改可覆盖预设**，既有可改能力原样保留。
- 伪装提示词（`disguise_system_prompt`）注入语义不变，与预设正交叠加。

### R2 身份 ID 语义升级（预设作用域内）

- **会话 ID**：从请求体确定性派生（`sha256` over system + 首条用户消息指纹，算法对齐 Go `CanonicalSessionID`）——同一对话跨请求同会话（现状是每请求全新）；布局仍为降序 `ses_` 形状（时间部恒落 `f[c-f][0-9a-f]` 放行窗口）。
- **消息 ID**：`msg_` 升序形状；按（会话信号， 回合指纹）确定性派生——同一用户回合内跨请求稳定（对齐真实客户端语义），**无状态实现**（纯 hash，不引入 isolate 内存的回合 store）。
- 既有占位符 `{{opencode_session_id}}` / `{{opencode_request_id}}` 行为**不变**（每请求新生成），预设生成器走独立的上下文感知路径，二者并存互不影响。

### R3 头套件（按目标协议渲染，v1 指纹）

- UA：`opencode/1.19.3 ai-sdk/provider-utils/{chat 4.0.23 | responses 4.0.40 | anthropic 4.0.46} runtime/bun/1.3.14`，版本常量集中于预设模块便于随上游漂移手工刷新。
- 全量身份头：`Accept: */*`、`x-opencode-client: cli`、`x-opencode-session` 与 `x-opencode-session-id`（同值）、`x-opencode-request`、`x-opencode-project`（默认 `global`）。
- anthropic 目标：`anthropic-beta` 按 body 工具类型派生（无命中不设头）；`x-api-key` + `anthropic-version` 由既有分支负责，不改。

### R4 body 形状合规（请求侧）

- **流式强制**：客户端非流式请求（`stream !== true`）发往预设渠道时，上游 body 强制 `stream: true`；`stream_options.include_usage` 注入条件同步以上游实际流式为准。
- **工具集注入**：`tools` 缺失 / 无 bash / 数量 <2 时注入真实 opencode 工具集（bash 必注入，不足补齐）；按目标协议输出正确形状（chat 嵌套 function / anthropic name+input_schema / responses 扁平 function）。
- 转换类分支（chat→anthropic、responses→chat 等）在**转换产物**上做合规检查；透传类分支在 bodyCopy 拷贝上做，与 disguisePrompt / developer 归一化共享单次 stringify 判定。

### R5 响应侧 SSE 聚合（强制流式的对偶）

- 上游被迫流式而客户端要非流式时：SSE 全量聚合还原为对应协议的标准非流 JSON 再走既有 `convertResponse` 非流转换链——chat（content 拼接 / tool_calls index 合并 / 终止 chunk usage 与 finish_reason）、anthropic（blocks 重组含 thinking / tool_use 的 input_json_delta 拼接）、responses（直接取 `response.completed` 内 response 对象）。
- usage / 计费链路零改动：聚合产物即标准非流 JSON，现有非流 usage 解析直接生效。
- 客户端本就流式时：响应管线**零变化**。

### R6 作用调用方矩阵

- 主代理（`proxy.ts` 全部目标分支）、`anthropic-proxy.ts`（anthropic 目标透传 + openai 目标转换）、Playground、渠道单模型测试（`/test-model`）行为一致——headers / body / 响应聚合三面同样生效（test-model 是免费模型验收路径，必须生效）。
- 连通性测试 / 模型拉取探针（GET `/models`，无 body）不受影响。

### R7 CRUD 与 UI

- POST/PATCH 接受 `disguise_preset`（三态：undefined 保留 / 空串清除 / 白名单值设置；非法值 400 `invalid_disguise_preset`）。
- 管理台渠道表单：预设下拉新增「服务端预设」分组（`opencode_zen_v1`，实时渲染标识）；既有快照预设的 applyPreset 行为不变。newapi 兼容层不写该字段（保持 NULL）。

### R8 明确不做（范围外）

- v2 通道指纹（`/inference`、`/zen/go`：2.x UA、x-session-affinity 三连、`?beta=true`）。
- 匿名 `public` 凭证通道。
- 其余预设（claude-code / cline 等）服务端化——快照机制原样保留。
- 工具注入的开关（预设即完整行为；副作用见 design 已知边界）。
- 系统提示词指纹伪造（调研确认门禁不查 prompt 内容）。
- 会话/消息 ID 的 isolate 内存 memo（纯 hash 派生已满足回合稳定）。

## 约束

- Biome 规范（tab、双引号）；提交前 `bun run check && bun run typecheck && bun run test` 全绿。
- 新逻辑下沉 services 层（预设引擎、聚合器），routes 薄壳；热路径零新增 DB 查询。
- `disguise_preset` 为 NULL 的渠道零行为变化（字节级透传回归断言）。
- 文档同步：AGENTS.md §8 + `.trellis/spec/api-worker/backend/proxy-headers.md`（应用顺序扩展）。

## Acceptance Criteria

- [ ] AC1 零回归：`disguise_preset` 为 NULL 的渠道，`buildChannelRequest` 输出与现状逐字节一致（新增断言），现有全部测试不回退。
- [ ] AC2 会话 ID：同一 body 两次构建会话 ID 相同；首条用户消息不同则会话 ID 不同；布局黄金断言（`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` 且时间部落 `^[0-9a-f]{9}f[c-f][0-9a-f]$`）。
- [ ] AC3 消息 ID：同一（会话信号， 回合）两次构建相同；末条用户消息变化则变化；带 tool_result 的 user 消息不计新回合；布局黄金断言。
- [ ] AC4 头矩阵：预设 × 三目标格式（openai/responses/anthropic）→ UA 分段、Accept、client、session 双头同值、request、project 全量断言；anthropic-beta 仅在命中派生规则时出现。
- [ ] AC5 覆盖链：disguise_headers_json 同名头覆盖预设头；custom_headers_json 再覆盖；全局剔除能删除预设头；全局注入不覆盖预设头。
- [ ] AC6 body 合规（请求侧）：非流 chat 入站 + 三目标 → 上游 body `stream:true` + tools 含 bash 且 ≥2（各协议形状正确）；流式客户端 body 不被改写 stream 字段。
- [ ] AC7 SSE 聚合：三协议聚合器单测——chat（content/tool_calls/usage/finish_reason）、anthropic（text/thinking/tool_use 重组 + usage 累计取值）、responses（response.completed 提取）；畸形事件 fail-open。
- [ ] AC8 端到端（attempt 循环层）：非流客户端 × 强制流式渠道 → 响应为合法非流 JSON 且 usage 正常解析计费；流式客户端 → 管线与现状一致。
- [ ] AC9 anthropic-proxy 路径：anthropic 目标透传与 openai 目标转换两条分支的 headers/body/聚合生效。
- [ ] AC10 CRUD/UI：POST/PATCH 三态与 400 错误码；UI 预设下拉服务端分组选择后保存回读正确；快照预设行为不变。
- [ ] AC11 三调用方一致：主代理 / Playground / test-model 对同一渠道渲染出相同指纹形态。
- [ ] AC12 门禁：`bun run check && bun run typecheck && bun run test` 全绿；AGENTS.md §8 与 proxy-headers.md 同步更新。
- [x] AC13 真实验证：zen key 渠道 + 免费模型 `/test-model` 返回 200——**2026-10-22 渠道实测通过（用户执行）**。
