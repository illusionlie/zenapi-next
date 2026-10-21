# 执行计划 — 设置开关：developer 角色透传归一化（developer→system）

> 按依赖排序；每步末尾的验证命令须通过再进下一步。行号锚点见 design.md。

## Step 1 — format-converter.ts：归一化纯函数

- [ ] 新增 `normalizeChatDeveloperRole(body: Record<string, unknown>): boolean`：遍历 `messages` 数组，`role === "developer"` → 置 `"system"`；返回是否有修改；非数组返回 false。
- [ ] 新增 `normalizeResponsesDeveloperRole(body: Record<string, unknown>): boolean`：遍历 `input` 数组，`type === "message" && role === "developer"` → 置 `"system"`；返回是否有修改；非数组返回 false。
- [ ] 两函数注释标明：原位改名（保序保内容）与 hoist+拼接（openaiToAnthropicRequest / convertResponsesInputItem）的语义差异及选型理由。
- 验证：`bun run typecheck`

## Step 2 — services/settings.ts：设置管道

- [ ] `DEVELOPER_NORMALIZE_ROLE_KEY = "normalize_developer_role"` 键常量。
- [ ] `PROXY_SETTING_KEYS`（:538-543）加入新键（搭车 `loadProxySettingsCached` 单查询 + 30s TTL）。
- [ ] `resolveDeveloperNormalizeFlag(raw: SettingsRawMap): boolean` 纯解析器：严格 `"true"`/`"false"`，缺失/脏值 → `false`（无 envFallback 参数，与 debug 键的差异写注释）。
- [ ] `loadDeveloperNormalizeFlagDirect(db)` 直读变体（镜像 `loadDebugLogFlagDirect` :735-741）。
- [ ] `setDeveloperNormalizeFlag(db, value: boolean)` 写入器（严格存字符串，镜像 :746-755）。
- 验证：`bun run typecheck`

## Step 3 — routes/settings.ts：GET / PUT

- [ ] GET 响应 + `normalize_developer_role: await loadDeveloperNormalizeFlagDirect(c.env.DB)`（表单真相，绕缓存）。
- [ ] PUT 新增校验块（镜像 :313-330）：接受 `true`/`false`/`"true"`/`"false"`，其余 400 `invalid_normalize_developer_role`。
- 验证：`bun run typecheck`

## Step 4 — proxy.ts：buildChannelRequest 接线

- [ ] 签名新增末位可选参数 `normalizeDeveloperRole?: boolean`（默认 false）。
- [ ] openai 裸透传子分支（:312-341）：`shouldNormalize = flag && parsedBody?.messages 是数组`；与 disguisePrompt 合并「重写判定」，bodyCopy 内先归一化后注入伪装；「归一化返回 false 且无 disguise」时回退 `body = requestText`（守住无 developer 不重序列化）。
- [ ] responses 原生透传子分支（:212-225）：同模式，`normalizeResponsesDeveloperRole`。
- [ ] 其余分支（anthropic / responses 转换 / 非 chat 透传 / custom / openai 转换）显式不动，不加噪音分支。
- [ ] 主代理 handler（:781 调用点）：`resolveDeveloperNormalizeFlag(proxySettings)` 传入（`proxySettings` 已在 :584 取得，零新增查询）。
- 验证：`bun run typecheck`

## Step 5 — playground.ts / channels.ts：另两个调用方

- [ ] playground.ts:120 调用点：`loadProxySettingsCached(c.env.DB)` → 解析 → 传入。
- [ ] channels.ts:628（test-model）调用点：同上。
- 验证：`bun run typecheck`

## Step 6 — UI：管理台开关

- [ ] `core/types.ts`：`Settings.normalize_developer_role: boolean`；`SettingsForm.normalize_developer_role: string`。
- [ ] `core/constants.ts`：`initialSettingsForm` 默认 `"false"`。
- [ ] `AdminApp.tsx`：`loadSettings` 映射 +1；`handleSettingsSubmit` payload +1。
- [ ] `SettingsView.tsx`：checkbox（镜像 :243-258 样板），标题「developer 角色归一化」+ design.md D6 说明文案。
- 验证：`bun run typecheck`（UI workspaces）+ `bun run check`

## Step 7 — 测试

- [ ] `tests/developer-normalize.test.ts`（新）：design.md D7 纯函数矩阵。
- [ ] `tests/proxy-developer-normalize.test.ts`（新）：buildChannelRequest flag×分支×disguise 矩阵 + flag off 字节级透传断言（AC1）。
- [ ] `tests/developer-role-setting.test.ts`（新）：解析器 matrix、直读、写入器、GET 表单真相、PUT 400（镜像 debug-request-log.test.ts 的 makeDb / makeMutableSettingsDb / settingsApp.request 样板）。
- [ ] `tests/proxy-settings-cache.test.ts`：四键断言 → 五键（:93-114）。
- 验证：`bun run test`

## Step 8 — 全量门禁 + 文档

- [ ] `bun run check && bun run typecheck && bun run test` 全绿（AC9）。
- [ ] AGENTS.md §8 增补行为条目（AC10）。
- [ ] `.trellis/spec/api-worker/backend/settings-config.md` §3 布尔键变体补记录（AC10）。

## Review gates

- Gate A（Step 1-2 后）：归一化语义纯函数与解析器先行评审——确认「原位改名、不重序列化」语义与 D2/D4 一致，再动接线。
- Gate B（Step 4-5 后）：接线矩阵评审——对照 design.md 分支覆盖表逐分支核对「动/不动」。
- Gate C（Step 8 后，最后一轮 2.2 全范围检查）：trellis-check 全量门禁 + AC 清单逐项核对。

## 回滚点

- 每个 Step 独立可编译，可按 Step 粒度 `git checkout -- <files>` 回退。
- 运行期回滚 = 设置开关关闭（默认），无需代码回退。
