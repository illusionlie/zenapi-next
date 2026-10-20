# 技术设计 — P2 渠道冷却与请求日志减负

## 开放问题定稿（PRD → 决策）

- **冷却过滤的实现层级**：在候选数组进入 `createWeightedOrder` **之前**过滤（proxy.ts / anthropic-proxy.ts 各自的候选装配处）——加权排序函数保持纯函数语义，冷却作为「候选资格」前置条件，与 api_formats 资格判定同一层级。
- **`debug_request_body_log` 写入入口**：后端纳入 settings 已知键清单（GET 返回 / PUT 接受），**管理台 UI 开关不在本任务范围**（后续可选）；管理员可经 API 设置。读侧走 settings → env（`DEBUG_REQUEST_BODY_LOG`）→ 默认 false 的标准三级回退。

## 渠道冷却器（新 services/channel-cooldown.ts）

```ts
type CooldownState = { consecutiveFailures: number; cooldownUntil: number };
// 模块级 Map<channelId, CooldownState>（isolate 本地视图，已知边界）

export const COOLDOWN_FAILURE_THRESHOLD = 3;
export const COOLDOWN_DURATION_MS = 60_000;

export function recordChannelFailure(channelId: string, now?: number): void;
// consecutiveFailures+1；达阈值 → cooldownUntil = now + COOLDOWN_DURATION_MS
export function recordChannelSuccess(channelId: string): void;
// 清零并删除条目（成功即恢复，不等冷却到期）
export function isChannelCoolingDown(channelId: string, now?: number): boolean;
// cooldownUntil > now 即冷却中（惰性过期，不主动清扫）
export function filterCoolingChannels(channelIds: string[], now?: number): string[];
// 剔除冷却中渠道；**fail-open**：全部被剔时原样返回全量
export function resetChannelCooldownsForTest(): void; // 测试隔离
```

- 失败/成功的**判定语义**（与 utils/retry.ts 的可重试判定同源）：
  - `recordChannelFailure`：渠道被放弃时记一次——即该渠道 Key 循环耗尽且最后失败为可重试（408/429/5xx）或网络错误（fetch throw）。**每个渠道每次请求至多记 1 次**（不按每个 Key/每响应计，避免单请求内多 Key 失败叠加导致误冷却）。
  - `recordChannelSuccess`：该渠道返回了任何 HTTP 响应（含不可重试 4xx——上游活着）即成功。
- 测试用注入 `now` 参数（免 fake timers 泄漏），Map 用 reset 函数在 beforeEach 清。

## 接线（proxy.ts / anthropic-proxy.ts 同构）

- 渠道循环内：每次 `fetch` 得到响应 → `recordChannelSuccess(channel.id)`（无论后续是否解析失败）；渠道放弃点（Key 耗尽 / 不可重试跳出该渠道）按上述判定调 `recordChannelFailure`。
- 候选装配处（预载 Promise.all 之后、加权排序之前）：

```ts
const candidateIds = filterCoolingChannels(candidates.map((c) => c.id));
// fail-open 已内建于 filterCoolingChannels：全冷时返回全量，行为与今日一致
const ordered = createWeightedOrder(candidates.filter((c) => candidateIds.includes(c.id)), ...);
```

- playground 不接线（对话测试无冷却诉求）。
- **已知边界文档化**（AGENTS §8）：冷却为 isolate 本地视图，多 isolate 不共享、不精确但方向正确；fail-open 保证永不因冷却而 503 提前。

## 请求日志减负（index.ts 全局中间件）

- 现状（index.ts:34-61）：写方法请求 clone + 全量 json() + Object.keys + console.log。
- 改造：读 `debug_request_body_log`（settings，30s TTL 缓存包装——新小函数 `loadDebugLogFlag(db)`，复用 utils/cache.ts 原语；键缺失/解析失败 → 默认 false）：
  - **false（默认）**：`console.log("[request]", { method, path })`，**不 clone 不解析请求体**（零内存税）。
  - **true**：保留现状完整形态（body_type/body_keys/body_size）。
- settings 键标准链路：services/settings.ts 增常量与读取函数（三级回退：settings → env `DEBUG_REQUEST_BODY_LOG` 真值判定 → false）；routes/settings.ts 的已知键清单增补（GET 返回 / PUT 接受，布尔严格校验非 0/1/true/false 拒绝）。
- hono logger 与 observability 采样不动。

## 测试

- `tests/channel-cooldown.test.ts`：3 连败进冷却、60s 过期（注入 now）、成功清零、fail-open（全冷返回全量）、部分冷剔除、每渠道单请求至多记 1 次的调用约定由调用方保证（单元层测状态机）。
- `tests/debug-request-log.test.ts`（或并入现有 middleware 测试）：开关两态——false 不 clone（mock raw.clone 未被调）、true 保持现状输出；键缺失/脏值 → false。
- settings 键 CRUD：GET 含该键、PUT 合法布尔与非法值 400。
- 路由层接线：冷却中渠道不进入加权排序（fail-open 分支）——仿既有 proxy 测试 mock 模式，若成本过高可降为 filterCoolingChannels 单测 + 装配点代码审查，报告说明。

## 兼容与回滚

- 冷却器为纯增量模块；不接线任何持久状态，revert 即消失。
- 日志开关默认 false **改变现状可观测性**（body_keys 不再默认打印）——这是本任务目的，AGENTS §8 注记；回滚 = settings 置 true 或 revert。
- 无迁移、无 schema 变更。

## 权衡记录

- 不做半开探测/指数退避：固定 3×60s 起步，参数集中常量，后续需要再加。
- 按「渠道放弃」而非「每响应」计失败：单请求多 Key 全失败只记 1 次，防止热点渠道被单请求误拉黑。
- 日志开关读走独立 30s 缓存而非并进 loadProxySettingsCached：中间件在路由前运行，不依赖代理路径的预载结构。
