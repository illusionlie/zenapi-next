# 执行计划 — P1 热路径缓存与写入异步化

前置：P0（10-19-p0-index-billing）已归档（写路径已 batch 化、热路径索引已就位）。按序执行，每步可独立提交回退。

## Checklist

1. [ ] **utils/cache.ts + 单测**
   - `createTtlCache`（惰性过期、可选 max 清空、clear）；TTL 常量导出。
   - `tests/cache.test.ts`：命中 / 过期（fake timers）/ clear / max 触顶。
2. [ ] **tokenAuth JOIN 合一**
   - 单 SQL 显式列清单 + `user_*` 别名（design.md 的 SQL）。
   - `tests/token-auth.test.ts`（新增）：无 user_id token / 正常绑定 / 悬空 user_id 三态断言，与改造前行为逐字段等价。
3. [ ] **settings 缓存包装**
   - services/settings.ts 增 `loadProxySettingsCached`（4 键 IN 查询 + 30s TTL）。
   - 单测：缓存命中不再打 DB（mock 计数）、过期重读、回退链语义不变（既有 settings 测试零改动通过）。
4. [ ] **读并行合一**
   - proxy.ts 与 anthropic-proxy.ts：鉴权后 5 读（别名×2、channels、settings）并入单个 Promise.all；channels/alias 接入 10s TTL 缓存。
   - 两路径逐点对照改造（审查门）。
5. [ ] **写入异步化**
   - 抽 `runPostResponse` 助手；非流式 `await record` 与错误路径 INSERT 切换；playground 不动。
   - 单测：executionCtx 存在 → waitUntil 被调用；缺失 → 降级 fire-and-forget 且 catch 记录。
6. [ ] **文档（Phase 3.3 一并）**
   - AGENTS.md §8：缓存陈旧窗口注记（渠道/别名 ≤10s、settings ≤30s）、热路径读形态。
   - spec settings-config / proxy-headers / channel-routing 增补缓存注记（trellis-update-spec）。

## 验证命令

```bash
bun run check && bun run typecheck && bun run test
```

本地行为验证：`bun run dev:worker` 后改渠道/代理设置，确认 ≤10s / ≤30s 内代理路径生效。

## 审查门

- 步骤 2 后：JOIN 三态与改造前行为逐字段等价。
- 步骤 4 后：proxy.ts 与 anthropic-proxy.ts 改造逐点对称；`SELECT *` 收窄（若做）未改变下游字段可用性。
- 步骤 5 后：响应返回路径上无任何 `await record` 残留（grep 核对）。

## 回滚点

- 缓存为纯增量模块：revert 单 commit 即全冷回退到直查 D1。
- JOIN 与 waitUntil 化各自独立 commit，可单独回退。
