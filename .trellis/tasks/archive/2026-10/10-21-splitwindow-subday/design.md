# design：splitWindow 短窗口绕开 rollup

## 决策

**判定放 splitWindow 内部，而非调用点。** 理由：5 个调用点（monitoring.ts:22、
user-api.ts:129/487、dashboard.ts:44、models.ts:179/184）语义同源，逐点改必然漏；
未来新增调用点自动继承正确语义。短窗口走 raw 扫描的成本即改造前（46e3d8c~1）的成本，
可接受。

## 改动形态

`splitWindow(fromIso, toIso, now)` 内部，在现有 `from >= todayStart` 分支之后、
rollup 分支之前插入短窗口短路：

```ts
// sub-day windows must not eat the day-granularity approximation
const toMs = to === "" ? now.getTime() : parseUtcIsoMs(to);
const fromMs = parseUtcIsoMs(from);
if (fromMs !== null && toMs !== null && toMs - fromMs <= DAY_MS) {
	return { rollupFrom: null, rollupTo: "", rawFrom: from, rawTo: to === "" ? null : to };
}
```

- 返回形态与现有「纯当日窗口」分支（usage-stats.ts:79-87）完全一致，下游
  loadWindowTotals / loadChannelHealthRows / loadModelRequestStats / loadModelUsageTotals /
  loadUserUsageTotals 无需感知。
- **1d 档**：`now - (now - 24h) === DAY_MS`，`<=` 判定命中 → raw-only。这是有意的
  （1d 是监测页语义最敏感的档位，宁可付 raw 扫描也不接受恒虚高）；design 定稿此行为。
- **7d/30d**：跨度 > DAY_MS，不命中，行为与现状逐字节一致。

## parseUtcIsoMs（新私有 helper）

输入是 `toISOString()` 全格式（`2026-10-20T03:17:00.000Z`）或 `slice(0,19)` 截断
（`2026-10-20T03:17:00`）。截断形态无 Z 后缀，裸 `Date.parse` 会按本地时区解释——
必须先规范：长度 19 时补 `Z`，长度 ≥ 20 且已带时区标记则原样 parse。parse 失败返回
null（垃圾输入维持现状宽松：不短路、走原有字符串比较路径，不抛错）。

- `to === ""` 时用 `now.getTime()`（窗口终点=当下）。
- 只用于 span 判定；返回值里的 rawFrom/rawTo 仍传原字符串，SQL 绑定零变化。

## 各调用点影响核对（实现时逐一验证）

| 调用点 | 输入形态 | 新行为 |
|--------|----------|--------|
| monitoring.ts:22 | `now-config.ms`（15m/1h/1d/7d/30d） | 15m/1h 恒 raw-only；1d 恒 raw-only（修掉恒虚高）；7d/30d 不变 |
| user-api.ts:129 | 同上（用户监测） | 同上 |
| user-api.ts:487 | `(null, null)` | 不变（fromMs null 不短路） |
| dashboard.ts:44 | query.from/to 任意 | 子日窗口精确化；跨日/全史不变 |
| models.ts:179/184 | 30d 固定窗口 | 不变（span 30d） |

`loadChannelDailyTrends` 消费 split 的方式不动（小时槽 sqlSlice ≠ 10 走 raw-only 的
既有逻辑保持；当天槽位本就只扫当日 raw）。

## 测试设计（确定性锚点，全部注入 now）

沿用 tests/usage-stats.test.ts 的 fake db / 固定数据集模式：

1. `splitWindow` 纯函数单测：1d 形态（now 取 UTC 23:00 与 00:30 两个时刻）、15m 跨午夜
   （now = 00:07Z）、历史同日子日窗口（from/to 都在昨天）、7d 回归（rollupFrom =
   7 天前日期）、截断无 Z 后缀输入、`(null, null)` 不变。
2. 等价性测试：固定数据集（跨昨日/今日的行），短窗口下 loadWindowTotals(split) ==
   raw-only 直查结果，逐字段断言。
3. 既有测试更新：凡断言「子日窗口吃整天 rollup」的旧语义用例改为新语义，在 implement.md
   逐条列清单（预期只有 usage-stats.test.ts 内 splitWindow 单元段需要动）。

## 风险与回滚

- 唯一行为风险：某调用点隐式依赖「短窗口也走 rollup」的性能（大 raw 表短窗口扫描）。
  核对过 5 个调用点均为管理台/用户端聚合端点，非代理热路径，且改造前就是 raw 扫描。
- 回滚 = revert 单个 feat commit，无迁移、无数据形态变化。
