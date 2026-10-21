# verification：计费 batch 失败单次重试与可对账日志

日期：2026-10-21。实现：trellis-implement 子代理；复核：trellis-check 子代理 + 主会话亲验
（check 代理曾为 baseline 对比执行 stash/pop 引入 CRLF 噪音，已自愈；主会话以 git status /
diff 抽查 + `bunx vitest run tests/usage-billing.test.ts` 7/7 复跑确认交付态完好）。

## 结论：可提交

- **AC 全过**：瞬时失败吸收（拒一次 → 无失败日志、batch 共 2 次、重放含完整三写）；
  持续失败（拒两次 → R2 全字段 + attempts=2、resolve 不 reject）；成功路径恰一次 batch
  零额外延迟；门禁全绿（check 0 error / typecheck exit 0 / vitest 31 文件 598 用例）。
- **usage-accounting §8 契约零回归**：每次尝试仍是单次 db.batch(statements)；MAX(0,…) 钳制
  SQL 逐字节未动；条件省略四组合用例零改动；重放复用同一 statements 数组引用，无重建无变异。
- **确定性**：目标文件连跑 3 次 7/7 一致；全部用例 retryDelayMs: 0，零真实定时器。

## 实现偏离（2 条，复核相容）

1. 内联 while（BILLING_BATCH_MAX_ATTEMPTS=2 固化「恰一次重试」）代替独立 helper——无独立复用方。
2. status 记 input 原始值（undefined 键序列化缺位）：重建规则 `payload.status ?? "ok"` 三态
   精确还原 INSERT 行为；4 处调用方恒传显式值，undefined 仅为理论态。

## 遗留观察（非阻断）

- 载荷不含 cachedInputTokens / cacheCreationTokens / latencyMs——离线重建统计行缺缓存列；
  PRD R2 字段清单即此，后续需要时再加。
