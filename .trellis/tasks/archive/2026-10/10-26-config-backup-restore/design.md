# Design：配置一键备份导出/导入

> 需求 prd.md（R1-R5）。锚点已亲核：渠道写入 `services/channel-repo.ts`
> （insertChannel :191 / updateChannel / deleteChannel）、渠道校验在
> `routes/channels.ts`（invalid_api_formats / invalid_endpoint_overrides 等）、
> 别名写入 `services/model-aliases.ts`（saveAliasesForModel / saveChannelAliases）、
> settings GET/PUT 在 `routes/settings.ts:67/:131`、渠道/别名/settings 缓存均为
> **无主动失效的 TTL**（10s/30s 文档化陈旧边界）。

## 1. 导出（GET /api/backup/export，adminAuth）

- 新路由文件 `routes/backup.ts`，`index.ts` 挂 `/api/backup`（**不**进 adminAuth 放行
  清单 = 默认受 adminAuth 保护；核对 index.ts 放行清单不误加）。
- 载荷：
  ```json
  { "version": 1, "exportedAt": "<ISO>", 
    "channels": [/* 全配置列，含明文 api_key */],
    "model_aliases": { "<primary>": ["alias", ...] },
    "channel_model_aliases": [/* 渠道别名行 */],
    "settings": { "<key>": "<value>" } }
  ```
- channels 列集 = `channel-repo.listChannels()` 原样行（JSON 列保持字符串形态，
  导入侧再 parse 校验——round-trip 字节保真优先）。
- **settings 导出集合**：以 `routes/settings.ts` GET 返回的键为白名单基础
  （管理台可见即可导），**显式排除**：管理员密码哈希键、Turnstile secret 键、
  LinuxDO OAuth secret 键（实现时先读 settings.ts GET/PUT 全文列出实际键名，
  排除清单写入代码常量并注释）。会话类不存 settings 表（各有独立表），无需处理。
- 响应：`Content-Disposition: attachment; filename="zenapi-backup-YYYY-MM-DD.json"`、
  `Cache-Control: no-store`。

## 2. 导入（POST /api/backup/import，adminAuth）

- 请求体大小防护：Hono `c.req.text()` 前判 `content-length` > 2MB → 413
  `payload_too_large`；解析失败 → 400 `invalid_backup_payload`；`version !== 1`
  → 400 `unsupported_backup_version`。
- **逐渠道校验复用**：导入的每条渠道过与 `routes/channels.ts` POST 相同的规则集
  （api_formats / endpoint_overrides / base_url / custom 约束等）。校验逻辑若深内联
  在路由层，做**最小抽取**为可复用函数（新导入路径与既有 POST 共用同一函数），抽取
  不得改变 POST 行为（既有测试为锚）。任一渠道非法 → 400 带定位
  （`channels[3].name` 形态 message + 对应错误码），**不写任何行**。
- **写入 = 先清后写，单次 `db.batch`**（D1 batch = 单事务，失败整体回滚）：
  1. DELETE：channels 全表、model_aliases 全表、channel_model_aliases 全表、
     settings 中「本次导入载荷包含的键」（不是全表——载荷没有的键保留现值，
     便于增量演进的备份文件仍可导入）；
  2. INSERT：channels（**保留原 id**——token.allowed_channels / usage_logs.channel_id
     等引用不断链）、别名、settings。
  - D1 batch 语句数上限（1000/调用）在渠道数量级（数十）下无虞，不做分批。
- **导入范围铁律**（PRD R4）：users / tokens / usage_logs / usage_stats_daily /
  recharge_orders / invite_codes / 邀请码 / 各会话表**一律不触碰**。
- 缓存陈旧：导入后渠道/别名 ≤10s、settings ≤30s TTL 自然过期（与既有 CRUD 一致，
  不加失效调用——缓存本无失效接口，为此新建失效机制超出本任务最小面）。
  响应体带 `cache_staleness: {"channels_seconds": 10, "settings_seconds": 30}` 提示。

## 3. UI（SettingsView「备份与恢复」区块）

- 导出按钮 + **明文密钥警示文案**（导出含全部渠道 API Key 明文，妥善保管）。
- 导入：文件选择 + 文本粘贴两种入口 → 解析预览（渠道 N / 别名 M / 设置 K 条）→
  **双重 confirm**（「将完全覆盖现有配置，不可逆」）→ 提交 → 结果 toast
  （成功条数 / 错误定位）。样式照该文件既有区块。

## 4. 测试地图

- `tests/backup-restore.test.ts`（新）：
  - 导出形状：含渠道明文 key、settings 排除清单键不出现、文件头字段；
  - round-trip：建渠道（多格式 + endpoint_overrides + 伪装 + 别名）→ 导出 → 清库
    → 导入 → 渠道/别名/设置逐字段等价、代理可用（复用既有测试的 fake db 模式）；
  - 校验失败：单条渠道 api_formats 非法 → 400 + 定位信息 + 库零写入（batch 未执行
    断言）；version 不符 400；超限 413；
  - settings 选择性替换：载荷无的键保留现值。
- 既有渠道 CRUD 测试零回归（校验抽取锚）。

## 5. 范围外

统计/日志数据备份、定时自动备份、加密、增量合并导入、跨版本迁移（version 只收 1）。
