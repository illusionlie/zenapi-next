/**
 * 全站品牌标记：禅门 mark（墨底方圆 + 纸白缺口圆环 + 圆心朱点，inline SVG；
 * 几何契约与独立母版见 docs/assets/logo.svg，任务 11-06-brand-icon）+ 主名 `ZenAPI`
 * （字号/字重/字体完全随所在位置继承，不做任何改动）+ 右侧小号 `Next` pill 徽章。
 * 所有品牌显示位统一复用本组件，只允许按所在位置的字号密度选档（sm 顶栏 text-sm /
 * md 侧栏导航 text-lg / lg 登录注册卡片 text-2xl），徽章视觉语言（amber 描边 pill）全站一致。
 * 图标以 1.15em 定尺寸，随所在档位字号自动缩放，无需逐档调参。
 *
 * a11y：整块作为品牌名被读出——外层 `role="img"` + `aria-label="ZenAPI Next"`
 * （遵循 component-guidelines 信息性元素约定，避免读成「ZenAPI」「Next」两个碎片）；
 * 内嵌图标为纯装饰，`aria-hidden` 不进可读名。
 */
type BrandMarkProps = {
	/** 徽章尺寸档位，按所在位置主名字号选档；默认 md。 */
	size?: "sm" | "md" | "lg";
};

const badgeSizeClasses: Record<NonNullable<BrandMarkProps["size"]>, string> = {
	sm: "px-1.5 py-px text-[9px]",
	md: "px-2 py-0.5 text-[10px]",
	lg: "px-2 py-0.5 text-xs",
};

export const BrandMark = ({ size = "md" }: BrandMarkProps) => (
	<span
		class="inline-flex items-center gap-1.5"
		role="img"
		aria-label="ZenAPI Next"
	>
		<svg
			viewBox="0 0 512 512"
			aria-hidden="true"
			class="h-[1.15em] w-[1.15em] shrink-0"
		>
			<rect width="512" height="512" rx="112" fill="#1E2024" />
			<path
				d="M402.2 222.3A150 150 0 1 1 289.7 109.8"
				fill="none"
				stroke="#F5F1E8"
				stroke-width="34"
				stroke-linecap="round"
			/>
			<circle cx="256" cy="256" r="46" fill="#D9482E" />
		</svg>
		<span>ZenAPI</span>
		<span
			class={`inline-flex items-center rounded-full border border-amber-300/70 bg-amber-50 font-['Space_Grotesk'] font-semibold tracking-normal text-amber-700 ${badgeSizeClasses[size]}`}
		>
			Next
		</span>
	</span>
);
