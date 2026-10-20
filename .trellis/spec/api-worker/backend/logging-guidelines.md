# Logging Guidelines

> How logging is done in this project (evidence-based from `apps/worker/src`).

---

## Overview

Worker 端**没有日志库**，统一使用 `console.*`（Cloudflare Workers 的 `console.*` 会输出到 wrangler tail / Workers Logs）。日志调用点为方括号前缀标签 + 结构化载荷的形态（`console.log` 为主，另有 1 处 P0 批准的计费收尾 `console.error` 例外，见下）。**不要引入 pino/winston 等日志库**——Workers 环境没有文件句柄，原生 console 即是平台惯例。

---

## Conventions

### Convention: 全局请求日志由 index.ts 中间件负责

**What**: `index.ts` 有两个全局日志中间件：`hono/logger`（`app.use("*", logger())`）输出标准请求行；自定义中间件**两态**（2026-10-19 P2 起）：默认 `console.log("[request]", { method, path })`，**不 clone 不解析请求体**；settings `debug_request_body_log=true`（30s TTL 缓存读取，加载失败降级 false）时恢复完整形态 `console.log("[request]", { method, path, content_type, body_type, body_keys, body_size })`。

**Why**: 请求侧可观测性集中在入口，路由文件内零请求日志。新路由**不需要**自己打请求日志。body 解析默认关闭：每请求 clone + 全量 json() 是纯 CPU/内存税（长对话体数百 KB、双重解析），开启仅用于调试期。

### Convention: 业务日志用方括号前缀 + 对象载荷

**What**: 现有业务日志形如 `console.log("[usage] ${label}", { ...结构化字段 })`（`proxy.ts` 的 usage 记录）。前缀标签定位模块，载荷是平面对象（one-level，不嵌套）。

**Why**: wrangler tail 输出为单行 JSON，方括号前缀便于人眼 grep；平面载荷保证 `JSON.stringify` 可读。

### Convention: 失败路径靠 jsonError 返回给客户端，不靠日志

**What**: 错误统一经 `utils/http.ts` 的 `jsonError(c, status, message, code?)` 返回；上游渠道失败详情记入 `usage_logs` 表（含 status/error 信息）而非打印。**已批准例外（2026-10-19 P0）**：`services/usage.ts` 计费 batch 失败走 `console.error("[usage] billing batch failed", { ... })`——该失败发生在响应已交给客户端之后（waitUntil 收尾），jsonError 无处可返，日志是唯一可见性手段。

**Why**: Workers 无持久 stderr，落库才是可查询的事实来源。调试期可临时 `console.log`，但提交前应移除或转为落库字段。「响应后收尾失败」类日志须遵循同一形态（`[tag]` 前缀 + 平面载荷），且不得用于能把错误返回客户端的场景。

---

## What NOT to log

- API key / token 明文（含 `Authorization` 头、`x-api-key`、channels 表的 `api_key` 字段内容）。
- 用户密码、session hash。
- 完整请求/响应 body（proxy 场景体积大且可能含用户内容；只记元数据）。

---

## Severity guidance

| 场景 | 手段 |
|------|------|
| 请求进出 | `hono/logger` + `[request]` 中间件（已有，勿重复） |
| 关键业务事件（usage 记账、重试换渠道） | `console.log("[tag]", {...})` 或落库 |
| 错误返回客户端 | `jsonError()`，不打印 |
| 响应后收尾失败（计费 batch 等，waitUntil 内） | `console.error("[tag]", {...})`，不 rethrow |
| 可查询的失败历史 | `usage_logs` 表字段 |
