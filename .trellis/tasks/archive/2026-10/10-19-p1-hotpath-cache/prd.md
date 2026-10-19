# P1：热路径缓存与写入异步化

## Goal

把一次代理请求的 D1 读从 ~7 次压到「鉴权 1 次 + 并行 1 批」，低频变更数据（渠道/别名/代理 settings）加 isolate TTL 缓存，非流式与错误路径的 usage 写入不再阻塞响应。目标：上游 fetch 之前的串行深度从 4 个 RTT 降到 2 个，D1 读压力与并发量解耦。前置：P0（10-19-p0-index-billing）已归档——依赖其 batch 化的写路径与索引。

## 背景（已核实的事实）

- 一次用户绑定 token 的计费请求：7 读 + 3 写 = 10 次 D1 往返；并行点仅一处（proxy.ts:607-616），串行深度 4 RTT：tokenAuth.ts:34-38（tokens）→ :64-72（users）→ proxy.ts:566（模型别名）→ :573（aliasOnly 全表）→ :607-616（channels + settings×2）。
- 零缓存：env.ts Bindings 仅 DB；channels 全量 `SELECT *` 含 models_json 大列（proxy.ts:608）、aliasOnly 全表读（model-aliases.ts:296-311）、代理 settings 4 键 2 条 SQL（proxy-headers.ts:79-96、settings.ts:433-475）每请求直打。
- token 与 user 两次查询存在依赖链（user 查询需 token.user_id），可 JOIN 合一；两表存在同名列（status / allowed_models），须显式列清单避免歧义。
- 非流式 usage 三写在 return 响应前 await（proxy.ts:978-980、anthropic-proxy.ts:516-533）；错误路径 INSERT 阻塞（proxy.ts:823-836、anthropic-proxy.ts:411-424）。流式路径已验证 waitUntil 模式（proxy.ts:947-977，含 executionCtx 缺失降级 fire-and-forget）。
- settings-config.md 的三级回退链（settings→env→默认）与 clamp 语义：缓存层只能缓存「settings 表的读取结果」，回退逻辑照常每次执行（纯内存），语义不受影响。

## Requirements

- **R1 tokenAuth JOIN 合一**：单条 SQL 显式列清单（tokens LEFT JOIN users ON u.id = t.user_id），鉴权阶段 2 RTT → 1 RTT；无 user_id 的 token 行为等价（user 字段为 null）。
- **R2 鉴权后读并行合一**：模型别名解析、aliasOnly 映射、活跃渠道、代理运行时 settings（头策略 + 重试配置 4 键一次 IN 查询）进单个 Promise.all，形成 1 个 RTT 阶段。
- **R3 TTL 缓存**（新 utils/cache.ts，isolate 内存 Map + 过期时间戳，零依赖）：活跃渠道 10s、别名两图 10s、代理 settings 30s；TTL 常量集中定义；命中路径零 D1 读。
- **R4 写入异步化**：非流式与错误路径 usage 记录改 waitUntil（抽公共助手复用流式路径的 executionCtx 降级模式）；响应返回不再等待计费写。
- **R5 测试**：缓存 TTL 命中/过期（fake timers）、JOIN 三态等价（无 user / 有 user / user 缺失）、settings 缓存包装与回退链回归、waitUntil 降级路径。
- **R6 文档**：AGENTS.md §8 注记缓存陈旧窗口（渠道/别名 ≤10s、settings ≤30s 生效）；spec settings-config / proxy-headers / channel-routing 增补缓存注记。

## 非目标

- 不做写时失效/跨 isolate 失效（无 DO/KV；TTL 到期自然刷新）。
- 不缓存 token 鉴权结果（安全敏感；P0 索引后其成本已可接受）。
- 不动 retry 循环内部逻辑（P2 cooldown 处理）。
- 不动 playground（不记录用量）。

## Acceptance Criteria

- [ ] 一次计费代理请求（缓存冷）D1 读 ≤ 5 次；缓存热 ≤ 2 次（鉴权 JOIN + 至多一次未命中补读）。
- [ ] 管理台修改渠道/别名后 ≤ 10s、修改代理 settings 后 ≤ 30s 对代理路径生效（文档化陈旧上界，本地 dev 实测）。
- [ ] 非流式响应返回不再包含 usage 写入延迟（代码路径审查：await record 已改 waitUntil）。
- [ ] settings 三级回退链与 clamp 语义回归通过（既有 settings 测试零改动通过）。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。
