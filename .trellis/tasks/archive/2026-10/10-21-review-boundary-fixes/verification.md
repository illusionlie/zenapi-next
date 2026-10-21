# verification：评审修复父任务收口

日期：2026-10-21。

## 交付总览（4 feat + 1 docs + 规划/归档 chore）

| 提交 | 内容 |
|------|------|
| 2dbbf9d | chore(trellis)：任务树规划（父 + 4 子三件套） |
| 975b3e2 | feat(api)：splitWindow 短窗口（span≤1 天）绕开 rollup 段 |
| 1c9322c | feat(api)：retention 配额加固（chunk 5000×180 轮）+ cron rollup 自愈补漏 |
| 216707d | feat(api)：计费 batch 单次重试 + 可对账日志载荷 |
| 9e9bf47 | feat(api)：debug 日志 text 回退 / 管理台直读 / 冷却 streak 5 分钟衰减 |
| d281a3b | docs(spec)：AGENTS §8 + usage-accounting §8·§9 同步 |

## 父任务收口验证

- 全量门禁在四子任务合流后的提交树上重跑：check 0 error（23 warnings + 7 infos 存量）、
  typecheck exit 0、vitest 31 文件 611 用例全绿。
- 跨子任务验收 5 条全勾（见 prd.md）；「不许动」清单经 4 个子任务 check 的越界扫描逐项确认。
- 每个子任务有独立 verification.md（实现/复核代理结论 + 主会话抽查记录 + 偏离裁定）。

## 遗留（评审结论中未纳入本树的事项）

- env.DB WeakMap 同一性假设（评审 W2）：缓存注册表依赖未文档承诺的绑定对象同一性，
  失效形态为静默零命中——建议后续加一次性探针计数（.trellis 任务或 issue 跟踪）。
- GET /api/usage 内联 retention（Free 计划 50 条查询上限仍可能超限）：cron 已覆盖，可考虑摘除读路径内联 prune。
- 计费失败日志载荷不含 cachedInputTokens/cacheCreationTokens/latencyMs（离线重建缺缓存列）：需要时再加。
