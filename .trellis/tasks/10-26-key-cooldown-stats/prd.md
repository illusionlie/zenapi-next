# 渠道 Key 池冷却与错误统计

## Goal

单渠道多 Key 现状（`utils/keys.ts:1-6` 换行分隔、`routes/proxy.ts:919` 洗牌轮换）对
key 级失败**无冷却、无统计**——哪把 key 在报 401 全靠猜，坏 key 每轮重试都重新参战。
本任务补 key 级冷却、错误归因与统计展示，并顺带完成**归因分离**（拍板决策）：
key 坏 ≠ 渠道坏。

复杂任务：`task.py start` 前需补 `design.md` + `implement.md`。

## Requirements

- **R1 key 冷却（isolate 内存）**：照 `channel-cooldown.ts` 范式新建 key 冷却模块，
  键 = `channelId + key 指纹`（key 字符串短哈希，**稳定于存储行序变化**，不用列表
  index——管理员重排 key 行后 index 语义漂移）；失败分类冷却时长：
  - 401/403（key 大概率失效）：长冷却（建议 10 分钟，design 定稿）；
  - 429/5xx/网络错误：短冷却 60s；
  - 选 key 时跳过冷却中者；**全部 key 在冷却 → fail-open 不过滤**（沿用渠道冷却哲学，
    宁可再吃一次失败也不提前拒服务）。
- **R2 归因分离**：401/403 的 key 失败**不推进渠道冷却 streak / 重试失败计数**
  （key 坏 ≠ 渠道坏，换下一把 key 继续）；429/5xx 照旧计入渠道级判定（核对现行为后
  保持）。全 key 尝尽仍 401/403 → 按现行渠道失败语义处理（design 对照现状定稿）。
- **R3 key 错误统计**：`usage_logs` 加 `key_tag TEXT NULL`（key 指纹前 8 位，随
  recordUsage 透传，进同一计费 batch，原子性不动）；成功行也记（可算 key 维度成功率）；
  rollup 不动（key 维度只查近期 raw）。
- **R4 监测页展示**：渠道维度新增 key 健康展开——近期（1h/1d）per-key 错误计数、
  成功率、当前是否冷却中；key 显示指纹不显明文。
- **R5 单 Key 渠道零回归**：单 key 渠道行为与现状一致（冷却触发条件与渠道冷却的
  交互在 design 中明确，避免单 key 401 把整个渠道打进冷却的双杀）。
- **R6 测试**：429 后 60s 内该 key 不被首选；401 后长冷却且渠道 streak 不 +1；
  usage_logs 行含 key_tag；全 key 冷却时不提前 503；单 key 渠道回归用例。

## Acceptance Criteria

- [ ] 多 key 渠道某 key 连续 401 → 该 key 进入长冷却不再参战，其他 key 正常服务，
      渠道不进冷却。
- [ ] 监测页可看到该渠道 per-key 错误计数与冷却状态。
- [ ] usage_logs 新行均带 key_tag（多 key 渠道），存量行 NULL 兼容。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不做 key 健康分 / 轮换向导（后续可选）。
- 不做持久化 key 统计表 / key 级 rollup。
- 不做管理台 key 级禁用操作（删行即禁用，已有能力）。
