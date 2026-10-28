# 执行计划 — responses↔anthropic 经 chat 枢纽互转

> 前置：design.md 已定稿；本清单按序执行，每步可独立验证。

## 执行清单

1. **路由常量扩展**（`apps/worker/src/services/channel-routing.ts:27-38`）
   - responses 可服务集合增 `anthropic`，anthropic 增 `responses`；头注释矩阵两行同步重写。
   - 验证：`bun run test -- channel-routing`（既有 16 格应全绿——新格断言在第 5 步补）。
2. **组合函数**（`apps/worker/src/services/format-converter.ts` 底部）
   - 导出 4 个纯函数：`responsesToAnthropicRequest` / `anthropicToResponsesRequest` / `anthropicToResponsesResponse` / `responsesToAnthropicResponse`，JSDoc 标明两跳组成与有损声明（cache_creation 折总量、签名不回传）。
3. **proxy.ts responses 入站分支**（锚点：请求 :421、响应 :556-595）
   - 增 target=anthropic case：请求 / 非流式 / 流式（`pipeThrough` 双 transform 串联）。不触碰既有 openai/responses case。
4. **anthropic-proxy.ts responses 目标分支**（锚点：:239、:547-571）
   - 对称 case；流式 transform 参数镜像 :547 现有调用形态。
5. **路由矩阵测试**（`tests/channel-routing.test.ts`）
   - 新增 2 格断言（responses×anthropic → `"anthropic"`、anthropic×responses → `"responses"`）+ 混合池偏好序（单跳优先于 pivot，AC4）+ 14 格不变断言保持。
6. **pivot 集成测试**（新文件 `tests/proxy-pivot.test.ts`，风格照 `proxy-responses.test.ts`：mock 上游 + `runStreamTransform` + `parseSseData`）
   - 方向 A（responses 入站 → anthropic-only 渠道）：非流式 / 流式 / usage 接缝 `parseUsageFromSse` prompt>0 / tool 往返 / anthropic 流内 error → `response.completed` 健康收尾锁定。
   - 方向 B（anthropic 入站 → responses-only 渠道）：对称 + responses 上游 error 终止形态锁定。
   - count_tokens 打 responses-only 候选 → 本地估算恒 200（AC6，若第 4 步实现中发现分支按入站集合而非目标格式判断，先修再测）。
7. **文档同步**（R5）
   - `AGENTS.md` §8 路由矩阵 bullet 两行重写（「responses↔anthropic 转换不存在」表述更新为 pivot 语义）。
   - `.trellis/spec/api-worker/backend/channel-routing.md` §3.1 表格与「不得另写特判」段更新。
   - `.trellis/spec/api-worker/backend/format-conversion.md` 增补 pivot 段（组合函数、接缝依赖、有损口径）。
8. **全量门禁**：`bun run check && bun run typecheck && bun run test`（AC7）。

## 验证命令

```bash
bun run test -- channel-routing proxy-pivot   # 定向
bun run check && bun run typecheck && bun run test   # 全量门禁（提交前必跑）
```

## 风险文件与回滚点

- **风险文件**：`proxy.ts` / `anthropic-proxy.ts`（请求热路径）——改动均为**新增分支**，不触碰既有分支路径；`channel-routing.ts` 为 proxy / anthropic-proxy / playground 三处共用判定，属常量级改动。
- **回滚点**：步骤 1 的常量 revert 即恢复旧行为（斜边回 503）；全量 revert 零配置态 / schema / 数据面残留（R6 无开关的直接收益）。
- **无迁移**：不涉及 migrations / schema.sql。

## task.py start 前检查

- [ ] prd.md 收敛 pass 完成（无未决 Open Questions）
- [ ] design.md / implement.md 就绪
- [ ] implement.jsonl / check.jsonl 含真实条目（种子 `_example` 行已删）
- [ ] 用户对最终规划摘要明确批准
