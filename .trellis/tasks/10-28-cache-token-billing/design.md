# 技术设计：缓存 token 折价计费

## 架构与边界

纯计价口径改造，不动表结构、不动鉴权、不动路由。改动面四层：

1. **定价解析**（`services/channel-models.ts`）：`ModelPricing` / `ModelLike` 增可选字段
   `cache_read_price` / `cache_write_price`（USD/1M）。
2. **计价纯函数**（`services/pricing.ts`）：`calculateCost` 新签名接收缓存 token 数与全局倍率；
   `getModelPrice` 透传 cache 字段。
3. **配置读取**（`services/settings.ts` + `routes/settings.ts`）：两个全局倍率键进
   `PROXY_SETTING_KEYS`（随 `loadProxySettingsCached` 单查询 30s TTL），
   GET 直读 / PUT 严格校验，照 `probe_interval_minutes` / `token_rpm_default` 既有两级链模式。
4. **调用点接线**（`routes/proxy.ts`、`routes/anthropic-proxy.ts`）+ **UI**
   （`SettingsView.tsx` 系统设置两字段、`ModelsView.tsx` 定价编辑两可选字段、`core/types.ts` 同步）。

生产调用方恰好两处：`proxy.ts:1247` 与 `anthropic-proxy.ts:889`（grep 已核实），
均在 post-response `record()` 闭包内，`normalized.cachedInputTokens` / `cacheCreationTokens` 已在手。

## 契约

### 配置形状

| 层 | 键/字段 | 语义 | 默认 |
|----|---------|------|------|
| settings | `cache_read_ratio` | 缓存读价 = `input_price × ratio` | `1`（全价 = 现行为） |
| settings | `cache_write_ratio` | 缓存写价 = `input_price × ratio` | `1` |
| models_json | `cache_read_price` | 每模型绝对价覆盖，`> 0` 数字（延续既有 `Number(ip) > 0` 约定） | 缺省 → 走全局倍率 |
| models_json | `cache_write_price` | 同上 | 缺省 → 走全局倍率 |

- 倍率 clamp `[0, 100]`（写倍率 1.25 合法；0 = 缓存免费是合法语义），脏值降 1（非 0 回退）。
- PUT 校验：非负有限数字，非法 400 `invalid_cache_read_ratio` / `invalid_cache_write_ratio`。
- 「缓存免费」的每模型表达：全局 ratio=0；每模型 0 价不收（延续 `> 0` 约定，如实文档化）。
- PUT `/api/models/prices/:modelId` 对 cache 字段三态：`undefined` 保留 / `null` 清除（回落全局）/ 数字设置——清除态是对现状的补充（现实现无清除路径，input/output 不动）。

### 计价公式（`calculateCost` 新签名）

```
calculateCost(price, prompt, completion, total?, cachedInput?, cacheCreation?, ratios?)
```

- `cacheRead = cachedInput ?? 0`；`cacheWrite = cacheCreation ?? 0`。
- **短路守卫**：`cacheRead === 0 && cacheWrite === 0` → 走现公式原路径逐字节返回（防浮点结合序差异破坏零回归对照测试）。
- 通用路径：`nonCached = max(0, prompt − cacheRead − cacheWrite)`（仓库既有口径：cached ⊆ prompt，Anthropic 形态 prompt 已折算 input+cache_read+cache_creation，OpenAI 形态 cached 是子集、cache_creation 为 NULL——负数钳制兜底异常上游）；
  `readPrice = price.cache_read_price ?? input_price × ratioRead`；`writePrice = price.cache_write_price ?? input_price × ratioWrite`；
  `cost = nonCached/1M × input_price + cacheRead/1M × readPrice + cacheWrite/1M × writePrice + completion/1M × output_price`。
- `totalTokens`-only 回退（均值价）不变，缓存不拆分（与现状一致）。
- `getModelPrice` 返回 null（无定价）→ cost = 0 不变；cache 字段单独存在而 input/output 皆缺，仍视为无定价（维持现判定 `input/output` 双 null → null），cache 字段不参与「是否定价」判定。
- 倍率读取走 `loadProxySettingsCached` → 计费口径变更生效窗口 ≤30s（与重试/限流配置同语义，AGENTS.md 如实标注）。

### 公开面

- `GET /api/public/models` 渠道行增 `cache_read_price` / `cache_write_price`（未配置为 null）；
  ModelsView / UserModelsView 展示价时带出（有值才显示）。

## 兼容与迁移

- **零迁移**：settings 是 KV 表运行时键；`models_json` 是 JSON 列，`modelsToJson` 对 `!= null` 字段才序列化，旧行为无新字段 = 天然回落倍率路径。
- **零回归保障**：倍率默认 1 + 短路守卫双保险；存量部署不配置任何新键、不改 models_json 时 cost 输出与改造前一致（对照测试锁定）。
- **备份**：export/import 对 `models_json` 原样字符串 round-trip，新字段自动保真（测试补一行含 cache 字段的断言即可）。

## 权衡

- 每模型 0 价不被解析是既有约定，本任务不顺手放宽（改解析口径会波及 input/output 语义，收益仅「每模型缓存免费」这一角落场景）。
- 倍率进 `PROXY_SETTING_KEYS` 而非直读：计费在 post-response 路径，30s 陈旧可接受；换来热路径零新增查询。
- `calculateCost` 目前**零单测**（grep 核实）——本次公式复杂化，新测试文件必须覆盖完整矩阵，而非只测增量。

## 回滚

纯代码 revert 即恢复；settings 残留两键无人读取，无害。无数据迁移、无不可逆写入。
