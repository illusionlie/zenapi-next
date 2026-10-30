# 项目更名为 ZenAPI Next（文档 + UI 徽章 + worker 文本）

## 背景（Goal）

本项目 fork 自已停止开发的 ZenAPI，经大量修改已实质分叉。现把对外品牌更名为
**ZenAPI Next**，覆盖文档、管理台/用户端/公开页 UI 显示、worker 侧对外可见纯文本。

命名约定（2026-10-30 用户拍板）：

- **UI 显示位**：主名 `ZenAPI` 保持原字号/字重/字体，右侧紧跟小号 `Next` **pill 徽章**。
- **纯文本场景**（HTML title、备份文件名、webhook/报警标题、充值商品名、README/AGENTS）：
  一律写 `ZenAPI Next`，无徽章概念。
- **范围**：全面改（含 worker 侧文本与测试断言）。

## 改名锚点清单

### UI（apps/ui）

| 位置 | 现状 | 改为 |
|------|------|------|
| `index.html:9` | `<title>ZenAPI</title>` | `ZenAPI Next`（纯文本） |
| `src/features/AppLayout.tsx:70/101/145` | 移动端顶栏 + 移动抽屉 + 桌面侧栏 logo | 主名 + Next 徽章 |
| `src/UserApp.tsx:507/538/582` | 用户端 3 处品牌位 | 主名 + Next 徽章 |
| `src/PublicApp.tsx:146/193` | 公开页 2 处 | 主名 + Next 徽章 |
| `src/features/LoginView.tsx:43` | 管理员登录页 | 主名 + Next 徽章 |
| `src/features/UserLoginView.tsx:49` | 用户登录页 | 主名 + Next 徽章 |
| `src/features/UserRegisterView.tsx:78/105/182` | 用户注册页 3 处 | 主名 + Next 徽章 |
| `src/AdminApp.tsx:1255` | 前端备份下载文件名 `zenapi-backup-*` | `zenapi-next-backup-*` |

### Worker（apps/worker）

| 位置 | 现状 | 改为 |
|------|------|------|
| `src/routes/backup.ts:134` | `zenapi-backup-YYYY-MM-DD.json` | `zenapi-next-backup-YYYY-MM-DD.json` |
| `src/services/alerts.ts:212/230/367` | `[ZenAPI] 渠道故障报警/恢复`、`[ZenAPI] 用量日报` | `[ZenAPI Next] ...` |
| `src/routes/webhooks.ts:204/208` | `[ZenAPI] Webhook 测试` + 正文 | `[ZenAPI Next] ...` |
| `src/routes/recharge.ts:92` | `name: "ZenAPI 充值"`（易支付网关商品名，**即时参数不落库**，已确认无历史数据问题；改后签名随同请求重算，自洽） | `"ZenAPI Next 充值"` |

### 文档

| 位置 | 现状 | 改为 |
|------|------|------|
| `README.md:1` | `# ZenAPI` | `# ZenAPI Next` |
| `AGENTS.md:8` | `ZenAPI —— 基于 ...` | `ZenAPI Next —— 基于 ...` |

### 顺手改（代码注释，非强制但建议）

- `apps/ui/src/core/client-presets.ts:602` — 注释中的 `ZenAPI 自定义 provider`
- `apps/worker/src/routes/proxy.ts:306` — 注释 `ZenAPI does not`

### 测试同步

- `tests/backup-restore.test.ts:189` — 文件名正则改 `zenapi-next-backup-`
- `tests/webhook-alerts.test.ts:33/82/99/126/403/493/650` — `[ZenAPI]` 标题断言改 `[ZenAPI Next]`

### 明确不动

- `package.json` 各级 name（`api-worker` / `api-worker-ui`）与 wrangler worker name ——
  不含品牌名；改 wrangler name 会更换部署 URL，禁止。
- `tests/proxy-settings-cache.test.ts:230/234` 的 `{"X-Track":"zenapi"}` —— 任意 fixture 值。
- 历史 webhook 消息、历史 usage 行中的旧名 —— 不做任何数据迁移。

## 徽章设计约定

- 形态：`ZenAPI` 主名 + 小号圆角 pill 徽章 `Next`，全站**同一套 class**、形态一致。
  （页面间允许尺寸微调：登录/公开页大标题处可稍大，侧栏小字号处收紧，但视觉语言统一。）
- 风格基调：项目现有 stone 色系 + Space Grotesk + amber focus 色；徽章建议
  `rounded-full`、amber 系描边/底色或 stone-100 底 stone-600 字、`text-[10px]`~`text-xs`、
  `font-semibold`，与主名留小 gap。具体由实现代理按各页面密度微调。
- **实现建议**：抽一个共享小组件（如 `features/` 下 `BrandMark.tsx` 或就近合适位置）
  供 10+ 处显示位复用，避免 class 复制漂移；组件放哪由实现代理依现有 features
  结构与 directory-structure spec 决定。
- 主名本身字样不变（`ZenAPI`），徽章承担 `Next` 语义——a11y 上整块作为品牌名可读
  （如需要，外层容器加 `aria-label="ZenAPI Next"`，遵循 component-guidelines 的 a11y 约定）。

## 非目标

- 不改包名 / worker 部署名（部署 URL 稳定）。
- 不迁移任何历史数据（webhook 历史消息、旧备份文件名等保持原样）。
- 旧备份 JSON 导入兼容是既有行为（导入不校验文件名），本任务回归确认即可，不改导入逻辑。

## 验收标准（Acceptance Criteria）

- [ ] 全仓 `rg -i "zenapi"`（排除 node_modules/dist/lockfile/.trellis）命中仅剩：
  明确不动清单 + `.trellis` 工件；代码注释两处若保留需在 PR 汇报中说明取舍。
- [ ] UI 各品牌位为主名 + Next pill 徽章，全站形态一致；`index.html` title 为 `ZenAPI Next`。
- [ ] 备份文件名、webhook/报警/日报标题、充值商品名均为 `ZenAPI Next` / `zenapi-next-backup-*`。
- [ ] 测试断言同步后 `bun run check && bun run typecheck && bun run test` 全绿。
- [ ] UI 新增代码遵循 component-guidelines（a11y、语义化按钮、色系）。

## 实现锚点（Notes）

- 上述清单即锚点；行号基于 2026-10-30 工作区，以内容匹配为准。
- UI 组件规范见 `.trellis/spec/api-worker-ui/frontend/component-guidelines.md`；
  目录结构约定见同目录 `directory-structure.md`。
