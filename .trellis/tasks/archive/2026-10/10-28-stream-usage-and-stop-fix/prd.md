# 转换链两处存量缺口修复（include_usage 注入 + 双 message_stop）

## Goal

修复前序任务 10-27-responses-anthropic-pivot 质检确认的两处**存量**缺陷（非 pivot 引入，spec 已标注）：

1. **计费缺口（资金影响）**：anthropic 入站 + openai 目标的**普通流式**分支不注入 `stream_options.include_usage`——OpenAI 兼容上游不自愿携带 SSE usage 尾块时，该路径 usage 落库记零。
2. **协议纪律**：`createOpenaiToAnthropicStreamTransform` 在 chat 上游以 `[DONE]` 正常收尾时向客户端发**双 `message_stop`**；空流（无 message_start）还会产孤儿 `message_stop`。

## Background（已亲验锚点）

- **缺口①现场**（`apps/worker/src/routes/anthropic-proxy.ts` openai 分支，:481-535）：唯一注入点 ：521 条件为 `preset.forceUpstreamStream && openaiCopy.stream === true`——仅覆盖「客户端非流 + 预设强制上游流式」。客户端 `isStream` 的普通路径不进拷贝 gate（:511-513 `disguisePrompt || presetTouchesBody`）也就无处注入。`channelOpenaiBody` 是跨重试轮/Key 共享体，**注入必须落在每尝试拷贝上**（:503-510 注释明示 mutate 纪律）；`channelOpenaiBody` 为 null（`channelRequestText` 回退）时上游体形状未知，不注入。
- **缺口②现场**（`apps/worker/src/services/format-converter.ts`）：`[DONE]` 分支 :1251-1258 无条件入队 `message_stop`；`flush()` :1453-1462 在 `sentMessageStart` 为真时再入队一次 → `[DONE]` 收尾双发。且 `[DONE]` 分支不看 `sentMessageStart`——空流产孤儿 stop（无 message_start 前缀）。
- **受益事实**：前序任务已让 `message_delta` 终止 chunk 转发 `input_tokens`（format-conversion.md §3.7），include_usage 到位后该路径 usage 即完整恢复（prompt 不再恒零），零额外改动。
- 注入矩阵现状：chat 入站 handler 预注入 ✓；/v1/responses 入站 buildChannelRequest 注入 ✓；anthropic 入站 openai 目标 ✗（本任务补）；两个 pivot 分支出站体非 chat 形状不适用 ✓。

## Requirements

- **R1 include_usage 注入补全**：anthropic 入站 + openai 目标、客户端流式时，出站 chat 体注入 `stream_options: { include_usage: true }`。注入落点在每尝试拷贝上：扩 ：511 gate（`disguisePrompt || presetTouchesBody` → 增 `isStream && channelOpenaiBody` 分支），拷贝内注入条件合并预设强制流式为**单一表达式**（`isStream || (preset 强制流 && stream===true)`），语义恰一次；`channelOpenaiBody` 为 null 不注入；非流式请求字节零变化。
- **R2 message_stop 恰一不变量**：`[DONE]` 分支与 `flush()` 共享 `sentMessageStop` 守卫——任何终止路径（[DONE] / 截断 flush / 流内 error 后 flush）至多一次；两处同时守卫 `sentMessageStart`（无 message_start 不产 message_stop，消除孤儿）。
- **R3 测试**：单测四路径 `message_stop` 计数（[DONE] 正常 / 截断 / error / 空流）；集成断言上游收到 `stream_options.include_usage === true` 且落库 usage 三值齐全 prompt>0；动测试前先 grep 证实无旧形状断言依赖。
- **R4 文档同步**：AGENTS.md §8 注入矩阵句补 anthropic 入站形态；format-conversion.md §3.5 已知缺口行改写为不变量表述、§3.7 已知缺口标注改为已覆盖表述。

## Acceptance Criteria

- [ ] AC1 anthropic 入站 + openai-only 渠道**流式**请求：mock 上游收到 `stream_options.include_usage === true`；**非流式**请求出站体不含该字段（字节零变化红线）。
- [ ] AC2 该流式路径（上游按 include_usage 回 usage 尾 chunk）落库 usage 三值齐全且 prompt > 0。
- [ ] AC3 四路径 `message_stop` 计数：[DONE] 正常收尾 = 1；截断流 = 1；流内 error = 1；空 [DONE] 流 = 0。
- [ ] AC4 零回归：预设强制流式注入行为不变；两个 pivot 分支出站体 `stream_options` 仍 undefined；全量 `bun run check && bun run typecheck && bunx vitest run` 全绿。
- [ ] AC5 无预设无伪装的非流式请求保持既有字节（零重序列化 gate 语义不变）。

## Out of Scope

- responses 目标 / anthropic 目标分支注入（协议自带 usage，不适用）。
- count_tokens / playground / 伪装预设引擎语义变更。
- 其余流式转换器的同类审计（本任务只修两处已确认缺口；若质检发现同族新缺口，另行立项）。
