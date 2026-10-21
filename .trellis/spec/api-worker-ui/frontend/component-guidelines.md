# Component Guidelines

> How components are built in this project.

---

## Overview

<!--
Document your project's component conventions here.

Questions to answer:
- What component patterns do you use?
- How are props defined?
- How do you handle composition?
- What accessibility standards apply?
-->

(To be filled by the team)

---

## Component Structure

<!-- Standard structure of a component file -->

(To be filled by the team)

---

## Props Conventions

<!-- How props should be defined and typed -->

(To be filled by the team)

---

## Styling Patterns

### 动效约定：motion tokens + 枚举过渡属性（09-15-ui-motion-polish 沉淀）

**What**: 全站过渡类禁止 `transition-all`，必须按实际过渡属性枚举；hover 位移类一律用 `ease-smooth-out`。

**Why**: `transition-all` 让无关属性（color/border）蹭车过渡，且 `hover:shadow-*` 场景逐帧重绘开销大；`ease-in-out` 的语义是 icon/text swap，不是 hover 位移。token 单一事实源在 `apps/ui/src/styles.css`。

**Token 位置**：
- `@theme` 内：`--ease-smooth-out`（Tailwind v4 自动生成 `ease-smooth-out` utility）、`--animate-toast-*` / `--animate-skeleton-shimmer`（生成 `animate-toast-*` / `animate-skeleton-shimmer`）
- `:root` 内：`--modal-*` / `--dropdown-*` / `--panel-*`（t-* 片段变量，运行时 JS 用 `getComputedStyle` 读取保持同源）、`--view-enter-dur` / `--page-enter-dur`（视图/页面入场动画时长）

**Example**:

```tsx
// hover 位移 + 阴影（lift 类）
class="transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg"
// hover 纯变色
class="transition-colors duration-200"
// hover 变色 + 阴影
class="transition-[color,background-color,border-color,box-shadow] duration-200"
```

**Reduced-motion**: 全局守卫在 styles.css 末尾（`prefers-reduced-motion: reduce` 时长归零），t-* 片段各自 guard 不得删。新增循环动画无需单独处理，但新增 t-* 片段必须连带其 guard。

---

## Modal 与进出场动画约定（09-15-ui-motion-polish 沉淀）

### Convention: 模态一律用 features/Modal.tsx 壳

**What**: 新增模态禁止手写 `fixed inset-0` 结构，用 `<Modal isOpen onClose sheet? backdropClass? panelClass?>`；容器持有 `isOpen` state、**常驻渲染**（不条件挂载），关闭动画由 Modal 内部状态机（closing → `--modal-close-dur` 后卸载）完成。

**Why**: 条件挂载 `{cond && <Modal isOpen>}` 会让出场动画失效（卸载即消失）；Modal 壳统一提供 backdrop fade、Esc（栈顶优先，防叠层连关丢草稿）、bottom-sheet 断点适配。

**移动端形态**：`sheet` prop（贴底 rise，`items-end md:items-center` 布局 + `.t-modal-sheet` 断点变换）；桌面居中 scale 走 `.t-modal` 原样。非 sheet 模态在移动端也会贴底（统一规格）。

**遗留条件挂载模态的迁移**：若模态内部 state 以 `useState(() => props初值)` 初始化、依赖容器条件挂载实现"打开时重置"（先例：ModelsView 编辑别名/价格），改容器常驻需引入边沿重置，得不偿失。标准迁移路径是**组件内 closing 包装**：容器/调用点零改动，state 语义不变 ——

```tsx
const [closing, setClosing] = useState(false);
const closeTimerRef = useRef<number | null>(null);
useEffect(() => () => {
	if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
}, []);
const handleClose = () => {
	if (closing) return;
	setClosing(true);
	const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--modal-close-dur")) || 150;
	closeTimerRef.current = window.setTimeout(onClose, duration);
};
// return <Modal isOpen={!closing} onClose={handleClose} ...>；组件内所有关闭入口（按钮/保存成功）统一走 handleClose
```

### Gotcha: hono/jsx/dom 的 data-* 布尔属性与 React 语义不同

> **Warning**: `data-open={someBool}` 在 hono 4.x dom renderer 下 `true` 渲染为 `data-open=""`、`false` 直接移除属性 —— CSS 选择器 `[data-open="true"]` 永远不匹配，开关型动画静默失效。

必须传字符串：`data-open={isOpen ? "true" : "false"}`（先例：AppLayout / UserApp 抽屉）。需要布尔属性语义的场合同理适用。

### Gotcha: .t-modal 的 transform 会为 fixed 后代创建 containing block

> **Warning**: `.t-modal` 恒有 `transform` + `will-change`，嵌套在它内部的 `fixed` 定位后代会被面板盒（含 `overflow-y-auto`）裁剪，不再是相对视口定位。

叠层浮层（如模型选择器叠在编辑模态上）必须作为编辑模态的**兄弟节点**渲染，不能嵌套进 `<form>` / overflow 容器内（先例：ChannelsView 模型选择浮层从 form 内外提）。同理注意 closing 期容器 state 置 null 会导致内容空洞 —— 需在 children 加 guard（先例：ChannelsView `fetchedModels !== null`、UsersView `showEditModal && editingUser`）。

### Convention: 关键帧动画 token 对齐 transitions.dev 口径

toast 出入场（350ms/250ms + `cubic-bezier(0.22,1,0.36,1)` + 16px rise + cross-blur）是全站 toast 的既定节奏；新动效优先对齐 `@theme`/`:root` 既有 token，不要新造硬编码时长。入场可带 cross-blur，退场从简（只 fade + 回落）。

### Convention: 视图/页面级切换过渡 = key 重挂载 + CSS animation（09-17-ui-tab-transitions-skeleton 沉淀）

**What**: 无退场需求的切换过渡（tab 切换、登录态分支跨越）标准做法是：容器 `key` 表达切换语义 + 元素挂 `.t-view-enter`（内容区/标题，250ms + 4px）或 `.t-page-enter`（整页分支，400ms + 16px）入场动画类。CSS `@keyframes` animation 在元素插入 DOM 时自动播放，key 变化重挂载时自动重播，零 JS 参与。

**Why**: key 重挂载（即时替换、无退场）场景下不需要 Modal 那套 transition + phase 状态机（`closed → entering → open → closing` + 双 rAF）——状态机的存在意义是退场动画，enter-only 绕开全部复杂度。快速连点无残影（旧节点直接销毁）。

**Example**:
```tsx
// 内容区包裹层（AdminApp/UserApp）
<div key={activeTab} class="t-view-enter">{renderContent()}</div>
// 页面标题（label 唯一映射 tab，key 用 activeLabel）
<h1 key={activeLabel} class="... t-view-enter">{activeLabel}</h1>
// 页面级分支（App.tsx，key 表见任务 design §4.5）
<div key="admin-app" class="... t-page-enter">...</div>
```

**边界**: key 必须表达「分支跨越」语义——同分支内 `setPath` 重渲染时 key 不变、动画不重播，这正是预期；hono dom renderer 对 `key !== undefined` 要求 key+tag 双匹配才复用节点（已实证 `dom/render.js`）。全站范围：不要给已有退场语义的组件（Modal/Drawer）改用此模式。

### Gotcha: 入场动画类的恒留 transform 会为 fixed/absolute 后代创建 containing block（09-17 回归教训）

> **Warning**: 入场动画类走 `transform + filter`，`fill-mode: both/forwards` 会在动画结束后**恒留** `transform: translateY(0)` + `filter: blur(0)`——非 `none` 值持续为后代创建 containing block：嵌套的 `fixed` 后代被包裹盒裁剪（`.t-modal` 同款问题），`absolute` 后代被重新锚定，且创建 stacking context。

**fill-mode 选择规则（09-17 回归后修正，勿再按子树排查）**：enter-only 动画若终帧 = 元素自然静止态（本项目 `.t-view-enter` / `.t-page-enter` 均如此），**一律用 `backwards`**——delay=0 时首帧行为与 `both` 完全一致，结束后释放 transform/filter，无条件安全。`both`/`forwards` 仅当终帧 ≠ 自然态、需要持久化终帧时才考虑，且届时必须先实证子树内无 fixed/absolute 外锚后代。

**回归先例（为何规则收紧）**：09-17 首版 `.t-view-enter` 曾用 `both`，check 阶段按「子树 grep fixed」判定安全（理由：模态是 AppLayout 兄弟节点）——但漏看了 Modal 壳不走 portal、各 View 的编辑弹窗（ChannelsView/TokensView/UsersView 等）都渲染在 renderContent 子树内，导致弹窗被关进内容区盒子并被 `<main overflow-hidden>` 裁剪。教训：**子树排查不可靠（嵌套层级深、后续新增组件不受控），优先选结构性安全的写法**。

**纵深防御**：即便 fill-mode 已用 `backwards`，动画播放期间（250ms 内）transform 仍存在——若需要在动画包裹层子树内加 fixed 浮层，优先 portal（先例：ToastHost、ModelAllowlistPicker）或提升为包裹层兄弟节点。

### Convention: 加载态三件套，禁止再内联手写（09-17-ui-tab-transitions-skeleton 沉淀）

**What**: 整页加载骨架用 `features/ViewSkeleton.tsx`（`variant: "stats" | "table" | "form" | "generic"`，映射表见 AdminApp/UserApp 的 `tabToSkeletonVariant`）；局部小加载用 `features/DotLoader.tsx`（三点 bounce，`role="status" aria-label="加载中"`，无色、调用方传 `class` 配色）；迷你骨架行直接组装 `ViewSkeleton` 导出的 `SkeletonBlock`（自带 `aria-hidden` 与 `.skeleton` shimmer 基类）。

**Why**: 三者收拢后 shimmer/bounce 节奏与 a11y 语义（live region 不嵌套：整页骨架套 `role="status"`、局部装饰块仅 `aria-hidden`）全站单一实现；新增加载态先查这三件，不要平行造轮子。

**边界**：`.skeleton` 是非分层规则，`background-color` / `border-radius` 不可被 Tailwind 工具类覆盖（会压过 utilities 层）——变体骨架块只传尺寸/间距类；`.t-view-enter` 恒留 transform 同时是脚枪，见上条 Warning。

**已知边缘遗留**：`UserDashboard.tsx` 的 `!data` 空值守卫仍有一处「加载中...」静态文字（正常流程触达不了，仅 dashboard 加载失败边缘态），清偿时换 `ViewSkeleton variant="stats"`。

---

## Accessibility

本节为 09-14-fix-ui-a11y-lint 清偿 24 个存量 a11y 错误后沉淀的实战约定，新 UI 代码直接沿用（ Biome a11y 规则全绿是质检门槛，见 quality-guidelines.md）。

### 表单 label：真实关联，不用 aria-label 伪装

`noLabelWithoutControl` 的正确修法是让 `<label>` 真正关联控件：`htmlFor`+`id`（首选）或控件嵌套进 `<label>`。禁止加 `aria-label` 后保留空 label 结构骗过 lint——点击聚焦是 label 的原生职责。

```tsx
// Correct：htmlFor+id 真实关联
<label htmlFor="user-create-name">用户名</label>
<input id="user-create-name" ... />

// Correct：纯提示文字不是 label，用 span
<span>可用模型（留空不限制）</span>

// Wrong：aria-label 伪装，点击不聚焦，骗 lint 而已
<label aria-label="用户名">用户名</label>
```

**模态内 id 必须加前缀防冲突**：创建/编辑双模态渲染同类表单时，用 `user-create-*` / `user-edit-*` 前缀隔离，避免重复 id 导致 htmlFor 关联错乱（先例：UsersView）。

### SVG：按语义分流

- **装饰性**（紧邻可读文本、纯视觉）：`aria-hidden="true"`，外加 icon-only button 场景在按钮层补 `aria-label`。
- **信息性**（图表、独立含义）：`role="img"` + `aria-label` 描述含义（先例：ModelsView 迷你趋势图）。不要一刀切全加 hidden。

### 可点击静态元素：直接改 `<button>`，不要 role="button"

> **Warning**：给 div 补 `role="button"` + `tabIndex` + 键盘事件虽然满足 `useKeyWithClickEvents`，但会立刻触发 Biome `useSemanticElements` 报错——等于从一个坑跳进另一个。

正确做法是直接语义化 `<button type="button">`：

- 行为等价性靠样式补齐：Tailwind v4 preflight 已重置 button 的 border/padding/background，原 div 类名照搬即可视觉零差异（先例：MonitoringView 柱条 div→button）。
- 模态背景点击关闭用 `absolute inset-0` 的 `<button>` + 内容层 `relative z-10`（先例：UsersView / App.tsx AnnouncementModal）——比 `e.target === e.currentTarget` 判断多出原生键盘可达性。

### 可展开表格行：行级点击 + 行内真按钮的键盘双触发守卫（10-21-usage-log-detail-expand 沉淀）

**Pattern**: 表格行展开详情（New API 风格）的标准结构——`Set<id>` state 管理多行独立展开、`pagedUsage.flatMap` 产出「数据行 + 条件详情行」扁平 `<tr>` 数组（显式 key，详情行 `${id}-detail`）、`columnCount` 常量供表头/空态/详情行 colSpan 三处同步引用（先例：UsageView）。

> **Gotcha**: 可点击 `<tr>` 为满足 `useKeyWithClickEvents` 写了行级 `onKeyDown`（Enter/Space），行内展开按钮又是行内唯一可聚焦控件时：按钮聚焦按 Enter/Space，keydown 从按钮**冒泡到 tr** 触发第一次 toggle，浏览器随后在按钮上**合成 click** 再触发第二次 toggle——若按钮只对 click 做 `stopPropagation`，两次 toggle 相互抵消，**键盘用户完全无法展开**（鼠标路径正常，问题零表象）。

**Fix**: 行级 `onKeyDown` 顶部加来源守卫早退，键盘激活完全交给按钮原生行为（按钮 click 已 stopPropagation 防行级双触发，恰好单次）：

```tsx
// Wrong：行级 keydown 不分来源 → 按钮键盘激活双触发净效果零
<tr onClick={toggle} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") toggle(); }}>

// Correct：keydown 只在事件源就是行自身时生效
<tr onClick={toggle} onKeyDown={(e) => {
	if (e.target !== e.currentTarget) return;
	if (e.key === "Enter" || e.key === " ") toggle();
}}>
```

（先例：UsageView `:362`；复核曾实际抓到该缺陷并修复。）

> **Gotcha**: `import { Fragment } from "hono/jsx/dom"` 直接 typecheck 失败（TS2786，dom runtime 的 Fragment 类型签名与 `jsxImportSource: hono/jsx/dom` 的元素类型检查不兼容）。组件返回「兄弟节点对」用 `flatMap` 返回数组方案替代 Fragment，语义等价且零类型风险。

---

## Common Mistakes

<!-- Component-related mistakes your team has made -->

(To be filled by the team)
