# AGENTS.md

> 面向 AI 编程助手的项目规范。人类向文档见 [README.md](./README.md)；
> 本文件只补充 agent 在代码库中作业所需的结构、约定与坑点，不重复 README 已有的 API / 部署细节。

## 1. 项目简介

ZenAPI —— 基于 Cloudflare Workers + D1 的轻量 AI API 网关，内置管理后台与多用户系统（固定服务模式：用户注册登录、余额计费，管理员可按用户配置可用模型白名单）。
支持 OpenAI (`/v1/*`) 与 Anthropic (`/anthropic/v1/*`) 双协议代理、格式互转、按权重负载均衡与故障重试。

## 2. 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Cloudflare Workers |
| 后端框架 | Hono（`strict: false`） |
| 数据库 | Cloudflare D1（SQLite） |
| 前端 | Hono JSX (`hono/jsx/dom`) + Vite + Tailwind v4 |
| 包管理 | Bun 1.3.9（workspaces: `apps/*`） |
| 代码规范 | Biome 2.x（tab 缩进、双引号） |
| 测试 | Vitest |
| CI/CD | GitHub Actions |

## 3. 仓库布局

```
apps/worker/                # Hono 后端
  src/
    index.ts                # 入口：全局中间件 + 路由挂载 + SPA 静态回退
    env.ts                  # Bindings / Variables / AppEnv 类型
    routes/                 # 按领域拆分的路由模块（见 §6）
    middleware/             # adminAuth / newApiAuth / tokenAuth / userAuth
    services/               # 业务逻辑
    utils/                  # 工具函数（含 url 规范化等）
    db/schema.sql           # D1 全表 schema
  migrations/               # D1 迁移文件
  wrangler.toml             # Cloudflare 配置
apps/ui/                    # 管理台 / 用户端前端
  src/
    App.tsx                 # 顶层路由分发（Admin/User/Public）
    AdminApp.tsx            # 管理后台主组件
    UserApp.tsx             # 用户端主组件
    PublicApp.tsx           # 公开页主组件
    core/                   # api / constants / types / utils
    features/               # 各功能视图（AdminApp/UserApp 各自的 View）
  dist/                     # 构建产物（由 Worker Static Assets 托管，勿手动改）
tests/                      # Vitest 单测（如 model-allowlist.test.ts、channel-models.test.ts、filter-allowed-channels.test.ts）
```

## 4. 开发命令

| 命令 | 说明 |
|------|------|
| `bun install` | 安装依赖 |
| `bun run dev:worker` | 启动后端（默认 8787） |
| `bun run dev:ui` | 启动前端（默认 4173，Vite proxy 转发至后端） |
| `bun run test` | 运行 Vitest |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` / `format` / `check` | Biome 检查 / 格式化 / 综合修复 |

首次本地启动需先迁移：`bun run --filter api-worker db:migrate`。
首次访问管理台输入的密码会写入 `settings` 表作为管理员密码（**不**来自环境变量）。

## 5. 代码规范

- **命名**：变量 `camelCase`，文件 `kebab-case`，组件文件 `PascalCase.tsx`。
- **格式**：Biome —— tab 缩进、双引号、`organizeImports: on`。提交前跑 `bun run check`。
- **TS**：`strict: true`，`moduleResolution: Bundler`，前端 `jsxImportSource: hono/jsx/dom`。
- **Git**：trunk-based，Conventional Commits。
- **错误处理**：错误码 `ERR_{模块}_{含义}`，日志 `info/warn/error`。
- **测试**：核心逻辑须有单测，置于 `tests/`，文件名 `*.test.ts`。

## 6. 路由 / 模块速查表

挂载点见 `apps/worker/src/index.ts`。鉴权放行规则：`/api/auth/login`、`/api/channel*`、`/api/user*`、`/api/group*`、`/api/public*`、`/api/u/*`、`/api/recharge*` 不走 `adminAuth`。

| 挂载路径 | 路由文件 | 职责 |
|----------|----------|------|
| `/api/auth` | `routes/auth.ts` | 管理员登录 / 登出（密码存 `settings`，会话 hash 存 `admin_sessions`） |
| `/api/channels` | `routes/channels.ts` | 渠道 CRUD、连通性测试（`/v1/models`）、单模型真实对话测试（`/test-model`）、模型拉取 |
| `/api/models` | `routes/models.ts` | 模型广场聚合（仅启用渠道） |
| `/api/model-aliases` | `routes/model-aliases.ts` | 模型别名映射 |
| `/api/tokens` | `routes/tokens.ts` | API 令牌 CRUD、令牌级模型白名单、额度编辑（三态 PATCH）、可选过期时间 `expires_at`（到期**禁用不删除**——tokenAuth 惰性判定 403 `token_expired`，非法存量值 fail-open，PATCH 续期即恢复）、令牌级 RPM 上限 `rpm_limit` 编辑（三态，见 §8 客户端限流）、`/reveal` 二次查看明文 |
| `/api/usage` | `routes/usage.ts` | 使用日志查询与保留清理 |
| `/api/dashboard` | `routes/dashboard.ts` | 聚合统计 |
| `/api/monitoring` | `routes/monitoring.ts` | 渠道健康 / 成功率 / 延迟（15m/1h/1d/7d/30d，管理员专用） |
| `/api/settings` | `routes/settings.ts` | 系统键值配置 |
| `/api/backup` | `routes/backup.ts` | 配置一键备份（导出 JSON 下载 / 导入全量替换，管理员专用，见 §8） |
| `/api/invite-codes` | `routes/invite-codes.ts` | 邀请码 |
| `/api/public` | `routes/public.ts` | 站点信息 / 公开模型（含定价） |
| `/api/channel` | `routes/newapiChannels.ts` | New API 兼容渠道（含 tag 批量、fetch_models） |
| `/api/user` | `routes/newapiUsers.ts` | New API 兼容用户 |
| `/api/group` | `routes/newapiGroups.ts` | New API 兼容分组（从 `group_name` 解析，空取 `default`） |
| `/api/playground` | `routes/playground.ts` | 对话测试（不记用量、不扣费） |
| `/api/users` | `routes/admin-users.ts` | 用户管理 CRUD（含 `allowed_models` 可用模型白名单） |
| `/api/u/auth` | `routes/user-auth.ts` | 用户注册 / 登录 / 登出 / me |
| `/api/u` | `routes/user-api.ts` | 用户仪表盘 / 模型 / 令牌（含模型白名单配置，额度字段拒改） / 日志 / 模型可用性监测 |
| `/api/recharge` | `routes/recharge.ts` | 充值订单 |
| `/v1` | `routes/proxy.ts` | OpenAI 兼容代理（见 §8） |
| `/anthropic/v1` | `routes/anthropic-proxy.ts` | Anthropic Messages 代理（含格式互转与 `count_tokens`） |

## 7. 鉴权中间件

| 中间件 | 用于 | 凭据 |
|--------|------|------|
| `adminAuth` | `/api/*`（除放行清单） | session token / `x-admin-token` / `x-api-key` |
| `newApiAuth` | `/api/channel`、`/api/user`、`/api/group` | `Authorization: Bearer {管理员密码}`，支持 `New-Api-User` 头 |
| `tokenAuth` | `/v1/*`、`/anthropic/v1/*` | `Authorization: Bearer {api_token}`；内嵌客户端限流两门（见 §8） |
| `userAuth` | `/api/u/*` | 用户 session token |

## 8. 代理关键行为（改 `proxy.ts` 前必读）

- 按渠道**权重随机**排序选择，失败（5xx / 429）按重试轮数轮询重试；重试参数存 `settings` 表（`proxy_retry_rounds` 1–10 / `proxy_retry_delay_ms` 0–60000ms，管理台可改），读取优先级为 settings → env（`PROXY_RETRY_ROUNDS` / `PROXY_RETRY_DELAY_MS`，兼容回退）→ 内置默认（2 轮 / 200ms），读取侧对越界脏值 clamp；热路径（proxy / anthropic-proxy）经 `loadProxySettingsCached`（30s TTL，只缓存 settings 原始读）+ `resolveProxyRetryConfig` 每次重算，playground 循环前与 settings GET 仍走未缓存的 `loadProxyRetryConfig`。
- **单渠道多 API Key：key 级冷却与归因分离**（`services/key-cooldown.ts`，任务 10-26-key-cooldown-stats）：随机打乱顺序逐 Key 尝试，全部 Key 失败才换渠道。**失败分类**（proxy / anthropic-proxy 两处 key 循环同构）：401/403 → `recordKeyAuthFailure`（长冷却 10min）+ **换下一把 Key 继续**（2026-10-26 起为有意的客户端可见行为变更：原 break 放弃整渠道，多 key 渠道一把 key 失效即请求失败；现多 key 渠道 401 后由好 key 服务）；408/429/5xx/网络错（fetch throw）→ `recordKeyRetryableFailure`（短冷却 60s）+ 现行为不变（`channelRetryable`、换 key）；其他 4xx（400/404/413/422…）请求级错误不冷却 key、break 不换 key（换 key 无意义）；成功 `recordKeySuccess` 清冷却。**Map 键 = `channelId:keyFingerprint`**（fnv1a32 前 8 hex，稳定于 key 行序重排、UI 不泄明文），isolate 内存视图、多 isolate 不共享、计数自 isolate 启动累计（UI 文案如实标注）；`filterCoolingKeys` 选 key 前过滤冷却中者，**全部 key 冷却 → fail-open 原样返回**（沿渠道冷却哲学，永不因 key 冷却拒绝服务）；size > 10000 触发过期清扫。**归因分离**：401/403 是 key 坏 ≠ 渠道坏——不置 `channelRetryable`、不推进渠道冷却 streak，渠道放弃点记账现状即把 401/403 记为渠道成功（上游活跃证明），本任务零改动；429/5xx 照旧计入渠道级判定。**usage_logs.key_tag**（迁移 0030）：成功行记服务 key 指纹、错误行记末次尝试 key 指纹（upstream_unavailable 且零尝试为 NULL，旧行 NULL 兼容），经 `recordUsage` 的 `keyTag` 入参透传、同 batch 原子落库；rollup 不含 key 维度（只查 24h raw）。**监测双源**：`/api/monitoring` 响应 `keyStats` 段 = 内存活值（冷却状态 + 累计 auth/retryable 失败数、successes）+ 24h `key_tag` 归因计数（一条 `GROUP BY channel_id, key_tag` 查询合并，无 key_tag 索引——channel_id+created_at 既有索引够用）；监测页渠道行「Key 健康」展开仅显指纹。单 key 渠道零回归：401 仍穿透（fail-open 无替代 key），渠道不进冷却（无双杀）。
- 流式请求自动注入 `stream_options.include_usage = true`（注入条件：最终上游体为 chat completions 形状——chat 入站在 handler 预注入，`/v1/responses` 入站在转换为 chat 体后由 `buildChannelRequest` 注入，单请求恰一次），并从 SSE / 响应头 / 非 JSON 体解析 usage。
- **路由矩阵：格式即能力声明**：渠道 `api_formats`（JSON 数组，如 `["openai","anthropic"]`；`api_format` 为规范化首元素镜像列，repo 层双写，旧代码回滚可读）声明上游原生支持的端点集合；`custom` 只能独占。入站协议（chat / responses / anthropic / 其他透传）按「声明集 ∩ 可服务集合」判定渠道资格，命中多个时按每协议固定偏好序选唯一**目标格式**（chat `openai>responses>anthropic>custom`；responses `responses>openai>custom`；anthropic `anthropic>openai>custom`；透传 `openai>responses>custom`）；判定与选择收敛于 `services/channel-routing.ts` 的 `selectTargetFormat`，proxy / anthropic-proxy / playground 三处共用，选中目标经浅拷贝覆盖 `api_format` 贯穿请求构造 / 伪装 / 头策略 / 响应转换。无合格候选 → 503 `no_available_channels`（不发上游请求）。responses↔anthropic 转换不存在：responses 入站排除仅声明 anthropic 的渠道，anthropic 入站排除仅声明 responses 的渠道。
- **responses 渠道格式**（声明含 `responses`，OpenAI Responses API 上游）：chat 入站自动 Chat↔Responses 双向转换（含流式与 tool 往返）；`/v1/responses` 入站原生透传 `{base_url}/responses`（`store` / `previous_response_id` 不解释，状态由上游承担；无路径回退）；连通性测试与 openai 同语义（`GET {base_url}/models` + Bearer）。
- **openai 渠道 + responses 入站自动降级**：仅声明 `openai` 的渠道收到 `/v1/responses` 请求时自动转换为 chat completions（`responsesToOpenaiRequest` 发 `{base}/chat/completions`，`text.format`→`response_format` 对称映射、stateful 字段丢弃 + warn），响应/SSE 以 Responses 协议回传（`openaiToResponsesResponse` / `createOpenaiToResponsesStreamTransform`：usage 仅 `response.completed` 单事件、`[DONE]` 不外泄、reasoning_content→summary delta、error→`response.failed`）。
- **anthropic 渠道格式**（声明含 `anthropic`，Anthropic Messages 上游，转换在 `format-converter.ts`）：chat 入站 `reasoning_effort` / `reasoning.effort` 按档位（minimal 0.1 / low 0.2 / medium 0.5 / high 0.8 / xhigh·max 0.95 × max_tokens，clamp `[1024, max_tokens-1]`；`none` 不发字段）映射 `thinking:{type:"enabled",budget_tokens}`，客户端直发 `thinking` 对象（enabled/adaptive/disabled）最小校验后直通；产物含 thinking 时剥离 `temperature` / `top_p`；`max_completion_tokens` 优先于 `max_tokens`（均缺省 8192）、`developer` 并入 system、`tool_choice:"none"` 直发 `{type:"none"}` 且保留 tools；user 部件 `image_url`→image（http(s)→url source、data URL→base64 source，mime 限 jpeg/png/gif/webp）、`file`→document（仅 base64 PDF）、`input_audio` 与未知部件丢弃并 warn（前缀 `[format-converter]`），全丢弃时回退空 text 块。响应侧 thinking 块→`message.reasoning_content`（流式 `delta.reasoning_content` 增量；redacted_thinking / signature / citations 不回传）；usage 口径换算 `prompt_tokens = input_tokens + cache_read + cache_creation`（cache_read→`prompt_tokens_details.cached_tokens`、thinking_tokens→`completion_tokens_details.reasoning_tokens`），流式 usage 仅出现在 message_delta 终止 chunk、`[DONE]` 恰一次（flush 不补发）、流内 error 事件发终止 chunk（finish_reason stop）+ warn。已知限制：thinking+工具往返的签名回传 chat 协议无法满足（不承诺兼容）；非 thinking 场景 temperature 代际适配不做（4.6+ 只收 1.0 的 400 原样透传）。
- **渠道多格式配套**：CRUD 接受 `api_formats` 数组（`api_formats` 优先、legacy 单值 `api_format` 双接受；空 / 非法 / custom 组合 → 400 `invalid_api_formats`，PATCH 无清除态）；**每格式端点覆盖** `endpoint_overrides`（JSON 对象，键白名单 `openai/responses/anthropic`，custom 不可覆盖；键须在生效 `api_formats` 内、值须 http(s)，否则 400 `invalid_endpoint_overrides`；三态 undefined 保留 / null·空串清除 / 值设置；anthropic 覆盖入库走 `normalizeBaseUrl`、其余保留版本路径；空对象存 NULL）——URL 解析统一走 `resolveEndpointBaseUrl`（`channel-routing.ts`）：覆盖优先，**无覆盖时与既有 base_url 推导逐字节一致**；`base_url` 的存储规范化仅对纯 anthropic 渠道走 `normalizeBaseUrl`，其余 trim 去尾斜杠（anthropic 端点请求时自会规范化，存 `/v1` 无害，反向剥离对 openai 端点有损）；连通性测试与模型拉取逐声明格式用**各自解析端点** `Promise.allSettled` 探测（有响应即可达语义不变），模型按 id 并集去重，部分失败附 `probe_warnings` 与逐格式 `results`，全部网络失败才不可达；test-model 按 chat 偏好序选目标格式；UI 表单多选（custom 独占可见约束）+ 每格式可选覆盖输入。
- `base_url` 入库前规范化为无尾斜杠；空值返回空串避免崩溃。
- usage 记录：输入/输出 tokens、首 token 延迟、流式标记、推理强度（取自请求体 `reasoning` / `reasoning_effort`）；缓存命中 `cached_input_tokens`（优先级 `prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens` → `prompt_cache_hit_tokens` → `cache_read_input_tokens`）与缓存写入 `cache_creation_tokens`（仅 Anthropic 语义，不进命中率分子），NULL = 上游未报告；`prompt_tokens` 全路径口径统一为含缓存总输入——纯 Anthropic 形态（prompt 取自 `input_tokens` 别名且存在 cache 字段）折算 `input + cache_read + cache_creation`，OpenAI 形态 / 转换产物不二次叠加；流式 SSE usage 逐字段合并（非 null 覆盖、缺失保留），保住 `message_start` 的 input/cache 字段。**延迟口径**（2026-10-23 起）：流式 TTFT 锚定**请求起点** → 首条 SSE data 行（含重试/换渠道时间，`parseUsageFromSse` 接收请求起点 epoch ms，缺省回退调用时刻供既有直调兼容）；流式 `latency_ms` 含完整流时长（流尾取值——TTFB→总时长口径变更，部署后与历史 rollup 存在台阶、随 180d 老化消失）；非流式 TTFT 恒等于总用时；SSE 解析失败回退 headers latency + TTFT null。
- **计费原子性**：`recordUsage` 把 INSERT usage_logs + UPDATE tokens.quota_used + UPDATE users.balance 组装为**单次 `db.batch`**（D1 batch = 单事务，三写同生共死，无「记日志未扣费」中间态）；余额扣减为 `balance = MAX(0, balance - cost)` **钳制不为负**（余额不足时平台吸收单请求差额，`usage_logs.cost` 仍记真实成本，差额可对账审计）；quota 语义不变（预检 + 无条件累加，并发上浮有界 = 在途请求数 × 单次增量）；batch 失败后 **250ms 单次重试**（重放同一 statements，失败已整体回滚、无半态风险），两次都败才 `console.error("[usage] billing batch failed", …)`——载荷含 model/channelId/requestPath/prompt·completion·total tokens/status/attempts，Logpush 侧可离线重建统计行——不影响已成功的上游响应。调用方（proxy / anthropic-proxy）只算 cost 并传 `userId`，**不得**在路由层自行扣余额。
- **热路径缓存与异步收尾**：活跃渠道/模型别名 10s、代理 settings（头策略 + 重试配置 + developer 归一化开关）30s 的 isolate 内存 TTL 缓存（`utils/cache.ts`，惰性过期，消费方对缓存行**只读**）——管理台变更的生效陈旧窗口即 TTL（渠道/别名 ≤10s、settings ≤30s）；**token 鉴权永不缓存**（tokens+users JOIN 单查，显式列清单 + `user_*` 别名）；非流式与错误路径的 usage 写入经 `runPostResponse`（waitUntil）响应后收尾，不阻塞返回，executionCtx 缺失时降级 fire-and-forget + 记日志。
- **用量预聚合与维护**：`usage_stats_daily`（日粒度 model×channel×token×user，UTC 日切）承载往日统计；跨日窗口 = rollup 段（≤昨日）+ 当日 raw 段并集（`splitWindow` 两段严格不相交；**span ≤ 1 天的窗口走 raw-only 精确边界**，不吃日粒度近似——秒粒度判定，防止监测 1d/15m/1h 档整天虚高；>1 天窗口起点日按整天近似计入，误差 ≤ 1/窗口天数）。Cron `03:17 UTC`（wrangler.toml `[triggers]`）每日执行：**近 7 天 rollup 自愈扫窗**（逐日索引探测、缺才补，单晚失败不再黑洞）→ 分批 retention 清理原始日志（chunk 5000 × 至多 180 轮保险丝，最坏全链 ~219 条查询 ≪ D1 1000/调用上限）→ 清理过期 sessions → rollup 表 180d 保留期清理，单步失败不阻断。手动端点：`POST /api/dashboard/rollup`（单日 / 空体全量缺失回填，`rollupMissingDates` 走 MIN+DISTINCT 差集无全表扫）、`POST /api/usage/prune`（有界，响应 `{deleted, complete}`，complete=false 重跑续删）；cutoff 统一 `retentionCutoffIso`（UTC 毫秒）。**防丢守卫**：`rollupDate` 对「原始行已清且 rollup 行存在」的日期 no-op，永不把幸存统计删空。
- **渠道冷却与请求日志开关**：渠道**时间聚类**的连续 3 次可重试失败（408/429/5xx/网络错误，每渠道每请求至多记 1 次，成功即清零；间隔超 `COOLDOWN_STREAK_RESET_MS`=5 分钟则 streak 重置——非 isolate 生命周期累计）进入 60s 冷却（`services/channel-cooldown.ts`，isolate 内存视图、多 isolate 不共享），期间不进加权随机候选池；**fail-open**：全部候选都在冷却中时不过滤，永不因冷却提前 503。入口请求日志中间件默认不解析请求体（`[request]` 仅 method/path），settings `debug_request_body_log=true`（三级回退 + 30s 缓存；管理台 GET 走 `loadDebugLogFlagDirect` 直读不受缓存陈旧影响，UI 开关未做、可经 API 设置）恢复完整 body 解析形态（一次 `text()` 后自行 `JSON.parse`：非 JSON body 记 `text` + 真实 `body_size`）。
- usage 解析兼容 Responses 格式：SSE `response.completed` 事件的 `response.usage` 路径；`input_tokens/output_tokens` 归一为 prompt/completion tokens。
- **count_tokens 端点**：`POST /anthropic/v1/messages/count_tokens`（tokenAuth，Claude Code 上下文管理依赖）。模型治理与 `/messages` 同链——经 `anthropic-proxy.ts` 内共享 helper（热态读取 `loadAnthropicProxyHotState`、候选选择 `selectAnthropicInboundCandidates`、目标格式路由 `routeAnthropicTargetFormats`）复用 `channel/model` 路由语法、per-channel 别名、令牌/用户白名单与 alias_only 抑制（**不**解析全局 `model_aliases`，与 `/messages` 现行热路径一致）；anthropic 目标渠道单次加权挑选后透传 `{anthropic 端点}/v1/messages/count_tokens`（头按 anthropic 分支惯例 + `applyHeaderPolicy`，不接客户端预设/伪装提示词——注入会改变计数本身），上游失败（网络错/非 2xx）或目标为 openai/responses/custom 时不重试不换渠道，本地粗估 `input_tokens = max(1, ceil(序列化长度/4))` 恒 200；**零计费**：不写 usage_logs、不动额度与冷却（tokenAuth 预检照常）。
- **禁用的模型不参与路由匹配**，也不出现在 `/v1/models`。
- **用户级可用模型白名单**：`users.allowed_models`（JSON 数组，空 = 不限制）；按请求模型名**精确匹配**，白名单外返回 403 `model_not_allowed`；`/v1/models` 与 `/api/u/models` 同步过滤；与令牌级 `allowed_channels` 相互独立、正交生效。
- **令牌级可用模型白名单**：`tokens.allowed_models`（JSON 数组，NULL/空 = 不限制），管理台与用户端均可配置；与用户级白名单**取交集生效**（逐清单独立校验后 AND，不合并数组，避免空交集 fail-open 反转），精确匹配、白名单外 403 `model_not_allowed`；`/v1/models` 同步双重过滤；与令牌级 `allowed_channels` 正交。
- **伪装头动态模板**：伪装头（`disguise_headers_json`）的值支持每上游请求实时解析的 `{{...}}` 占位符（`{{uuid}}` / `{{timestamp_ms}}` / `{{opencode_request_id}}` / `{{opencode_session_id}}`，解析于 `applyHeaderPolicy` 与连通性探针两处接线点，重试/换渠道/换 Key 天然各自新鲜）；未知占位符原样保留；渠道级 `custom_headers_json` 与全局注入/剔除头**不**解释模板，按字面值发送。
- **客户端头基础剥离**：`buildChannelRequest` 全量复制入站头后、五层头策略之前，按固定常量 `STRIPPED_CLIENT_HEADERS`（12 项）剔除 CF 边缘身份/转发头（`cf-connecting-ip`、`x-forwarded-*`、`x-real-ip`、`true-client-ip`、`cdn-loop` 等）与 `cookie`——防终端用户真实 IP 泄露给上游；全局注入同名头可显式加回（管理员意图优先），仅应用层（Workers 出站连接自身平台特征不可去除），锚点 `tests/privacy-header-strip.test.ts`。
- **developer 角色透传归一化开关**：settings `normalize_developer_role`（严格布尔，默认**关闭**；两级读取链——存储值严格 `"true"`/`"false"`，缺失/脏值降级 `false`，**无 env 回退**）。开启后仅作用于 openai 协议族两处裸透传：chat completions 入站 + openai 目标把 `messages` 中 `role:"developer"` **原位改名**为 `system`；`/v1/responses` 入站 + responses 目标把 `input` 中 `type:"message"` 的 developer item 同样改名——保序保内容（含多模态 part 与空内容），不合并相邻 system，不触碰 `tool` / `function_call` / `function_call_output` / `reasoning`。**不动**：anthropic / responses / openai+responses 入站各转换分支（已有 developer hoist 进 system / instructions，语义见 format-converter）、custom 独占渠道（协议未知，透传即不解释）。与伪装提示词共享同一次 bodyCopy 拷贝与 stringify（先归一化后注入；命中改名的 message/input item 逐条浅克隆，保证调用方共享 parsedBody 跨重试轮不被污染——否则改名后重试会找不到 developer 而回退未归一化原文）；开启但无 developer 且无伪装时回退字节级 `requestText` 不重序列化。键入 `PROXY_SETTING_KEYS` 随 `loadProxySettingsCached` 单查询 + 30s TTL（管理台生效陈旧窗口 ≤30s）；GET 直读表单真相（`loadDeveloperNormalizeFlagDirect`）、PUT 严格布尔校验非法 400 `invalid_normalize_developer_role`；主代理 / Playground / 渠道单模型测试三处 `buildChannelRequest` 调用方一致生效（归一化纯函数 `normalizeChatDeveloperRole` / `normalizeResponsesDeveloperRole` 在 `services/format-converter.ts`）。
- **渠道级服务端客户端预设**：`channels.disguise_preset`（NULL = 关闭；值白名单 `CLIENT_PRESET_IDS`（现仅 `opencode_zen_v1`），非法 400 `invalid_disguise_preset`，PATCH 三态同 disguise_headers；预设本体是代码常量 `services/client-presets.ts`——上游指纹随客户端发版漂移，不进 settings/DB，版本活值集中在 `OPENCODE_V1_VERSIONS` 随上游发布**手工刷新**；引擎纯函数不读 DB/settings，热路径零新增查询，`buildChannelRequest` 每次构建求值一次）。**头五层应用顺序**：剔除 → 全局注入 → 预设头 → 伪装头（模板）→ custom，后应用者赢；预设头是已求值字面值（不解释 `{{...}}`，模板解析仍是伪装独占域），全局剔除对预设头保持裁决权（清单内头名预设层跳过注入，大小写不敏感同 `headers.delete`），全局注入因先行不能覆盖预设头；`policy === null` 豁免仍只跳全局两步，预设/伪装/custom 照常生效。**opencode_zen_v1 指纹**：同步确定性 ID 派生（FNV-1a + splitmix64 64-bit 混合，无 crypto.subtle / 无随机段 / 无 memo）——`ses_` 降序会话 ID（36-bit 伪时间 `<<12|1` 取反 ⇒ 低 12 hex 恒 `ffe`，落 counter 活体窗口）同一对话跨请求 / 重试轮 / 换渠道稳定（prompt-cache 亲和），`msg_` 升序消息 ID 混入回合指纹（真用户回合计数、跳过 tool_result 回灌）同回合同 ID，无信号 body 回退旧生成器；UA 按目标协议分段 `opencode/1.19.3 ai-sdk/provider-utils/{chat 4.0.23 | responses 4.0.40 | anthropic 4.0.46} runtime/bun/1.3.14`（custom 用 chat 段）；身份头组 `x-opencode-client` / `x-opencode-session` + `x-opencode-session-id`（双头同值）/ `x-opencode-request` / `x-opencode-project`（`global`，不用 v2 拒收的 `prj_` 形状）；`anthropic-beta` 仅 anthropic 目标按 body 特征派生（mcp / context / skills / task-budget / speed / fallbacks / thinking / 工具 type 与模型能力，无命中不设）。**body 合规**（chat/anthropic/responses 三协议形状）：客户端非流时上游强制 `stream:true`（流式客户端 body 不动 stream 字段）+ 工具合规 bash 恒注入、总数 <2 补 read/edit（定义逐字移植 sst/opencode v1.19.3 tag，存 chat 嵌套 function 形状、anthropic 运行时 `parameters`→`input_schema` 改名、responses 扁平；追加前拷贝 tools 数组，不污染跨重试轮共享的 parsedBody）；**形状守卫**：chat/anthropic 目标要求 `messages` 数组、responses 要求 `input`（string/array），非对话形状 body（embeddings 等）不动、原样回退零重序列化；custom 目标仅头生效、不解释 body。**强制流式响应侧**：上游 SSE 由 `services/stream-aggregate.ts` 全量聚合为该协议标准非流 JSON 再喂 `convertResponse`（本体零改动；入口 fail-open 非 SSE 原样返回、逐事件 fail-open 脏行跳过 + `[stream-aggregate]` warn、截断流产出部分聚合；anthropic `message_delta.usage` 累计直取经导出的 `mergeRawUsage` 合并、不二次累加）；`stream_options.include_usage` 预注入条件扩为 `isStream || 候选池含强制流式预设渠道`（custom 排除，判定用 `isStreamForcingPreset`）。范围外：v2 通道（`/inference`、`/zen/go`）与匿名凭证（PRD R8）；连通性测试探针不接预设（GET 无 body），Playground / test-model / anthropic-proxy 各分支同模式接线。
- **客户端限流**（tokenAuth 域 `/v1/*` 与 `/anthropic/v1/*`，`services/rate-limiter.ts` 原语 + `middleware/tokenAuth.ts` 接线，任务 10-26-rate-limiting）：两层防护均为 **isolate 内存 60s 滑动窗近似**（模块级 Map，多 isolate 不共享，有效上限 ≈ 设定值 × 活跃 isolate 数；纯内存无外部依赖，fail-open 是结构性属性而非 catch 兜底）。**门序**：① IP 鉴权失败节流门在 D1 查询**之前**——同 IP 窗口内失败数 ≥ settings `ip_auth_fail_limit`（默认 0 = 关）→ 429 `auth_throttled` + `Retry-After`，此后零 D1 查询；IP 提取链 `cf-connecting-ip` → `x-forwarded-for` 首值 → 缺省跳过两门。失败计数口径：仅四个鉴权失败出口计数（401 `token_required` / `invalid_token`、403 `token_disabled` / `token_expired`）；402 quota/balance 与 403 `user_disabled` **不**计（合法客户端资金问题，非爆破信号）；鉴权成功不清零计数（防「扫描混正常调用」绕过，滑窗自身承载窗口滑动恢复）。② RPM 尾门在全部既有门之后、`next()` 之前——`tokens.rpm_limit` 三态：NULL = 跟随全局默认 settings `token_rpm_default`（默认 0 = 关，存量令牌零变化）、0 = 显式不限（豁免全局默认）、正整数 = 每分钟上限；超限 429 `rate_limit_exceeded` + `Retry-After`（窗口剩余秒数）；允许路径也计数（限**到达速率**非成功速率，被拒请求不占窗）。两门拦截在 tokenAuth 内 → 不发上游、不写 usage_logs、不动额度（计费纪律天然满足）。**惰性短路**：零失败记录的 IP / 空窗且 rpm_limit NULL 的令牌不触发 settings 读取——全默认配置下 D1 查询画像与改造前一致；两键入 `PROXY_SETTING_KEYS` 随 `loadProxySettingsCached`（30s TTL）+ `resolveRateLimitConfig` 每请求重算（clamp [0, 1e6]，脏值降 0）；管理台 GET 走 `loadRateLimitConfigDirect` 直读表单真相、PUT 严格整数校验（非法 400 `invalid_token_rpm_default` / `invalid_ip_auth_fail_limit`）；令牌 CRUD 双端（`/api/tokens` 与 `/api/u/tokens`）POST/PATCH 接 `resolveRpmLimitValue` 三态校验（undefined 保留 / null·空串 → NULL / 0 或正整数，非法 400 `invalid_rpm_limit`）；UI：系统设置两数值字段 + 令牌表单（管理台/用户端）rpm_limit 数值输入（空 = 跟随全局默认 / 0 = 显式不限 / 正整数 = 上限，列表不展示）；迁移 `0029_token_rpm_limit.sql`。
- **配置一键备份**（`routes/backup.ts`，任务 10-26-config-backup-restore，管理员专用——`/api/backup` **不**进 adminAuth 放行清单）。**导出** `GET /api/backup/export`：载荷 `{version:1, exportedAt, channels, model_aliases, channel_model_aliases, settings}`；channels 为 `listChannels()` 原样行（**含明文 api_key**，JSON 列保持存储字符串形态）；两张别名表导出行数组（保留 is_primary / alias_only，等价恢复所需）；settings = **GET 可见键白名单**（`BACKUP_SETTINGS_EXPORT_KEYS`，23 键）∩ **排除清单**（`BACKUP_SETTINGS_EXCLUDED_KEYS`：`admin_password_hash` / `turnstile_secret_key`；LinuxDO OAuth secret 是 env 变量不存 settings 表，会话态各有独立表，均天然不进备份）——白名单外未知键不导出；响应 `no-store` + `attachment; filename="zenapi-backup-YYYY-MM-DD.json"`。**导入** `POST /api/backup/import`（全量替换式）：防护链 content-length/读后长度 > 2MB → 413 `payload_too_large`，解析/结构非法 → 400 `invalid_backup_payload`，`version !== 1` → 400 `unsupported_backup_version`；载荷含排除清单键 → 400 `forbidden_settings_key`（fail-closed，防跨实例恢复锁死管理员）；逐渠道校验走 `services/channel-validation.ts`——渠道 CRUD（POST/PATCH/fetch_models/test-model）与导入**共用的唯一规则实现**（2026-10-26 自 channels.ts 原样抽取，行为零变化），非法 400 带定位（`channels[1] "name": ...` + CRUD 错误码）。**写入 = 单次 `db.batch` 先清后写**（D1 batch 单事务，失败整体回滚 500 `import_failed`）：DELETE channels / model_aliases / channel_model_aliases 全表 + settings **仅载荷内键**（载荷没有的键保留现值），INSERT 渠道**保留原 id**（token.allowed_channels / usage_logs.channel_id 引用不断链）、JSON 列（api_formats / endpoint_overrides / models_json 等）parse 校验后**回写原字符串**（round-trip 字节保真，不 re-stringify）。**导入范围铁律**：users / tokens / usage_logs / usage_stats_daily / recharge_orders / invite_codes / 各会话表一律不触碰。缓存无失效接口：渠道/别名 ≤10s、settings ≤30s TTL 自然过期，响应体 `cache_staleness` 显式提示。UI：SettingsView「备份与恢复」区块（导出明文警示 / 文件+粘贴双入口 / 预览 + 双重 confirm / 结果 toast）。锚点 `tests/backup-restore.test.ts`（20 用例：导出形状与排除清单、round-trip 等价 + 代理路由字段可解析、校验失败零写入、413/400 矩阵、settings 选择性替换）。

## 9. 静态资源 / SPA 回退

`index.ts` 的 `notFound` 处理：非 API/V1/Anthropic 路径交由 `ASSETS.fetch`；HTML 请求且无扩展名时回退到 `/index.html`。因此 `apps/ui/dist` 必须存在（`.gitkeep` 占位以通过 wrangler assets 检查）。

## 10. 数据库（D1）

`apps/worker/src/db/schema.sql` 定义全部表。核心域：

- **代理**：`channels`（含 `api_formats` 多格式能力声明 + `api_format` 镜像首元素 + `endpoint_overrides` 每格式端点覆盖）、`tokens`（含 `allowed_models` 令牌级白名单 + `expires_at` 可选过期 + `rpm_limit` 令牌级 RPM 上限三态（NULL = 跟随全局默认 / 0 = 不限 / 正整数，见 §8 客户端限流））、`usage_logs`（含 `cached_input_tokens` / `cache_creation_tokens` 缓存列，NULL = 上游未报告；含 `key_tag` key 级末次归因 8 hex 指纹列，NULL = 旧行/无归因路径）、`usage_stats_daily`（日粒度预聚合，rollup 180d 保留）、`model_aliases`、`channel_model_aliases`
- **会话/设置**：`admin_sessions`、`settings`
- **用户体系**：`users`（含 `allowed_models` 白名单）、`user_sessions`、`user_checkins`、`invite_codes`
- **资金**：`recharge_orders`

迁移位于 `apps/worker/migrations/`，按文件名顺序执行。

## 11. 环境变量（`env.ts` Bindings）

| 变量 | 说明 |
|------|------|
| `DB` | D1 绑定（wrangler 注入） |
| `CORS_ORIGIN` | `/api/*` 允许来源，`*` 或逗号分隔列表 |
| `PROXY_RETRY_ROUNDS` | 代理重试轮数兼容回退（settings `proxy_retry_rounds` 优先，默认 2） |
| `PROXY_RETRY_DELAY_MS` | 重试间隔毫秒兼容回退（settings `proxy_retry_delay_ms` 优先，默认 200） |
| `TURNSTILE_DISABLED` | Turnstile 紧急逃生开关：真值（`"1"` / `"true"` / `"yes"`，大小写不敏感）时全局跳过登录/注册人机验证（settings 已启用也跳过，重新部署生效） |
| `LINUXDO_CLIENT_ID` / `LINUXDO_CLIENT_SECRET` | LinuxDO OAuth（如启用） |

管理员密码、注册模式、会话时长、日志保留天数等**业务配置存 `settings` 表**，经管理台「系统设置」修改，非环境变量。

## 12. 部署

GitHub Actions 工作流「Deploy SPA CF Workers[Worker一体化部署]」，区分 `init`（首次：建库 + 迁移 + 部署）与 `update`（按变更范围选 frontend/backend/both）。Secrets、触发参数与完整流程见 [README.md](./README.md#github-actions-自动部署)。

## 13. 给 agent 的作业准则

1. 改路由前先看 `index.ts` 的挂载点与鉴权放行清单，避免漏挂或破坏鉴权边界。
2. 新增表必须同时加 `schema.sql` 与编号迁移文件。
3. 改前端入口结构时同步更新本文件 §3；`App.tsx` 是视图分发入口，勿直接堆业务。
4. 提交前必跑 `bun run check && bun run typecheck && bun run test`。
5. 本文件是 agent 规范的**唯一事实来源**；如与 README 冲突，以代码与本文件为准并提 issue 修正 README。
<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
