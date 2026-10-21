# 技术设计 — 设置开关：developer 角色透传归一化（developer→system）

> 行号锚点基于侦察时点（proxy.ts 1038 行 / format-converter.ts 2895 行 / settings.ts 755 行）。

## 1. 决策记录

### D1 设置键：`normalize_developer_role`，搭车 `PROXY_SETTING_KEYS` 热路径缓存

- 键常量 `DEVELOPER_NORMALIZE_ROLE_KEY = "normalize_developer_role"`（services/settings.ts，紧邻 `DEBUG_REQUEST_BODY_LOG_KEY`，约 line 656 区域）。
- 读取链两级：存储值严格 `"true"`/`"false"` → 缺失/脏值默认 `false`。**无 env 回退**——env 回退只服务于「env→settings 迁移」的历史键（PROXY_RETRY_*、DEBUG_REQUEST_BODY_LOG），新键无迁移包袱，两级链是 settings-config.md 三级链的合法退化（脏值即默认，读宽写严不变）。
- **搭车而非自建缓存**：把键加进 `PROXY_SETTING_KEYS`（settings.ts:538-543），随 `loadProxySettingsCached`（563-578，30s TTL WeakMap 缓存、单 `WHERE key IN` 查询）免热路径新增查询。proxy.ts:584 的 handler 已持有 `proxySettings` raw map，新增一次纯解析调用即得布尔值。代价：tests/proxy-settings-cache.test.ts:93-114 的「恰好四键」断言改为五键。
- 纯解析器 `resolveDeveloperNormalizeFlag(raw: SettingsRawMap): boolean`（镜像 `resolveDebugLogFlag` 形态但无 envFallback 参数）；直读变体 `loadDeveloperNormalizeFlagDirect(db)`（绕缓存，供 GET 表单真相，镜像 `loadDebugLogFlagDirect`，settings.ts:735-741）；写入器 `setDeveloperNormalizeFlag(db, value)`（严格存 `"true"`/`"false"`，镜像 `setDebugRequestBodyLog`，746-755）。不需要独立 WeakMap——独立缓存模式（debug 键 661）是不在 `PROXY_SETTING_KEYS` 里的键才需要的备胎。

### D2 归一化语义：原位改名，不复用 hoist+拼接

已有两处 developer 处理（`openaiToAnthropicRequest` format-converter.ts:394-402 拼 systemParts、`convertResponsesInputItem` 2173-2181 收 systemParts）是「hoist + 拼接 + 消息消失」语义，为单 system 字段协议（Anthropic `system` 顶层 / Responses `instructions`）设计：多模态 part 丢到只剩 `.text`、消息被移出原位、多条合并。透传归一化若复用会改变消息结构与内容，超出「改名」预期。

**新写纯函数，放 `format-converter.ts`（导出），原位改名**：

```ts
// chat completions 体：messages 数组原位改名
export function normalizeChatDeveloperRole(body: Record<string, unknown>): boolean
// responses 体：input 数组中 message item 原位改名
export function normalizeResponsesDeveloperRole(body: Record<string, unknown>): boolean
```

- 返回 `boolean` = 是否发生了修改（调用方据此决定是否重序列化）。
- 遍历 `messages` / `input`（非数组直接返回 false），命中 `role === "developer"`（responses 侧还须 `type === "message"`）时置 `role = "system"`，**直接 mutate 传入对象**（调用方总在 per-call 副本上操作，见 D4；shallow 复制外层 + mutate 与既有 `injectSystemPromptOpenAI` / `injectSystemPromptResponses` 的 bodyCopy 模式一致）。
- 内容零接触：不碰 `content` / `content_list` part，空内容保留，位置不动，不合并。
- `tool` 等其他角色天然不命中；responses 的 `function_call` / `function_call_output` / `reasoning` item 因 `type !== "message"` 不命中。
- 注释标明与 hoist 语义的差异及选型理由（协议允许多条 system，改名最小侵入）。

### D3 接入点：`buildChannelRequest` 内部 + 新增末位可选参数

`buildChannelRequest`（proxy.ts:151-162）新增参数：

```ts
normalizeDeveloperRole?: boolean,   // 默认 false，末位可选，向后兼容
```

三个调用方各解析设置传入（值语义全局一致）：

| 调用方 | 位置 | 读点 |
|---|---|---|
| 主代理 handler | proxy.ts:781 | handler 已持有 `proxySettings`（proxy.ts:584 读的 `loadProxySettingsCached` 结果），`resolveDeveloperNormalizeFlag(proxySettings)` 零新增查询 |
| Playground | playground.ts:120 | 调 `loadProxySettingsCached(c.env.DB)` 后解析（该处此前未读设置，新增一次**缓存**读，非每请求必查库） |
| 渠道单模型测试 | channels.ts:628 | 同 Playground |

分支覆盖矩阵（`normalizeDeveloperRole === true` 时）：

| 目标分支 | 位置 | 动作 |
|---|---|---|
| anthropic 目标 | proxy.ts:170-201 | **不动**——`openaiToAnthropicRequest` 已 hoist developer 进 `system` |
| responses 目标 / `/v1/responses` 入站原生透传 | proxy.ts:212-225 | **归一化**：`parsedBody` 存在时 `normalizeResponsesDeveloperRole(parsedBody)` |
| responses 目标 / chat 入站→转换 | proxy.ts:226-245 | **不动**——`openaiToResponsesRequest` 已 hoist 进 `instructions` |
| responses 目标 / 非 chat 透传 | proxy.ts:246-251 | **不动**——无 role 概念 |
| custom 目标 | proxy.ts:263-277 | **不动**——custom 上游协议未知，透传即不解释（与端点覆盖白名单排除 custom 同一边界哲学） |
| openai 目标 / `/v1/responses` 入站→chat 转换 | proxy.ts:284-311 | **不动**——`responsesToOpenaiRequest` 已收 developer 进 systemParts |
| openai 目标 / 其余（chat completions 裸透传等） | proxy.ts:312-341 | **归一化**：`parsedBody?.messages` 为数组时 `normalizeChatDeveloperRole(parsedBody)`；非 chat 形状体（embeddings 等）无 messages 数组天然跳过 |

flag 为 false 时所有分支行为与现状逐字节一致（`body = requestText` 字节级透传不动），满足 AC1。

### D4 重写与序列化：与 disguisePrompt 共享单次拷贝

两处归一化落点都落在既有 bodyCopy 模式上，合并「需要重写」判定，至多一次 stringify：

- openai 裸透传子分支（proxy.ts:312-341）改为：

```ts
const shouldNormalize = normalizeDeveloperRole
    && !!parsedBody && Array.isArray(parsedBody.messages);
if ((disguisePrompt && parsedBody && isConvertedChatPath(targetPath)) || shouldNormalize) {
    const bodyCopy: Record<string, unknown> = { ...parsedBody, messages: [...parsedBody.messages] };
    if (shouldNormalize) normalizeChatDeveloperRole(bodyCopy);
    if (disguisePrompt && isConvertedChatPath(targetPath)) injectSystemPromptOpenAI(bodyCopy, disguisePrompt);
    body = JSON.stringify(bodyCopy);
}
// 否则保持 body = requestText（字节级透传）
```

- responses 原生透传子分支（proxy.ts:212-225）同理：`(disguisePrompt && parsedBody) || (normalizeDeveloperRole && parsedBody)` 时拷贝，先 `normalizeResponsesDeveloperRole(bodyCopy)` 后 `injectSystemPromptResponses`。

无 developer 时不重序列化由「`normalizeChatDeveloperRole` 返回 false → bodyCopy 与原文内容等价但仍 stringify」妥协——但注意：**只要 disguisePrompt 或 flag 命中重写分支就会 stringify**。为守住 AC2 的「无 developer 不重序列化」，shouldNormalize 为 true 但实际无 developer 时：`normalizeChatDeveloperRole` 返回 false 且无 disguise → 走原样 `requestText`。修正判定：`needsRewrite = (disguisePrompt…) || shouldNormalize`；若进入分支后归一化返回 false 且无 disguise 动作，则回退 `body = requestText`。实现时以「最终是否 stringify」为断言写测试（AC2/AC4）。

> 简化实现：`normalizeChatDeveloperRole` 先扫描是否存在 developer（O(n) 无分配），存在才返回 true；调用方据返回值决定 stringify 或回退。扫描成本可忽略。

### D5 设置管道与路由（routes 薄壳）

- **GET**（routes/settings.ts:60-109）：`normalize_developer_role: await loadDeveloperNormalizeFlagDirect(c.env.DB)`（直读，表单真相，避免 PUT 后同 isolate 回读吃到 30s 缓存旧值——debug 键先例 routes/settings.ts:83）。
- **PUT**（routes/settings.ts:313-330 样板）：`if (body.normalize_developer_role !== undefined)` 块，接受 `true`/`false`/`"true"`/`"false"`，其余 400 `invalid_normalize_developer_role`；写 `setDeveloperNormalizeFlag`。
- **env.ts**：不新增 Bindings（无 env 回退）。

### D6 UI（管理台系统设置）

四处最小改动（布尔开关样板 = SettingsView.tsx:243-258 的 require_invite_code checkbox）：

1. `core/types.ts`：`Settings` +1 字段 `normalize_developer_role: boolean`；`SettingsForm` +1 字段 `normalize_developer_role: string`（表单态布尔以 `"true"`/`"false"` 承载，见 types.ts:328 注释）。
2. `core/constants.ts`：`initialSettingsForm` 默认 `"false"`。
3. `AdminApp.tsx`：`loadSettings`（230-263）映射 +1 行；`handleSettingsSubmit`（670-722）payload +1 行。
4. `SettingsView.tsx`：checkbox 块放在代理/重试设置分组附近，文案：
   - 标题「developer 角色归一化」
   - 说明「开启后，透传请求体中 developer 角色的消息将改写为 system 再发往上游（兼容智谱 GLM 等不识别 developer 角色的上游）。注意：developer 指令优先级语义会降级为 system；对原生支持 developer 的 OpenAI 官方端点建议保持关闭。」

### D7 测试设计

| 文件 | 内容 | 参照 |
|---|---|---|
| `tests/developer-normalize.test.ts`（新） | 纯函数矩阵：单/多 developer 保序改名、多模态 part 保留、空内容保留、tool 不动、responses input 变体（message+developer 改名 / function_call·reasoning 不动 / 非数组 input / 无 input）、修改与否返回值 | tests/format-converter-anthropic.test.ts 纯调用风格 |
| `tests/proxy-developer-normalize.test.ts`（新） | `buildChannelRequest` 矩阵：flag off 字节级透传（AC1）、flag on × chat/responses 透传改名、× disguisePrompt 组合单次 stringify、custom/anthropic/转换分支不受 flag 影响 | 直接 import 纯函数调用 |
| `tests/developer-role-setting.test.ts`（新） | 解析器 matrix（缺失/`"true"`/`"false"`/脏值→false）、`loadDeveloperNormalizeFlagDirect`、写入器严格布尔、GET 表单真相、PUT 校验与 400 | tests/debug-request-log.test.ts 的 makeDb / makeMutableSettingsDb / settingsApp.request 样板 |
| `tests/proxy-settings-cache.test.ts`（改） | 四键断言 → 五键 | :93-114 |

### D8 文档同步（Phase 3.3）

- `AGENTS.md` §8 增补一条：developer 归一化开关的行为、默认关闭、作用分支、custom 例外、30s 生效窗口。
- `.trellis/spec/api-worker/backend/settings-config.md` §3 Contracts 布尔键变体补本键记录（两级读取链：无 env 回退的退化形态）。

## 2. 兼容性 / 回滚

- 默认关闭 → 部署后行为零变化；关闭即回滚（无需回滚代码）。
- 不新增迁移、不新增表列（settings 键值表天然承载）；UI 字段缺失时（旧前端 + 新后端）PUT 不带键即走「全部键未命中 → settings_empty」既有语义，无兼容坑。
- `buildChannelRequest` 新参数为末位可选，既有调用与测试编译期兼容。

## 3. 已知边界（不做的事）

- anthropic 入站 openai 目标 catch-all 分支（format-converter.ts:644-653）对非法输入 `role:"developer"` 的理论透出不处理。
- custom 独占渠道不归一化（协议未知，改写有损透传语义）。
- 不做 developer→user、渠道级粒度、env 回退。
- 400/1214 不重试策略不变（归一化是前置规避，不是错误恢复）。
