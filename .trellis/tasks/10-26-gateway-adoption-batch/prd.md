# 网关增强批次：ai-relay 调研采纳

## Goal

对 github.com/MoyuFamily/ai-relay 调研（2026-10-26，三路子代理源码分析 + 主会话逐项核实）后，
经维护者拍板采纳的功能批次。父任务持有需求源、拍板记录、任务地图与跨子任务验收；
实现工作全部落在子任务，父任务不直接承载代码变更。

## 需求来源与拍板记录

| 项 | 决策 | 备注 |
|----|------|------|
| count_tokens 端点 | ✅ 采纳 | 已核实现状 404（anthropic-proxy 仅挂 `POST /messages`，`routes/anthropic-proxy.ts:69`），成本低 |
| 令牌过期 | ✅ 采纳 | 语义拍板：到期**禁用不删除**、鉴权时惰性判定、`status` 保留人工意图态；额度耗尽现行语义（402 拒绝 + 行保留）即同构参照 |
| 默认剔除隐私/转发头 | ✅ 采纳 | 已核实 `buildChannelRequest` 全量复制入站头仅删 host/content-length（`routes/proxy.ts:207-211`），cf-connecting-ip / x-forwarded-* / cookie 透传泄露用户 IP 给上游；Worker 连接层自身特征不可根除，仅做应用层剥离 |
| 限流 | ✅ 采纳 | 拍板方案：令牌级 RPM（isolate 内存近似 + fail-open，不做 DO）+ IP 鉴权失败节流（防 token 爆破） |
| Key 池冷却 + 错误统计 | ✅ 采纳 | 冷却照 `channel-cooldown.ts` 范式（简化，无时间聚类）；错误统计进 usage_logs；归因分离（401/403 的 key 失败不计渠道失败） |
| 配置备份/恢复 | ✅ 采纳 | 一键导出/导入 JSON |
| Webhook 通知 | ✅ 采纳 | 以**故障报警**为主（报警延迟 ≤ 数分钟），用量日报为可选开关；无重试队列 |
| 主动健康探测 | ✅ 有条件采纳 | 渠道级开关**默认关**（公益站/中转站禁测活顾虑，维护者明确）；仅 GET /models 零 token 成本探测；结果只展示、**不参与路由裁决** |
| 渠道模板 | ❌ 拒绝 | 不做 |
| UA 中性回退 / UA 候选重试链 | ⏸ 未采纳 | 默认 UA 已查明为客户端透传（无默认值，客户端无 UA 时上游收到裸请求）；留作后续候选 |
| smart routing / KV 采样 / Local CLI / 生态互导 | ❌ 不采纳 | 非本批次范围 |

## 任务地图

| 子任务 | 优先级 | 复杂度 | 建议顺序 |
|--------|--------|--------|----------|
| `10-26-count-tokens-endpoint` | P1 | 轻量（PRD-only） | 1 |
| `10-26-privacy-header-strip` | P1 | 轻量（PRD-only） | 2 |
| `10-26-token-expiry` | P1 | 轻量（PRD-only） | 3 |
| `10-26-rate-limiting` | P1 | 复杂（需 design+implement） | 4 |
| `10-26-key-cooldown-stats` | P2 | 复杂（需 design+implement） | 5 |
| `10-26-config-backup-restore` | P2 | 复杂（需 design+implement） | 6 |
| `10-26-webhook-alerts` | P2 | 复杂（需 design+implement） | 7 |
| `10-26-channel-probe` | P2 | 复杂（需 design+implement） | 8 |

子任务间无硬依赖，可任意顺序；建议按上表（先小后大、先兼容缺口后能力增强）。

## 跨子任务验收（父任务持有）

- [ ] 每个子任务独立走完 Trellis 流程（artifact → start → 实现 → check → spec 更新 → commit → archive）。
- [ ] 全部子任务归档后：`bun run check && bun run typecheck && bun run test` 全绿。
- [ ] 涉及代理热路径的三个子任务（privacy-header-strip / rate-limiting / key-cooldown-stats）
      互不回归对方行为；最后一个热路径子任务的 check 覆盖一轮全量回归。
- [ ] AGENTS.md §8（代理关键行为）在相关子任务的 spec 更新环节同步补充新行为锚点。

## 非目标

- 不采纳 ai-relay 的：smart routing、KV 采样、Local CLI/设备码、渠道模板、UA 工程、生态互导。
- 不做 HMAC 无状态临时令牌（与计费归属冲突；过期用 DB 惰性判定替代）。
- 不做多平台运行时抽象（ZenAPI 单栈 CF Workers + D1）。
