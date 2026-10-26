# Implement：配置一键备份导出/导入

> 顺序执行；设计依据 design.md。先读 routes/settings.ts GET/PUT 全文列出实际
> settings 键名再定排除清单（design §1）。

## Step 1：导出端点 + 测试

- [ ] `routes/backup.ts` 新建：GET `/export`（design §1 载荷/排除常量/响应头）；
      `index.ts` 挂载 `/api/backup`（核对不放行清单）
- [ ] 测试：导出形状 + 排除清单
- 验证：`bunx vitest run tests/backup-restore.test.ts`；`bun run typecheck`

## Step 2：导入端点

- [ ] POST `/import`：大小/解析/版本防护 → 逐渠道校验（**最小抽取** channels.ts
      POST 校验为共用函数，POST 行为零变化）→ 单 db.batch 先清后写（design §2）
- 验证：`bun run typecheck`

## Step 3：导入测试

- [ ] round-trip / 校验失败零写入 / version 400 / 413 / settings 选择性替换
      （design §4 清单）
- 验证：`bunx vitest run tests/backup-restore.test.ts`；全量 `bunx vitest run`
      （渠道 CRUD 回归）

## Step 4：UI

- [ ] `SettingsView.tsx`「备份与恢复」区块（design §3：导出+警示 / 文件+粘贴导入 /
      预览+双重确认+结果）；`AdminApp.tsx` 接线（照既有 settings 表单模式）；
      `core/types.ts` 增类型
- 验证：`bun run typecheck`

## Step 5：门禁 + 文档

- [ ] `bun run check && bun run typecheck && bunx vitest run` 三绿
- [ ] AGENTS.md：§6 路由表加 `/api/backup` 行；§8 或新 bullet 简述备份契约
      （导出集合/排除清单/导入范围铁律/缓存陈旧窗口）
- 验证：`bun run check`

## 回滚点

Step 1-3 纯新增（routes/backup.ts + 抽取改动可整体 revert）；UI 独立。
