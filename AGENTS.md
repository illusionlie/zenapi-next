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
| `/api/tokens` | `routes/tokens.ts` | API 令牌 CRUD、令牌级模型白名单、额度编辑（三态 PATCH）、`/reveal` 二次查看明文 |
| `/api/usage` | `routes/usage.ts` | 使用日志查询与保留清理 |
| `/api/dashboard` | `routes/dashboard.ts` | 聚合统计 |
| `/api/monitoring` | `routes/monitoring.ts` | 渠道健康 / 成功率 / 延迟（15m/1h/1d/7d/30d，管理员专用） |
| `/api/settings` | `routes/settings.ts` | 系统键值配置 |
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
| `/anthropic/v1` | `routes/anthropic-proxy.ts` | Anthropic Messages 代理（含格式互转） |

## 7. 鉴权中间件

| 中间件 | 用于 | 凭据 |
|--------|------|------|
| `adminAuth` | `/api/*`（除放行清单） | session token / `x-admin-token` / `x-api-key` |
| `newApiAuth` | `/api/channel`、`/api/user`、`/api/group` | `Authorization: Bearer {管理员密码}`，支持 `New-Api-User` 头 |
| `tokenAuth` | `/v1/*`、`/anthropic/v1/*` | `Authorization: Bearer {api_token}` |
| `userAuth` | `/api/u/*` | 用户 session token |

## 8. 代理关键行为（改 `proxy.ts` 前必读）

- 按渠道**权重随机**排序选择，失败（5xx / 429）按重试轮数轮询重试；重试参数存 `settings` 表（`proxy_retry_rounds` 1–10 / `proxy_retry_delay_ms` 0–60000ms，管理台可改），读取优先级为 settings → env（`PROXY_RETRY_ROUNDS` / `PROXY_RETRY_DELAY_MS`，兼容回退）→ 内置默认（2 轮 / 200ms），读取侧对越界脏值 clamp；三条代理路径统一经 `loadProxyRetryConfig` 读取（proxy / anthropic-proxy 并入现有 `Promise.all` 预载，playground 循环前单次读取）。
- 单渠道多 API Key：随机打乱顺序，首个 Key 失败自动换下一个 Key，全部 Key 失败才换渠道。
- 流式请求自动注入 `stream_options.include_usage = true`（注入条件：最终上游体为 chat completions 形状——chat 入站在 handler 预注入，`/v1/responses` 入站在转换为 chat 体后由 `buildChannelRequest` 注入，单请求恰一次），并从 SSE / 响应头 / 非 JSON 体解析 usage。
- **路由矩阵：格式即能力声明**：渠道 `api_formats`（JSON 数组，如 `["openai","anthropic"]`；`api_format` 为规范化首元素镜像列，repo 层双写，旧代码回滚可读）声明上游原生支持的端点集合；`custom` 只能独占。入站协议（chat / responses / anthropic / 其他透传）按「声明集 ∩ 可服务集合」判定渠道资格，命中多个时按每协议固定偏好序选唯一**目标格式**（chat `openai>responses>anthropic>custom`；responses `responses>openai>custom`；anthropic `anthropic>openai>custom`；透传 `openai>responses>custom`）；判定与选择收敛于 `services/channel-routing.ts` 的 `selectTargetFormat`，proxy / anthropic-proxy / playground 三处共用，选中目标经浅拷贝覆盖 `api_format` 贯穿请求构造 / 伪装 / 头策略 / 响应转换。无合格候选 → 503 `no_available_channels`（不发上游请求）。responses↔anthropic 转换不存在：responses 入站排除仅声明 anthropic 的渠道，anthropic 入站排除仅声明 responses 的渠道。
- **responses 渠道格式**（声明含 `responses`，OpenAI Responses API 上游）：chat 入站自动 Chat↔Responses 双向转换（含流式与 tool 往返）；`/v1/responses` 入站原生透传 `{base_url}/responses`（`store` / `previous_response_id` 不解释，状态由上游承担；无路径回退）；连通性测试与 openai 同语义（`GET {base_url}/models` + Bearer）。
- **openai 渠道 + responses 入站自动降级**：仅声明 `openai` 的渠道收到 `/v1/responses` 请求时自动转换为 chat completions（`responsesToOpenaiRequest` 发 `{base}/chat/completions`，`text.format`→`response_format` 对称映射、stateful 字段丢弃 + warn），响应/SSE 以 Responses 协议回传（`openaiToResponsesResponse` / `createOpenaiToResponsesStreamTransform`：usage 仅 `response.completed` 单事件、`[DONE]` 不外泄、reasoning_content→summary delta、error→`response.failed`）。
- **anthropic 渠道格式**（声明含 `anthropic`，Anthropic Messages 上游，转换在 `format-converter.ts`）：chat 入站 `reasoning_effort` / `reasoning.effort` 按档位（minimal 0.1 / low 0.2 / medium 0.5 / high 0.8 / xhigh·max 0.95 × max_tokens，clamp `[1024, max_tokens-1]`；`none` 不发字段）映射 `thinking:{type:"enabled",budget_tokens}`，客户端直发 `thinking` 对象（enabled/adaptive/disabled）最小校验后直通；产物含 thinking 时剥离 `temperature` / `top_p`；`max_completion_tokens` 优先于 `max_tokens`（均缺省 8192）、`developer` 并入 system、`tool_choice:"none"` 直发 `{type:"none"}` 且保留 tools；user 部件 `image_url`→image（http(s)→url source、data URL→base64 source，mime 限 jpeg/png/gif/webp）、`file`→document（仅 base64 PDF）、`input_audio` 与未知部件丢弃并 warn（前缀 `[format-converter]`），全丢弃时回退空 text 块。响应侧 thinking 块→`message.reasoning_content`（流式 `delta.reasoning_content` 增量；redacted_thinking / signature / citations 不回传）；usage 口径换算 `prompt_tokens = input_tokens + cache_read + cache_creation`（cache_read→`prompt_tokens_details.cached_tokens`、thinking_tokens→`completion_tokens_details.reasoning_tokens`），流式 usage 仅出现在 message_delta 终止 chunk、`[DONE]` 恰一次（flush 不补发）、流内 error 事件发终止 chunk（finish_reason stop）+ warn。已知限制：thinking+工具往返的签名回传 chat 协议无法满足（不承诺兼容）；非 thinking 场景 temperature 代际适配不做（4.6+ 只收 1.0 的 400 原样透传）。
- **渠道多格式配套**：CRUD 接受 `api_formats` 数组（`api_formats` 优先、legacy 单值 `api_format` 双接受；空 / 非法 / custom 组合 → 400 `invalid_api_formats`，PATCH 无清除态）；**每格式端点覆盖** `endpoint_overrides`（JSON 对象，键白名单 `openai/responses/anthropic`，custom 不可覆盖；键须在生效 `api_formats` 内、值须 http(s)，否则 400 `invalid_endpoint_overrides`；三态 undefined 保留 / null·空串清除 / 值设置；anthropic 覆盖入库走 `normalizeBaseUrl`、其余保留版本路径；空对象存 NULL）——URL 解析统一走 `resolveEndpointBaseUrl`（`channel-routing.ts`）：覆盖优先，**无覆盖时与既有 base_url 推导逐字节一致**；`base_url` 的存储规范化仅对纯 anthropic 渠道走 `normalizeBaseUrl`，其余 trim 去尾斜杠（anthropic 端点请求时自会规范化，存 `/v1` 无害，反向剥离对 openai 端点有损）；连通性测试与模型拉取逐声明格式用**各自解析端点** `Promise.allSettled` 探测（有响应即可达语义不变），模型按 id 并集去重，部分失败附 `probe_warnings` 与逐格式 `results`，全部网络失败才不可达；test-model 按 chat 偏好序选目标格式；UI 表单多选（custom 独占可见约束）+ 每格式可选覆盖输入。
- `base_url` 入库前规范化为无尾斜杠；空值返回空串避免崩溃。
- usage 记录：输入/输出 tokens、首 token 延迟、流式标记、推理强度（取自请求体 `reasoning` / `reasoning_effort`）；缓存命中 `cached_input_tokens`（优先级 `prompt_tokens_details.cached_tokens` → `input_tokens_details.cached_tokens` → `prompt_cache_hit_tokens` → `cache_read_input_tokens`）与缓存写入 `cache_creation_tokens`（仅 Anthropic 语义，不进命中率分子），NULL = 上游未报告；`prompt_tokens` 全路径口径统一为含缓存总输入——纯 Anthropic 形态（prompt 取自 `input_tokens` 别名且存在 cache 字段）折算 `input + cache_read + cache_creation`，OpenAI 形态 / 转换产物不二次叠加；流式 SSE usage 逐字段合并（非 null 覆盖、缺失保留），保住 `message_start` 的 input/cache 字段。
- usage 解析兼容 Responses 格式：SSE `response.completed` 事件的 `response.usage` 路径；`input_tokens/output_tokens` 归一为 prompt/completion tokens。
- **禁用的模型不参与路由匹配**，也不出现在 `/v1/models`。
- **用户级可用模型白名单**：`users.allowed_models`（JSON 数组，空 = 不限制）；按请求模型名**精确匹配**，白名单外返回 403 `model_not_allowed`；`/v1/models` 与 `/api/u/models` 同步过滤；与令牌级 `allowed_channels` 相互独立、正交生效。
- **令牌级可用模型白名单**：`tokens.allowed_models`（JSON 数组，NULL/空 = 不限制），管理台与用户端均可配置；与用户级白名单**取交集生效**（逐清单独立校验后 AND，不合并数组，避免空交集 fail-open 反转），精确匹配、白名单外 403 `model_not_allowed`；`/v1/models` 同步双重过滤；与令牌级 `allowed_channels` 正交。
- **伪装头动态模板**：伪装头（`disguise_headers_json`）的值支持每上游请求实时解析的 `{{...}}` 占位符（`{{uuid}}` / `{{timestamp_ms}}` / `{{opencode_request_id}}` / `{{opencode_session_id}}`，解析于 `applyHeaderPolicy` 与连通性探针两处接线点，重试/换渠道/换 Key 天然各自新鲜）；未知占位符原样保留；渠道级 `custom_headers_json` 与全局注入/剔除头**不**解释模板，按字面值发送。

## 9. 静态资源 / SPA 回退

`index.ts` 的 `notFound` 处理：非 API/V1/Anthropic 路径交由 `ASSETS.fetch`；HTML 请求且无扩展名时回退到 `/index.html`。因此 `apps/ui/dist` 必须存在（`.gitkeep` 占位以通过 wrangler assets 检查）。

## 10. 数据库（D1）

`apps/worker/src/db/schema.sql` 定义全部表。核心域：

- **代理**：`channels`（含 `api_formats` 多格式能力声明 + `api_format` 镜像首元素 + `endpoint_overrides` 每格式端点覆盖）、`tokens`（含 `allowed_models` 令牌级白名单）、`usage_logs`（含 `cached_input_tokens` / `cache_creation_tokens` 缓存列，NULL = 上游未报告）、`model_aliases`、`channel_model_aliases`
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
