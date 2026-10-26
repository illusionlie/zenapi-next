# 配置一键备份导出/导入

## Goal

ZenAPI 无任何用户可操作的自助备份（D1 export 是命令行玩家的事）。管理台增加配置级
一键导出 / 导入 JSON，覆盖迁移与容灾场景。

复杂任务：`task.py start` 前需补 `design.md` + `implement.md`。

## Requirements

- **R1 导出**：`GET /api/backup/export`（adminAuth）→ JSON 文件下载
  `{version, exportedAt, channels, model_aliases, channel_model_aliases, settings}`：
  - channels 含全部配置列（**api_key 明文**、伪装、端点覆盖、api_formats 等）；
  - settings 排除敏感与会话类键（admin 密码哈希、会话类、Turnstile secret 等，
    design 定排除清单，原则：只导「重建配置所需」，不导「凭据与运行态」）；
  - 响应头 `no-store` + attachment 文件名 `zenapi-backup-YYYY-MM-DD.json`。
- **R2 导入**：`POST /api/backup/import`：
  - 校验：版本号、结构、逐渠道字段合法性（对齐渠道 CRUD 的校验规则——
    `api_formats` / `endpoint_overrides` 等非法 → 400 带定位信息）；
  - 策略 = **全量替换式**（先清后写，单 batch 事务，含别名 / 设置）；失败整体回滚；
  - 导入后主动失效热路径缓存（渠道 / 别名 / settings 缓存，若有失效接口则调用，
    无则文档注明 TTL 窗口内陈旧，design 定稿）；
  - 请求体上限防护（如 2MB，超限 413）。
- **R3 UI（管理台）**：系统设置或独立工具区——导出按钮（**明文密钥警示文案**）、
  导入（文件选择 + 粘贴两种方式 + 双重确认「完全覆盖不可逆」+ 导入结果摘要
  （各表条数））。
- **R4 数据边界**：users / tokens / usage_logs / 充值订单 / 邀请码**不进备份**
  （计费数据，防误恢复覆盖）；导入只动配置域表。
- **R5 测试**：导出 → 清配置 → 导入 round-trip 后渠道 / 别名 / 设置等价恢复且代理
  立即可用（含 api_formats / endpoint_overrides / 伪装字段无损）；非法 JSON 400；
  版本不匹配拒绝；敏感 settings 键不出现在导出中。

## Acceptance Criteria

- [ ] round-trip 后 `/v1/models` 与代理请求行为与备份前等价（多格式渠道字段无损）。
- [ ] 导出文件不含 settings 排除清单内的键；渠道 key 为明文（有警示）。
- [ ] 导入非法载荷 → 400 且原配置不动（事务回滚）。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不做统计数据备份 / 定时自动备份 / 云端推送。
- 不做备份文件加密（警示文案承担告知义务）。
- 不做增量 / 合并导入（只做全量替换）。
