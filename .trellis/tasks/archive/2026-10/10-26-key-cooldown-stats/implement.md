# Implement：渠道 Key 池冷却与错误统计

> 顺序执行，每步跑该步验证；设计依据 design.md（现状确认 §0 必读——401/403 现为
> break，本任务改为 continue，是有意的客户端可见行为变更）。

## Step 1：key-cooldown 模块 + 单测

- [ ] 新建 `apps/worker/src/services/key-cooldown.ts`（design §1 全签名；fnv1a32
      本地实现；Map 键 `channelId:fp`；惰性剪枝 + size>10000 清扫；now 注入）
- [ ] 新建 `tests/key-cooldown.test.ts`（design §6 第一条清单）
- 验证：`bunx vitest run tests/key-cooldown.test.ts`

## Step 2：迁移 + usage 透传

- [ ] `apps/worker/migrations/0030_usage_key_tag.sql` + `db/schema.sql` usage_logs
      同步（key_tag TEXT）
- [ ] `services/usage.ts`：UsageRecordInput.keyTag + INSERT 列/值
- 验证：`bun run typecheck`；bun:sqlite 跑迁移（照 0028/0029 验证方式）

## Step 3：proxy.ts 接线

- [ ] §2 五点：filterCoolingKeys、401/403 continue（不置 channelRetryable）、
      429/5xx/网络错 recordKeyRetryableFailure、其他 4xx 不冷却 break、成功
      recordKeySuccess；servedKeyFp/lastAttemptKeyFp → 两处 recordUsage keyTag
- 验证：`bunx vitest run`（预期部分 401 穿透类既有断言需更新——逐个核对语义后改，
  汇报列出改了哪些断言及理由）

## Step 4：proxy key failover 集成测试

- [ ] `tests/proxy-key-failover.test.ts`（design §6：401 failover / 全 401 穿透 +
      key_tag / 429 语义 / 成功 key_tag；mock 按 x-api-key 头区分，不依赖洗牌顺序）
- 验证：`bunx vitest run tests/proxy-key-failover.test.ts`

## Step 5：anthropic-proxy 接线 + 用例

- [ ] §3 同构改造（先读循环确认结构差异）；≥1 个 401 failover 用例（并入
      proxy-key-failover.test.ts 或就近文件）
- 验证：`bunx vitest run`

## Step 6：监测 + UI

- [ ] `routes/monitoring.ts`：渠道健康响应增 keyStats 内存段 + 24h usage_logs
      key_tag 归因查询（design §4）
- [ ] `apps/ui/src/features/MonitoringView.tsx`：渠道行展开 per-key 区
      （指纹 / 冷却徽标 / 计数 / 24h 归因），照该文件既有展开区样式；`core/types.ts`
      同步类型
- 验证：`bun run typecheck`

## Step 7：全量门禁 + 文档

- [ ] `bun run check && bun run typecheck && bunx vitest run` 三绿
- [ ] AGENTS.md §8：渠道多 Key bullet 更新（401/403 换 key 继续 + key 冷却两档 +
      归因分离 + key_tag + 监测双源）；§10 usage_logs 描述加 key_tag
- [ ] 若 `.trellis/spec/api-worker/backend/` 有冷却/usage 相关 spec 维护清单则同步
      （先看 usage-accounting.md 结构再动）
- 验证：`bun run check`

## 回滚点

Step 1-2 纯新增可丢弃；Step 3/5 后需回退两处循环接线；key_tag 列留存无害。
