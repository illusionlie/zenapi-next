# 对比调研采纳批次：CPA/NewAPI

## Goal

对 CLIProxyAPI（router-for-me/CLIProxyAPI v8.0.44，Go 本地长驻）与 New API（QuantumNous/new-api，全功能计费分发平台）调研（2026-10-28，三路子代理：外部两项目功能清单 + 本地仓库细节盘点）后，经维护者拍板成立的功能批次。父任务持有需求源、拍板记录、任务地图与跨子任务验收；实现工作全部落在子任务，父任务不直接承载代码变更。

与上轮 ai-relay 批次的差异：本轮 4 个子任务中 3 个是**设计评估型**——交付物是评估报告而非代码，用户看完报告再逐项决定是否立项实施（实施任务届时再挂到本父任务下）。

## 需求来源与拍板记录

| 项 | 决策 | 备注 |
|----|------|------|
| 缓存 token 折价计费 | ✅ 实施 | 现 `calculateCost` 把含缓存 prompt 全量按 input_price 计价（`services/pricing.ts`），而 `prompt_tokens` 口径为含缓存总输入；Anthropic 缓存读上游收 0.1×、缓存写 1.25×，OpenAI cached 约 0.5×——对 Claude Code 等缓存重度场景用户被多收、运营账目与上游成本对不上；`usage_logs` 缓存列已具备，只差计价口径 |
| Gemini 原生协议 | 🔍 设计评估 | 用户原话「先设计看看成本怎么样」；`/v1beta` generateContent / stream / countTokens；格式白名单（`openai/responses/anthropic/custom`，`services/channel-types.ts:3`）顺延第 5 种；CLIProxyAPI 与 New API 均已支持 |
| 管理员 2FA | 🔍 设计评估 | 「可以考虑」按评估先行；管理员握全部渠道明文 key + 支付网关密钥 + 备份导入全量替换权，现仅密码 + session |
| 敏感词过滤 | 🔍 设计评估 | 用户明确「要看看成本，毕竟是 worker」——热路径现状默认零 body 解析，过滤要求全量解析 + 扫描，成本收益必须算清 |
| 兑换码 / 邀请返利 | ❌ 不做 | 不往运营激励方向发展 |
| CLI OAuth 订阅账号池 | ❌ 不做 | CLIProxyAPI 的灵魂，但属定位决策，明确放弃 |
| OAuth 种类扩展 | ❌ 暂不做 | 保持仅 LinuxDO |
| 多管理员 RBAC | ❌ 不需要 | 单管理员够用 |

## 任务地图

| 子任务 | 类型 | 复杂度 | 建议顺序 |
|--------|------|--------|----------|
| `10-28-cache-token-billing` | 实施 | 复杂（需 design+implement） | 1 |
| `10-28-gemini-native-protocol` | 设计评估 | 轻量（PRD-only，交付物=评估报告） | 2 |
| `10-28-admin-2fa` | 设计评估 | 轻量（PRD-only，交付物=评估报告） | 3 |
| `10-28-sensitive-word-filter` | 设计评估 | 轻量（PRD-only，交付物=评估报告） | 4 |

无硬依赖；cache-token-billing 先行（唯一实施项，且其计价形状决策影响 gemini 报告中的 usage 计费交叉章节）。三个评估报告完成后由用户逐项拍板；采纳者另开实施子任务挂本父任务下，拒绝/挂起在父任务拍板记录表补注即可。

## 跨子任务验收（父任务持有）

- [ ] 每个子任务独立走完 Trellis 流程（artifact → start → 交付 → check → spec 更新 → commit → archive）；评估型任务的「交付」= 报告落盘 `research/`。
- [ ] 实施子任务合入后：`bun run check && bun run typecheck && bun run test` 全绿（主会话亲跑门禁）。
- [ ] 三个评估报告齐备且用户逐项拍板（采纳 / 拒绝 / 挂起各有着落，结论回写本文件拍板记录表）。
- [ ] 实施落地时 AGENTS.md §8 / §10 相应小节同步更新。

## 非目标

- 不做：兑换码、邀请返利、CLI OAuth 账号池、OAuth 种类扩展、多管理员 RBAC（2026-10-28 拍板）。
- 不重提上轮 ai-relay 未采纳清单：NewAPI 导入导出、渠道自动禁用/自动恢复探测、请求日志采集窗口（见 memory `ai-relay-comparison`）。
- 不做多平台运行时抽象（ZenAPI 单栈 CF Workers + D1）。
- 不把「看起来缺其实不缺」当差距补：embeddings/images/audio 等专用端点（passthrough 已覆盖且计费一致）、管理 API/热更新（admin API + TTL 缓存已是 serverless 等价物）。
