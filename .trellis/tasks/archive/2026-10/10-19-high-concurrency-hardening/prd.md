# 高并发加固（父任务）

## Goal

让 ZenAPI 的代理热路径与数据层在并发水位上匹配 Workers 平台的弹性能力：消除每请求 D1 全表扫描与零缓存串行读、修复计费并发正确性、把统计查询从原始行实时聚合切到预聚合、给故障渠道冷却能力并削掉入口日志的每请求 CPU/内存税。对外协议行为（`/v1`、`/anthropic/v1` 的请求/响应形态与错误码语义）保持不变。

## 背景（2026-10-19 架构审查，证据均在工作区核实）

- **鉴权无索引**：全库 CREATE INDEX 清单无 `tokens(key_hash)`、无 `admin_sessions(token_hash)`；`tokenAuth.ts:34-38` 每个代理请求全表扫描 tokens，`adminAuth.ts:17-21` 每个管理请求全表扫描 admin_sessions（惰性清理致单调增长）。
- **每请求 ~10 次 D1 往返、零缓存**：一次计费请求 7 读 + 3 写，上游 fetch 前串行深度 4 RTT（tokenAuth 两次 → 别名两条 → channels+settings 批，仅一处 Promise.all，proxy.ts:607-616）；`env.ts` 仅 DB 绑定，无 KV/Cache API/内存缓存。
- **计费三写无事务、无守卫、失败静默**：INSERT usage_logs（services/usage.ts:45-70）+ UPDATE tokens（usage.ts:72-79）+ UPDATE users.balance（proxy.ts:899-904、anthropic-proxy.ts:483-490）独立执行；流式路径记录任务失败被 .catch 吞掉（proxy.ts:964-972）；扣费无 `WHERE balance >= ?`，闸门读旧值快照（tokenAuth.ts:76-77）。
- **统计无预聚合**：dashboard/monitoring/models/user-api 四处对 usage_logs 原始行做 7d/30d 实时聚合（dashboard.ts:35-81、monitoring.ts:7-89、models.ts:169-243、user-api.ts:113-211），token_id/model 无索引；D1 单库单线程逐查询处理，大聚合排队会拖慢同库代理请求。
- **retention 恶性循环**：无 cron（wrangler.toml 无 [triggers]），仅管理员 GET /api/usage 顺带触发（usage.ts:42-43）且为单条无 LIMIT 大 DELETE（services/usage.ts:91-94）；admin/user sessions 仅惰性清理、永久残留。
- **入口日志税**：index.ts:34-61 对每个写方法请求 clone + 全量 json() 解析 + Object.keys + console.log（请求体被双重完整解析，长对话体数百 KB；isolate 内存上限 128MB）。
- **无渠道熔断**：坏渠道每请求同权重参与加权随机（services/channels.ts:11-30）与重试矩阵（rounds×渠道×Key + 每轮 sleep，proxy.ts:727-819）。
- **平台参照**：D1 单库单线程，过载先排队后报 overloaded（官方 limits 文档）；Workers 每调用同时等响应头连接上限 6；Cron 触发墙钟 15 分钟。

## 任务地图

| 子任务 | 交付物 | 顺序 |
|--------|--------|------|
| [10-19-p0-index-billing](../10-19-p0-index-billing/prd.md) | 索引迁移 0025 + 计费三写 db.batch 原子化 + 余额钳制不为负 | 1（必须最先） |
| [10-19-p1-hotpath-cache](../10-19-p1-hotpath-cache/prd.md) | token+user JOIN、热路径读并行合一、TTL 缓存、非流式写入 waitUntil 化 | 2（依赖 P0 的 batch 化写路径） |
| [10-19-p2-rollup-retention](../10-19-p2-rollup-retention/prd.md) | usage_stats_daily 预聚合 + Cron scheduled handler + 分批 DELETE + 会话清理 | 3（建议在 P1 后） |
| [10-19-p2-cooldown-log-trim](../10-19-p2-cooldown-log-trim/prd.md) | 渠道失败冷却（fail-open）+ 入口日志 body 解析默认关闭 | 3（与 rollup 相互独立，可并行推进） |

**前置依赖（硬性）**：`10-18-cache-rate-stats`（in_progress，工作树未提交）必须先完成提交——迁移编号 0024 已被其占用（本树从 0025 顺延），且 proxy.ts / services/usage.ts / anthropic-proxy.ts / utils/usage.ts 与本树 P0/P1 改动文件重叠，带脏改开工必然冲突。

## 关键决策（已定）

- **余额防负策略：钳制不为负**（用户 2026-10-19 决策）——`balance = MAX(0, balance - cost)`；usage_logs 仍记真实 cost，差额可对账审计；预扣-退款模式明确不采用，未来如需另立任务。
- 缓存只做 isolate 内存 TTL（无 KV/DO）：渠道/别名 10s、代理 settings 30s；不做写时失效。
- 冷却只做 isolate 内存视图：固定 3 连败 60s、fail-open；不做跨 isolate 一致性与半开探测。
- rollup 日切默认 UTC（与 created_at ISO 存储一致），本地时区日切留待 P2 激活时定稿。

## 跨子任务约束与验收

- 每个子任务：对外协议行为不变；`bun run check && bun run typecheck && bun run test` 全绿；新表/索引同时改 schema.sql 与编号迁移（AGENTS §13.2）。
- 文档同步：AGENTS.md §8 / §10 随各子任务更新；spec（usage-accounting、settings-config、database-guidelines、channel-routing）在 Phase 3.3 增补契约。
- 子任务激活门槛：各自 prd/design/implement/jsonl 齐备并经用户批准后 `task.py start`（P2 两子任务当前仅 prd，design/implement 在其激活前补齐）。
- **父任务集成审查**（四子任务全部归档后）：核对索引齐备且 EXPLAIN 走索引、计费 batch 原子且钳制生效、热路径读次数达标、cron 手动触发全链路通过、冷却 fail-open 行为正确；对 AGENTS/spec 做一次整体一致性通读。

## 非目标（全树）

- 不引入 Durable Objects、KV、Queues、读副本等新基础设施；isolate 内存是缓存与冷却的上限。
- 不做分布式限流/请求队列/半开探测。
- 不改计费价格模型、前端计费展示、重试轮数/延迟语义本身。
- 不动 observability 采样配置（部署侧自调）。

## 风险

- cache-rate-stats 未落地前本树任何子任务不得 start（文件冲突 + 迁移编号冲突）。
- TTL 缓存引入管理端配置变更的陈旧窗口（≤10s/30s），P1 落地时必须在 AGENTS §8 文档化。
- P2 rollup 的大小窗口拼装（今日原始行 + 历史 rollup）是全树最复杂的 SQL 改造，激活时需专项 design 定稿。
