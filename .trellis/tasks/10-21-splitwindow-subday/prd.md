# splitWindow 短窗口绕开 rollup

## Goal

修复 splitWindow「边界日整天近似」在短窗口上的放大缺陷：span ≤ 1 天的窗口完全绕开
日粒度 rollup 段，以 raw 段精确边界服务；span > 1 天的窗口保持 rollup + raw 两段拼装
（含文档化边界日近似，误差 ≤ 1/窗口天数）。

## 缺陷（已核验，评审 Critical 3）

`splitWindow`（services/usage-stats.ts:70-99）对起点日整天计入 rollup 段。调用方把
`now - config.ms` 直接喂进来后：

- **1d 档恒错**：`now-24h` 恒落昨日 → rollup 段 = 昨天一整天 + raw 段 = 今天 0 点至今。
  UTC 23:00 时报出 ~47h 数据（~2x 虚高），全天每时每刻都错（monitoring.ts:17-22、user-api.ts:129）。
- **15m/1h 档跨 UTC 午夜爆炸**：00:00–00:15 之间 15m 窗口把昨天整天计入（~96x）；
  1h 档 00:00–01:00 同理（~24x）。
- **dashboard 任意历史子日窗口**（query.from/to，dashboard.ts:44）同样吃整天近似。
- 同一响应自相矛盾：summary 走 split（虚高），趋势图 `loadChannelDailyTrends` 小时槽走
  raw-only（精确）。
- 改动前（46e3d8c~1）monitoring 是精确单段 raw 查询——这是本次引入的回归。

## Requirements

- **R1 短窗口判定收敛在 splitWindow**：窗口有效跨度 ≤ 1 天（`DAY_MS`）时返回 raw-only
  形态（rollupFrom = null、rawFrom = 精确 from、rawTo 原样）。判定放 splitWindow 内部，
  全部 5 个调用点（monitoring / user-api 两处 / dashboard / models）自动继承，不逐点改。
- **R2 长窗口行为不变**：跨度 > 1 天的窗口保持现有 rollup + raw 拼装与边界日整天近似
  （7d 误差 ≤ 1/7、30d ≤ 1/30，AGENTS §8 已文档化）。
- **R3 from 缺省不受影响**：`splitWindow(null, null)`（user-api.ts:487 全史窗口）维持现状。
- **R4 时间戳解析确定性**：from/to 是 `toISOString()` 或其 `slice(0,19)` 截断（无 Z 后缀）。
  计算 span 时必须统一按 UTC 解释（截断形态补 Z 再 parse），禁止裸 `Date.parse`（无 Z 时
  按本地时区解析，跨时区结果漂移）。
- **R5 测试等价锚点**：短窗口下「split 拼装结果 == raw-only 精确查询结果」的确定性等价
  测试（注入 now、注入固定数据集），覆盖 1d 档形态、15m 跨午夜、dashboard 历史子日窗口、
  7d 档仍走 rollup（回归保护）。

## Acceptance Criteria

- [ ] `splitWindow(now-24h, null, now)` → rollupFrom 为 null、rawFrom = 传入 from。
- [ ] `now` 在 UTC 午夜后 15 分钟内、from = now-15min → rollupFrom 为 null。
- [ ] from/to 为历史同日一小时窗口 → rollupFrom 为 null、rawTo 精确。
- [ ] from = now-7d → rollupFrom = 7 天前日期（现状保持），有回归测试锚定。
- [ ] 注入数据集上短窗口 totals 与 raw-only 查询逐字段相等。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿；既有 usage-stats 测试中
      与旧短窗口语义绑定的断言按新语义更新（改动需在 implement.md 逐条列出）。

## 非目标

- 不改 `loadChannelDailyTrends` 的槽位逻辑（小时槽本来就走 raw-only）。
- 不改 rollup 写入侧（retention-fuse-backfill 子任务管）。
- 不处理 from > to 等垃圾输入的语义收紧（维持现状宽松）。
