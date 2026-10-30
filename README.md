# ZenAPI Next

> 由 [lsy2246/api-worker](https://github.com/lsy2246/api-worker) 衍生开发。

轻量级 AI API 网关，基于 Cloudflare Workers + D1，内置管理后台与多用户系统。
管理台构建产物通过 Worker Static Assets 与 Worker 一起部署，无需额外托管。

## 功能特性

- **多格式代理** — 同时兼容 OpenAI (`/v1/*`) 和 Anthropic (`/anthropic/v1/*`) 协议，支持自定义格式渠道
- **智能负载均衡** — 按权重随机分配请求到多个渠道，自动故障重试，单渠道支持多 API Key 失败自动换 Key
- **格式互转** — OpenAI ↔ Anthropic 请求/响应自动转换，上游无感知
- **精细模型管控** — 渠道内单独启用/禁用某个模型，按模型定价
- **用量追踪与计费** — 按模型定价记录 token 消耗、费用、延迟，服务模式下按用户余额扣减
- **用户系统** — 管理员用户管理（余额、状态、可用模型白名单）、用户注册登录（注册模式 open / linuxdo_only / closed，支持 LinuxDO OAuth）、令牌管理（存量令牌级渠道限定继续生效）、用量查看
- **模型广场** — 公开访问，展示可用模型与定价
- **可用性监测** — 实时渠道健康状态、成功率、延迟趋势
- **对话测试** — 管理后台内置 Playground，选择模型直接测试对话
- **一键部署** — GitHub Actions 自动构建部署到 Cloudflare Workers

## 目录结构

```
apps/
├── worker/          # Cloudflare Worker 后端 (Hono)
│   ├── src/
│   │   ├── index.ts           # 入口：路由注册、中间件
│   │   ├── routes/            # API 路由
│   │   ├── services/          # 业务逻辑
│   │   ├── middleware/        # 鉴权中间件
│   │   └── utils/             # 工具函数
│   ├── migrations/            # D1 数据库迁移
│   └── wrangler.toml          # Cloudflare 配置
└── ui/              # 管理台前端 (Vite + Hono JSX)
    └── src/
        ├── AdminApp.tsx       # 管理后台主组件
        ├── UserApp.tsx        # 用户端主组件
        ├── core/              # 类型、常量、工具
        └── features/          # 各功能视图组件
tests/               # 单元测试
```

## 快速开始

### 前置要求

- [Bun](https://bun.sh/) 1.3.9+
- Cloudflare 账号（用于 Wrangler 和 D1）

### 本地开发

```bash
# 安装依赖
bun install

# 本地数据库迁移（首次启动必须）
bun run --filter api-worker db:migrate

# 启动后端（默认 8787 端口）
bun run dev:worker

# 启动前端（默认 4173 端口）
bun run dev:ui
```

首次访问管理台时输入的密码将自动设置为管理员密码。

### 常用命令

| 命令 | 说明 |
|------|------|
| `bun run dev:worker` | 启动后端开发服务 |
| `bun run dev:ui` | 启动前端开发服务 |
| `bun run test` | 运行测试 |
| `bun run typecheck` | TypeScript 类型检查 |
| `bun run lint` | Biome 代码检查 |
| `bun run format` | Biome 代码格式化 |

### 环境变量

**Worker 配置** (`wrangler.toml` 或 `wrangler secret put`)：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CORS_ORIGIN` | `http://localhost:5173` | 允许的 CORS 来源 |
| `PROXY_RETRY_ROUNDS` | `2` | 代理失败重试轮数 |
| `PROXY_RETRY_DELAY_MS` | `200` | 重试间隔（毫秒） |

**前端配置** (`apps/ui/.env`，可选)：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_API_BASE` | 同域 | API 基址 |
| `VITE_API_TARGET` | `http://localhost:8787` | 本地代理目标 |

**系统设置**（管理台 → 系统设置）：

| 设置 | 默认值 | 说明 |
|------|--------|------|
| 日志保留天数 | 30 | 超期日志自动清理 |
| 会话时长 | 12 小时 | 管理员 session TTL |
| 注册模式 | open | open / linuxdo_only / closed |
| 签到奖励额度 | 0.5 | 用户每日签到奖励余额 |
| 新用户初始额度 | 0 | 注册用户初始余额 |
| 需要邀请码注册 | 关 | 开启后注册需填写有效邀请码 |
| LDC 充值 | 关 | LDC 支付开关、易支付参数与兑换汇率 |
| Turnstile 人机验证 | 关 | 登录 / 注册人机验证开关与 Cloudflare 密钥，详见下文 |
| 站点公告 | 空 | 全站公告内容，留空不显示 |

## 渠道格式

| 格式 | 说明 |
|------|------|
| `openai` | 标准 OpenAI 兼容 API，请求直接转发 |
| `anthropic` | Anthropic Messages API，自动进行 OpenAI ↔ Anthropic 格式互转（含 `reasoning_effort` → `thinking` 映射、图片/PDF 部件转换、缓存口径 usage 换算） |
| `responses` | OpenAI Responses API（`/responses`），chat 入站自动双向转换（含流式），`/v1/responses` 入站原样透传 |
| `custom` | 自定义 API，`base_url` 作为完整地址，支持自定义请求头 |

### 多 API Key

每个渠道支持配置多个 API Key，在管理后台文本框中每行填写一个 Key。请求时随机打乱 Key 顺序，第一个 Key 失败（可重试状态码）则自动尝试下一个 Key，所有 Key 失败后才换下一个渠道。连通性测试使用第一个 Key。单个 Key 的渠道行为不变。

### 模型启用/禁用

渠道的模型列表支持单独启用或禁用某个模型。在模型定价编辑区域点击模型前的「启用/禁用」按钮即可切换。禁用的模型：
- 不出现在 `/v1/models` 接口返回中
- 不参与代理路由匹配（请求该模型时不会路由到此渠道）
- 配置（定价）保留不丢失，随时可恢复启用

## 管理后台

| 标签页 | 功能 |
|--------|------|
| 数据面板 | 请求量、Token 消耗、错误率、按日/模型/渠道/令牌维度统计 |
| 可用性监测 | 渠道健康状态、成功率、延迟、日趋势（支持 15m/1h/1d/7d/30d） |
| 渠道管理 | 渠道 CRUD、连通性测试、模型自动拉取、多 API Key、模型启用/禁用 |
| 模型广场 | 汇总各渠道模型、定价、用量、延迟 |
| 令牌管理 | API Token CRUD、配额管理、渠道限制 |
| 使用日志 | 详细请求日志，支持按时间/模型/渠道/令牌筛选 |
| 系统设置 | 日志保留、会话时长、注册模式、签到、初始额度、邀请码、LDC 充值、公告、管理员密码 |
| 用户管理 | 用户 CRUD、余额管理、状态控制、可用模型白名单 |
| 对话测试 | 内置 Playground，选择模型直接流式对话测试 |

## 用户端

| 页面 | 功能 |
|------|------|
| 仪表盘 | 余额、请求量、费用、近期趋势 |
| 状态 | 渠道可用性监测 |
| 模型广场 | 可用模型与定价 |
| 我的令牌 | 创建/管理个人 API Token |
| 使用日志 | 个人请求记录 |

## Turnstile 人机验证

为管理员登录、用户登录、用户注册三个入口接入 [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)，抵御脚本爆破管理员密码、撞库登录与垃圾注册。

- **配置入口**：管理后台 → 系统设置 → 「Turnstile 人机验证」。在 Cloudflare Dashboard 创建 Turnstile 站点后，把 Site Key 与 Secret Key 填入并保存，两把密钥齐备后才能打开开关（避免半配置启用）。Secret Key 只写不回显。
- **紧急开关**：环境变量 `TURNSTILE_DISABLED` 设为 `1` / `true` / `yes`（大小写不敏感）并重新部署后，即使 settings 已启用也全局跳过校验，用于 siteverify 故障或误锁定时的快速止血。
- **fail-open 容错**：siteverify 网络异常 / 超时（5s）/ 非 2xx 时按放行处理并记录 warn 日志；仅 siteverify 显式判定 `success=false` 才拒绝（403 `turnstile_verify_failed`）。缺 token 为 400 `turnstile_token_missing`。
- **本地联调**：可使用 Cloudflare 官方测试密钥（总是通过）——Site Key `1x00000000000000000000AA`、Secret Key `1x0000000000000000000000000000000AA`（另有 always-block 的 `2x` 前缀密钥）。
- **对程序化客户端的影响**：启用后，三个登录/注册端点必须携带 Turnstile token（浏览器页面会自动完成），脚本直接调用 `POST /api/auth/login`、`POST /api/u/auth/login`、`POST /api/u/auth/register` 将无法登录。LinuxDO OAuth 流程与 `/v1`、`/anthropic/v1` 代理、New API 兼容端点不受影响。未配置 / 未启用时系统行为与之前完全一致。

## API 参考

### 鉴权方式

| 接口组 | 鉴权方式 |
|--------|----------|
| `/api/*` 管理接口 | `Authorization: Bearer {session_token}`（也支持 `x-admin-token`、`x-api-key`） |
| `/api/channel`、`/api/group`、`/api/user` | `Authorization: Bearer {管理员密码}`（兼容 New API，支持 `New-Api-User` 头） |
| `/v1/*` OpenAI 代理 | `Authorization: Bearer {api_token}` |
| `/anthropic/v1/*` Anthropic 代理 | `Authorization: Bearer {api_token}` |
| `/api/u/*` 用户接口 | `Authorization: Bearer {user_session_token}` |
| `GET /health` | 无需鉴权 |

### 管理接口 (`/api/*`)

**认证**
- `POST /api/auth/login` — 管理员登录
- `POST /api/auth/logout` — 管理员登出

**渠道**
- `GET /api/channels` — 渠道列表
- `POST /api/channels` — 新增渠道
- `PATCH /api/channels/:id` — 更新渠道
- `DELETE /api/channels/:id` — 删除渠道
- `POST /api/channels/:id/test` — 连通性测试（自动刷新模型列表）
- `POST /api/channels/test-model` — 单渠道单模型真实对话测试（body 传 `model` 与可选表单配置，未保存渠道可测；不写 usage、不更新连通性结果）

**模型**
- `GET /api/models` — 汇总所有渠道模型（含定价、用量、延迟统计）

**令牌**
- `GET /api/tokens` — 令牌列表
- `POST /api/tokens` — 新建令牌（返回一次性明文 token）
- `PATCH /api/tokens/:id` — 更新令牌（配额/状态/允许渠道）
- `GET /api/tokens/:id/reveal` — 查看令牌明文
- `DELETE /api/tokens/:id` — 删除令牌

**用量**
- `GET /api/usage` — 使用日志（支持 `from/to/model/channel_id/token_id/limit`）

**面板**
- `GET /api/dashboard` — 聚合指标（支持 `from/to`）

**监测**
- `GET /api/monitoring` — 渠道健康数据（支持 `range`: 15m/1h/1d/7d/30d）

**设置**
- `GET /api/settings` — 读取系统设置
- `PUT /api/settings` — 更新系统设置

**用户管理**
- `GET /api/users` — 用户列表
- `POST /api/users` — 创建用户
- `PATCH /api/users/:id` — 更新用户
- `DELETE /api/users/:id` — 删除用户

**对话测试**
- `GET /api/playground/models` — 可用模型列表
- `POST /api/playground/chat` — 对话测试（不记录用量，不扣费）

### New API 兼容接口

**渠道管理 (`/api/channel`)**
- `GET /api/channel` — 渠道列表（分页：`page/page_size/limit/p`）
- `GET /api/channel/search` — 渠道搜索（`keyword/group/model/status/type`）
- `GET /api/channel/:id` — 渠道详情
- `POST /api/channel` — 新增渠道
- `PUT /api/channel` — 更新渠道
- `DELETE /api/channel/:id` — 删除渠道
- `GET /api/channel/test/:id` — 连通性测试
- `POST /api/channel/test` — 连通性测试（body 传 id）
- `GET /api/channel/fetch_models/:id` — 拉取渠道模型
- `POST /api/channel/fetch_models` — 拉取模型（body 传 base_url/key）
- `GET /api/channel/models` — 模型列表
- `GET /api/channel/models_enabled` — 启用模型列表
- `PUT /api/channel/tag` — 批量更新 tag 权重/优先级
- `POST /api/channel/tag/enabled` — 批量启用 tag
- `POST /api/channel/tag/disabled` — 批量停用 tag

**分组与用户**
- `GET /api/group` — 渠道分组列表
- `GET /api/user/models` — 用户可用模型列表

### 公开接口 (`/api/public`)

- `GET /api/public/site-info` — 站点信息
- `GET /api/public/models` — 公开模型列表（含定价与渠道名）

### 用户接口 (`/api/u/*`)

**认证**
- `POST /api/u/auth/register` — 用户注册（受注册模式控制）
- `POST /api/u/auth/login` — 用户登录
- `POST /api/u/auth/logout` — 用户登出
- `GET /api/u/auth/me` — 当前用户信息

**数据**
- `GET /api/u/dashboard` — 用户仪表盘（余额、用量、趋势）
- `GET /api/u/models` — 可用模型列表
- `GET /api/u/tokens` — 用户令牌列表
- `POST /api/u/tokens` — 创建令牌
- `DELETE /api/u/tokens/:id` — 删除令牌
- `GET /api/u/tokens/:id/reveal` — 查看令牌明文
- `GET /api/u/usage` — 用户使用日志

### OpenAI 兼容代理 (`/v1/*`)

- `GET /v1/models` — 可用模型列表
- `POST /v1/chat/completions` — 对话补全
- `POST /v1/responses` — 响应接口
- `ALL /v1/*` — 其他请求透传

代理特性：
- 按权重随机选择渠道，支持多轮重试
- 单渠道多 API Key 支持，失败自动换 Key 重试，所有 Key 失败后才换渠道
- 禁用的模型不参与路由匹配，不出现在模型列表中
- 用户级可用模型白名单：白名单外模型返回 403 `model_not_allowed`，`/v1/models` 按白名单过滤
- 流式请求自动注入 `stream_options.include_usage = true`
- `/v1/chat/completions` 返回 400/404 时自动回退到 `/v1/responses`
- 自动记录 token 用量和费用

### Anthropic 兼容代理 (`/anthropic/v1/*`)

- `POST /anthropic/v1/messages` — Anthropic Messages API

接受 Anthropic 格式请求，自动路由到配置的渠道并转换格式。

## 数据库

使用 Cloudflare D1 (SQLite)，包含以下表：

| 表 | 说明 |
|----|------|
| `channels` | 渠道配置（base_url、api_key、权重、模型列表、格式等） |
| `tokens` | API 令牌（hash 存储、配额、允许渠道） |
| `usage_logs` | 请求日志（模型、token 数、费用、延迟） |
| `settings` | 系统键值设置 |
| `admin_sessions` | 管理员会话 |
| `users` | 用户账号 |
| `user_sessions` | 用户会话 |

迁移文件位于 `apps/worker/migrations/`。

## GitHub Actions 自动部署

工作流：`Deploy SPA CF Workers[Worker一体化部署]`

### 配置 Secrets

在仓库 Settings → Secrets and variables → Actions 中添加：

- `CLOUDFLARE_API_TOKEN` — 需包含 Workers + D1 读写权限
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare 账户 ID

### 可选变量

- `SPA_DEPLOY` — 自动部署开关（`true`/`false`），未设置时默认启用

### 触发方式

| 方式 | 条件 | 受 `SPA_DEPLOY` 控制 |
|------|------|----------------------|
| Push | `main`/`master` 分支，变更涉及 `apps/ui/**` 或 `apps/worker/**` | 是 |
| 手动 | Actions 页面 → Run workflow | 否（除非 `from_panel=true`） |
| 外部 | `repository_dispatch` (type: `deploy-spa-button`) | 否 |

### 手动触发参数

| 参数 | 选项 | 默认 | 说明 |
|------|------|------|------|
| `deploy_action` | `update` / `init` | `update` | `init` 用于首次部署（创建 D1 + 迁移 + 部署） |
| `deploy_target` | `frontend` / `backend` / `both` / `auto` | `auto` | `auto` 按变更范围决定 |
| `apply_migrations` | `true` / `false` / `auto` | `auto` | `auto` 仅在迁移文件变更时执行 |
| `from_panel` | `true` / `false` | `auto` | 是否由控制面板触发 |

### 部署流程

1. 检出代码 → 安装 Bun 1.3.9 → `bun install`
2. 构建管理台（`apps/ui/dist`）并校验产物
3. 创建/校验 D1 数据库（`api-worker`），写入 `database_id`
4. 按需执行远程数据库迁移
5. `wrangler deploy` 部署 Worker（含静态资源）

### 数据库迁移与升级顺序

- 后端变更（`backend` / `both`）涉及迁移文件时，D1 迁移在**同一 CI run 内先于 Worker 部署**执行（即上方流程第 4 → 5 步），请勿将迁移与代码部署拆到两次 run 单独执行。
- 自 `0019_remove_shared_ecosystem.sql` 起，迁移包含不可逆的 DROP 表 / DROP 列操作，**升级前建议先备份数据库**（Cloudflare 控制台导出或 `wrangler d1 export`）。
- 迁移先于新代码生效的秒级窗口内，旧代码读取已删除的列/表会报错，属预期现象，随新代码部署完成即恢复。

## 技术栈

| 层 | 技术 |
|----|------|
| 后端运行时 | Cloudflare Workers |
| 后端框架 | Hono |
| 数据库 | Cloudflare D1 (SQLite) |
| 前端框架 | Hono JSX + Vite |
| 样式 | Tailwind CSS |
| 包管理 | Bun 1.3.9 |
| 代码规范 | Biome |
| 测试 | Vitest |
| CI/CD | GitHub Actions |
| 语言 | TypeScript |
