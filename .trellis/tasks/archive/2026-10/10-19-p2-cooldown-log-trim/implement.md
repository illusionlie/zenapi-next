# 执行计划 — P2 渠道冷却与请求日志减负

前置：P2a 已提交（工作树应只有簿记改动）。按序执行。
**沙箱禁令：禁止长驻进程（dev server / watch / `bun run test`），验证一律 `bunx vitest run`。**

## Checklist

1. [ ] **services/channel-cooldown.ts**：design 的六个导出（常量 + 状态机 + fail-open 过滤 + 测试重置）；`tests/channel-cooldown.test.ts`（注入 now，不依赖真实时钟）。
2. [ ] **双代理接线**：proxy.ts / anthropic-proxy.ts 同构——成功/失败标记（判定语义按 design：渠道放弃记 1 次、任何响应记成功）+ 候选装配处 fail-open 过滤；playground 不动。两文件逐点对照。
3. [ ] **日志开关**：services/settings.ts 增 `debug_request_body_log` 读取（三级回退 + 30s TTL 缓存 `loadDebugLogFlag`）+ routes/settings.ts 已知键清单（GET/PUT，严格布尔校验）；index.ts 中间件两态改造（默认不 clone 不解析）。
4. [ ] **测试**：cooldown 状态机 / settings 键 CRUD / 中间件两态 / 装配点过滤（可行则做，成本过高降级为单测 + 审查并报告）。
5. [ ] **文档（Phase 3.3 一并，本次不做）**：AGENTS §8 冷却边界与日志开关注记、settings-config 增键、logging-guidelines 中间件两态。

## 验证命令

```bash
bun run check && bun run typecheck && bunx vitest run
```

本地行为验证（deferred to user，步骤写入 verification.md）：持续 5xx 的渠道观察候选池变化；`PUT /api/settings` 置 debug_request_body_log=true 后观察 [request] 日志恢复 body_keys。

## 审查门

- 步骤 1 后自查：fail-open（全冷 → 返回全量）有测试锚定。
- 步骤 2 后自查：两代理路径对称；「每渠道每请求至多记 1 次失败」的调用点正确（渠道放弃点，非每个响应）。
- 步骤 3 后自查：默认路径 `raw.clone()` 零调用（grep/mock 断言）；既有 settings 测试零改动通过。

## 回滚点

- 冷却器纯增量模块，revert 即消失；日志开关默认值即回滚开关（置 true 恢复现状行为）。
- 无迁移。
