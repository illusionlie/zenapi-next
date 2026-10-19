# Backend Development Guidelines — api-worker

> `apps/worker`（Cloudflare Workers + Hono + D1）后端规范索引。内容均来自真实代码与任务教训，随任务持续增补。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | index.ts 唯一挂载点、鉴权放行清单、routes 薄壳 + services 下沉 | ✅ Filled |
| [Database Guidelines](./database-guidelines.md) | D1 迁移与 schema.sql 同步、幂等性分层（Migrations 章节已填，Query Patterns 待补） | 🟡 Partial |
| [Error Handling](./error-handling.md) | jsonError 统一错误形态、snake_case 错误码 | 🟡 Partial |
| [Quality Guidelines](./quality-guidelines.md) | 提交门禁（check/typecheck/test）、Biome 规则、命名、禁则 | ✅ Filled |
| [Logging Guidelines](./logging-guidelines.md) | console.* 前缀标签惯例、错误靠 jsonError/落库不打日志 | ✅ Filled |
| [Proxy Headers](./proxy-headers.md) | 上游请求头策略契约（全局注入/剔除/渠道级）、settings 新增配置项标准链路 | ✅ Filled |
| [Settings Config](./settings-config.md) | 数值型 settings 契约与 env→settings 迁移模式（三级回退链、读宽写严、clamp 三层一致） | ✅ Filled |
| [Format Conversion](./format-conversion.md) | 协议转换器契约（chat↔anthropic、chat↔responses 双向）：usage 末 chunk 惯例与口径换算、thinking 映射、fail-open 部件丢弃、流式不变量 | ✅ Filled |
| [Channel Routing](./channel-routing.md) | 渠道多格式能力声明与统一路由矩阵（api_formats 双写、偏好序 selectTargetFormat、base_url 规范化、探测并集契约） | ✅ Filled |
| [PATCH Update Semantics](./patch-update-semantics.md) | 资源更新三态语义（undefined保留/null清除/值设置）与纯函数 resolver 模式 | ✅ Filled |
| [Usage Accounting](./usage-accounting.md) | usage 解析→落库→聚合口径（缓存字段优先级链、Anthropic 折算防二次叠加、SSE raw 层逐字段合并、NULL≠0 分母） | ✅ Filled |
| [Turnstile Auth](./turnstile-auth.md) | 登录入口人机验证契约（enforceTurnstile 接线、fail-open 边界、secret 零回显、错误码族） | ✅ Filled |

---

## Sources

- `AGENTS.md`（agent 规范唯一事实来源，本目录与其互补不重复）
- 真实任务教训：`4fac541` D1 迁移/错误处理、`0b09027` 质量门禁 0 error

**Language**: 与 AGENTS.md 一致，中文为主。
