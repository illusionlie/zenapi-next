# Journal - illusionlie (Part 1)

> AI development session journal
> Started: 2026-07-26

---



## Session 1: Remove site mode & shared ecosystem, add per-user model allowlist

**Date**: 2026-09-13
**Task**: Remove site mode & shared ecosystem, add per-user model allowlist
**Branch**: `main`

### Summary

Fixed ZenAPI to service-only mode: removed site_mode mechanism (17 backend anchors), entire shared ecosystem (withdrawal/LDOH/contributions/shared flags/fee-review settings, 5 route files deleted), channels legacy columns; added per-user allowed-models allowlist (users.allowed_models TEXT, 403 model_not_allowed in both proxies, list filtering, admin picker UI) with migration 0019 (DROP 5 tables/6 cols/8 settings keys, models_json shared cleanup via json_each CASE guards). 49 new unit tests; typecheck/test/build green; lint zero-new (38->24 baseline debt). Key lessons captured into specs: D1 JSON-in-TEXT bulk rewrite traps, DROP COLUMN single-run semantics, fail-open parse/fail-closed write convention, frontend lint-debt gate. 5 AC items pending online smoke test after deploy (403 intercept, / redirect, public models, 3 registration modes, admin whitelist interaction). Deploy contract: migration before code in same CI run, backup first.

### Git Commits

| Hash | Message |
|------|---------|
| `7fd36c3` | (see git log) |
| `a71dd93` | (see git log) |
| `1c338e0` | (see git log) |
| `4fac541` | (see git log) |

### Status

[OK] **Completed**


## Session 2: 修复 apps/ui 存量 a11y lint 错误（24E+6W）

**Date**: 2026-09-14
**Task**: 修复 apps/ui 存量 a11y lint 错误（24E+6W）
**Branch**: `main`

### Summary

清偿 apps/ui 全部 24 个存量 a11y lint error（14 noLabelWithoutControl 用 htmlFor+id 真实关联并以 create/edit 前缀隔离模态 id、6 noSvgWithoutTitle 按语义分流 aria-hidden/role=img、4 处点击类改语义化 button）并顺带清偿 6 个 warning；质检门槛升级为 bun run check 全仓 0 error（仅 .pi/trellis 基建 noSelfAssign 例外）；沉淀 a11y 实战约定与 check --write 簿记 gotcha 到 frontend spec。验收：biome check apps/ui 0E0W、typecheck 0E、49/49 tests、vite build 全过。

### Git Commits

| Hash | Message |
|------|---------|
| `f6f9a9d` | (see git log) |
| `0b09027` | (see git log) |
| `01fa423` | (see git log) |

### Status

[OK] **Completed**


## Session 3: 清账归档两个挂起任务 + 补全 spec 空模板

**Date**: 2026-09-14
**Task**: 07-27-channel-model-picker（验收归档）、00-bootstrap-guidelines（补全后归档）
**Branch**: `main`

### Summary

盘点发现两个 in_progress 任务实为「已完成未归档」：channel-model-picker 代码早已随 9692fa3 提交（仅差 checkbox 与归档）；bootstrap-guidelines 走了「随任务按需捕获」路线但留下 6 个空模板 + 11 个与包性质不符的空壳目录。处理：归档前从真实代码提炼补全 7 个有效 spec（logging/quality/directory-structure、UI 的 directory/hook/state/type-safety，要点：console 前缀标签惯例、jsonError snake_case 错误码、零状态库容器集中持有、hono/jsx-dom 无自定义 hook、类型直通 snake_case）；api-worker/frontend 与 api-worker-ui/backend 整体标注 N/A；刷新 4 个 index 状态表。验收：check 1E（spec 豁免项）、typecheck 0E、49/49 tests。归档后 0 active tasks。

### Git Commits

| Hash | Message |
|------|---------|
| `9f91211` | chore(task): archive 07-27-channel-model-picker |
| `9adcb42` | chore(task): archive 00-bootstrap-guidelines |
| (本次) | docs(trellis): fill spec templates & mark N/A dirs |

### Status

[OK] **Completed**

## Session 4: 全局通知改造——notice banner 迁移为底部 Toast

**Date**: 2026-09-14
**Task**: 09-14-toast-notification-refactor（全流程：规划→实施→检查→归档）
**Branch**: `main`

### Summary

痛点：notice banner 渲染在 main 文档流（无定位无 z-index），被 11 个 z-50 modal 的遮罩盖死，「成功才关弹窗」类弹窗的失败提示 100% 不可见。方案（用户四项决策：创建任务/底部 toast/分层迁移/区分类型）：自研轻量 toast——core/toast.ts 模块级 store（success 3s/error 5s/info 3s、堆叠上限 5、两段式退场）+ ToastHost createPortal 挂 body（z-[100]）+ Tailwind v4 @theme 动画。71 处 setNotice 全量迁移 + UserDashboard 补充 8 处（签到/充值反馈，实施中发现规划漏盘点），7 处手工 clear 删除，4 份 notice state/6 处 banner/3 条 props 链拆除。明文类 5 处（令牌/邀请码）升级 SecretValueModal（展示+复制）。分层保留：注册表单校验/充值金额校验（改红色语义）、Playground 对话区错误。

### Key learnings

1. hono/jsx/dom 原生支持 createPortal（4.13.7 验证），但 ToastHost 不能挂在有 early return 的 App 组件返回树里（分支切换会卸载）——用 fragment 包 `<ToastHost/><AppRoutes/>`，顺带修复 401 登出组件卸载丢 notice 的问题（store 独立于组件树生命周期）。
2. Tailwind v4 @theme 内嵌 @keyframes 会被 Biome 拒绝，需 biome.json 开 `css.parser.tailwindDirectives` 且 keyframes 提到顶层。
3. 同文件混两个功能的提交分离：checkout HEAD 版本 → 重放 A 功能 hunk → commit A → 还原完整版 → commit B（注意 A 的上下文行若被 B 改过，patch 不能直接 apply，须手工重放）。
4. a11y：动态 toast 容器补 `role="status" aria-live="polite"`（WAI-ARIA toast 标准模式）。
5. spec 翻转约定：「不引入 toast 库」→「不引入第三方 toast 库」，state-management.md 三处已同步。

### Git Commits

| Hash | Message |
|------|---------|
| `a1bb0b4` | feat(ui): 拉取模型默认仅预勾选已存在模型（上个任务遗留改动分离提交） |
| `98b4127` | feat(ui): 全局通知迁移为底部 toast，明文信息升级弹窗 |
| `501347d` | chore(task): archive 09-14-toast-notification-refactor |

### Status

[OK] **Completed**（遗留：浏览器手动冒烟清单已交用户，代码层机制经 check 全量验证）

## Session 5: 令牌「查看」改直接复制，明文弹窗降级为兜底

**Date**: 2026-09-14
**Task**: 09-14-token-reveal-direct-copy（轻量任务：PRD-only，规划→实施→检查→归档）
**Branch**: `main`

### Summary

上一任务把令牌 reveal 主路径改成了 SecretValueModal，用户反馈过重（参考 newapi：直接复制即可）。本任务纠正交互主次：令牌列表按钮「查看」→「复制」，点击 fetch reveal → clipboard.writeText → toast 反馈；仅复制失败（Safari/iOS 用户激活过期、非安全上下文 clipboard 为 undefined）回落 SecretValueModal 兜底。管理台 TokensView 2 处按钮文案 + AdminApp/UserApp 两处 handleTokenReveal；UserTokensView 文案本就是「复制」只改行为。无后端改动（token_plain 存库可重复获取）。一次性展示弹窗（新令牌创建、邀请码导出）保留不动；明文不进 toast 文案。

### Key learnings

1. **兜底不能升主路径**：上个任务为救「复制失败无处看明文」把弹窗当唯一出口，本任务纠正——高频动作（复制）必须是零摩擦主路径，弹窗只留给低频/一次性场景。spec state-management.md 已把明文展示分成「一次性弹窗」与「可重复获取走复制优先」两类。
2. `await fetch` 后调 `navigator.clipboard.writeText` 在 Chrome/Firefox 无碍（transient activation 窗口约 5s），Safari/iOS 可能拒绝；内层 catch 弹窗兜底顺带覆盖非安全上下文（http 部署下 clipboard 为 undefined 同步抛 TypeError）。
3. `bun run check`（`biome check --write .`）会顺手重排仓库内不合规范的簿记 JSON（归档 task.json 2 空格→tab），quality-guidelines 预告过：不回滚，随任务提交。

### Git Commits

| Hash | Message |
|------|---------|
| `da45d78` | feat(ui): 令牌查看改为直接复制，明文弹窗降级为失败兜底 |
| `80b18db` | chore(task): biome 重排归档任务 task.json 缩进 |
| `3a4a684` | chore(task): archive 09-14-token-reveal-direct-copy |

### Status

[OK] **Completed**（check 全绿：PRD R1-R6 逐项合规、Admin/User handler 同构、三命令 0 error / 49 用例通过；浏览器手动冒烟建议用户自验）

---

## Session 6 — 全局自定义请求头（注入/剔除）与渠道级统一

**Date**: 2026-09-15
**Task**: 09-14-global-custom-headers（复杂任务：PRD + design + implement，规划→实施→检查→冒烟→归档）
**Branch**: `main`

### Summary

系统设置新增两个全局头策略（仅 /v1 与 /anthropic/v1 计费代理生效，Playground 与连通性测试豁免）：① proxy_extra_headers 注入（JSON 对象）② proxy_remove_headers 剔除（JSON 字符串数组）。核心是新建 utils/proxy-headers.ts 单点 applyHeaderPolicy（固定顺序：剔除 → 全局注入 → 渠道级，后应用者赢），两条代理链路全部 6 个上游 fetch 分支统一接入；顺带把渠道级 custom_headers_json 从 custom-only 扩展到全格式并把 ChannelsView 编辑字段常显（用户此前根本看不到该字段——条件渲染 + 后端仅 custom 分支生效的双重隐藏）。buildChannelRequest 加可选第 9 参 policy 保住 Playground 豁免边界。settings KV 原文存储，零迁移。实施派 trellis-implement（TDD 25 用例）、核查派 trellis-check（抓出 placeholder 非法 JSON 真 bug），最后本地 wrangler dev + 回显上游做端到端冒烟（6 分支 × 注入/剔除/覆盖矩阵全 PASS）。

### Key learnings

1. **跨层契约改动必须先盘全部分支**：动手前逐分支盘点（design §2 接入矩阵）避免了遗漏——anthropic-proxy 的 openai 转换分支是 fresh Headers 白名单式，不看代码根本想不到剔除在那里是 no-op。
2. **豁免边界用参数显式化**：全局配置若在共享函数内自动读库，Playground 这类复用方无法豁免；改为调用方传 policy（null = 仅渠道级），边界清晰且读库时机（与渠道查询 Promise.all）由调用方控制。
3. **「后应用者赢」保持现状能力**：历史 custom 分支渠道级就能覆盖 x-api-key，统一时不加保护名单回退它，规则单一 + UI 警示兜底。
4. **冒烟断言也会拿错对象**：两次 FAIL 都是断言脚本自身错位（拿 custom 渠道行为断言 openai 渠道、拿渠道级值判全局豁免），先看原始日志再下结论。
5. wrangler d1 execute --local 必须在 apps/worker/ 目录下执行；本地 dev D1 有历史管理员密码时，直接往 admin_sessions 插已知 hash 的会话是最无侵入的冒烟通道。

### Git Commits

| Hash | Message |
|------|---------|
| `c7e1e18` | feat(worker): 全局自定义请求头注入/剔除与渠道级 custom_headers 全格式生效 |
| `a4f6825` | feat(ui): 系统设置新增请求头注入/剔除配置，渠道级自定义请求头常显 |
| `21d3148` | chore(task): archive 09-14-global-custom-headers |
| `686c623` | docs(spec): 沉淀上游请求头策略契约与 settings 新增配置项标准链路 |

### Status

[OK] **Completed**（check/typecheck/test 全绿：74 用例、0 error；端到端冒烟 6 分支矩阵全 PASS，AC1–AC10 逐项达成；spec 沉淀至 api-worker/backend/proxy-headers.md + cross-layer guide checklist）

---

## Session 7 — 渠道模型测试（编辑弹窗内嵌真实请求测试 + 全局测试文本）

**Date**: 2026-09-15
**Task**: 09-15-channel-model-test（复杂任务：PRD + design + implement，规划→实施→检查→提交→归档）
**Branch**: `main`

### Summary

渠道管理编辑弹窗内嵌「模型测试」区块：勾选表单解析出的模型（搜索/全选/反选），以并发 4 的 worker-pool 逐模型调 `POST /api/channels/test-model` 发真实非流式对话请求，四态结果行（pending/running/success 耗时+摘要/failed 原因+重试）实时渲染，支持停止与单模型重试。后端复用 playground 已验证的 `buildChannelRequest`（policy=null 豁免全局头）+ `convertResponse`（仅 2xx 归一化，anthropic/responses 渠道才能 OpenAI 风格回显）+ `AbortSignal.timeout(30s)`；「表单即真相」body 覆盖语义让未保存渠道也能直接测试。全局测试文本 `model_test_prompt` 走 settings KV 九触点标准链路（无迁移），弹窗内覆盖仅当次生效。TDD 12 单测先行，实施派 trellis-implement ×2（后端/前端分治），核查派 trellis-check（补齐 README/AGENTS.md 文档同步）。

### Key learnings

1. **管理端真实请求探测的固定组合已沉淀为 spec**：buildChannelRequest(/v1/chat/completions, policy=null) → 仅 2xx 过 convertResponse → timeout 兜底、不写 usage；禁止重新实现按格式构建（anthropic/responses 不转换则 choices 提取必落空——本次实现代理自发的 convertResponse 补全正是这条铁律的实证）。
2. **「表单即真相」一举两得**：探测类端点 body 显式配置覆盖库值，同时解决「脏表单测旧配置」与「未保存渠道不可测」；与 PATCH 部分覆盖语义同构，无心智负担。
3. **批量上游探测拆前端逐项调用**：每请求独立 Worker invocation 仅 1 子请求，规避免费版 50 上限；附赠逐项实时结果与故障隔离。API 按单对象设计是关键前提。
4. **前端并发池停止语义**：per-batch 闭包 stopped 标记 + 会话代次 runIdRef；全局共享 stop 标记会在「停止后立即重开批次」时让旧池误读新标记继续跑旧列表，runId 同时使关弹窗后在途请求写入失效。
5. settings 新键九触点 checklist（cross-layer guide）照单执行零遗漏——spec 沉淀的复利直接兑现。

### Git Commits

| Hash | Message |
|------|---------|
| `43bbc34` | feat(worker,ui): 渠道模型测试——编辑弹窗内嵌真实请求测试 + 全局测试文本设置 |
| `6bd89d8` | docs(spec): 沉淀管理端真实请求探测、表单即真相、前端逐项并发三条约定 |
| `3335c51` | chore(task): Biome 格式化归档任务 task.json |
| `1a18249` | chore(task): archive 09-15-channel-model-test |

### Status

[OK] **Completed**（check/typecheck/test 全绿：8 文件 143 用例、Biome 0 error；check 代理 PRD 七条 AC 逐项勾选通过；真实上游手工冒烟留待用户自验）


## Session 8: 代理重试参数迁入 settings（管理台可调）

**Date**: 2026-09-16
**Task**: 代理重试参数迁入 settings（管理台可调）
**Branch**: `main`

### Summary

Session summary was not supplied.

### Main Changes

- 把 wrangler.toml 的 PROXY_RETRY_ROUNDS / PROXY_RETRY_DELAY_MS 迁为 settings 表配置（proxy_retry_rounds / proxy_retry_delay_ms），管理台系统设置新增两个数字字段
- 建立三级回退链：settings → env（兼容回退，wrangler.toml 保留）→ 内置默认 2 轮 / 200ms；三条代理路径统一走 loadProxyRetryConfig，worker 端并入既有 Promise.all 预载（零串行新增）
- 三层边界一致：PUT 整数+范围校验（1-10 / 0-60000，invalid_* 400）、读取侧 clamp、UI min/max 引用同一组 MIN/MAX 常量
- 顺带修正历史漂移：旧代码兜底 ?? "1" 与 wrangler.toml "2" 不一致，内置默认归一为 2

### Git Commits

| Hash | Message |
|------|---------|
| `5f26fa4` | (see git log) |
| `8c587c9` | (see git log) |

### Testing

- [OK] 新增 tests/proxy-retry-settings.test.ts 10 用例（回退链三分支 + clamp 边界矩阵 + 单 SQL 断言）；全量 9 文件 154 例全绿；check/typecheck 0 error
- [OK] trellis-check 核查 8/8 PASS：预载合并、回退链、存量 proxy-responses 兼容（mock env 经回退行为逐值不变）

### Status

[OK] **Completed**

### Next Steps

- 后续版本可考虑从 wrangler.toml 移除两个 env 变量（现为兼容回退保留）
- PUT 路由层校验暂无单测（需先解决 adminAuth mock 成本），属独立改进


## Session 9: 令牌管理增强：长度提升 / 令牌级模型白名单 / 额度编辑

**Date**: 2026-09-16
**Task**: 令牌管理增强：长度提升 / 令牌级模型白名单 / 额度编辑
**Branch**: `main`

### Summary

新生成令牌 32 字节（generateToken 参数化，其余随机串用途不变）；新增令牌级 allowed_models 白名单，与用户级取交集（逐清单独立校验 AND，迁移 0020）；管理台令牌编辑模态 + PATCH 三态语义纯函数（token-update.ts），废除 null/NaN 静默回退。

### Main Changes

**Task**: 09-16-token-management-enhancements

### Main Changes

- `generateToken(prefix, byteLength=24)` 参数化：仅 tokens.ts / user-api.ts 两处 API 令牌传 32（新令牌总长 46），其余 9 处调用（会话/渠道ID/OAuth state/随机密码）输出不变；存量令牌按 key_hash 校验零影响
- 令牌级白名单：迁移 0020 + schema.sql 同步；tokenAuth SELECT 加列并注入解析后的 token_allowed_models；proxy / anthropic-proxy 改 isModelAllowedByAll 逐清单独立校验取 AND；/v1/models 链式双过滤
- 设计关键决策：**不计算交集数组**——空交集会被 isModelAllowed 的 fail-open 语义误判为「不限制」→ 全放行（安全反转），已在 spec error-handling.md 沉淀为 Don't 禁则
- PATCH 三态语义（undefined=保留 / null=清除 / 值=设置）抽为 services/token-update.ts 纯函数并全量单测；非法值 400（invalid_*），废除 NaN/null 静默回退存量 bug
- serializeAllowedModels 从 admin-users.ts 下沉为 utils/model-allowlist.ts 的 serializeAllowlist；UI 抽取共享 ModelAllowlistPicker（portal 规避 .t-modal transform 裁剪），管理台/用户端创建+编辑四处复用
- 用户端边界：可配自己令牌的白名单（收窄语义），PATCH 出现 quota/status/渠道字段即 400 field_not_editable；UI 两视图加「模型限制」徽章列与编辑模态

### Testing

- [OK] 新增 tests/crypto-token.test.ts（46/32/35 长度+charset 回归）、tests/token-update.test.ts（三态矩阵全字段）、model-allowlist.test.ts 追加 isModelAllowedByAll 7 组用例；全量 11 文件 189 例全绿
- [OK] trellis-check 全量核查 9 项 PASS 零修复；check/typecheck 0 error（22 warning 均为未触碰存量文件）

### Status

[OK] **Completed**（AC1–AC9 自动化可验部分全过；implement.md §V 手工验证 V1–V5 留待用户本地 dev 冒烟；部署注意：存量环境需先跑迁移 0020）

### Next Steps

- 后续可考虑给 allowed_channels 补 UI 编辑（后端三态已支持 null 清除）
- 令牌长度提升仅影响新令牌；存量轮换如需另立任务


### Git Commits

| Hash | Message |
|------|---------|
| `fa0ea68` | (see git log) |
| `9e0bacc` | (see git log) |

### Status

[OK] **Completed**


## Session 10: 用户端我的令牌与管理端令牌管理完全对齐

**Date**: 2026-09-17
**Task**: 用户端我的令牌与管理端令牌管理完全对齐
**Branch**: `main`

### Summary

重构 UserTokensView 为管理端 TokensView 同款（Grid 表格/移动端卡片/药丸按钮/分页/sheet 模态，renderModelLimit 共享导出）；UserApp 增加前端切片分页与启停回调；worker 端 PATCH /api/u/tokens/:id 放开 status（新纯函数 resolveUserTokenUpdate 三态语义对齐管理端，forbidden 缩为 quota×2+allowed_channels）；移除渠道限定存量列；新增 13 条单测（202 全过）。playwright+curl 实测 AC1-AC7 全通过（停用令牌 403 token_disabled、非法 status 400 invalid_status）。spec 沉淀低权限 PATCH 子集 resolver 模式，修正 error-handling.md 过时先例。决策变更：推翻旧 D5.3 status admin-only，用户可启停自有令牌。

### Git Commits

| Hash | Message |
|------|---------|
| `19c4da0` | (see git log) |

### Status

[OK] **Completed**


## Session 11: UI 选项卡过渡动画与骨架屏加载态（含 containing block 回归修复）

**Date**: 2026-09-17
**Task**: UI 选项卡过渡动画与骨架屏加载态（含 containing block 回归修复）
**Branch**: `main`

### Summary

为 Admin/User 两端补齐全套过渡动效：tab 切换入场动画（.t-view-enter，250ms fade+4px+blur）、登录态整页过渡（.t-page-enter，400ms+16px）、页面标题同步淡入、ViewSkeleton 骨架屏（stats/table/form/generic 四变体+shimmer）替换主加载态静态文字、DotLoader 收拢三点 bounce 并升级 MonitoringView 两处零散加载态。技术路线：key 重挂载 + CSS animation（enter-only），绕开 Modal phase 状态机复杂度；spec 沉淀三条约定（key 重挂载动画模式 / containing block 脚枪 / 加载态三件套）。回归教训：.t-view-enter 首版用 fill-mode both 恒留 transform+filter，使 Modal 壳（不走 portal）在各 View 内的编辑弹窗被关进内容区盒子并被 overflow-hidden 裁剪；check 阶段『子树 grep fixed』排查漏看 View 层嵌套而误判安全。修复为 backwards 并收紧 spec 规则：enter-only 且终帧=自然态一律 backwards，废除子树排查法。Playwright 实测动画全生命周期 transform 状态与 fixed 探针视口锚定闭环。

### Git Commits

| Hash | Message |
|------|---------|
| `5c610be` | (see git log) |
| `9059f72` | (see git log) |

### Status

[OK] **Completed**


## Session 12: 渠道客户端伪装(请求头+系统提示词注入)

**Date**: 2026-09-17
**Task**: 渠道客户端伪装(请求头+系统提示词注入)
**Branch**: `main`

### Summary

渠道级客户端伪装全量交付:channels 新增 disguise_headers_json/disguise_system_prompt(0021 迁移),applyHeaderPolicy 扩第 4 参形成四层头契约(剔除→全局→伪装→渠道级,policy=null 时伪装仍生效),utils/client-disguise.ts 三协议系统提示词前置注入(openai messages/anthropic system/responses instructions,含 /v1/responses 透传;custom 仅头),八分支接线覆盖真实代理与测试链路(连通性测试仅头)。UI 六预设(Cline/Kilo/pi/Cherry/ZCode(测试)/Codex(测试)),指纹由三个研究代理从本机实装与官方仓库锚定版本提取并全部溯源。关键教训:①注入必须重建数组不可原地 mutate,否则重试轮累积重复 system(逐字节守护断言);②CherryStudio/{version} UA 是遥测特征非 API 特征,指纹必须锚定真实请求路径。质检修复 ZCode UA 复合后缀与预设 note 渲染,proxy-headers.md spec 升级四层契约。发现存量缺陷待另立任务:custom_headers 提交链路 || undefined 在 PATCH 下清空保存无法真正清除。228 测试全绿;真实上游冒烟留待部署前。

### Git Commits

| Hash | Message |
|------|---------|
| `dbbcd3d` | (see git log) |
| `5235595` | (see git log) |

### Status

[OK] **Completed**


## Session 13: 渠道伪装动态头模板与 OpenCode 客户端预设

**Date**: 2026-09-19
**Task**: 渠道伪装动态头模板与 OpenCode 客户端预设
**Branch**: `main`

### Summary

为客户端伪装机制新增动态头模板能力：伪装头值支持 {{uuid}}/{{timestamp_ms}}/{{opencode_request_id}}/{{opencode_session_id}} 每请求实时解析（仅伪装域，custom/全局头字面值），ID 生成算法经官方源码与抓包样本双重验证（时间戳段为 ts mod 2^36）；新增第七预设 OpenCode（含 Zen 免费额度不支持警示）。三子代理流程（implement/check/update-spec），AC1-AC8 全过，240 测试绿，spec 契约同步至 proxy-headers.md。

### Git Commits

| Hash | Message |
|------|---------|
| `f8826e8` | (see git log) |
| `99f4dba` | (see git log) |
| `34a02eb` | (see git log) |

### Status

[OK] **Completed**


## Session 14: 用户端监控改为模型可用性并收紧 monitoring 鉴权

**Date**: 2026-09-19
**Task**: 用户端监控改为模型可用性并收紧 monitoring 鉴权
**Branch**: `main`

### Summary

发现 /api/monitoring* 在 adminAuth 放行清单中匿名可读（渠道名/渠道状态/错误详情全量泄露）。用户端「状态」页由共用 MonitoringView（渠道维度）替换为新的 ModelMonitoringView（模型维度，非交互 uptime 条，无下钻）：后端新增 GET /api/u/monitoring（userAuth，usage_logs 按模型聚合，零渠道字段，用户级 allowed_models 白名单过滤，聚合下沉纯函数 utils/model-monitoring.ts 并配 7 单测含无渠道字段防回归断言）；/api/monitoring* 移出放行清单收紧为管理员专用（管理端走 admin session 零改动）；RANGE_CONFIG 抽至 utils/monitoring.ts 共享；前端 generateSlots/formatSlotLabel/barColor 抽至 monitoring-shared.ts。AGENTS.md §6 与 spec 目录结构契约同步。check/typecheck/test 全绿（247 tests），trellis-check 逐条核过 AC1-AC8。遗留备忘：模型广场 /api/u/models 与 /api/public/models 仍按设计返回 channels[].name（按渠道定价），如需收敛另开任务；部署选 both，新旧混跑间隙用户端状态页短暂显示暂无数据。

### Git Commits

| Hash | Message |
|------|---------|
| `b7cd4d5` | (see git log) |
| `e09928f` | (see git log) |

### Status

[OK] **Completed**


## Session 15: 登录注册接入 Cloudflare Turnstile 人机验证

**Date**: 2026-09-19
**Task**: 登录注册接入 Cloudflare Turnstile 人机验证
**Branch**: `main`

### Summary

为管理员登录、用户登录、用户注册三处接入 Cloudflare Turnstile：services/turnstile.ts 单点实现（读宽写严 + siteverify 基建故障 fail-open + TURNSTILE_DISABLED env 逃生），settings 三键（secret 零回显），site-info 下发启用状态与 site key，前端首例动态第三方脚本模式（core 单例 loader + resetSignal），管理台配置卡片。新增 45 测试（共 292 全绿），check/typecheck 通过；沉淀后端 turnstile-auth 与前端 third-party-widget 两份 spec。人工验收项 AC7（含启用态断网场景）留给用户。

### Git Commits

| Hash | Message |
|------|---------|
| `d66c9d1` | (see git log) |
| `8cf65ac` | (see git log) |

### Status

[OK] **Completed**


## Session 16: Chat Completions↔Anthropic Messages 转换器补全

**Date**: 2026-09-20
**Task**: 09-20-chat-anthropic-converter
**Branch**: `main`

### Summary

修复 chat completions 入站 → anthropic 渠道方向的转换缺陷（用户实测：reasoning_effort 未透传 + 流式「假非流式」体感）。根因三层：reasoning→thinking 映射缺失；thinking 块/delta 全吞致长静默 + `[DONE]` 双发；usage 拆两 chunk 叠加 parseUsageFromSse last-wins 致流式 prompt_tokens 恒 0（计费低估）。文档实抓（research/）定档：budget_tokens 主路径（adaptive 仅 4.6+，4.5 存量会 400）+ thinking 直通逃生舱 + 生成 thinking 时剥离 temperature/top_p；usage 三项和口径换算（两 API 缓存口径相反）；reasoning_content 回传；image/file 部件 fail-open 转换；stop_reason 七值补全。改动集中 format-converter.ts + 新建 29 例测试（共 321 全绿），proxy/anthropic-proxy/usage 零改动，零回归经运行时 A/B 实证。沉淀 format-conversion spec。已知限制（design §8）：工具往返 thinking 签名回传、temperature 4.6+ 代际、反方向多模态缺口。

### Git Commits

| Hash | Message |
|------|---------|
| `cfca96a` | (see git log) |
| `15cdc7e` | (see git log) |
| `bdcf1ff` | (see git log) |

### Status

[OK] **Completed**

## Session 17: 渠道多 API 格式与 responses 自动降级转换

**Date**: 2026-09-20
**Task**: 09-20-channel-multi-api-format
**Branch**: `main`

### Summary

渠道 `api_format` 单值升级为 `api_formats` 多格式能力声明（迁移 0022 加列回填 + `api_format` 镜像首元素双写，回滚可降级），`/v1/responses` 入站在渠道无 responses 原生格式时自动降级。核心架构：「格式即能力声明」——新增 `services/channel-routing.ts` 统一入站协议 × 格式集资格判定与每协议偏好序选择（chat: openai>responses>anthropic>custom；responses: responses>openai>custom；anthropic: anthropic>openai>custom；透传 openai>responses>custom），proxy / anthropic-proxy / playground 三处共用，目标格式经浅拷贝覆盖 `api_format` 贯穿请求构造/伪装/头策略/响应转换。新增 responses→chat 转换器三函数（请求/响应/流式，`text.format`↔`response_format` 双向互逆，usage 单末事件、`[DONE]` 仅消费不外泄、error→response.failed）。唯一明示行为变更：responses 入站 + openai 渠道从裸透传 + 400/404 路径回退改为自动转换（回退死代码整体移除）。配套：CRUD `api_formats` 校验（custom 独占、无清除态、legacy 双接受）、逐格式探测并集 + `probe_warnings`、test-model 偏好序选目标、UI 多选 chips 与全格式徽章、监控下发 `api_formats`。关键取舍：normalizeBaseUrl 剥 /v1 对 openai 端点有损，多格式渠道存 trim+去尾斜杠（子代理纠正了 dispatch 预设）；错误码沿用代码现实 snake_case `invalid_api_formats` 而非 design 字面 ERR_ 前缀。测试 292→416 全绿（+124），check/typecheck 全过；trellis-check 全范围验收 13/13 AC 通过、零 blocker。沉淀 channel-routing spec（新建）+ format-conversion 增补 responses→chat 方向。

### Git Commits

| Hash | Message |
|------|---------|
| `f8a98a6` | (see git log) |
| `8fe3cc2` | (see git log) |
| `0e5a26c` | (see git log) |
| `ac6792d` | (see git log) |
| `5d34f59` | (see git log) |
| `08afca5` | (see git log) |
| `260495a` | (see git log) |
| `2f2fa91` | (see git log) |

### Status

[OK] **Completed**

## Session 18: 渠道每格式独立端点覆盖

**Date**: 2026-09-21
**Task**: 09-20-channel-per-format-endpoints
**Branch**: `main`

### Summary

上一任务（多格式能力声明）的延伸：coding plan 类上游不同协议挂在不同 URL（无推导关系），单 base_url + 路径推导表达不了。新增 `endpoint_overrides` JSON 列（迁移 0023，键白名单 openai/responses/anthropic，custom 不可覆盖，存量 NULL 零感知），`resolveEndpointBaseUrl` 统一收口全部 URL 解析点（buildChannelRequest 三分支、anthropic-proxy 两分支、逐格式探针）——**红线：无覆盖时与既有推导逐字节一致**，由既有 26+16 项 URL 断言用例零改动通过实证（新列排 api_formats 之后，INSERT 位置断言无位移）。CRUD `normalizeEndpointOverrides` 纯函数：键须在生效声明集内、值须 http(s)，三态 undefined 保留 / null·空串·空白清除 / 值设置；anthropic 覆盖入库 normalizeBaseUrl、其余保留版本路径；400 invalid_endpoint_overrides。UI 按选中格式渲染可选覆盖输入，提交仅含选中键（空串传 "" 触发清除）。测试 416→463（+47），check/typecheck/UI build 全绿；trellis-check 8/8 AC 通过，唯一 should-fix（openai 覆盖透传路径断言缺口）已补。channel-routing spec 增补 3.5 端点解析契约。范围外显式声明：每格式独立 API key、newapi 透传。

### Git Commits

| Hash | Message |
|------|---------|
| `994d31d` | (see git log) |
| `c1d8d20` | (see git log) |
| `6dbcdfb` | (see git log) |
| `c40420d` | (see git log) |
| `7514eed` | (see git log) |
| `67165e1` | (see git log) |

### Status

[OK] **Completed**


## Session 17: 新增 Claude Code 客户端伪装预设

**Date**: 2026-09-29
**Task**: 新增 Claude Code 客户端伪装预设
**Branch**: `main`

### Summary

在 CLIENT_PRESETS 新增第 8 个预设 claude-code（Claude Code 2.1.226，testing 待实测）：15 个请求头快照（UA/9-flag anthropic-beta/x-stainless-* 全家，x-claude-code-session-id 走 {{uuid}} 每请求解析；省略 authorization/x-api-key/content-type 并记因）+ systemPrompt 注入 billing 行与 Agent SDK 身份行；note 记录证据来源（pi-anaouter-cc @ d46b8f3 抓包校准）、版本锚点与 body 级校验限制（metadata.user_id/context_management/?beta=true 超出体系）。纯前端数据改动，零后端/迁移/测试改动；check/typecheck/test 全绿（463 用例）。指纹快照存任务 research/claude-code-fingerprint.md，spec 判断无需更新。

### Git Commits

| Hash | Message |
|------|---------|
| `3eccf76` | (see git log) |
| `666c6fa` | (see git log) |

### Status

[OK] **Completed**


## Session 18: 缓存命中率统计与双端仪表盘可视化

**Date**: 2026-10-19
**Task**: 缓存命中率统计与双端仪表盘可视化
**Branch**: `main`

### Summary

usage_logs 新增 cached_input_tokens / cache_creation_tokens 两列（迁移 0024，NULL = 上游未报告，不用 0 表示无数据）；normalizeUsage 建立缓存命中四级优先链与纯 Anthropic 形态 prompt 折算（防转换产物二次叠加），parseUsageFromSse 改 raw 层逐字段合并（保住 message_start 的 input/cache 字段，OpenAI 终端 chunk 与旧 last-wins 等价）；管理端/用户端仪表盘新增缓存命中率卡片与每日趋势（NULL ≠ 0 分母，无数据显 —，零依赖 mini bar）。门禁全绿（481 用例），check 验收 6 条全过。新增 spec usage-accounting.md（解析→落库→聚合完整口径契约）。

### Git Commits

| Hash | Message |
|------|---------|
| `766e5e0` | (see git log) |
| `b66f494` | (see git log) |
| `4a371ac` | (see git log) |
| `8cc2273` | (see git log) |
| `a5a9b98` | (see git log) |
| `97fc127` | (see git log) |

### Status

[OK] **Completed**


## Session 19: P0 索引补齐与计费原子性

**Date**: 2026-10-19
**Task**: P0：索引补齐与计费原子性（高并发加固树 1/4）
**Branch**: `main`

### Summary

迁移 0025 补 4 索引（tokens_key_hash / admin_sessions_token_hash / usage_logs_token_created / usage_logs_channel_created）并 DROP 冗余单列 usage_logs_channel_id——EXPLAIN 三条热查询全部 SEARCH…USING INDEX，鉴权全表扫描成为历史。recordUsage 改单次 db.batch（INSERT + quota + balance 单事务），余额扣减 `MAX(0, balance - cost)` 钳制不为负（用户 2026-10-19 决策），失败 `console.error("[usage] …")` 不 rethrow；proxy / anthropic-proxy 调用点收缩为只算 cost 传 userId。新增 usage-billing 6 用例，487 全绿；batch 原子性经内存 D1 UNIQUE 冲突回滚实测。三项偏离（userId TEXT、cost 复用、错误路径单语句 batch）均经 check 认可。spec：usage-accounting §8 计费契约、AGENTS §8 计费原子性 bullet、logging-guidelines 收尾失败例外。

### Git Commits

| Hash | Message |
|------|---------|
| `62f97e5` | (see git log) |
| `1f94be9` | (see git log) |
| `a4d0047` | (see git log) |

### Status

[OK] **Completed**


## Session 20: P1 热路径缓存与写入异步化

**Date**: 2026-10-19
**Task**: P1：热路径缓存与写入异步化（高并发加固树 2/4）
**Branch**: `main`

### Summary

新增 utils/cache.ts（TTL 原语，渠道/别名 10s、代理 settings 30s，WeakMap 注册表 + max 触顶清空）与 utils/post-response.ts（waitUntil 助手，executionCtx 缺失降级）；tokenAuth 合一为 tokens LEFT JOIN users 单查（显式列 + user_* 别名，三态与基线逐分支等价）；双代理路径鉴权后 4 读并单个 Promise.all，冷读 5 / 热读 1；非流式与错误路径 usage 写入切 post-response 不阻塞返回；顺带修复 anthropic-proxy 流式 executionCtx 裸断言存量 bug。新增 31 用例共 518 全绿，既有测试零改动。实施分两段（前代理超时遗留 + 续做审计补齐），check 独立复核修正 verification.md 计数笔误（487+31）。dev server 运行时手验 deferred to user（沙箱禁长驻进程），手验步骤在任务 verification.md §6。

### Git Commits

| Hash | Message |
|------|---------|
| `50f4ad6` | (see git log) |
| `72a8f11` | (see git log) |

### Status

[OK] **Completed**


## Session 21: P2 用量预聚合与保留策略 cron 化

**Date**: 2026-10-19
**Task**: P2：用量预聚合与保留策略 cron 化（高并发加固树 3/4）
**Branch**: `main`

### Summary

迁移 0026 建 usage_stats_daily（日粒度 model×channel×token×user，UTC 日切，含 cache_prompt_base 分母承载列与 last_seen_at）；services/usage-stats.ts 承载 splitWindow / rollupDate（幂等 + 防丢守卫：原始行已清且有 rollup 行时 no-op）/ 分批 retention / sessions 清理 / runDailyMaintenance；index.ts 增 scheduled（03:17 UTC 四步单步容错）+ wrangler.toml triggers；dashboard/monitoring/models/user-api 四处聚合切「rollup 段（≤昨日）+ 当日 raw 段」并集，user-api 走冗余 user_id 列免 JOIN；手动端点 POST /api/dashboard/rollup（空体全量缺失回填，rollupMissingDates 防误删）与 POST /api/usage/prune。新增 25 用例共 543 全绿；check 复核确认两段不相交与 80/110 cache 分母锚点、并修正 verification 计数。check 提出 #1 显式单日回填数据丢失脚枪已由守卫修复（+2 用例）。决策记录：AC-2「数十万行基准数值」沙箱不可造数，复判为以 EXPLAIN 查询计划证据替代（verification §3），部署后可补测。运行时手验（cron 触发、切表前后数值抽样）deferred to user，步骤在 verification §8。

### Git Commits

| Hash | Message |
|------|---------|
| `46e3d8c` | (see git log) |
| `29d6c03` | (see git log) |

### Status

[OK] **Completed**


## Session 22: P2 渠道冷却与请求日志减负 + 高并发加固树集成收尾

**Date**: 2026-10-20
**Task**: P2：渠道冷却与请求日志减负（高并发加固树 4/4）+ 父任务集成审查
**Branch**: `main`

### Summary

新增 services/channel-cooldown.ts（3 连败 60s 冷却，now 注入，fail-open 内建：全冷返回全量永不提前 503）；双代理接线（成功 = 任何存活证明响应即清零；失败 = 渠道放弃点每渠道每请求至多记 1 次）；候选装配在路由矩阵后、加权排序前过滤。入口请求日志默认零解析（raw.clone 零调用，[request] 仅 method/path），settings `debug_request_body_log` 三级回退 + 30s 缓存，PUT 严格布尔校验。实施分三段（被取消的前代理 + 续做审计 + check 修复）：续做修复接线双 bug（多轮重试误清失败记录、响应后解析抛错误记网络失败）；check 抓获 P0——惰性过期误清未达阈的失败计数致冷却在接线路径完全不生效（此前 575 全绿是权重随机的幸运样本），修复后确定性单测锚定、集成测试 8/8 可复现，576 全绿。父任务集成审查：四子任务全部独立 check 通过，AGENTS/spec 逐任务增量更新一致，跨子任务账目（索引/计费/读数/cron/冷却）逐项核对通过；运行时手验与数十万行基准压测 deferred to user（步骤在各 verification.md）。

### Git Commits

| Hash | Message |
|------|---------|
| `f248493` | (see git log) |
| `d568ddc` | (see git log) |

### Status

[OK] **Completed**


## Session 18: 管理台使用日志详情展开视图

**Date**: 2026-10-21
**Task**: 管理台使用日志详情展开视图
**Branch**: `main`

### Summary

UsageView 行展开详情面板：错误详情(JSON 提取+原始报文)/缓存 tokens/cost/请求路径收进详情，用时与首 token 合并列，状态保持 ok/error 加色 badge，UsageLog 类型补五字段；check 复核抓到并修复行内按钮键盘双触发 P0（target/currentTarget 守卫）；spec 沉淀可展开行守卫模式 + hono dom Fragment gotcha；顺带归档上会话 developer-role-normalize。

### Git Commits

| Hash | Message |
|------|---------|
| `add2548` | (see git log) |
| `10a0eb8` | (see git log) |

### Status

[OK] **Completed**
