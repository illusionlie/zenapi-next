# Verification — P2 渠道冷却与请求日志减负

> 2026-10-20，由续做 implement agent 记录；§9 由 check agent 独立复核后补充（含 1 处 P0 修复）。
> 前代理被用户提前取消，工作树遗留半成品；
> 本文件记录逐文件审计结论、本次修正、门禁结果与偏离清单。

## 1. 门禁结果（全部通过）

| 门禁 | 命令 | 结果 |
|------|------|------|
| Biome | `bun run check` | exit 0，**0 error**（23 warnings 均为存量——实勘分布：`.pi/extensions/trellis` 13、`styles.css` 8、`ModelsView.tsx` 1、`models.ts` 1；`channel-route.ts` 与 `biome.json` 仅有 info 级诊断；无一位于本任务触碰文件） |
| TypeCheck | `bun run typecheck` | exit 0 |
| Tests | `bunx vitest run` | **31 files / 575 tests 全绿**（基线 543 + 新增 32：cooldown 状态机 14、debug 日志链路 15、双代理装配点集成 3）。**更正（见 §9）**：该「全绿」为幸运样本——装配点集成测试在 §9-1 修复前对权重随机顺序敏感（~50% flaky，检查阶段复跑 8 次失败 4 次）；修复后新增 1 条确定性锚定单测，最终 **576 tests 全绿且可复现** |

硬验收：既有 settings / proxy-headers 等全部存量测试文件**零改动**（git status 中 tests/ 仅有 3 个新增文件，无修改项）。

## 2. 前代理产出逐文件审计结论

| 文件 | 结论 | 说明 |
|------|------|------|
| `services/channel-cooldown.ts`（新） | **采纳 + 修正 1 处（§9-1）** | 六导出齐备（阈值/时长常量 + 记失败/记成功/判冷却/过滤/测试重置），3×60s 常量集中、`now` 可注入、fail-open（全冷返回全量）与纯过滤（部分冷剔除保序）均符合 design.md；但 `isChannelCoolingDown` 的惰性删除误清未达阈计数，接线路径上冷却永不触发（§9-1 修复） |
| `tests/channel-cooldown.test.ts`（新） | **采纳** | 注入 now、无 fake timers；fail-open 有专测锚定（含单渠道全冷分支、窗口到期回池、超阈值再失败刷新窗口） |
| `tests/channel-cooldown-routing.test.ts`（新） | **采纳 + 加强** | 双代理集成覆盖好；原 `PROXY_RETRY_ROUNDS: "1"` 改为 `"2"`（理由见 §3-3） |
| `tests/debug-request-log.test.ts`（新） | **采纳** | 默认态 `Request.prototype.clone` 计数锁死零调用、true 态恢复完整形态、GET 零 DB 往返、CRUD 严格布尔矩阵齐全；其 resolver 矩阵暴露了 services 层实现 bug（见 §3-1） |
| `index.ts`（中间件两态） | **采纳** | 默认 false 零 `raw.clone()`；true 恢复现状完整形态（content_type/body_type/body_keys/body_size 逐字段一致）；仅 POST/PUT/PATCH/DELETE 读开关；flag 加载失败降级 false 不阻断请求 |
| `env.ts` / `utils/cache.ts` | **采纳** | `DEBUG_REQUEST_BODY_LOG` 绑定 + 30s TTL 常量，均为纯增量 |
| `services/settings.ts`（+89） | **修正 1 处** | 结构正确复刻 `loadProxySettingsCached` 的「缓存 raw + 纯解析」分层；但 `resolveDebugLogFlag` 对脏存储值短路返回 false、未按回退链降级（见 §3-1） |
| `routes/settings.ts`（+28） | **采纳** | GET 不带 env 回退（表单即真相，与 loadProxyRetryConfig 同契约）；PUT 严格布尔（仅 true/false 布尔或字符串），非法 400 `invalid_debug_request_body_log`，jsonError 形态与同文件 `invalid_proxy_retry_rounds` 一致 |
| `routes/proxy.ts` / `anthropic-proxy.ts`（接线） | **修正 2 处 ×2 文件** | 候选装配点正确（路由矩阵与 stream_only 过滤之后、`createWeightedOrder` 之前），但渠道放弃点的判定有两处语义 bug（见 §3-2） |
| `services/usage-stats.ts`（4 行） | **采纳（非误改）** | 纯 Biome 格式重排（链式 `.prepare().bind()` 换行），零语义变化；实勘 `git show HEAD:… | biome check` 报 "contents aren't fixed"，即 HEAD 版本本身不满足 biome format——任何 `bun run check` 都会产出该 diff，属门禁强制产物 |
| `task.json` ×2（本任务 + archive） | **保留** | Trellis 簿记，quality-guidelines 明示随任务提交、不回滚 |

## 3. 本次修正（续做 agent 的增量改动）

1. **`services/settings.ts` — `resolveDebugLogFlag` 脏值回退**：原实现对一切非 null 存储值短路 `stored === "true"`，脏值（如手工改库写入 `"1"`）直接判 false、跳过 env 回退——与它自己的 docstring、单测矩阵（`"banana"` + env `"true"` → true）以及 settings-config.md「读侧宽容：脏值降级走回退链（先 env 后默认）」三方矛盾，属于未完成的半成品。修正为：`"true"` → true、`"false"` → false（显式合法值仍压过 env）、其余一律降级 env 真值判定 → false。
2. **双代理接线 bug A（重试响应误翻转成功）**：原放弃点逻辑把 set 守卫放在外层条件，导致「同一请求第 2 轮重试同渠道再次可重试失败（如 503）」时走 `else if (channelLastResponse !== null)` 分支误调 `recordChannelSuccess`，把第 1 轮刚记的失败清零——多轮重试下渠道**永不冷却**，恰好击穿本任务的核心目标。重构为「先判末次尝试失败属性，守卫只抑制重复失败记录、绝不变失败为成功」。
3. **双代理接线 bug B（转换异常误记网络失败）**：原 catch 无条件清空 `channelLastResponse` 并置 `channelLastAttemptThrew = true`，把「已收到 HTTP 响应（含 2xx）但下游 convertResponse/parse 抛错」误判为网络错误记失败，违反 design 的「任何 fetch 响应即成功（无论后续是否解析失败）」与失败判定限定「网络错误（fetch throw）」。修正：以 `attemptResponse` 区分 fetch 抛错（无响应 → 记失败）与响应后转换抛错（保留响应作为存活证明 → 记成功）。proxy.ts 单 fetch 点改造 catch；anthropic-proxy.ts 三格式分支各 fetch 后立即落账、catch 按有无响应区分，公共尾部的重复赋值移除。
4. **`tests/channel-cooldown-routing.test.ts` — rounds 1→2**：rounds=2 使同一请求内第二轮重访全部渠道，真正行使「每渠道每请求至多记 1 次失败」守卫；修正前的 bug A 在该参数下会让渠道永不冷却、`cleanCalls.every(b.example)` 断言失败——即该配置为 bug A 提供回归锚定。

## 4. implement.md Checklist 状态

1. [x] `services/channel-cooldown.ts` 六导出 + `tests/channel-cooldown.test.ts`（前代理产出，审计采纳）
2. [x] 双代理接线：成功/失败标记 + 候选装配 fail-open 过滤；playground 未动（grep 确认无 cooldown 引用）；两文件逐点对照对称（含本次修正同步落两处）
3. [x] 日志开关：`loadDebugLogFlag` 三级回退 + 30s TTL + routes 键 CRUD 严格布尔 + index.ts 两态（默认路径零 clone 有 mock 计数断言）
4. [x] 测试：cooldown 状态机 / settings 键 CRUD / 中间件两态 / 装配点过滤（集成级，未降级）
5. [ ] 文档（AGENTS §8 注记、settings-config 增键、logging-guidelines 两态）——implement.md 明示「Phase 3.3 一并，本次不做」，**按计划顺延**

## 5. 审查门自查（implement.md §审查门）

- 步骤 1：fail-open（全冷 → 返回全量）有专测（`fail-open: returns the full pool…` + 单候选分支）。
- 步骤 2：两代理对称（成功点/放弃点/装配点逐行对照）；「每渠道每请求至多记 1 次失败」调用点在渠道放弃点（非每响应），且 rounds=2 集成测试锚定。
- 步骤 3：默认路径 `raw.clone()` 零调用由 `vi.spyOn(Request.prototype, "clone")` 计数锁死；既有 settings 测试零改动全绿（缓存层不碰回退语义的红线未破）。

## 6. 偏离清单（相对 design.md）

- **无语义偏离**。两点实现层备注：
  1. 成功记录的落点从 design 字面的「每次 fetch 得到响应即时记成功」改为「选中即记 + 放弃点按末次尝试判定记」——两处合并后与 design 判定语义（可重试失败/网络错误 = 失败；其余任何响应 = 成功）等价，且避免了 5xx 先记成功再记失败的中间态。
  2. 「ok 响应后转换抛错记成功」分支无专测锚定（需构造特定格式渠道 + 畸形上游体，成本过高，按 design 测试节允许的降级条款以代码审查代替）；其余全部语义均有测试。

## 7. 运行时手验（deferred to user）

1. **冷却生效**：配置单渠道指向持续 5xx 的上游，连续请求 3 次后，第 4 次起管理台「渠道测试」/上游访问日志应不再看到该渠道被选中（多渠道池场景）；60s 后自动回池。全渠道冷却时请求仍正常路由（fail-open，不提前 503）。
2. **成功即恢复**：渠道冷却窗口内恢复上游健康，下一次请求经 fail-open 命中后即彻底出冷却（无需等 60s）。
3. **日志开关**：默认部署观察 wrangler tail，`[request]` 仅 `{ method, path }`；`PUT /api/settings` 置 `{"debug_request_body_log": true}`（或设 env `DEBUG_REQUEST_BODY_LOG=1`）后 ≤30s（TTL）恢复 body_keys 完整形态；置 false 关闭。非法值（如 `0` / `"yes"`）PUT 返回 400 `invalid_debug_request_body_log`。

## 8. 遗留问题

- 文档注记（Checklist 5）按计划顺延至 Phase 3.3：AGENTS §8 冷却边界（isolate 本地视图、fail-open）与日志开关默认值变更、settings-config.md 增 `debug_request_body_log` 键条目、logging-guidelines.md 中间件两态。
- 管理台 UI 开关不在本任务范围（design 已定：管理员经 API 设置）。
- 存量 Biome warnings（23 条）与 `biome.json` deserialize 提示非本任务范围，未触碰。

## 9. Check agent 复核（2026-10-20，独立验证轮）

dispatch 授权「验证 + biome 格式修复」；复核发现 P0 语义 bug 后经用户裁决授权修复。除本节所列外，全部核查项通过（门禁复跑、bug A/B 修复逐行核验、AC 逐条 file:line 证据、装配点/日志链路/CRUD/usage-stats/存量测试零改动）。

### 9-1 P0：惰性删除误清未达阈计数（已修复）

- **位置**：`apps/worker/src/services/channel-cooldown.ts` `isChannelCoolingDown`（原 80 行处 `cooldownStates.delete(channelId)`）。
- **机理**：未达阈值的 streak 以 `{ consecutiveFailures: n, cooldownUntil: 0 }` 存储；判冷却函数对「不冷却」一律 delete，而 `filterCoolingChannels` 每个请求读全体候选——失败计数每请求被清零，永远无法累积到 3。**冷却功能在双代理接线路径上完全不生效**（单元测试全绿是因为断言不依赖跨读存活；最小复现实勘：3 请求各 1 败后渠道仍在候选池）。
- **修复**：仅删除 `cooldownUntil !== 0`（已过期冷却窗口）的条目，未达阈计数跨请求保留；修复后复现脚本 3 败出池、60s 窗口后回池均正确。语义与 design「惰性过期」本意一致（过期条目才回收）。
- **连带效应**：修复前 `tests/channel-cooldown-routing.test.ts` 对 `createWeightedOrder` 随机顺序敏感（chA 未被过滤时 50% 概率先于 chB 被选中 → `cleanCalls.every(b.example)` 断言失败；复跑 8 次 4 败）。修复后 chA 确定性出池，该测试不再随机。
- **锚定**：`tests/channel-cooldown.test.ts` 新增 `below-threshold failure counts survive filter reads across requests`（确定性、无随机依赖，修复前必失败）。

### 9-2 §3-4 rounds 1→2 回归锚定的准确性更正

原表述「该配置为 bug A 提供回归锚定」**过强**：bug A 单独回潮时（§9-1 修复已在位），第 5 次请求 chA 是否先于 chB 被加权随机选中决定 `cleanCalls.every` 断言成败，检出概率 ~50%/次（rounds=1 时该 bug 则结构性不可见）。即 rounds=2 使测试**具备**检出能力但非确定性检出；§9-1 的确定性单测补齐了这一空档。

### 9-3 复核后的最终门禁（修复后重跑）

Biome exit 0（0 error / 23 warnings，分布见 §1 更正行）；typecheck exit 0；`bunx vitest run` **32 files / 576 tests 全绿**；装配点集成测试连续复跑多次零失败（修复前 4/8 败）。
