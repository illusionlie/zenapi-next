# Settings Config — 数值型配置项与 env 迁移契约

> 来自任务 `09-15-proxy-retry-settings`（代理重试参数从 wrangler.toml 迁入 settings）。
> 把 `[vars]` 环境变量迁移为 settings 配置、或新增**数值型**（整数范围）settings 项之前必读。
> UI 字段流转六环节 checklist 见 [proxy-headers.md §8](./proxy-headers.md)，本文不重复。

---

## Scenario: env → settings 迁移（三级回退链）

### 1. Scope / Trigger

- 任何把 `wrangler.toml` `[vars]` 中"部署方可调"的参数迁为 settings 表配置的工作。
- 任何新增带取值范围（min/max）的数值型 settings 键。

### 2. Signatures

```ts
// apps/worker/src/services/settings.ts —— 数值型配置的标准形态（样板：代理重试参数）
export const MIN_PROXY_RETRY_ROUNDS = 1;
export const MAX_PROXY_RETRY_ROUNDS = 10;
export const DEFAULT_PROXY_RETRY_ROUNDS = 2; // 取 wrangler.toml 实际部署值，非旧代码兜底值

export type ProxyRetryConfig = { rounds: number; delayMs: number };

// 单条 SQL 读多键（key IN），env 回退值由调用方传入
export async function loadProxyRetryConfig(
	db: D1Database,
	envFallback?: ProxyRetryEnvFallback,
): Promise<ProxyRetryConfig>;

// 写入侧：upsert + Number.toString()，不做 clamp（clamp 属读取侧职责，PUT 校验属路由侧职责）
export async function setProxyRetryRounds(db: D1Database, rounds: number): Promise<void>;
```

### 3. Contracts

- **三级回退链**：settings 值 → env 变量（兼容回退，由调用方传 `c.env.*`）→ 内置默认。
  settings 键缺失时行为与迁移前完全一致（存量部署零回归的保证）。
- **env 变量保留不删**：留在 `wrangler.toml` 降级为回退默认；`env.ts` 类型不动。
- **GET 返回 clamp 后的有效值**（`loadProxyRetryConfig(db)` 不带 envFallback）：
  管理台显示的即运行时实际生效值（表单即真相）；且不透显 env 值，
  避免用户点保存时把 env 值意外固化进 settings。
- **内置默认值必须对齐 wrangler.toml 的实际部署值**，不要照抄旧代码里的兜底字面量。
- **代理 settings 热路径读取走 30s TTL 缓存**（2026-10-19 P1）：`loadProxySettingsCached` 只缓存 settings 表的 raw map（一条 `key IN` 查询）；`resolveProxyRetryConfig` 等纯解析与三级回退链**每次照常执行**——缓存层永不改变回退/clamp 语义（既有 settings 测试零改动通过即此保证）。管理台表单真相路径（`loadProxyRetryConfig(db)` 直读）**不走缓存**。生效陈旧窗口 ≤30s。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| PUT 值非整数（`"2.5"` / `"2e3"`）或越界 | 400 `invalid_{key}`（snake_case，沿用 jsonError 惯例） |
| PUT 合法整数 | upsert 入库 |
| 读取：值越界（脏数据 / 手工改库） | clamp 到 `[MIN, MAX]`，不抛错 |
| 读取：值缺失 / NaN / 非整数 / 空串 / null | 降级走回退链（先 env，后内置默认） |
| env 回退值越界 | 同样 clamp（env 无法突破边界，上限保护优先于 env 自由度） |

分工记忆：**写侧严格（fail-closed）、读侧宽容（fail-open）**，与 error-handling.md 的全局契约一致。

### 5. Good/Base/Bad Cases

- **Good**：MIN/MAX/DEFAULT 常量单点定义于 services，PUT 校验、读取 clamp、UI input `min`/`max` 三层引用同一组常量，边界永不漂移。
- **Base**：settings 两键缺失 + env 未注入 → 生效内置默认（2 轮 / 200ms），与迁移前部署行为一致。
- **Bad**：在三条代理路径各自 `Math.max(1, Number(c.env.X ?? "1"))`——clamp 逻辑三份漂移、且无上限保护（迁移前的真实状态）。

### 6. Tests Required

样板：`tests/proxy-retry-settings.test.ts`（10 用例），断言点：
- 回退链三分支（settings 优先 / env 回退 / 内置默认）。
- clamp 边界矩阵（MIN-1、MIN、MAX、MAX+1、负数、NaN、非整数字符串、null）。
- SQL 形态：单条查询 + `key IN` 双键绑定（防退化为多次串行读）。
- upsert 值字符串化。

### 7. Wrong vs Correct

#### Wrong

```ts
// 迁移前写法：env 直解析，三份重复、无上限、与 wrangler.toml 默认值漂移
const retryRounds = Math.max(1, Number(c.env.PROXY_RETRY_ROUNDS ?? "1"));
```

#### Correct

```ts
// 预载阶段与渠道查询、头策略并行（不新增串行 DB 往返），循环处只消费结果
const [channelResult, headerPolicy, retryConfig] = await Promise.all([
	c.env.DB.prepare("SELECT * FROM channels WHERE status = ?").bind("active").all(),
	loadProxyHeaderPolicy(c.env.DB),
	loadProxyRetryConfig(c.env.DB, {
		rounds: c.env.PROXY_RETRY_ROUNDS,
		delayMs: c.env.PROXY_RETRY_DELAY_MS,
	}),
]);
```

> 上例为 P1 前的历史形态，保留作回退链语义参照。**2026-10-19 P1 起代理热路径**：预载并成单个 Promise.all（别名 / aliasOnly / 渠道缓存 / `loadProxySettingsCached`），settings 只缓存 raw map，`resolveProxyRetryConfig` / `parseHeaderPolicyFromRaw` 纯解析每次执行（含 env 回退与 clamp）。

---

## Design Decisions

### Design Decision: 三级回退链而非"settings 唯一来源"

**Context**: env 迁移到 settings 后，仅用 env 自定义过参数的部署会怎样？

**Decision**: 保留 env 作为中间层回退。纯 settings 方案会让这类部署在升级后静默丢失配置（内置默认 ≠ 用户 env 值）。三级链让"升级零变化"成为可测试的契约（存量测试 mock env 经回退后行为逐值一致）。

### Design Decision: GET 返回 clamp 后有效值，而非原始存储值

**Context**: 管理台表单该显示什么？

**Decision**: 显示运行时实际生效值（表单即真相）。附带收益：避免把 env 回退值透显进表单——用户无意间点保存会把 env 值固化成 settings，env 语义从此失效且难以察觉。

> **Warning：内置默认值双源漂移。**
> 迁移前代码兜底是 `?? "1"`（1 轮）而 wrangler.toml 是 `"2"`——两处"默认"不一致。
> 迁移时以**实际部署生效值**（wrangler.toml）为准归一，并顺手消灭代码里的意外兜底字面量。
> 新迁移任务先 grep `c.env.{VAR}` 确认所有解析点，再决定归一值。
