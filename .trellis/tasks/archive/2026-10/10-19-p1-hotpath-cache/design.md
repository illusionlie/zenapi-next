# 技术设计 — P1 热路径缓存与写入异步化

## 缓存原语（新 utils/cache.ts）

```ts
export function createTtlCache<T>(ttlMs: number, opts?: { max?: number }): {
	get(key: string): T | undefined;
	set(key: string, value: T): void;
	clear(): void;
};
```

- 模块级 Map + 过期时间戳，惰性淘汰（get 时判过期）；不设后台清扫。
- `max` 可选上限做粗粒度防膨胀（超限时整表 clear，简单优于 LRU）——值域受渠道数/别名数约束，通常不会触顶。
- TTL 常量集中在文件头部导出：`CHANNEL_CACHE_TTL_MS = 10_000`、`ALIAS_CACHE_TTL_MS = 10_000`、`PROXY_SETTINGS_CACHE_TTL_MS = 30_000`。
- 测试经 vi.useFakeTimers 推进时间。

## 鉴权 JOIN（middleware/tokenAuth.ts）

现状两条串行查询（tokens → users，tokenAuth.ts:34-38 / :64-72）合一：

```sql
SELECT t.id, t.name, t.status, t.allowed_models, t.quota_used /* …按现查询列照搬 */,
       u.balance AS user_balance, u.status AS user_status,
       u.allowed_models AS user_allowed_models
FROM tokens t LEFT JOIN users u ON u.id = t.user_id
WHERE t.key_hash = ?
```

- **列清单显式**，user 侧全部 `AS user_*` 别名——两表同名列（status / allowed_models）不得裸选。
- 无 user_id 的 token：LEFT JOIN 产出 null user 字段，下游判断 `tokenRecord.user_id` 的分支等价；user 行缺失（悬空 user_id）同样归 null 分支。
- 既有闸门逻辑（status / quota / balance <= 0 检查）不动，只换数据来源。

## 读并行合一（routes/proxy.ts + anthropic-proxy.ts 同构）

阶段重排：auth（JOIN 1 RTT）→ **单个 Promise.all** → 内存筛选/路由（不变）：

```
Promise.all([
	resolveModelAlias(db, model),        // 现状 proxy.ts:566
	loadChannelAliasOnlyMap(db),         // 现状 proxy.ts:573（全表 → 缓存）
	getActiveChannelsCached(db),         // 现状 proxy.ts:608 SELECT * 全量
	loadProxySettingsCached(db),         // 头策略 + 重试配置 4 键一次 IN 查询
])
```

- `loadProxySettingsCached`（services/settings.ts 新增）：一条 `SELECT key, value FROM settings WHERE key IN (4键)` 读 raw map → 30s TTL 缓存包装（只缓存「settings 表读取结果」）；既有 `loadProxyHeaderPolicy` / `loadProxyRetryConfig` 降为纯解析函数，三级回退链与 clamp 每次照常执行——语义零改动。
- `getActiveChannelsCached`：缓存 active 渠道行数组（含解析后对象），命中零 D1；`SELECT *` 顺带收窄为显式列（models_json 等大列按需保留，避免行为漂移的前提下减小载荷，收窄范围实现时定）。
- 别名缓存：per-alias 解析结果与 aliasOnly 全图各 10s TTL。
- **写路径不做失效**：管理台 CRUD 后靠 TTL 自然刷新；AGENTS §8 注记陈旧上界。

## 写入异步化

- 抽助手（utils 或 services/usage.ts 导出）：

```ts
export function runPostResponse(ctx: { executionCtx?: ExecutionContext } | undefined, task: () => Promise<void>): void
```

executionCtx 可得 → `ctx.executionCtx.waitUntil(task)`；不可得 → fire-and-forget + `task().catch(console.error)`（与流式路径 proxy.ts:976 降级语义一致）。
- 非流式：`await record(...)`（proxy.ts:978-980、anthropic-proxy.ts:516-533）→ `runPostResponse(c, () => record(...))`；错误路径 INSERT（proxy.ts:823-836、anthropic-proxy.ts:411-424）同改。
- P0 之后 task 本身已是单次 batch（三写一往返），本任务不再拆语句。

## 兼容与风险

- 双代理路径（proxy.ts / anthropic-proxy.ts）同构改造，验收时逐点对照，防止单边漂移。
- 缓存实例为模块级单例：多 isolate 各自持有，本就预期；dev 热重载时模块重置 = 全冷，无碍。
- settings 缓存只包 DB 读：env 回退、clamp、脏值防御全部保持既有测试覆盖面。

## 权衡记录

- 不上 KV：读延迟更高、需新绑定与配额，isolate 内存零成本够用；跨 isolate 失效需求出现时再评估 DO。
- 不缓存 token 鉴权：封禁/额度变更需即时生效，缓存引入的安全窗口不值得 1 次索引读的节省。
- JOIN 而非两次并行读：单 RTT 且消除双读一致性窗口（token 与 user 状态瞬时不一致的可能）。
