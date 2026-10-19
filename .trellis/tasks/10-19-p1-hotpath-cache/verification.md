# Verification — P1 热路径缓存与写入异步化

> 2026-10-19，trellis-implement 续做（前代理超时遗留半成品）。本文件记录前代理产出审计结论、本次改动、门禁结果、偏离与遗留。

## 1. 前代理产出审计结论（逐文件）

| 文件 | 结论 | 说明 |
|------|------|------|
| `apps/worker/src/utils/cache.ts` | **采纳** | TTL 常量与 design 一致（CHANNEL/ALIAS 10s、PROXY_SETTINGS 30s）；惰性过期、`max` 整表清除、`clear()` 齐备。附带的 `getTtlCache`（per-holder WeakMap）是合理增强，见偏离 D2。 |
| `apps/worker/src/utils/post-response.ts` | **采纳**（签名偏离见 D1） | try/catch 包 `executionCtx` getter（quality-guidelines gotcha 的正确处理）、waitUntil 分支、降级 `catch + console.error` 与 design 一致。 |
| `apps/worker/src/middleware/tokenAuth.ts` | **采纳** | JOIN SQL 显式列清单 + `user_*` 别名正确；悬空 user_id → `user_status` null → 与旧 `user?.status !== "active"` 同一 `user_disabled` 分支（已对照 git 基线逐行核实）；status/quota 闸门未动。 |
| `apps/worker/src/services/channels.ts` | **采纳** | `getActiveChannelsCached` 正确；`SELECT *` 未收窄（design 可选项，见 D3）。共享行只读契约成立：`createWeightedOrder` map 出副本、`resolveChannelRoute` slice 后排序、routing 浅拷贝覆盖 `api_format`，下游无变异点。 |
| `apps/worker/src/services/model-aliases.ts` | **修正补齐** | 前代理只加了一行**未使用的 import**（会挂 biome lint），缓存函数本体缺失。本次在两个热路径函数（`loadChannelAliasesByAlias` / `loadChannelAliasOnlyMap`）原位接入 10s TTL 缓存，见 D4。 |
| `apps/worker/src/services/settings.ts` | **采纳** | `loadProxySettingsCached` 只缓存 settings raw map（30s）；`resolveProxyRetryConfig` 抽为纯函数，`loadProxyRetryConfig` 保持每次直读（管理台表单真相语义不变）；4 键单条 `IN` 查询。既有 proxy-retry-settings 测试零改动通过。 |
| `apps/worker/src/utils/proxy-headers.ts` | **采纳** | `parseHeaderPolicyFromRaw` 纯解析器；`loadProxyHeaderPolicy` 重构后行为逐字段一致（既有 proxy-headers 32 用例零改动通过）。 |

## 2. 本次改动清单

**接线（前代理未触碰部分）**

- `apps/worker/src/services/model-aliases.ts`：两个热路径别名函数原位接 `ALIAS_CACHE_TTL_MS` 缓存；per-alias 缓存挂 `max: 500` 防膨胀帽（别名键来自请求模型名，键空间不可控）。
- `apps/worker/src/routes/proxy.ts`：
  - 鉴权后读合一：别名解析 + aliasOnly 全图 + `getActiveChannelsCached` + `loadProxySettingsCached` 进单个 `Promise.all`（鉴权 JOIN 后仅剩 1 个串行 RTT 阶段）；
  - `parseHeaderPolicyFromRaw` / `resolveProxyRetryConfig` 从缓存 raw map 纯解析（fail-open / 三级回退 / clamp 每次照常执行）；
  - 三处写切 `runPostResponse`：`upstream_unavailable` 错误路径 INSERT、非流式 `await record(...)`、流式 task（含移除本地 `ExecutionContextLike` try/catch，收敛到助手）。
- `apps/worker/src/routes/anthropic-proxy.ts`：与 proxy.ts 逐点同构（同样的 Promise.all 合一、settings 纯解析、三处写切换）；**顺带修复**流式路径既有的裸断言 bug——原 `(c as {executionCtx}).executionCtx` 无 try/catch，getter 在非 Workers runtime 会 throw（quality-guidelines 记录的 gotcha，此前该路径在测试环境必 500，只是没有测试覆盖到）。
- playground、retry 循环内部逻辑、token 鉴权缓存：**未动**（按要求）。

**测试（新增 4 文件 / 31 用例）**

- `tests/cache.test.ts`（7）：命中/未命中、fake timers 过期（含 9999/10000 边界）、惰性删除不复活、clear、max 触顶清表、max 内覆盖不逐出、TTL 常量锚点、getTtlCache per-holder 隔离。
- `tests/token-auth.test.ts`（10）：单次 prepare（2 RTT→1 RTT）、JOIN SQL 别名形态断言、三态等价（无 user_id / 正常绑定 / 悬空 user_id→403 user_disabled）、user_disabled/insufficient_balance/invalid_token/token_disabled/quota_exceeded 闸门矩阵。mock Context 直调中间件（hono 运行时包在根 tests/ 不可解析，见 D7）。
- `tests/proxy-settings-cache.test.ts`（9）：缓存命中零 DB（prepareCount=1 + 同引用）、29999/30000 边界过期重读、per-db 隔离、4 键单查询绑定序、`loadProxyRetryConfig` 保持非缓存、`resolveProxyRetryConfig` 回退链/clamp 纯语义、`parseHeaderPolicyFromRaw` fail-open。
- `tests/post-response.test.ts`（5）：waitUntil 被调、缺失降级 + 拒绝时 `[post-response]` console.error、getter throw 降级、executionCtx 无 waitUntil 降级、成功路径静默。

## 3. Checklist 状态（implement.md）

1. ✅ utils/cache.ts + 单测（前代理产出原语 + 本次补 `tests/cache.test.ts`）
2. ✅ tokenAuth JOIN 合一 + 三态测试（前代理产出 + 本次补 `tests/token-auth.test.ts`）
3. ✅ settings 缓存包装 + 单测（前代理产出 + 本次补 `tests/proxy-settings-cache.test.ts`；既有 settings/proxy-headers 测试零改动通过 = 硬验收达标）
4. ✅ 读并行合一，proxy.ts / anthropic-proxy.ts 逐点对称（本次完成）
5. ✅ 写入异步化 + `runPostResponse` 单测（本次完成；grep 核对：响应返回路径无 `await record` 残留，剩余 await 均在 runPostResponse 闭包体内）
6. ⬜ 文档注记（AGENTS §8 缓存陈旧窗口 + spec settings-config / proxy-headers / channel-routing 增补）——**遗留**，见 §7

## 4. 门禁结论

| 门禁 | 结果 |
|------|------|
| `bun run check` | **0 error**（23 warning 全部存量：.pi/extensions、ui styles、models.ts 等，本次涉改文件零新增；`.trellis` JSON 重排为 biome --write 的预期产物） |
| `bun run typecheck` | **0 error**（strict） |
| `bunx vitest run` | **27 文件 / 518 用例全绿**（基线 487 + 新增 31；既有测试零改动） |

审查门核对：

- JOIN 三态与改造前行为逐字段等价 ✅（对照 git 基线 `user?.status` 语义 + 测试断言）。
- 两代理路径改造逐点对称 ✅（唯一差异为 anthropic 侧错误路径本就无 reasoningEffort/日志，与改造前一致）；`SELECT *` 未收窄，下游字段可用性不变 ✅。
- 响应返回路径无 `await record` 残留 ✅。

PRD Acceptance Criteria：

- AC1（冷 ≤5 读 / 热 ≤2 读）：冷 = JOIN 1 + Promise.all 4（别名、aliasOnly、渠道、settings）= 5；热 = 1（仅 JOIN）。**结构达标**（代码路径审查），运行时计数见 §6 手验。
- AC2（≤10s / ≤30s 生效）：TTL 常量与边界测试锁定；运行时实测 deferred（§6）。
- AC3（非流式响应不含 usage 写延迟）：代码路径审查达标（await record 已全部切 runPostResponse）。
- AC4（回退链与 clamp 回归）：既有测试零改动通过 ✅。
- AC5（三命令全绿）✅。

## 5. 偏离清单

- **D1** `runPostResponse` 签名：design 写 `ctx: { executionCtx?: ExecutionContext } | undefined`，实现为 `c: unknown` + try/catch 包 getter——Hono 的 getter 是 throw 型，design 的形状无法安全表达（quality-guidelines gotcha 强制要求）。调用点传 Hono Context，语义与 design 意图一致。
- **D2** 缓存注册表为 per-D1Database WeakMap（`getTtlCache`）而非 design 字面的「模块级单 Map」：生产每 isolate 一个绑定对象，等价；测试传不同 mock db 天然隔离，避免模块级状态跨用例泄漏。
- **D3** `getActiveChannelsCached` 保留 `SELECT *`：design 的列收窄为可选项（「避免行为漂移的前提下」），本次选择不收窄，行为零漂移。
- **D4** 别名缓存**原位**接入 `loadChannelAliasesByAlias` / `loadChannelAliasOnlyMap`（而非新增 `*Cached` 导出）：全仓仅两条代理热路径消费这两函数（grep 核实），playground/管理台不经它们；per-alias 缓存加 `max: 500` 帽（键来自请求模型名，防膨胀）。
- **D5** 流式路径也切 `runPostResponse`（dispatch 字面只要求非流式 + 错误路径）：为修复 anthropic-proxy 流式裸断言 bug（见 §2）并统一两侧语义；proxy 侧行为等价（原 try/catch 降级 + task 内部自捕获，助手降级分支的 console.error 在该 task 上不可达）。
- **D6** 验证命令：`bun run test` = `vitest` watch 模式（长驻进程，沙箱禁止），按 quality-guidelines 改用一次性 `bunx vitest run`。
- **D7** token-auth 测试以 mock Context 直调中间件而非 `app.request`：hono 是 apps/worker workspace 依赖，root `tests/` 解析不到运行时包（实测报 `Cannot find package 'hono'`）；类型经 `Parameters<typeof tokenAuth>` 提取，不触发运行时解析。
- **D8** 基线用例数（check agent 复核定论）：实测基线 **487**（23 个存量测试文件单独跑 `bunx vitest run` 验证），新增 **31**（cache 7 / token-auth 10 / proxy-settings-cache 9 / post-response 5），487 + 31 = 518 全绿。本文件初稿误记「486 + 32」（把 proxy-settings-cache 的 9 用例数成 10、并以 518 − 32 反推基线 486）；任务档案期望的 487 是正确口径，无差异。

## 6. Deferred to user — 本地手验步骤

沙箱禁止长驻进程，以下运行时行为验证需用户本地执行（一次性命令无法覆盖）：

```bash
bun run dev:worker   # 需先 bun run --filter api-worker db:migrate（首次）

# AC1 读次数：开启 D1 日志（wrangler tail 或本地 d1 --local 观察），
#   发一条计费请求：冷缓存应见 5 条 SELECT（tokens JOIN + 4 并行读），
#   10s 内再发：仅 1 条 SELECT（JOIN）。

# AC2 陈旧窗口：
#   管理台改渠道/别名 → 立即发代理请求看旧路由 → ≤10s 后再发确认生效；
#   管理台改 proxy_retry_rounds / 伪装头 → ≤30s 内代理路径生效。

# AC3 写异步化：非流式请求观察响应先返回、usage INSERT 稍后落库
#   （wrangler tail 中 INSERT 晚于 200 响应即达标）。
```

## 7. 遗留问题

1. **implement.md 步骤 6（文档）未做**：AGENTS.md §8 缓存陈旧窗口注记 + spec 三文件（settings-config / proxy-headers / channel-routing）缓存契约增补。dispatch 未将其列入本次补齐范围，且 spec 更新按 implement.md 归 trellis-update-spec 流程——留给主会话。建议文案锚点：渠道/别名 ≤10s、代理 settings ≤30s、token 鉴权永不缓存、非流式与错误路径 usage 写为 post-response。
2. anthropic-proxy 流式裸断言 bug 已顺带修复（D5）；`/v1/models` 端点的渠道查询仍为直查（不在本次 AC 范围，如需可后续接入 `getActiveChannelsCached`，一处改动零风险）。
3. 无 git commit（按指令，留待主会话审查后提交）。
