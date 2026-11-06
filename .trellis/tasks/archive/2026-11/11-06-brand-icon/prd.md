# PRD: 品牌图标「禅门」全站落地

> 轻量任务（PRD-only）。设计方案已于 2026-11-06 会话中由用户拍板，本 PRD 附逐字节设计契约，实现不得偏移几何与颜色。

## 背景

- 项目此前**零品牌资产**：`apps/ui/index.html` 无任何 favicon 引用、无 `public/` 目录，浏览器标签页为默认图标。
- 拍板方案为「禅门」：墨底方圆 + 纸白缺口圆环（ensō，缺口朝右上 45° = 出口语义）+ 圆心一枚朱点（`/v1/` 的「1」/ 健康状态点语义）。
- 品牌位现状：`apps/ui/src/features/BrandMark.tsx` 是全站唯一品牌组件（管理台 AppLayout / 用户端 UserApp / 公共登录注册页共用，sm/md/lg 三档，纯文字 `ZenAPI` + amber `Next` pill）。

## 设计契约（几何与颜色固定，逐字节实现）

三份 SVG 的根元素均 `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`。

**母版 `logo.svg`**（品牌标准形，供文档/外部引用与 UI 内嵌）：

```svg
<rect width="512" height="512" rx="112" fill="#1E2024"/>
<path d="M402.2 222.3A150 150 0 1 1 289.7 109.8" fill="none" stroke="#F5F1E8" stroke-width="34" stroke-linecap="round"/>
<circle cx="256" cy="256" r="46" fill="#D9482E"/>
```

- 圆环缺口朝右上 45°、跨 64°（弧 296°，sweep=1）；圆心朱点 r=46；内缘半径 133 > 46，留白充分。
- 最大半径 167（150+17 描边半宽）< maskable 安全区 205，未来做 PWA 圆角裁切零风险。

**16px 光学修正版 `favicon.svg`**（描边加粗、朱点放大、缺口加宽，供浏览器标签页）：

```svg
<rect width="512" height="512" rx="112" fill="#1E2024"/>
<path d="M405.4 242.9A150 150 0 1 1 269.1 106.6" fill="none" stroke="#F5F1E8" stroke-width="48" stroke-linecap="round"/>
<circle cx="256" cy="256" r="58" fill="#D9482E"/>
```

**单色版 `logo-mono.svg`**（透明底、全墨 `#1E2024`，单色/浅色文档场景降级）：

```svg
<path d="M402.2 222.3A150 150 0 1 1 289.7 109.8" fill="none" stroke="#1E2024" stroke-width="34" stroke-linecap="round"/>
<circle cx="256" cy="256" r="46" fill="#1E2024"/>
```

色板三色封顶：墨 `#1E2024` × 纸 `#F5F1E8` × 朱 `#D9482E`，禁渐变。

## 交付物

1. `apps/ui/public/favicon.svg` —— 光学修正版几何（新建 `public/` 目录，Vite 自动拷贝进 dist 并由 Worker Static Assets 托管）。
2. `docs/assets/logo.svg` + `docs/assets/logo-mono.svg` —— 独立品牌母版（新建目录），**这是用户点名要求的"单独文件用于文档或其他地方引用"**。
3. `apps/ui/index.html`：`<head>` 内 `<title>` 前增 `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`。
4. `apps/ui/src/features/BrandMark.tsx`：组件前置禅门 mark——母版几何 inline SVG（hono/jsx，属性用 `class`/kebab-case），置于 `ZenAPI` 文字左侧，按 size 档位取图标边长：sm≈16 / md≈20 / lg≈28（px，实现可 ±2 微调对齐基线）；同步更新组件头部文档注释与 a11y 说明。amber `Next` pill 与文字部分**保持不变**。
5. `README.md`：`# ZenAPI Next` 标题行下加 `<p align="center"><img src="docs/assets/logo.svg" width="120" alt="ZenAPI Next" /></p>`（GitHub 渲染相对路径可用）。

## 约束

- **零新依赖**：不引光栅化工具链（sharp/resvg 等）；PNG / .ico / apple-touch-icon 不在本期。
- UI 内嵌用 inline SVG 组件而非 `<img src>`（避免运行时多一次请求，且与 `public/`、`docs/` 三处几何同源同契约）。
- 墨底方圆自承载背景色，深浅模式均可辨识，**不需要** `prefers-color-scheme` 分支。
- BrandMark 现有 sm/md/lg 用法共 12 处调用点零改动（图标随组件自动出现）。

## 验收标准

1. `bun run dev:ui` 打开后浏览器标签页显示禅门 favicon；`vite build` 后 `apps/ui/dist/` 含 `favicon.svg`。
2. 管理台侧栏/顶栏、用户端、登录/注册页的 BrandMark 均显示「图标 + ZenAPI + Next pill」，三档尺寸下图标与文字基线协调、无溢出换行。
3. README 在 GitHub 上渲染出 logo 图。
4. `bun run check && bun run typecheck && bun run test` 全绿。
5. 三份 SVG 文件内容与设计契约逐字节一致（空白/格式差异允许，属性值不允许）。

## 非目标

- apple-touch-icon / favicon.ico / PWA manifest 与 maskable PNG（无光栅化工具链，需要时另立项）。
- 「双弧」格式互转子标志。
- OG image 等社交分享卡片、邮件模板。
