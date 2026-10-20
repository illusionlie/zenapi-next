# implement：splitWindow 短窗口绕开 rollup

前置：`git status --short` 应干净（父任务规划文件已提交或可随后一起提交）。
测试命令一律 `bunx vitest run`（**禁止** `bun run test`——那是 watch 模式；禁止起 dev/wrangler 长驻进程）。

## 步骤

1. [x] `apps/worker/src/services/usage-stats.ts`：
   - 新增私有 `parseUtcIsoMs(s: string): number | null`（长度 19 补 Z；带时区标记原样 parse；失败 null）。
   - `splitWindow` 在 `from >= todayStart` 分支后插入 span ≤ `DAY_MS` 短路（见 design.md 代码形态）。
   - 更新 splitWindow 顶部的 JSDoc：短窗口 raw-only 语义替换「Boundary note」段落中
     「window 起点日整天计入」的无条件表述。
   - **实现偏离记录**：span 判定按**秒粒度**比较（`floor(toMs/1000) − floor(fromMs/1000) ≤ DAY_MS/1000`），
     而非 design.md 字面的 `toMs − fromMs ≤ DAY_MS`（毫秒直比）。原因：monitoring.ts:17 与
     user-api.ts:127 的 `since` 是 `.toISOString().slice(0, 19)`（截断到秒），而 `to === ""` 用带毫秒的
     `now`——1d 档的真实毫秒跨度是 `DAY_MS + (0..999ms)`，毫秒直比在 ~99.9% 的真实时钟下**漏掉 1d 档**，
     PRD R1/AC 明确要求 1d 档命中 raw-only。秒粒度floor 后 1d 档恰为 86400s（`<=` 命中），7d/30d 不受影响
     （604800s/2592000s ≫ 86400s），且对 ±1s 内的边界窗口两侧都无正确性悬崖（raw-only 恒精确）。
     专项测试锚定：east-host probe 用例在毫秒直比实现下于任何时区失败。
2. [x] `tests/usage-stats.test.ts`：
   - 新增 design.md 测试设计 1/2 两节用例（全部注入 now，不依赖真实时钟/随机）。
   - 更新与旧短窗口语义绑定的既有断言 → **在此逐条列出改了哪些用例、为什么**：
     - **零个既有用例需要更新**。逐条核对（全部维持原断言、原值通过）：
       - `serves pure current-day windows from raw alone`：from 在今日 → 走新逻辑**之前**的既有分支，不触发短路。
       - `splits spanning windows…`（4 天跨度）/ `drops the raw segment…`（4 天）/ `clamps the rollup upper bound…`（2+ 天）：跨度 > 1 天，不命中短路，rollup 段逐字段不变。
       - `treats an absent from as unbounded rollup coverage`（(null,null)）：`parseUtcIsoMs("")` → null → 不短路（R3）。
       - `produces no segment at all for a same-day date-only range (legacy quirk)`：date-only（10 字符、无时区标记）→ parse null → 不短路，「无任何段」怪癖保持。
       - endpoint 级用例（dashboard `?from=` 3 天前、models 30d/7d、monitoring `range=30d`、user loaders (null,null)）：跨度均 > 1 天或 from 缺省，路径与断言不变。
     - 新增用例清单：sub-day short-circuit describe 8 例（24h@23:00、24h@00:30、15m 跨午夜、历史同日一小时、
       7d 回归锚定、UTC 解析 east/west 双探针、(null,null) 不变）+ 等价性 describe 2 例
       （24h 滚动窗口 loadWindowTotals == raw-only 直查、历史子日窗口 loadDashboardSummary == raw-only 直查，
       固定数据集 + 已 rollup 的边界日，逐字段断言 + 确定性锚点值）。
3. [x] 核对 5 个调用点无需改动（grep splitWindow 消费点，确认无隐藏依赖）。
   - monitoring.ts:22 / user-api.ts:129：15m/1h/1d → raw-only（修复），7d/30d 不变；
   - user-api.ts:487 (null,null)：不变；dashboard.ts:44：子日窗口精确化；models.ts:179/184（30d/7d 全格式 ISO）：不变。
   - 消费侧 grep 确认：rawFrom/rollupFrom 全部作通用边界参数使用；唯一特判
     `loadChannelHealthRows` 的 `rawFrom === null` 回退（窗口终于往日）与 trends 的
     `sqlSlice !== 10 || rollupFrom === null` raw-only 分支，短路形态（rawFrom = 精确 from）均走正常路径。
     路由文件不直接触碰 split 字段。
4. [x] 门禁：`bun run check`（biome 会重排 .trellis 下 task.json 缩进——预期行为，不回滚）
   → `bun run typecheck` → `bunx vitest run`。结果：check 通过（exit 0，警告为存量非阻断）、
   typecheck 通过（exit 0）、vitest 全量 31 文件 586/586 通过（usage-stats 35/35）。

## 验证命令

```bash
bunx vitest run tests/usage-stats.test.ts
bun run check && bun run typecheck && bunx vitest run
```

## 完成判据

- prd.md Acceptance Criteria 全勾。
- 等价性测试用固定数据集逐字段断言通过。
- 无调用点文件改动（除非核对发现隐藏依赖，此时记录理由）。

## 回滚点

- 单 feat commit revert 即可；无迁移无数据变化。
