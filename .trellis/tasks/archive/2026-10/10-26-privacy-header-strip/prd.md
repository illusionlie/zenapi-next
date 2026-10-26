# 上游请求默认剔除隐私/转发头

## Goal

`buildChannelRequest` 以 `new Headers(incomingHeaders)` 全量复制客户端入站头（仅删
`host` / `content-length`，`routes/proxy.ts:207-211`），导致 CF 边缘注入的
`cf-connecting-ip` / `x-forwarded-for` / `x-real-ip` 等与 `cookie` 被原样转发给上游
服务商——等于把终端用户真实 IP 送出去。本任务在应用层加一份固定默认剔除清单。

已确认边界（维护者知悉）：Cloudflare Workers 出站连接自身的平台特征（出口 IP 段等）
应用层不可去除，本任务只管 HTTP 头。

## Requirements

- **R1 固定剔除清单**：在 `buildChannelRequest` 头构建处（删 host/content-length 同一
  收口点，proxy / anthropic-proxy / playground 三处共用）追加默认剔除，至少覆盖：
  `cf-connecting-ip`、`cf-ipcountry`、`cf-visitor`、`cf-ray`、`cf-worker`、
  `true-client-ip`、`x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host`、
  `x-real-ip`、`cdn-loop`、`cookie`。清单为代码常量（大小写不敏感，与
  `headers.delete` 同语义），v1 不做可配置。
- **R2 层序不破坏**：剔除发生在 `applyHeaderPolicy` 五层之前（即基础头阶段），因此
  全局注入（settings extra headers）仍可显式加回任意头（管理员意图优先）；预设 /
  伪装 / 渠道 custom 层在其后应用，不受影响（opencode 预设等全部自设头，无依赖）。
- **R3 host/content-length 既有剔除不回归**。
- **R4 测试**：单测断言——清单内头不出现在构建出的上游 headers（含大小写变体）；
  `host` / `content-length` 剔除保持；`cookie` 剔除；全局注入同名头（如管理员显式配
  `x-forwarded-for`）时该头仍出现于最终 headers；未列头的正常透传不受影响
  （如 `anthropic-beta`、`x-stainless-*`）。

## Acceptance Criteria

- [ ] 含 `cf-connecting-ip: 1.2.3.4` / `x-forwarded-for` / `cookie` 的入站请求，构建出的
      上游请求头中三者均不存在。
- [ ] 全局注入配置 `x-forwarded-for: 9.9.9.9` 时上游头为 `9.9.9.9`（显式意图可覆盖）。
- [ ] `anthropic-beta` 等未列头透传行为不变；三处调用方（proxy / anthropic-proxy /
      playground）行为一致。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不动默认 UA 策略（未采纳项，客户端 UA 继续透传）。
- 不做可配置剔除清单 / 管理台 UI（v1 固定常量）。
- 不处理 Workers 出站连接层平台指纹（做不到）。
