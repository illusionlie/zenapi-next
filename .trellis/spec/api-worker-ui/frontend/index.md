# Frontend Development Guidelines — api-worker-ui

> `apps/ui`（hono/jsx/dom + Vite + Tailwind v4 SPA）前端规范索引。内容均来自真实代码与任务教训。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | App 分发三层、core 基础设施、features 纯展示视图 | ✅ Filled |
| [Component Guidelines](./component-guidelines.md) | a11y 约定（htmlFor/aria）、语义化按钮、Tailwind 色系、动效 token 与 Modal 壳约定、品牌组件 BrandMark | ✅ Filled |
| [Quality Guidelines](./quality-guidelines.md) | 全仓 0-error 门禁、a11y 清偿记录、新增 UI 代码保持全绿 | ✅ Filled |
| [Hook Guidelines](./hook-guidelines.md) | 无自定义 hook、容器 hooks 惯用法、hono/jsx/dom 注意事项 | ✅ Filled |
| [State Management](./state-management.md) | 零状态库、容器集中持有 + props 单向下发、localStorage token | ✅ Filled |
| [Type Safety](./type-safety.md) | 类型集中在 core/types.ts、snake_case 直通、strict 门禁 | ✅ Filled |
| [Third-Party Widget](./third-party-widget.md) | 动态第三方脚本挂载模式（单例 loader、ref 渲染、resetSignal、卸载清理） | ✅ Filled |

---

## Sources

- `AGENTS.md` §3/§5（仓库布局与代码规范）
- 真实任务教训：`f6f9a9d` a11y 清偿、`0b09027` 质量门禁升级

**Language**: 与 AGENTS.md 一致，中文为主。
