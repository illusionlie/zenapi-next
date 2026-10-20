# verification：splitWindow 短窗口绕开 rollup

日期：2026-10-21。实现：trellis-implement 子代理；复核：trellis-check 子代理 + 主会话抽查核心 diff。

## 结论：可提交（6 项检查全过）

- **AC 逐条全过**：1d 档（24h@23:00 / 24h@00:30，now 毫秒 .750/.000 双形态）→ raw-only；
  15m 跨午夜（now=00:07Z）→ raw-only；历史同日子日窗口 rawTo 精确；7d 回归锚定
  （rollupFrom = 7 天前日期）；等价性 2 例（split == raw-only 直查，含已 rollup 昨日的
  数据集，锚点值 4 请求/1 错误/330ms、2 请求/150 tokens/cached 40/base 100）。
- **确定性**：`bunx vitest run tests/usage-stats.test.ts` 连跑 3 次，35/35 完全一致。
- **门禁**：check exit 0（23 warnings + 7 infos 存量非阻断）、typecheck exit 0、
  vitest 31 文件 586/586。
- **越界扫描**：5 个调用点零改动（git diff 无 routes/ 文件）；rollup 写入侧 /
  loadChannelDailyTrends / 防丢守卫未动。
- **既有断言更新**：零个（6 个旧 splitWindow 用例与全部 endpoint 用例的输入跨度均 >1 天
  或 from 缺省，原样通过）。

## 实现偏离（已独立复核确认必要）

span 判定用**秒粒度 floor 比较**而非 design 字面的毫秒直比：monitoring/user-api 的
`since` 是 `toISOString().slice(0,19)`（截断到秒），`now` 带毫秒，1d 档真实毫秒跨度
= DAY_MS + (0..999ms)，毫秒直比在时钟毫秒 >0 时漏掉 1d 档。floor 后恰 86400s 命中；
7d/30d 不受影响。east-host 探针用例（毫秒直比实现下任何时区必挂）锚定该规则。

## 遗留（父任务收口处理）

- AGENTS.md §8 预聚合条目未反映「span ≤ 1 天 raw-only」新语义（docs(spec) 提交统一更新）。
- monitoring.ts / user-api.ts 行内「Two-segment assembly」注释对短窗口档位表述滞后（同上）。
