# 执行计划 — OpenCode Zen 免费额度真身伪装

> 按依赖排序；每步末尾验证命令通过再进下一步。行号锚点见 design.md；门禁算法出处 research/opencode-zen-fingerprint.md。

## Step 1 — 存储层：disguise_preset 列与 CRUD

- [ ] `migrations/0027_channel_disguise_preset.sql`：`ALTER TABLE channels ADD COLUMN disguise_preset TEXT;`；`schema.sql` channels 表同步。
- [ ] `services/channel-types.ts`：`ChannelRecord.disguise_preset: string | null`。
- [ ] `services/channel-repo.ts`：insert（:182-216）/ update（:238-271）绑定与语句接线。
- [ ] `routes/channels.ts`：POST（:277-279 模式）+ PATCH 三态（:371-378 模式）+ payload 类型（:64-66 / :499-501）；值白名单校验（`CLIENT_PRESET_IDS`），非法 400 `invalid_disguise_preset`。
- 验证：`bun run typecheck`

## Step 2 — 预设引擎核心：services/client-presets.ts

- [ ] 模块骨架：`CLIENT_PRESET_IDS` / `OPENCODE_V1_VERSIONS` / `PresetRequestContext` / `AppliedPreset` / `applyClientPreset`（design D2 形状；未知/NULL → null）。
- [ ] ID 派生纯函数（design D3）：`conversationSignal`（system string/blocks text 拼接/instructions + 首条真用户消息）、`turnFingerprint`（计回数跳过 tool_result）、`deriveOpencodeSessionId`（36-bit 伪时间 <<12|1 取反 → 尾 `ffe` + base62 派生）、`deriveOpencodeMessageId`（升序 48-bit）。同步实现（**异步 hash 禁入**，混合函数即可——门禁只验形状与稳定性）；body null / 无信号回退 `genOpencodeSessionId()/genOpencodeRequestId()`。
- [ ] 头组装：research §2 全量表，UA 按 targetFormat 选 SDK 段（custom 目标用 chat 段）。
- [ ] `ensureToolConformance(body, targetFormat)`（design D5）：三协议形状检测 + bash 必注入 + <2 补 read/edit；工具集常量从 jasonxu114514/opencode2api（MIT）`internal/gateway/opencode_tools.json` 移植裁剪（bash 全文 + read/edit 等；chat 嵌套 function 存储，anthropic 运行时 `parameters`→`input_schema` 转换）。
- [ ] `transformBody` 闭包：工具合规 + 仅 `forceUpstreamStream` 时置 `stream:true`；custom 目标 no-op。
- 验证：`bun run typecheck`

## Step 3 — 头接线：applyHeaderPolicy 第 5 参 + buildChannelRequest

- [ ] `utils/proxy-headers.ts`：`applyHeaderPolicy` + `presetHeaders?` 末位可选参，应用顺序 剔除 → 全局注入 → **预设头** → 伪装头 → custom（design D4）。
- [ ] `routes/proxy.ts` `buildChannelRequest`：函数开头 `applyClientPreset(channel.disguise_preset, {targetFormat, parsedBody, isStream})` 求值一次；四个 `applyHeaderPolicy` 调用点（:189/:292/:308/:354）透传 `preset?.headers`。签名不变。
- [ ] `services/channel-testing.ts` 探针不动（GET 无 body，保持现状——设计明示）。
- 验证：`bun run typecheck`

## Step 4 — proxy.ts body 分支接线

- [ ] openai 裸透传 gate（:382-409）：条件并入 `preset?.transformBody`；bodyCopy 内先 transform 后注入伪装；「无实际修改」回退 `requestText`。
- [ ] responses 入站→chat 转换（:342-347）/ anthropic 目标转换（:205-210）/ responses 目标两分支（:236-263、:269-283）：转换产物或 bodyCopy 上调用 transform（design D5 接线表逐分支核对，custom 不动）。
- [ ] `stream_options.include_usage` 注入条件（:678-696）：`isStream || presetForceStream`。
- [ ] Playground（playground.ts:107-141）与 test-model（channels.ts:627-629）调用方核对：均传 channel 行 ⇒ headers/body 自动生效，确认无旁路。
- 验证：`bun run typecheck`

## Step 5 — 响应侧聚合：services/stream-aggregate.ts

- [ ] `aggregateUpstreamStream(protocol, response)` 三协议实现（design D6）：chat 拼接/合并、anthropic blocks 重组（usage 累计直取）、responses 取 `response.completed.response`；畸形 fail-open + `[stream-aggregate]` warn；截断流降级产出。
- [ ] attempt 循环插入（proxy.ts:872-894）：`upstreamForcedStream && response.ok && response.body` → 聚合 → 喂 `convertResponse`（本体零改动）。
- [ ] test-model / Playground 响应消费点同模式插入；anthropic-proxy openai 目标分支预留 Step 6。
- 验证：`bun run typecheck`

## Step 6 — anthropic-proxy.ts 接线（独立 attempt 循环）

- [ ] 三处 `applyHeaderPolicy`（:281/:328/:396）透传预设头（各分支求值）。
- [ ] anthropic 目标透传 bodyCopy（:292-302）与 openai 目标转换拷贝（:341-347）接 transformBody。
- [ ] openai 目标响应侧：强制流式 → 聚合 → 既有非流转换链；usage 解析链路核对不受影响（AC9）。
- 验证：`bun run typecheck`

## Step 7 — UI

- [ ] `core/types.ts` ChannelForm + `disguise_preset`；payload 透传（变化才携带，空串=清除）。
- [ ] `ChannelsView.tsx` 预设下拉（:1239-1257）：optgroup「服务端预设」/「快照预设」；服务端选择不灌 textareas + 实时渲染提示；快照 applyPreset 同时清空 `disguise_preset`（互斥）。
- [ ] ui `client-presets.ts` opencode 快照 note 追加服务端预设指引（design D7）。
- 验证：`bun run typecheck` + `bun run check`

## Step 8 — 测试

- [ ] design D8 六个测试文件的矩阵逐项落地（AC1-AC11 对应断言；AC1 字节级基线与「同输入两次构建逐字节一致」重试守护必含）。
- [ ] 既有 `tests/client-disguise.test.ts` / `tests/proxy-headers.test.ts` 全绿（占位符与四参调用零回归证明）。
- 验证：`bun run test`

## Step 9 — 全量门禁 + 文档 + 真实验证配方

- [ ] `bun run check && bun run typecheck && bun run test` 全绿（AC12）。
- [ ] AGENTS.md §8 增补 + proxy-headers.md 更新 + 新 spec `client-presets.md`（design D9）。
- [ ] 真实验证配方交付（AC13，用户执行）：本地/部署环境建渠道 `base_url=https://opencode.ai/zen`、`api_formats=["openai","anthropic"]`、zen key、模型填免费模型 ID（如 code-supernova）；先验证头/ID 层（预期：若 body 规则已弱化即 200），403 FreeTierError 再开完整预设复测；结果回填任务 journal。

## Review gates

- Gate A（Step 2 后）：ID 派生与头矩阵纯函数评审——布局黄金值对照 research §3/§4 正则逐一核对，再动接线。
- Gate B（Step 4 后）：接线矩阵评审——对照 design D5 分支表逐分支核对「动/不动」与单次 stringify 判定。
- Gate C（Step 9，最后一轮 2.2 全范围检查）：trellis-check 全量门禁 + AC 清单逐项核对 + 文档同步核对。

## 回滚点

- 每 Step 独立可编译，可按 Step 粒度 `git checkout -- <files>` 回退。
- 运行期回滚 = 渠道 `disguise_preset` 置空（即时生效受 10s 渠道缓存窗口约束），无需代码回退。
