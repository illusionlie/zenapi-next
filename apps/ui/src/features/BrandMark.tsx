/**
 * 全站品牌标记：主名 `ZenAPI`（字号/字重/字体完全随所在位置继承，不做任何改动）
 * + 右侧小号 `Next` pill 徽章。所有品牌显示位统一复用本组件，只允许按所在
 * 位置的字号密度选档（sm 顶栏 text-sm / md 侧栏导航 text-lg / lg 登录注册卡片 text-2xl），
 * 徽章视觉语言（amber 描边 pill）全站一致。
 *
 * a11y：整块作为品牌名被读出——外层 `role="img"` + `aria-label="ZenAPI Next"`
 * （遵循 component-guidelines 信息性元素约定，避免读成「ZenAPI」「Next」两个碎片）。
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
		<span>ZenAPI</span>
		<span
			class={`inline-flex items-center rounded-full border border-amber-300/70 bg-amber-50 font-['Space_Grotesk'] font-semibold tracking-normal text-amber-700 ${badgeSizeClasses[size]}`}
		>
			Next
		</span>
	</span>
);
