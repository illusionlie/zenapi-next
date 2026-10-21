# 设置开关：developer 角色透传归一化（developer→system）

## Goal

在管理台「系统设置」新增布尔开关（默认**关闭**），开启后代理透传路径把请求体中 `role: "developer"` 的消息**原位改名**为 `system` 角色再发往上游，解决部分 OpenAI 兼容上游（典型：智谱 GLM coding plan）不识别 developer 角色而返回 400（如 `{"code":"1214","message":"角色信息不正确"}`）的问题。

背景诊断见会话记忆 `glm-1214-developer-role`（2026-10-20）：developer 角色唯一能裸透传到上游的是 openai 协议族透传路径；anthropic / responses 目标的转换器已内置 developer 并入 system 的 hoist 逻辑。

## Requirements

### R1 开关本体

- settings 键 `normalize_developer_role`，严格布尔（存 `"true"` / `"false"`），**默认关闭**。
- 读取链：settings 存储值（严格 `"true"`/`"false"`）→ 缺失/脏值降级默认 `false`。**无 env 回退**（新键，无历史包袱，区别于 debug_request_body_log 的三级链）。
- 管理台 GET `/api/settings` 返回有效值（表单真相，绕热路径缓存直读）；PUT 严格布尔校验，非法值 400 `invalid_normalize_developer_role`。
- 管理台「系统设置」UI 可见、可切换，含说明文案（说明适用场景：不识别 developer 角色的上游，如智谱 GLM；开启的代价：developer 指令优先级语义降级为 system）。

### R2 归一化语义（开启时）

- **原位改名**：`developer` → `system`，保序、保内容（含多模态 content part 与空内容），不移动消息位置、不合并相邻 system。
- **作用范围（用户已拍板「覆盖全部透传路径」，精确化为 openai 协议族的两处裸透传）**：
  - chat completions 入站 + openai 目标的裸透传分支：`messages` 数组中 `role === "developer"` 的消息改名为 `system`；
  - `/v1/responses` 入站 + responses 目标的原生透传分支：`input` 数组中 `type === "message" && role === "developer"` 的 item 改名为 `system`。
- **绝不触碰**：`role: "tool"` 及其他角色；responses 体中 `function_call` / `function_call_output` / `reasoning` 等非 message item。
- **作用调用方**：主代理（`/v1`）、Playground（`/api/playground`）、渠道单模型测试（`/test-model`）三处 `buildChannelRequest` 调用方行为一致，均受开关控制。

### R3 已有安全路径保持不变

- chat→anthropic、chat→responses、responses→chat 转换分支的 developer hoist 逻辑**不改**（已安全）；anthropic 入站三条目标路径不改（合法输入不可能产生 developer）。

### R4 性能与兼容

- 开关关闭（默认）时：**零行为变化、零额外开销**——透传保持字节级原样，不解析、不重序列化。
- 开关开启时：仅当体中确实存在 developer 消息才拷贝重写并重序列化；与伪装提示词（disguisePrompt）同时生效时共享同一次拷贝/序列化（先归一化、后注入伪装）。
- 热路径**零新增数据库查询**：新键并入现有 `PROXY_SETTING_KEYS`，随 `loadProxySettingsCached` 单查询 + 30s TTL 缓存；管理台变更生效陈旧窗口 ≤30s。

### R5 明确不做（范围外）

- custom 独占渠道的透传**不归一化**（custom 上游协议未知，透传语义即「不解释」，与端点覆盖/伪装注入的既有边界一致）。
- 不做 developer→user 模式、不做渠道级粒度、不做 env 回退。
- 不处理 anthropic 入站 openai 目标 catch-all 分支对非法输入 `role:"developer"` 的理论透出（well-formed 请求不可能出现）。
- 不改变 400 非 5xx 不重试的既有策略。

## 约束

- 遵循仓库 Biome 规范（tab 缩进、双引号）；提交前 `bun run check && bun run typecheck && bun run test` 全绿。
- 新逻辑放 services 层（`format-converter.ts` 归一化纯函数、`settings.ts` 设置管道），routes 薄壳。
- 错误码 snake_case，先例 `invalid_debug_request_body_log` → 本键 `invalid_normalize_developer_role`。
- 同步更新 `tests/proxy-settings-cache.test.ts` 的单查询键清单断言（现锁死四键）。
- 文档同步：AGENTS.md §8 行为清单 + `.trellis/spec/api-worker/backend/settings-config.md` 布尔键变体记录。

## Acceptance Criteria

- [ ] AC1 默认关闭回归：settings 无该键时，chat 透传与 responses 原生透传的出站 body 与入站 requestText 字节一致（新增断言），现有全部测试不回退。
- [ ] AC2 归一化矩阵（纯函数单测）：单/多条 developer 原位改名保序；多模态 content part 保留；空内容消息保留（仅改名）；`tool` 消息不动；无 developer 时返回原引用（不触发重序列化）。
- [ ] AC3 responses 透传矩阵：`input` 中 message+developer 改名；function_call / function_call_output / reasoning item 不动；无 input 或非数组时原样透传不崩溃。
- [ ] AC4 `buildChannelRequest` 接线测试：flag 开/关 × (chat 裸透传 / responses 原生透传 / 与 disguisePrompt 组合) 出站 body 断言；组合时仅一次重序列化语义（先改名后注入伪装）。
- [ ] AC5 三调用方一致：主代理、Playground、渠道单模型测试均传入解析后的开关值（各有对应读点）。
- [ ] AC6 设置管道：GET 返回有效值（直读不受 30s 缓存影响）；PUT 接受 true/false/"true"/"false"，其余 400 `invalid_normalize_developer_role`；解析器对缺失/脏值返回 false（单测覆盖，镜像 debug 键 resolver matrix 写法）。
- [ ] AC7 缓存契约：`PROXY_SETTING_KEYS` 含新键后单查询键清单断言更新为五键；TTL 过期与 per-db 隔离测试仍绿。
- [ ] AC8 UI：系统设置出现开关（默认勾选态为关），切换并保存后回读正确。
- [ ] AC9 门禁：`bun run check && bun run typecheck && bun run test` 全绿。
- [ ] AC10 文档：AGENTS.md §8 增补行为条目；settings-config.md §3 布尔键变体补记录。
