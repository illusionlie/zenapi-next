import type { TabId, TabItem } from "../core/types";
import { BrandMark } from "./BrandMark";

type AppLayoutProps = {
	tabs: TabItem[];
	activeTab: TabId;
	activeLabel: string;
	token: string | null;
	isMobileMenuOpen: boolean;
	onTabChange: (tabId: TabId) => void;
	onToggleMobileMenu: () => void;
	onLogout: () => void;
	onNavigate: (path: string) => void;
	children?: unknown;
};

/**
 * Renders the admin app layout with responsive sidebar/hamburger menu.
 */
export const AppLayout = ({
	tabs,
	activeTab,
	activeLabel,
	token,
	isMobileMenuOpen,
	onTabChange,
	onToggleMobileMenu,
	onLogout,
	onNavigate,
	children,
}: AppLayoutProps) => (
	<div class="grid h-screen grid-cols-1 grid-rows-[auto_1fr] lg:grid-cols-[260px_1fr] lg:grid-rows-none overflow-hidden">
		{/* Mobile top bar */}
		<div class="sticky top-0 z-40 flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3 lg:hidden">
			<button
				class="flex h-10 w-10 items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900"
				type="button"
				onClick={onToggleMobileMenu}
				aria-label="Toggle menu"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
					stroke-width="2"
					stroke="currentColor"
					class="h-5 w-5"
					role="img"
					aria-label="Menu icon"
				>
					{isMobileMenuOpen ? (
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M6 18L18 6M6 6l12 12"
						/>
					) : (
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
						/>
					)}
				</svg>
			</button>
			<button
				type="button"
				class="font-['Space_Grotesk'] text-sm font-semibold tracking-tight text-stone-900"
				onClick={() => onNavigate("/")}
			>
				<BrandMark size="sm" />
			</button>
			<div class="w-10" />
		</div>

		{/* Mobile overlay drawer(常驻渲染:closing 动画期间保持挂载;closed 态可见性/命中由 .drawer-root 处理) */}
		<div
			class="fixed inset-0 z-50 lg:hidden drawer-root"
			data-open={isMobileMenuOpen ? "true" : "false"}
		>
			<button
				type="button"
				class={`absolute inset-0 bg-stone-900/40 transition-opacity duration-[350ms] ${
					isMobileMenuOpen ? "opacity-100" : "opacity-0 pointer-events-none"
				}`}
				tabIndex={-1}
				onClick={onToggleMobileMenu}
				onKeyDown={(e) => {
					if ((e as KeyboardEvent).key === "Escape") onToggleMobileMenu();
				}}
			/>
			<aside
				class="t-drawer absolute left-0 top-0 h-full w-[280px] border-r border-stone-200 bg-white px-5 py-8 shadow-xl"
				data-open={isMobileMenuOpen ? "true" : "false"}
			>
				<div class="mb-8 flex flex-col gap-1.5">
					<button
						type="button"
						class="font-['Space_Grotesk'] text-lg font-semibold tracking-tight text-stone-900 text-left"
						onClick={() => onNavigate("/")}
					>
						<BrandMark size="md" />
					</button>
					<span class="text-xs uppercase tracking-widest text-stone-500">
						console
					</span>
				</div>
				<nav class="flex flex-col gap-2.5">
					{tabs.map((tab) => (
						<button
							class={`flex h-11 w-full items-center rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
								activeTab === tab.id
									? "bg-stone-100 text-stone-900"
									: "text-stone-500 hover:bg-stone-100 hover:text-stone-900"
							}`}
							type="button"
							onClick={() => {
								onTabChange(tab.id);
								onToggleMobileMenu();
							}}
						>
							{tab.label}
						</button>
					))}
				</nav>
				<div class="mt-8 border-t border-stone-200 pt-4">
					<button
						class="h-11 w-full rounded-lg border border-stone-200 bg-transparent px-4 py-2.5 text-sm font-semibold text-stone-500 transition-colors hover:text-stone-900"
						type="button"
						onClick={onLogout}
					>
						退出
					</button>
				</div>
			</aside>
		</div>

		{/* Desktop sidebar */}
		<aside class="hidden border-b border-stone-200 bg-white px-5 py-8 lg:sticky lg:top-0 lg:block lg:h-screen lg:border-b-0 lg:border-r">
			<div class="mb-8 flex flex-col gap-1.5">
				<button
					type="button"
					class="font-['Space_Grotesk'] text-lg font-semibold tracking-tight text-stone-900 text-left"
					onClick={() => onNavigate("/")}
				>
					<BrandMark size="md" />
				</button>
				<span class="text-xs uppercase tracking-widest text-stone-500">
					console
				</span>
			</div>
			<nav class="flex flex-col gap-2.5">
				{tabs.map((tab) => (
					<button
						class={`flex h-11 w-full items-center rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
							activeTab === tab.id
								? "bg-stone-100 text-stone-900"
								: "text-stone-500 hover:bg-stone-100 hover:text-stone-900"
						}`}
						type="button"
						onClick={() => onTabChange(tab.id)}
					>
						{tab.label}
					</button>
				))}
			</nav>
		</aside>
		<main class="flex flex-col overflow-hidden px-4 pt-4 sm:px-6 sm:pt-6 md:px-10 md:pt-8">
			<div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between shrink-0">
				<div>
					<h1
						key={activeLabel}
						class="t-view-enter font-['Space_Grotesk'] text-xl md:text-2xl tracking-tight text-stone-900"
					>
						{activeLabel}
					</h1>
					<p class="text-sm text-stone-500">
						集中管理渠道、模型、令牌与使用情况。
					</p>
				</div>
				<div class="hidden sm:flex items-center gap-3">
					<span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
						{token ? "已登录" : "未登录"}
					</span>
					<button
						class="h-11 rounded-lg border border-stone-200 bg-transparent px-4 py-2.5 text-sm font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
						type="button"
						onClick={onLogout}
					>
						退出
					</button>
				</div>
			</div>
			<div class="flex-1 min-h-0 overflow-y-auto pb-8">{children}</div>
		</main>
	</div>
);
