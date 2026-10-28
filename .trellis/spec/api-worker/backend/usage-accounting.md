# Usage Accounting（utils/usage.ts + services/usage.ts + 聚合端点）

> 2026-10-18 由缓存命中率任务沉淀。usage 解析→落库→聚合的完整口径契约；协议转换层的产物契约见 [format-conversion](./format-conversion.md)。

## 1. Scope / Trigger

- 触发场景：改动 `NormalizedUsage` 结构、usage 解析优先级、`usage_logs` 列、dashboard/user-api 聚合口径。
- 本任务是 DB schema 变更 + 跨层契约变更，code-spec 深度强制。

## 2. Signatures

```ts
// utils/usage.ts
type NormalizedUsage = {
	totalTokens: number;
	promptTokens: number;
	completionTokens: number;
	cachedInputTokens: number | null; // null = 上游未报告，不得用 0 表示无数据
	cacheCreationTokens: number | null;
};

// services/usage.ts — usage_logs 两列：cached_input_tokens / cache_creation_tokens INTEGER 可空
// 迁移 0024_usage_cache_tokens.sql；0030 起增 key_tag TEXT 可空（key 级末次归因 8 hex 指纹，
// UsageInput.keyTag 透传，NULL = 旧行/无归因路径）
// recordUsage INSERT 20 列，NULL 直通
// 计费三写（INSERT + quota + balance）经单次 db.batch 原子执行，余额钳制不为负 → 见 §8
```

## 3. Contracts

### 3.1 缓存命中提取优先级（互斥生效，首个有限数字命中即停）

`prompt_tokens_details.cached_tokens`（OpenAI chat）→ `input_tokens_details.cached_tokens`（Responses）→ `prompt_cache_hit_tokens`（DeepSeek 系）→ `cache_read_input_tokens`（Anthropic）。

缓存写入仅 Anthropic 语义：`cache_creation_input_tokens`（不进命中率分子）。

### 3.2 prompt 折算条件（精确，防二次叠加）

仅当 `promptTokens` 取自 `input_tokens`/`inputTokens` 别名（即 `prompt_tokens`/`promptTokens` 均缺失）**且** cache_read/creation 至少一个非 null，才折算 `promptTokens = input + cacheRead + cacheCreation`。转换产物（`format-converter` 折算后的 OpenAI 形态）带 `prompt_tokens`，永不二次折算。

### 3.3 流式合并（raw 层，非候选层）

`parseUsageFromSse` 累积 raw usage 对象逐字段合并（非 null 覆盖、null/缺失保留，提取链含 `message.usage` 兜底），流结束一次性 `normalizeUsage`。**禁止**在 `NormalizedUsage` 候选层合并：该类型把缺失 prompt/total 压成 0，后到 chunk（如 Anthropic `message_delta` 仅 output）会把 `message_start` 的 input/cache 覆盖成 0。

### 3.4 聚合分母（NULL ≠ 0）

```
cache_rate = SUM(cached_input_tokens) / SUM(CASE WHEN cached_input_tokens IS NOT NULL THEN prompt_tokens ELSE 0 END)
```

base ≤ 0 → `null`（`computeCacheRate`，dashboard.ts 与 user-api.ts 共用同语义实现）。无数据行不进分母；响应字段 `cached_tokens` / `cache_creation_tokens` / `cache_rate`（snake_case 直通到 `core/types.ts`）。

## 4. Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| usage 对象缺失 / 全字段 null | `normalizeUsage` 返回 null，记录走零值兜底对象（两新列为 null） |
| 缓存字段存在但非有限数字 | 视为缺失，继续优先级链下一级 |
| 上游无任何缓存字段 | 两列 NULL，聚合分母排除该行，`cache_rate: null` |
| 响应头路径（`parseUsageFromHeaders`） | 两列恒 NULL（头协议无缓存字段） |

## 5. Good/Base/Bad Cases

- Good：Anthropic `input=100, cache_read=50, cache_creation=10` → `prompt_tokens=160, cached=50, creation=10`（JSON 与流式两路径同值）。
- Base：无缓存字段请求 → 既有三值不变、两新列 NULL、`cache_rate` 不受影响（零回归红线）。
- Bad：DeepSeek 形态带 `prompt_cache_hit_tokens` 却折算 prompt（`prompt_tokens` 别名在 → 不折算）；混合形态（prompt_tokens + details + anthropic cache 同在）二次叠加；NULL 记成 0 拉低均值。

## 6. Tests Required

`tests/usage-cache.test.ts`：优先级链逐级、折算/防叠加、SSE 合并（null 不清位、仅 output chunk 保 input/cache、全量终端 chunk 与 last-wins 等价）、recordUsage 列绑定（D1 mock 仿 turnstile 测试）、dashboard 路由 `cache_rate` null/有值两分支。断言锚点：Anthropic 折算 160/50/10 精确值。

## 7. Wrong vs Correct

### Wrong（修复前的两个真实偏差）

```ts
// ① last-wins：message_delta 仅 output，覆盖丢掉 message_start 的 input/cache
usage = candidate; // 每次整体替换
// ② anthropic 原生路径直接 normalizeUsage(usage)
//    input_tokens 不含 cache → prompt_tokens 记账偏小
```

### Correct

```ts
// raw 层逐字段合并后一次性 normalize
mergeRawUsage(acc, extractRawUsage(parsed)); // 非 null 覆盖
// normalizeUsage 内按 §3.2 条件折算 prompt，cache_read/creation 落库为独立列
```

## 8. 计费原子化契约（2026-10-19 P0 增补；2026-10-21 评审修复：单次重试 + 可对账日志）

### 8.1 Scope / Trigger

- 触发：改动 `recordUsage` 写入形态、计费语句组装、余额扣减语义。DB 写路径 + 跨层契约变更。

### 8.2 Signatures

```ts
// services/usage.ts
type UsageInput = {
	// ...既有 19 列字段不变（0030 起另有 keyTag?: string | null，key 级末次归因）
	cost?: number | null;      // 与 INSERT 的 cost 列同值，复用不另设
	userId?: string | null;    // 计费主体（users.id 为 TEXT 列）
};
// recordUsage 组装 [INSERT usage（恒有）+ UPDATE tokens.quota_used（tokenId && totalTokens）
//                + UPDATE users.balance（userId && cost > 0）] → 单次 env.DB.batch(statements)
```

### 8.3 Contracts

- **batch = 单事务**（D1 batch 语义）：三写同生共死，不存在「记了日志没扣费」中间态。
- 余额 SQL 固定为 `UPDATE users SET balance = MAX(0, balance - ?), updated_at = ? WHERE id = ?`：**钳制不为负**（2026-10-19 用户决策）；`usage_logs.cost` 记真实成本，差额 = cost − Δbalance 仅发生在余额不足边缘场景，可对账审计；正常路径最终态与旧三写形态完全一致。
- quota 条件照旧（`tokenId && totalTokens`，无条件累加）；并发上浮有界 = 在途数 × 单次增量，AGENTS §8 文档化，不做条件更新。
- 失败：**先 250ms 单次重试**（`opts.retryDelayMs` 可注入、测试传 0）——重放同一 statements 数组（引用复用，不重建），batch 失败已整体回滚故无半态风险；两次都败才 `console.error`，**不 rethrow**——计费收尾失败不影响已成功的上游响应（logging-guidelines 已批准例外）。
- 失败日志载荷（可对账）：`{ tokenId, userId, cost, model, channelId, requestPath, promptTokens, completionTokens, totalTokens, status, attempts: 2, error }`——Logpush 侧按 `payload.status ?? "ok"`、tokens `?? 0` 三态还原 INSERT 行为；tag 字面 `[usage] billing batch failed` 是告警签名锚点，不得改动。
- 调用方（`routes/proxy.ts` / `routes/anthropic-proxy.ts`）只算 cost 并传 `userId`，**禁止**在路由层自行扣余额；错误路径零值 INSERT 不带 userId/cost（即单语句 batch 形态）。

### 8.4 Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| 无 tokenId / totalTokens = 0 | 无 quota 语句，其余照常 |
| cost = 0 或无 userId | 无 balance 语句 |
| batch 任一语句失败 | 首败 250ms 后重放一次；再败 → 整批回滚 + `[usage]` console.error（全字段载荷 + attempts:2），调用方 promise 正常 resolve |
| balance < cost | 扣至 0，`usage_logs.cost` 记真实值 |

### 8.5 Good/Base/Bad Cases

- Good：正常计费请求 → 三语句一批落库；余额充足时最终态与旧三写独立形态逐字段一致。
- Base：错误路径零值记录 → 单语句 batch（无 quota/balance 语句），INSERT 失败仅日志不抛。
- Bad：路由层恢复独立 `UPDATE users SET balance = balance - ?`（无钳制、脱离事务）；把 `[usage]` 失败改成 rethrow（已成功的上游响应会变 5xx）；钳制差额改写 usage_logs.cost（破坏真实成本口径）。

### 8.6 Tests Required

`tests/usage-billing.test.ts`：三语句形态与逐位绑定（含 `MAX(0, balance - ?)` SQL 文本 toBe 断言）、条件省略三分支、batch reject → console.error 载荷断言 + `resolves.toBeUndefined()` + 成功路径静默。锚点：cost=0.5 且余额不足时 balance 绑定 `[0]`。2026-10-21 增：拒一次被吸收（batch 共 2 次、无失败日志、重放含完整三写）、拒两次载荷含 model/channel/tokens/status/attempts、成功路径恰一次 batch。

### 8.7 Wrong vs Correct

#### Wrong（修复前）

```ts
await db.prepare("INSERT INTO usage_logs ...").run();          // 三条独立语句
await db.prepare("UPDATE tokens SET quota_used = quota_used + ?").run();
await db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(); // 无守卫，并发可深度负数
```

#### Correct

```ts
await env.DB.batch([insertUsage, quotaStmt, balanceStmt]); // 单事务；balance 用 MAX(0, balance - ?)
// 失败：console.error("[usage] billing batch failed", ...) 不 rethrow
```

## 9. 预聚合与维护契约（2026-10-19 P2 增补；2026-10-21 评审修复：短窗口 raw-only / 配额保险丝 / 自愈补漏）

### 9.1 Scope / Trigger

- 触发：改动 `usage_stats_daily` 结构、rollup/清理任务、聚合端点的 rollup+raw 两段拼装。

### 9.2 Signatures

```ts
// services/usage-stats.ts
splitWindow(fromIso, toIso, now?): { rollupFrom: UtcDate | null; rollupTo: UtcDate; rawFrom: string | null; rawTo: string | null };
// 两段严格不相交：rollup 段 stat_date ≤ 昨日（UTC），raw 段 created_at ≥ 今日零点。
// span ≤ 1 天（秒粒度 floor 判定）→ raw-only 精确边界，不吃日粒度近似；
// 时间戳解析统一 parseUtcIsoMs：19 字符截断形态补 Z，禁止裸 Date.parse（无 Z 按本地时区）
rollupDate(db, date): Promise<void>;   // 同日先 DELETE 再 INSERT SELECT，幂等；防丢守卫见 9.3
rollupRecentMissing(db, now, lookbackDays = 7): Promise<UtcDate[]>;  // 自愈扫窗：逐日 SELECT 1 索引探测，缺才 rollupDate；单日写失败按日容错，probe 读失败冒泡
pruneUsageLogsBatched(db, beforeIso, opts?: { chunkSize?; maxRounds? }): Promise<{ deleted: number; complete: boolean }>;
// 默认 RETENTION_CHUNK_ROWS=5000 × RETENTION_MAX_ROUNDS=180；轮数到顶 complete=false（可重入续删）
retentionCutoffIso(now, retentionDays): string;  // UTC 毫秒统一 cutoff（cron 与手动端点共用，禁本地时区日历运算）
rollupMissingDates(db, now?): Promise<UtcDate[]>;  // MIN(created_at) 探底 + JS 枚举日期 + DISTINCT stat_date 差集；禁 substr(created_at) 全表扫
runDailyMaintenance(env): Promise<void>;  // cron 四步：自愈扫窗（含昨日，排除今日）→ retention（complete=false 时 console.warn）→ sessions → rollup 180d
```

### 9.3 Contracts

- **聚合口径承继**：rollup 表含 `cache_prompt_base` 列（§3.4 的 `SUM(CASE WHEN cached IS NOT NULL THEN prompt ELSE 0)` 逐日预算），两段合并后 `computeCacheRate` 口径与 raw 直查严格一致（NULL ≠ 0 不变）。
- **两段不相交**：读取端永远钳制 rollup 段 ≤ 昨日、raw 段 ≥ 今日零点——管理员手动 rollup 今日也不会导致重复计数。
- **短窗口 raw-only（2026-10-21）**：span ≤ 1 天（`to` 缺省时以 now 为终点，秒粒度 floor——`slice(0,19)` 截断 + now 带毫秒，毫秒直比漏判 1d 档）完全绕开 rollup 段，rawFrom/rawTo 用精确边界。防的缺陷：1d 档恒吃昨天整天（~2x 虚高）、15m/1h 档跨 UTC 午夜 24x–96x 放大、同响应 summary（split）与小时趋势（raw-only）自相矛盾。
- **`to` 边界整天近似（仅 >1 天窗口）**：`to` 落在往日时该日整天从 rollup 计入（误差 ≤ 1/窗口天数）。shipped UI 从不传 `to`，仅影响外部 API 客户端，AGENTS §8 已注记。
- **防丢守卫**：`rollupDate` 对「该日原始行已清且 rollup 行存在」直接 no-op——retention 清掉原始日志后，cron 重跑 / 显式单日回填都不得把幸存统计删空。
- **配额预算（2026-10-21）**：D1 每次调用 1000 条查询（Paid）/ 50（Free）上限覆盖 cron 整条链；最坏全链 ≈ 219 条（探测 7 + rollupDate 4×7 + settings 1 + DELETE ≤180 + sessions 2 + rollup 1）。改 chunk/轮数/扫窗天数前必须重算预算表。
- **cron 单步容错**：四步各自 try/catch `[rollup]`/`[retention]` console.error 继续；retention 读取走 `getRetentionDays` 三级回退（脏值回落默认 30，不会误清全表）；自愈扫窗内单日**写**失败按日容错、**probe 读**失败冒泡到步骤级（读故障继续扫只会烧查询）。
- **手动端点**：`POST /api/usage/prune` 响应 `{ deleted, complete }`，complete=false 表示保险丝到顶、重跑续删；`GET /api/usage` 内联 prune 与 cron 同一有界实现（Free 计划 50 条上限下仍可能超限，属文档化接受）。

### 9.4 Tests Required

`tests/usage-stats.test.ts`（node:sqlite 适配器）：rollup 幂等与防丢守卫（无原始行 + 有 rollup 行 → 重跑行存值不变；空集照常写）、日切边界、`rawSummaryTotals` legacy SQL 与两段并集逐项相等（80/110 cache 分母锚点）、prune 循环终止/可重入、runDailyMaintenance 单步失败不阻断。2026-10-21 增：短窗口 raw-only 单测族（1d/15m 跨午夜/历史子日/7d 回归/east+west 时区探针）与 split==raw-only 逐字段等价、保险丝（chunk=10/maxRounds=2/35 行 → {deleted:20, complete:false}）、自愈扫窗（缺 2 天恰补 2 天、在场日零写 marker 断言、单日失败容错）、retentionCutoffIso 固定字符串断言、rollupMissingDates 差集。部署后人工步骤：`POST /api/dashboard/rollup` 空体全量回填 → cron 接管；`wrangler dev --test-scheduled` 观察四步日志。

## 10. 延迟口径锚点契约（2026-10-23 增补）

### 10.1 Scope / Trigger

- 触发：改动 `parseUsageFromSse` 签名、TTFT / `latency_ms` 口径、`usage_logs` 延迟列语义。解析器签名 + 跨层（worker→UI/监测）数据语义变更，code-spec 深度强制。

### 10.2 Signatures

```ts
// utils/usage.ts
type StreamUsage = {
	usage: NormalizedUsage | null;
	firstTokenLatencyMs: number | null; // 锚点 → 首条 SSE data 行
	elapsedMs: number | null;           // 锚点 → 流尾；无响应体时为 null
};
parseUsageFromSse(response: Response, requestStartMs?: number): Promise<StreamUsage>;
// requestStartMs 缺省回退 Date.now()（调用时刻）——单参数旧直调兼容是硬约束
```

### 10.3 Contracts

- **TTFT 锚定请求起点**（proxy `start` :907 / anthropic `start` :218，均在重试循环之前）：含重试/换渠道时间，用户体感口径（2026-10-23 用户裁定）；渠道质量评估另有监测页独立统计，不混用。
- **流式 `latency_ms` 流尾取值**：流式成功路径经 `record`/`recordFn` 第三参 `streamLatencyMs ?? latencyMs` 覆盖——TTFB→总时长口径变更，部署后与历史 rollup 行存在台阶，随 180d 保留期老化消失。
- **回退恒等**：SSE 解析 catch 分支与非流式路径不传第三参，headers latency + 既有 TTFT 行为字节级不变；无 body → `{usage: null, ttft: null, elapsedMs: null}`，`??` 落回 headers latency。
- **非流式 TTFT ≡ `latencyMs` 是设计常量**（proxy :1084/:1131、anthropic :576/:636）：非流式整包到达无可观测首 token 时刻；强制流式聚合（客户端非流式）同属此类，网关侧上游 TTFT 不透出（范围外裁定）。
- **Workers 时钟语义**：`Date.now()` 只在 I/O 边界前进——流读取是 I/O，流内取差值真实；空候选（404/503）在落库前提前返回，不存在零 I/O 的 `latency_ms = 0` 行。

### 10.4 Validation & Error Matrix

| 条件 | 行为 |
|------|------|
| 无响应体 | 三字段 null，`elapsedMs` 经 `??` 落回 headers latency |
| SSE 解析 throw（流中断等） | catch → `record(immediateUsage, null)`（不传第三参）→ headers latency + TTFT null |
| 流式错误体（非 200 但走 `.then` 路径） | 也用 `elapsedMs` 记 `latency_ms`（起点→错误体读完，毫秒级差异）；TTFT 仍 null。备查非缺陷 |

### 10.5 Tests Required

`tests/usage-cache.test.ts`「latency anchors (fake timers)」：`vi.useFakeTimers({ toFake: ["Date"] })` + pull 驱动 `ReadableStream` 在 `pull()` 内拨钟（消费同步，`Date.now()` 精确落标记）；锚点公式推导断言 t0+500 首 data 行 → TTFT=500、t0+1200 流尾 → elapsed=1200；冻结时钟单参调用 TTFT/elapsed=0 锁旧语义；`finally` 恢复真实时钟。既有 5 个单参直调测试文件断言零改动即绿。

### 10.6 Wrong vs Correct

#### Wrong（修复前）

```ts
const start = Date.now(); // parseUsageFromSse 内部取——调用时刻锚，已在响应头之后
// TTFT 只量到「响应头 → 首条 data 行」的 SSE 分帧延迟（几 ms，UI 渲染 0.00s）；
// 真实模型首 token 等待被计进 latency_ms（上游首 token 就绪才 flush 响应头），
// 而 latency_ms 本身又不含流传输时长（convertResponse 流式分支只 pipeThrough 不消费 body）
```

#### Correct

```ts
parseUsageFromSse(lastResponse.clone(), start) // 请求起点透传（epoch ms）
// 首条 data 行：firstTokenLatencyMs = now - start（含重试/换渠道）
// 流尾：elapsedMs = now - start → 第三参覆盖 latency_ms
```

## 11. 计费公式口径（2026-10-28 缓存折价增补）

### 11.1 Scope / Trigger

- 触发：改动 `calculateCost` 签名 / cost 公式 / 定价解析（`services/pricing.ts` + `services/channel-models.ts`）。

### 11.2 Signatures

```ts
// services/pricing.ts
calculateCost(price, prompt, completion, total?, cachedInput?, cacheCreation?, ratios?): number;
// ratios: { readRatio, writeRatio }（resolveCacheRatioConfig，clamp [0,100] 脏值降 1）
// price.cache_read_price / cache_write_price：每模型绝对价覆盖（Number(x) > 0 解析约定）
```

### 11.3 Contracts

- cost = `非缓存 × input_price + 缓存读 × 读价 + 缓存写 × 写价 + 输出 × output_price`；非缓存输入 = `max(0, prompt − cacheRead − cacheWrite)`（cached ⊆ prompt 口径承继 §3.2 折算链，负余量钳制兜底异常上游）。
- **双零短路守卫**：cacheRead/cacheWrite 同时为 0（含 NULL）→ 原公式原路径逐字节返回（usage 行 NULL = 上游未报告，不猜测不折算）；`totalTokens`-only 均值价回退在前且不变、缓存不拆分。
- `getModelPrice` 无定价判定维持 input/output 双 null → null；cache-only 条目不是定价。倍率走 `loadProxySettingsCached` 30s TTL（post-response 路径，计费生效窗口 ≤30s）；调用方恰好 proxy `record` / anthropic-proxy `recordFn` 两处。

### 11.4 Tests Required

`tests/cache-token-billing.test.ts`：公式矩阵（读/写/混合/NULL 短路/倍率覆盖/绝对价覆盖/负余量钳制/totalTokens 回退）、零回归对照（legacy 参照 toBe 严格浮点相等）、settings clamp 与 PUT 校验矩阵、models prices PUT 三态、含 cache 字段 models_json 备份 round-trip。
