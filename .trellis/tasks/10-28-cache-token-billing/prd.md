# 缓存 token 折价计费

## Goal

现计费公式把含缓存的 prompt 全量按 input_price 计价：`calculateCost = prompt/1M × input_price + completion/1M × output_price`（`services/pricing.ts`），而 `prompt_tokens` 全路径口径为**含缓存总输入**（AGENTS.md §8）。上游官方语义对缓存 token 收折价（Anthropic 缓存读 0.1×、缓存写 1.25×；OpenAI cached 约 0.5×），我们对用户收全价——缓存重度场景（Claude Code）用户被多收，运营侧账目与上游成本也对不上。

数据侧已具备：`usage_logs.cached_input_tokens` / `cache_creation_tokens` 已采集（NULL = 上游未报告），缺的只是计价口径。复杂任务：`task.py start` 前需补 `design.md` + `implement.md`。

## Requirements

- **R1 计价公式**：cost 拆分为
  `非缓存输入 × input_price + 缓存读 × 缓存读价 + 缓存写 × 缓存写价 + 输出 × output_price`（USD/1M 口径，与现公式同尺度）。
  配置形状**已拍板（2026-10-28）**：settings 全局倍率两键（`cache_read_ratio` / `cache_write_ratio`，默认 1.0 = 现行为零回归）+ `models_json` 每模型可选绝对价字段（`cache_read_price` / `cache_write_price`）覆盖，每模型未配置时回落全局倍率。
- **R2 向后兼容**：
  - usage 行缓存字段 NULL（上游未报告）→ 缓存部分按现行为并入 input 全价，不猜测不折算；
  - 模型无缓存定价配置 → 缓存 token 按 input_price 全价（= 现行为，零回归路径）。
- **R3 非缓存输入推导**：`prompt_tokens − cached_input_tokens − cache_creation_tokens`，下限 0；须与既有「prompt 含缓存总输入、不二次叠加」口径逐路径核对（纯 Anthropic 形态折算链），防 cache_read 与 cache_creation 并存时重复扣减或漏扣。
- **R4 覆盖面**：proxy / anthropic-proxy 两个计费调用点同公式；playground 不计费不变；passthrough 路径经同一 record 链自然继承。
- **R5 定价配置同步**：管理端定价编辑（`PUT /api/models/prices/:modelId`）与模型广场/公开定价展示对新配置形状的支持；备份导出/导入 round-trip 兼容（旧备份文件无新字段可导入，新备份可无损恢复）。
- **R6 测试**：公式单测矩阵（仅缓存读 / 仅缓存写 / 混合 / NULL / 无配置）；无缓存数据时与改造前 cost 完全一致的对照测试；流式 SSE usage 逐字段合并后缓存字段不丢（既有行为回归锁定）。

## Acceptance Criteria

- [ ] Anthropic 形态行（如 prompt=1200 / cache_read=1000 / cache_creation=200 / output=500）按折价公式计价，各分量单测锁定。
- [ ] 缓存字段 NULL 或模型无缓存定价配置 → cost 与改造前公式完全一致（对照测试零回归）。
- [ ] 缓存定价可配置（形状按 design 拍板），UI 编辑与展示同步；旧备份文件导入成功、新备份 round-trip 保真。
- [ ] `bun run check && bun run typecheck && bun run test` 全绿。

## 非目标

- 不改 `usage_logs` 表结构（缓存列已存在，无迁移）。
- 不做阶梯价、表达式计价引擎（NewAPI billingexpr 那套，过重）。
- 不做用户分组倍率（运营分层已拍板不做）。
- 不改 rollup（不含价格维度，raw 已有缓存列）。
