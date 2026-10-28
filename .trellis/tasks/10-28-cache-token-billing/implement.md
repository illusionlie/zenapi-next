# 执行计划：缓存 token 折价计费

## 有序清单

1. [x] `services/channel-models.ts`：`ModelPricing` / `ModelLike` 增 `cache_read_price?` / `cache_write_price?`；
       `extractModelPricings` 按 `Number(x) > 0` 解析；`modelsToJson` 按 `!= null` 序列化。
2. [x] `services/pricing.ts`：`ModelPriceInfo` 增可选 cache 字段；`getModelPrice` 透传（null 判定维持
       input/output 双 null 语义）；`calculateCost` 新签名 + cacheRead/cacheWrite 双零短路守卫；
       非缓存输入 `max(0, prompt − read − write)`。
3. [x] `services/settings.ts`：`PROXY_SETTING_KEYS` 增 `cache_read_ratio` / `cache_write_ratio`；
       新增 `loadCacheRatioConfigDirect`（GET 表单真相）与 `resolveCacheRatioConfig`
       （cached 原始读 → clamp [0,100]，脏值降 1）。
4. [x] `routes/settings.ts`：GET 直读两键；PUT 严格校验（非负有限数字，非法 400
       `invalid_cache_read_ratio` / `invalid_cache_write_ratio`）。
5. [x] `routes/models.ts` PUT prices：cache 字段三态（`undefined` 保留 / `null` 清除 / 数字设置）。
6. [x] `routes/public.ts`：公开定价渠道行带 `cache_read_price` / `cache_write_price`（null 缺省）。
7. [x] `routes/proxy.ts:1247` 与 `routes/anthropic-proxy.ts:889`：`calculateCost` 调用传
       `normalized.cachedInputTokens` / `cacheCreationTokens` + `resolveCacheRatioConfig(...)`
       （热路径取 `loadProxySettingsCached`，与既有消费方同源）。
8. [x] UI：`SettingsView.tsx` 系统设置两数字字段（默认 1，step 0.01）；
       `ModelsView.tsx` 定价编辑每模型两可选输入（空 = 跟随全局）；
       `core/types.ts` / `UserModelsView.tsx` / 展示价处同步。
9. [x] 测试：新增 `tests/cache-token-billing.test.ts`——
       ① 公式矩阵（仅读 / 仅写 / 读写混合 / NULL 字段 / 无模型配置 / ratio 覆盖 / 每模型绝对价覆盖）；
       ② 零回归对照（cache 双零 + ratio 默认时与旧公式逐值相等，含 totalTokens 回退路径）；
       ③ settings clamp 与 PUT 校验；④ PUT 三态；⑤ 含 cache 字段 models_json 的备份 round-trip。
10. [x] AGENTS.md §8 计费段补口径锚点、§10 settings 键说明补两键；
       spec `usage-accounting.md` / `settings-config.md` 若有既定模式变化则同步（Phase 3.3 判断）。

## 验证命令

```bash
bun run check && bun run typecheck && bun run test
```

## 风险文件与回滚点

- 高风险：`services/pricing.ts`（两个调用方共用，签名变更必须同步两处编译通过）；
  `services/settings.ts`（PROXY_SETTING_KEYS 是多键共享单查询，增键不得破坏既有键读取）。
- 每步独立可编译；步骤 1–6 完成前公式行为不变（新字段无人消费），步骤 7 是唯一行为切换点。
- 回滚：revert 全部提交即可（无迁移、无不可逆数据）。

## start 前检查

- [x] prd.md 收敛（R1 决策已锁定，无开放问题）
- [x] design.md / implement.md 就绪
- [ ] 用户批准最终规划摘要
