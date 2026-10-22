# Proxy Headers — 上游请求头策略契约

> 来自任务 `09-14-global-custom-headers`（策略链）与 `09-17-channel-client-disguise`、
> `09-19-disguise-dynamic-headers`（伪装头 / 动态模板）。改动两条代理链路的请求头行为、或新增
> settings 配置项之前必读。

---

## Scenario: 上游请求头策略（全局注入 / 全局剔除 / 渠道级）

### 1. Scope / Trigger

- 任何需要修改"发往上游的请求头"的工作（`proxy.ts`、`anthropic-proxy.ts`、`playground.ts`、`channel-testing.ts`；后两个是 `policy=null` 豁免消费者，探针另有自己的伪装内联注入）。
- 任何新增 settings 配置项的工作（本任务建立的标准链路，见 §8）。

### 2. Signatures

```ts
// apps/worker/src/utils/proxy-headers.ts —— 头策略唯一入口
export type ProxyHeaderPolicy = {
	extraHeaders: Record<string, string>; // 全局注入
	removeHeaders: string[]; // 全局剔除
};
export function parseExtraHeaders(raw: string | null | undefined): Record<string, string> | null;
export function parseRemoveHeaders(raw: string | null | undefined): string[] | null;
export function parseHeaderPolicyFromRaw(raw: Record<string, string | null>): ProxyHeaderPolicy; // 2026-10-19 P1 起：代理热路径入口，纯解析（配合 loadProxySettingsCached 的 30s TTL 缓存）
export async function loadProxyHeaderPolicy(db: D1Database): Promise<ProxyHeaderPolicy>; // 直读 db；生产代理路径已改走 parseHeaderPolicyFromRaw，本函数保留给直读场景与既有测试锚定
export function applyHeaderPolicy(
	headers: Headers,
	policy: ProxyHeaderPolicy | null,
	channelCustomJson: string | null | undefined,
	disguiseJson?: string | null, // 渠道伪装头（09-17-channel-client-disguise），非法 JSON 按空配置
	presetHeaders?: Record<string, string> | null, // 服务端客户端预设头（10-21-opencode-zen-disguise），已求值字面值，见 client-presets.md
): void;

// 系统提示词注入（同一任务的姊妹契约）：utils/client-disguise.ts
// injectSystemPromptOpenAI / injectSystemPromptAnthropic / injectSystemPromptResponses
// —— 均为 fail-open 纯函数（空 prompt no-op，未知形态不损坏请求）

// 伪装头动态模板（09-19-disguise-dynamic-headers）：utils/client-disguise.ts
// genOpencodeRequestId() / genOpencodeSessionId() —— msg_/ses_ ID，内嵌毫秒时间戳
//   （ts*4096+1 取低 48 位写入 12 hex，ses 按位取反；低 6 字节仅存 ts mod 2^36，解码需绕回）
// resolveDisguiseTemplate(value: string): string
//   —— 无 "{{" fast path 原样返回同一引用；已知占位符替换、未知原样保留（fail-open）
// 注册表：uuid / timestamp_ms / opencode_request_id / opencode_session_id

// buildChannelRequest 第 9 / 10 参（可选，默认 null）
buildChannelRequest(channel, targetPath, querySuffix, incomingHeaders,
	requestText, parsedBody, isStream, apiKey?, policy?, disguisePrompt?)
```

### 3. Contracts

- settings KV（无迁移，key 缺失 = 空配置）：
  - `proxy_extra_headers`：JSON 对象字符串，值必须全为字符串。
  - `proxy_remove_headers`：JSON 字符串数组。
- 存储原文 JSON 字符串；**写入严格校验、读取宽容**（解析失败按空配置，不阻断代理请求）。
- API：`GET /api/settings` 返回 `proxy_extra_headers` / `proxy_remove_headers`（string，未设置为 `""`）；
  `PUT` 空串 = 清空。
- UI 字段流转链路（新增 settings 项必须全通）：
  `services/settings.ts get/set` → `routes/settings.ts GET/PUT` →
  `ui core/types.ts (Settings + SettingsForm)` → `core/constants.ts initialSettingsForm` →
  `AdminApp.tsx (loadSettings ?? "" 映射 + handleSettingsSubmit)` → `SettingsView.tsx` 表单。
- KV 键常量单点定义于 `utils/proxy-headers.ts`，service/route 引用常量，不要散落字符串字面量。
- 渠道伪装头（`channels.disguise_headers_json`，09-17 任务）：由 `applyHeaderPolicy` 第 4 参
  统一注入，应用顺序固定为 **剔除 → 全局注入 → 预设头 → 伪装头 → 渠道级 custom_headers**
  （后应用者赢，伪装可覆盖预设、全局与内置头、可被渠道级覆盖）。非法 JSON 按空配置（fail-open），
  绝不阻断代理请求。`policy === null`（Playground / test-model 豁免）时**预设 / 伪装 / 渠道级
  仍生效**，仅跳过全局两步。
- 服务端客户端预设头（`channels.disguise_preset`，10-21-opencode-zen-disguise 任务；引擎契约见
  [client-presets.md](./client-presets.md)）：由 `applyHeaderPolicy` 第 5 参（末位可选）注入，
  调用方先经 `applyClientPreset` 每请求求值一次（headers 内含当次派生的会话/消息 ID）。预设层
  两条专属规则：① 预设值是**已求值字面值**，**不**解释 `{{...}}` 模板——模板解析仍是伪装头
  独占域；② **全局剔除对预设头保持裁决权**——进入 `removeHeaders` 清单的头名（大小写不敏感，
  同 `headers.delete` 语义）预设层跳过注入，否则先行的剔除会被预设层的 set 静默回填，覆盖链
  退化为「预设恒赢」；全局注入因先行应用**不能**覆盖预设头。
- 伪装头动态模板（09-19）：伪装头的**值**在应用时刻经 `resolveDisguiseTemplate` 解析——每次调用
  `applyHeaderPolicy`（即每请求 / 每 attempt / 每探针）独立求值，重试 / 换渠道 / 换 Key 天然新鲜；
  这是特性不是浪费，**不要**把解析上移到策略/配置加载时（会把动态值冻结成静态值）。
- 伪装提示词（`channels.disguise_system_prompt`）不在本契约内：经 `utils/client-disguise.ts`
  三协议注入函数在 `buildChannelRequest` / `anthropic-proxy.ts` 各分支注入（**前置为首条 system**；
  custom 格式不解释 body）；`/v1/models` 连通性测试无 body 不注入提示词。

### 4. Validation & Error Matrix

| 条件 | 结果 |
|------|------|
| 注入值非字符串 / JSON 非对象 | 400 `invalid_proxy_extra_headers` |
| 剔除非字符串数组 / JSON 非数组 | 400 `invalid_proxy_remove_headers` |
| 空串 `""` | 合法 = 清空 |
| 运行时读到非法 JSON | 按空配置继续，不报错 |

### 5. Good/Base/Bad Cases

- **Good**：`loadProxyHeaderPolicy` 与渠道查询 `Promise.all` 并行预载；每请求一次，重试轮复用。
- **Base**：两项配置缺失 + 渠道无 custom_headers → 请求头与历史版本行为完全一致（零回归基线，测试有断言）。
- **Bad**：在分支内联 merge 渠道级头 / 在 `buildChannelRequest` 内部自动读 settings（会污染 Playground 豁免）。

### 6. Tests Required

`tests/proxy-headers.test.ts`（32 用例）断言点：
- parse 容错矩阵（null / 空串 / 标量 / 值非字符串 / 非数组）。
- `applyHeaderPolicy` 顺序：剔除 → 全局注入 → 伪装头 → 渠道级；policy=null 时伪装与渠道级仍生效；
  伪装非法 JSON 容错；大小写不敏感删除。
- 动态模板（09-19）：伪装值渲染 / 未知占位符保留 / 同串在 custom_headers 收到字面值（域界定对照）。
- `buildChannelRequest` 三格式 ×（policy 注入 + 渠道级覆盖）矩阵；不传 policy / 不传新参的零回归基线。

伪装注入另有 `tests/client-disguise.test.ts`（31 用例）：三协议注入函数全分支、
`buildChannelRequest` 八分支接线矩阵（含同输入两次调用逐字节一致的重试不累积断言）、零回归基线；
ID 生成器格式/黄金 hex/时间戳解码/随机段唯一性、模板解析 fast path 与混合文本、
连续两次 `buildChannelRequest` 动态值互异（AC7 代表路径）。

### 7. Wrong vs Correct

#### Wrong
```ts
// 分支内联 merge（历史写法，已删除）——行为会在 6 个分支间漂移
if (channel.custom_headers_json) {
	const custom = safeJsonParse<Record<string, string>>(channel.custom_headers_json, {});
	for (const [k, v] of Object.entries(custom)) headers.set(k, v);
}
```

#### Correct
```ts
// 内置头设置完之后、fetch/return 之前，统一调用（policy 可为 null）
applyHeaderPolicy(headers, policy, channel.custom_headers_json);
```

---

## Gotchas（踩过的坑）

> **Warning：「后应用者赢」贯穿始终。**
> 应用顺序固定为 剔除 → 全局注入 → 预设头 → 伪装头 → 渠道级，后写者可覆盖内置鉴权头
> （`Authorization` / `x-api-key`）。这是刻意保留的能力（历史 custom 分支即如此），
> 不要加"保护名单"回退它；风险由 UI 警示文案兜底。

> **Warning：`/anthropic/v1` 三个分支是 fresh Headers 白名单式构造。**
> 客户端头本来就不透传，剔除操作是 no-op，但仍必须统一调用 `applyHeaderPolicy`
> （一致性 + 防未来分支改动遗漏）。全局注入在这些分支同样生效。

> **Warning：Playground 的 `incomingHeaders` 是空的 `new Headers()`。**
> 它从不透传客户端头（现状），因此"全局剔除"在 Playground 无测试面；豁免仅指
> 不传 policy（全局注入/剔除均不生效），渠道级头在统一后**会**生效（预期行为）。

> **Warning：连通性测试 / 拉取模型（`channel-testing.ts`）不走本策略。**
> `fetchChannelModels` 保持自己的 custom-only 渠道级 merge——若强行收敛到
> `applyHeaderPolicy`，openai/anthropic 渠道的连通性测试会开始带渠道级头，属行为外溢。
> 伪装头（09-17）是在其现有 merge 旁**内联新增**的（伪装先应用、custom 后应用），
> 同样不收敛——`fetchChannelModels` 至今不调用 `applyHeaderPolicy` 是刻意的。

> **Warning：`policy === null` 只豁免全局两步。**
> 伪装头与渠道级 custom 在 policy=null 时照常生效（Playground / test-model 依赖此语义
> 完整应用渠道伪装，D4 决策）；给豁免调用方新增「跳过伪装」语义前先查 PRD。

> **Warning：伪装头动态模板只在伪装域解释（09-19）。**
> `resolveDisguiseTemplate` 仅作用于 `applyHeaderPolicy` 伪装分支与 `channel-testing.ts`
> 探针的伪装内联注入；`custom_headers_json` 与全局 extra/remove 恒为字面值（用户数据不解释，
> 测试有域界定对照用例）。未知占位符原样发送、不报错。由此 `proxy-headers ↔ client-disguise`
> 存在**刻意的双向 call-time 引用**（双向均为函数体内引用、无顶层求值），勿把任一侧改为
> 顶层初始化，也不要为"消除环"把函数挪进循环依赖更深的文件。

> **Warning：预设头层（第 5 参 `presetHeaders`）是字面值域，唯一来源是预设引擎。**
> 头值由 `services/client-presets.ts` 的 `applyClientPreset` 每请求求值（内含确定性派生的
> 会话/消息 ID）；引擎对 NULL / 未知 ID fail-open 返回 null（零回归），不在 `applyHeaderPolicy`
> 内部兜底。**绝不**在预设层调 `resolveDisguiseTemplate`——模板解析是伪装独占域（域界定有
> 测试锚定，五层顺序用例见 `tests/client-preset-headers.test.ts`）。全局 remove 清单对预设头
> 保持裁决权（清单内头名预设层跳过注入，大小写不敏感）；全局 inject 因先行不能覆盖预设头；
> `policy === null` 豁免只跳全局两步，预设/伪装/custom 照常生效。

> **Warning：伪装提示词注入不得原地修改共享 parsedBody。**
> 同一 parsedBody 跨重试轮 / 跨渠道复用；openai 透传与 anthropic-proxy 各分支注入时
> 必须浅拷贝（messages 数组一并克隆）或使用转换后的 fresh body，否则多轮重试会累积
> 重复 system（client-disguise.test.ts 有同输入两次调用逐字节一致的守护断言）。

---

## 8. 新增 settings 配置项 Checklist（本任务建立的标准链路）

1. `services/settings.ts`：`get/set` 函数对（存原文，模式照抄 `setAnnouncement`）。
2. `routes/settings.ts`：GET 返回（`?? ""`）+ PUT 校验分支（snake_case 400 错误码）。
3. UI `types.ts`：`Settings` **和** `SettingsForm` 各加字段（两处都改，漏一个类型报错）。
4. UI `constants.ts`：`initialSettingsForm` 补默认值。
5. UI `AdminApp.tsx`：`loadSettings` 映射 + `handleSettingsSubmit` 提交。
6. UI `SettingsView.tsx`：表单字段 + 说明文案。
7. 无需 D1 迁移（settings 是 KV 表）；本地冒烟可用 `bunx wrangler d1 execute api-worker --local --json`（须在 `apps/worker/` 目录下执行，否则找不到 DB）。
