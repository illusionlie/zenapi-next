# 合并渠道探测 cron 到 5 分钟 tick（3 条触发器减为 2 条）

## Goal

Cloudflare Workers Cron Triggers 上限为**每账号 5 条（Free）/ 250 条（Paid）**（官方 limits 表：
"Number of Cron Triggers per account"）。本仓库 `apps/worker/wrangler.toml` 现占 3 条
（`17 3 * * *` 维护 / `*/5` 报警 / `*/10` 探测），用户已在同账号部署其他项目时撞配额上限。

目标：移除 `*/10` 触发器，渠道主动探测的到期判定挂到既有 `*/5` tick 顺带执行——
探测调度器本就是「到期才探测」的轮询设计，tick 粒度从 10 分钟缩到 5 分钟只改善
到期判定的最大滞后（默认 30 分钟间隔下，最坏滞后 10min → 5min），无任何能力损失。

## Requirements

只动调度分发与注释，**零行为契约变更、零 schema 变更、零路由/热路径变更**。

1. **`apps/worker/wrangler.toml`**：`[triggers].crons = ["17 3 * * *", "*/5 * * * *"]`；
   L11–13 三行注释同步改写（`*/5` 行注明「报警评估 + 渠道探测到期判定」）。
2. **`apps/worker/src/index.ts`（L220–249 scheduled 分发）**：
   - 删除 `CHANNEL_PROBE_CRON = "*/10 * * * *"` 常量及其 `if` 分支；
   - `*/5` 分支改为：**先 `evaluateAlerts(env.DB)` 完成后，再 `runChannelProbes(env.DB)`**，
     同一 invocation 内顺序执行、两者都完成后 Promise 才 resolve。两者内部各自
     fault-isolated（现状契约，AGENTS.md「Steps are fault-isolated inside each handler」），
     分发层保持直接 await 风格，不新增 try/catch 包装；
   - 兜底分支（`17 3 * * *` 落入 else）→ `runDailyMaintenance` **零变化**；
   - 分发函数 doc comment 同步改写（every-10-minutes 表述删除）。
3. **注释同步（`*/10` 语义 → `*/5`）**，三处，纯注释零逻辑：
   - `apps/worker/src/db/schema.sql` L240 附近（channel_probes 表注释）；
   - `apps/worker/src/services/settings.ts` L819 附近；
   - `apps/worker/src/routes/settings.ts` L125 附近。
4. **测试锚点更新**（两处 cron 分发用例是本任务的验收锚）：
   - `tests/channel-probe.test.ts` "cron dispatch — third branch"（L517 起）：
     `*/10` 专属分支不存在了——改为断言 `*/5` 事件触发 `runChannelProbes`
     （同一事件也会跑 `evaluateAlerts`，需相应 mock），`17 3 * * *` 不触发探测；
   - `tests/webhook-alerts.test.ts` "cron dispatch"（L686 起）：`*/5` 用例现在
     同时会跑 `runChannelProbes`（mock 容忍即可），`*/5 → evaluateAlerts` 与
     `17 3 → runDailyMaintenance` 的既有断言保持不变。
5. **AGENTS.md 两处表述同步**（本文件是 agent 唯一事实来源）：
   - §8 webhook 报警 bullet「**评估周期**」：`crons 双条目` 表述中
     `*/5 → evaluateAlerts` 改为 `*/5 → evaluateAlerts + runChannelProbes（探测到期判定）`；
   - §8 渠道主动健康探测 bullet「**调度**」：删除「第三条 `*/10`」说法，
     改为探测到期判定并入 `*/5` tick（随报警评估同 tick 顺带执行，cron 触发器 3 → 2）。

## 非目标

- 不把 03:17 维护链合并进 `*/5`（需自建状态键判定「今日已跑」，比 cron 原生分发脆）。
- 不改探测调度算法与早退契约：settings 总闸 `probe_interval_minutes` 先行早退、
  到期抖动判定、路由隔离硬约束全部原样。
- 不改报警评估逻辑、代理热路径、任何迁移/schema 列。

## Acceptance Criteria

- [ ] `wrangler.toml` 仅 2 条 crons，注释与实际语义一致。
- [ ] `scheduled` 分发：`*/5` → alerts 先、probes 后（顺序固定）；`17 3 * * *` →
      维护链；代码中不存在 `*/10` 分发分支与 `CHANNEL_PROBE_CRON` 常量。
- [ ] `bunx vitest run` 全绿（**禁用 `bun run test`，那是 vitest watch 会挂起**；
      `tests/channel-probe.test.ts` 与 `tests/webhook-alerts.test.ts` 的 cron 用例为锚）；
      `bun run check`、`bun run typecheck` 通过。
- [ ] 全仓 grep 无 `*/10` cron 语义残留（源码 + 注释 + AGENTS.md；`.trellis/tasks` 下
      归档工件不算）。
- [ ] 行为不变式（回归口径）：探测总闸关闭时每 `*/5` tick 合计 2 条只读查询
      （报警空表 1 + 探测总闸 1）；总闸 >0 且渠道全关时为 3 条（第三条是探测
      调度器既有的 channels 空查，非本次引入）——均与合并前两条独立 tick 的
      总量一致；03:17 维护链调用形态零变化。
- [ ] AGENTS.md 表述与代码一致。

## Notes

- 部署提示（非代码验收）：下一个 backend 部署（GitHub Actions update:backend）会
  原子更新触发器，账号 cron 占用 3 → 2。
- 提交纪律（项目既有约定）：`git add` 与 `git commit` 必须同一调用；commit 需带
  `Co-Authored-By: GLM-5.3-Flash` trailer。
