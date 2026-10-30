import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "hono/jsx/dom";
import { createApiFetch } from "./core/api";
import { userTabs } from "./core/constants";
import { toast } from "./core/toast";
import type {
	ModelMonitoringData,
	PublicModelItem,
	Token,
	UsageLog,
	User,
	UserDashboardData,
	UserTabId,
} from "./core/types";
import { toggleStatus } from "./core/utils";
import { BrandMark } from "./features/BrandMark";
import { ModelMonitoringView } from "./features/ModelMonitoringView";
import { SecretValueModal } from "./features/SecretValueModal";
import { UserDashboard } from "./features/UserDashboard";
import { UserModelsView } from "./features/UserModelsView";
import { UserTokensView } from "./features/UserTokensView";
import { UserUsageView } from "./features/UserUsageView";
import type { SkeletonVariant } from "./features/ViewSkeleton";
import { ViewSkeleton } from "./features/ViewSkeleton";

export type ModelAliasConfig = {
	aliases: string[];
	alias_only: boolean;
};

export type ModelAliasesMap = Record<string, ModelAliasConfig>;

type UserAppProps = {
	token: string;
	user: User;
	updateToken: (next: string | null) => void;
	onNavigate: (path: string) => void;
	linuxdoEnabled: boolean;
	onUserRefresh: () => void;
};

const normalizePath = (path: string) => {
	if (path.length <= 1) return "/";
	return path.replace(/\/+$/, "") || "/";
};

const userTabToPath: Record<UserTabId, string> = {
	dashboard: "/user",
	monitoring: "/user/monitoring",
	models: "/user/models",
	tokens: "/user/tokens",
	usage: "/user/usage",
};

const userPathToTab: Record<string, UserTabId> = {
	"/user": "dashboard",
	"/user/monitoring": "monitoring",
	"/user/models": "models",
	"/user/tokens": "tokens",
	"/user/usage": "usage",
};

// tab → 骨架屏变体:按内容布局归类(与 userTabToPath 同层,两端 tab 集合不同故不做全局常量)
const userTabToSkeletonVariant: Record<UserTabId, SkeletonVariant> = {
	dashboard: "stats",
	monitoring: "generic",
	models: "table",
	tokens: "table",
	usage: "table",
};

export const UserApp = ({
	token,
	user,
	updateToken,
	onNavigate,
	linuxdoEnabled,
	onUserRefresh,
}: UserAppProps) => {
	const [activeTab, setActiveTab] = useState<UserTabId>(() => {
		const normalized = normalizePath(window.location.pathname);
		return userPathToTab[normalized] ?? "dashboard";
	});
	const [loading, setLoading] = useState(false);
	const [dashboardData, setDashboardData] = useState<UserDashboardData | null>(
		null,
	);
	const [models, setModels] = useState<PublicModelItem[]>([]);
	const [tokens, setTokens] = useState<Token[]>([]);
	const [usage, setUsage] = useState<UsageLog[]>([]);
	const [monitoring, setMonitoring] = useState<ModelMonitoringData | null>(
		null,
	);
	const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [secretModal, setSecretModal] = useState<{
		title: string;
		value: string;
	} | null>(null);
	// 令牌编辑态:仅名称 + 模型白名单(额度字段仅管理员可改,服务端拒绝)
	const [editingToken, setEditingToken] = useState<Token | null>(null);
	// 令牌分页:与管理端同款前端切片模式(design D2)
	const [tokenPage, setTokenPage] = useState(1);
	const [tokenPageSize, setTokenPageSize] = useState(10);

	// Handle Linux DO bind callback parameters
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const bindOk = params.get("linuxdo_bindok");
		const bindError = params.get("linuxdo_binderror");
		const rechargeOk = params.get("recharge");
		if (bindOk) {
			history.replaceState(null, "", "/user");
			toast.success("Linux DO 账号绑定成功");
			onUserRefresh();
		} else if (bindError) {
			history.replaceState(null, "", "/user");
			const errorMessages: Record<string, string> = {
				missing_token: "绑定失败：缺少令牌",
				invalid_token: "绑定失败：令牌无效或已过期",
				user_not_found: "绑定失败：用户不存在",
				already_bound: "绑定失败：已绑定 Linux DO 账号",
				linuxdo_already_taken: "绑定失败：该 Linux DO 账号已被其他用户绑定",
				invalid_bind_cookie: "绑定失败：绑定状态无效",
			};
			toast.error(errorMessages[bindError] ?? `绑定失败：${bindError}`);
		} else if (rechargeOk === "ok") {
			history.replaceState(null, "", "/user");
			toast.success("充值成功，余额已更新");
			onUserRefresh();
		}
	}, [onUserRefresh]);

	const apiFetch = useMemo(
		() => createApiFetch(token, () => updateToken(null)),
		[token, updateToken],
	);

	const loadDashboard = useCallback(async () => {
		const data = await apiFetch<UserDashboardData>("/api/u/dashboard");
		setDashboardData(data);
	}, [apiFetch]);

	const loadModels = useCallback(async () => {
		const result = await apiFetch<{ models: PublicModelItem[] }>(
			"/api/u/models",
		);
		setModels(result.models);
	}, [apiFetch]);

	const loadTokens = useCallback(async () => {
		const result = await apiFetch<{ tokens: Token[] }>("/api/u/tokens");
		setTokens(result.tokens);
	}, [apiFetch]);

	const loadUsage = useCallback(async () => {
		const result = await apiFetch<{ logs: UsageLog[] }>(
			"/api/u/usage?limit=200",
		);
		setUsage(result.logs);
	}, [apiFetch]);

	const loadMonitoring = useCallback(async () => {
		const data = await apiFetch<ModelMonitoringData>(
			"/api/u/monitoring?range=15m",
		);
		setMonitoring(data);
	}, [apiFetch]);

	const handleMonitoringLoaded = useCallback((data: ModelMonitoringData) => {
		setMonitoring(data);
	}, []);

	const loadedTabs = useRef<Set<string>>(new Set<string>());

	const loadTab = useCallback(
		async (tabId: UserTabId) => {
			if (!loadedTabs.current?.has(tabId)) setLoading(true);
			try {
				if (tabId === "dashboard") await loadDashboard();
				if (tabId === "monitoring") await loadMonitoring();
				if (tabId === "models") await loadModels();
				if (tabId === "tokens") {
					await loadTokens();
					await loadModels();
				}
				if (tabId === "usage") await loadUsage();
				loadedTabs.current?.add(tabId);
			} catch (error) {
				toast.error((error as Error).message);
			} finally {
				setLoading(false);
			}
		},
		[loadDashboard, loadMonitoring, loadModels, loadTokens, loadUsage],
	);

	useEffect(() => {
		loadTab(activeTab);
	}, [activeTab, loadTab]);

	useEffect(() => {
		const handlePopState = () => {
			const normalized = normalizePath(window.location.pathname);
			setActiveTab(userPathToTab[normalized] ?? "dashboard");
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	const handleTabChange = useCallback((tabId: UserTabId) => {
		const nextPath = userTabToPath[tabId];
		const normalized = normalizePath(window.location.pathname);
		if (normalized !== nextPath) {
			history.pushState(null, "", nextPath);
		}
		setActiveTab(tabId);
		setMobileMenuOpen(false);
	}, []);

	const handleLogout = useCallback(async () => {
		await apiFetch("/api/u/auth/logout", { method: "POST" }).catch(() => null);
		updateToken(null);
	}, [apiFetch, updateToken]);

	const handleLinuxdoUnbind = useCallback(async () => {
		try {
			await apiFetch("/api/u/auth/linuxdo/unbind", { method: "POST" });
			toast.success("Linux DO 账号已解除绑定");
			onUserRefresh();
		} catch (error) {
			toast.error((error as Error).message);
		}
	}, [apiFetch, onUserRefresh]);

	const handleTokenCreate = useCallback(
		async (
			name: string,
			allowedModels: string[],
			expiresAt: string,
			rpmLimit: string,
		) => {
			try {
				const result = await apiFetch<{ token: string }>("/api/u/tokens", {
					method: "POST",
					body: JSON.stringify({
						name,
						// 有效期:空串 = 永久(null);ISO 串由后端校验须晚于当前时刻
						expires_at: expiresAt.trim() === "" ? null : expiresAt,
						// RPM 上限三态:空串 = 跟随全局默认(null);0 = 显式不限;正整数 = 上限
						rpm_limit: rpmLimit.trim() === "" ? null : Number(rpmLimit),
						// 仅在选择模型时携带;缺省由服务端落 NULL(不限制)
						...(allowedModels.length > 0
							? { allowed_models: allowedModels }
							: {}),
					}),
				});
				toast.success("令牌已创建");
				setSecretModal({ title: "新令牌已创建", value: result.token });
				await loadTokens();
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadTokens],
	);

	// 编辑提交:名称 + 模型白名单 + 有效期(空串 = 永久)
	const openTokenEdit = useCallback((target: Token) => {
		setEditingToken(target);
	}, []);

	const closeTokenEdit = useCallback(() => setEditingToken(null), []);

	const handleTokenEditSubmit = useCallback(
		async (data: {
			name: string;
			allowedModels: string[];
			expiresAt: string;
			rpmLimit: string;
		}) => {
			if (!editingToken) return;
			try {
				await apiFetch(`/api/u/tokens/${editingToken.id}`, {
					method: "PATCH",
					body: JSON.stringify({
						name: data.name,
						// 恒传数组:空数组 = 清回不限制
						allowed_models: data.allowedModels,
						// 恒传有效期:空串转 null = 永久(已过期令牌改到未来即刻恢复)
						expires_at: data.expiresAt.trim() === "" ? null : data.expiresAt,
						// RPM 上限三态:空串 = 跟随全局默认(null);0 = 显式不限;正整数 = 上限
						rpm_limit:
							data.rpmLimit.trim() === "" ? null : Number(data.rpmLimit),
					}),
				});
				toast.success("令牌已更新");
				closeTokenEdit();
				await loadTokens();
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, closeTokenEdit, editingToken, loadTokens],
	);

	// 候选来源:/api/u/models 已按用户级白名单过滤,天然是安全候选池
	const loadUserModelCandidates = useCallback(async (): Promise<string[]> => {
		const result = await apiFetch<{ models: PublicModelItem[] }>(
			"/api/u/models",
		);
		return result.models.map((m) => m.id);
	}, [apiFetch]);

	const handleTokenDelete = useCallback(
		async (id: string) => {
			try {
				await apiFetch(`/api/u/tokens/${id}`, { method: "DELETE" });
				await loadTokens();
				toast.success("令牌已删除");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadTokens],
	);

	const handleTokenReveal = useCallback(
		async (id: string) => {
			try {
				const result = await apiFetch<{ token: string | null }>(
					`/api/u/tokens/${id}/reveal`,
				);
				if (!result.token) {
					toast.error("未找到令牌");
					return;
				}
				try {
					await navigator.clipboard.writeText(result.token);
					toast.success("令牌已复制到剪贴板");
				} catch {
					setSecretModal({ title: "令牌详情", value: result.token });
				}
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch],
	);

	// 令牌分页与管理端同款:全量列表 + 前端切片,删除后页码越界自动回退
	const tokenTotal = tokens.length;
	const tokenTotalPages = useMemo(
		() => Math.max(1, Math.ceil(tokenTotal / tokenPageSize)),
		[tokenTotal, tokenPageSize],
	);
	const pagedTokens = useMemo(() => {
		const start = (tokenPage - 1) * tokenPageSize;
		return tokens.slice(start, start + tokenPageSize);
	}, [tokens, tokenPage, tokenPageSize]);

	useEffect(() => {
		setTokenPage((prev) => Math.min(prev, tokenTotalPages));
	}, [tokenTotalPages]);

	const handleTokenPageChange = useCallback(
		(next: number) => setTokenPage(next),
		[],
	);

	const handleTokenPageSizeChange = useCallback((next: number) => {
		setTokenPageSize(next);
		setTokenPage(1);
	}, []);

	// 启停自己的令牌:status 已对用户端 PATCH 放开(额度/渠道字段仍 admin-only)
	const handleUserTokenToggle = useCallback(
		async (id: string, status: string) => {
			try {
				const next = toggleStatus(status);
				await apiFetch(`/api/u/tokens/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ status: next }),
				});
				await loadTokens();
				toast.success(`令牌已${next === "active" ? "启用" : "停用"}`);
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadTokens],
	);

	const toggleMobileMenu = useCallback(
		() => setMobileMenuOpen((prev) => !prev),
		[],
	);

	const activeLabel = useMemo(
		() => userTabs.find((tab) => tab.id === activeTab)?.label ?? "用户面板",
		[activeTab],
	);

	const renderContent = () => {
		if (loading) {
			return (
				<ViewSkeleton
					variant={userTabToSkeletonVariant[activeTab] ?? "generic"}
				/>
			);
		}
		if (activeTab === "dashboard") {
			return (
				<UserDashboard
					data={dashboardData}
					user={user}
					token={token}
					updateToken={updateToken}
					linuxdoEnabled={linuxdoEnabled}
					onUnbind={handleLinuxdoUnbind}
					onUserRefresh={onUserRefresh}
				/>
			);
		}
		if (activeTab === "monitoring") {
			return (
				<ModelMonitoringView
					monitoring={monitoring}
					token={token}
					onLoaded={handleMonitoringLoaded}
				/>
			);
		}
		if (activeTab === "models") {
			return <UserModelsView models={models} />;
		}
		if (activeTab === "tokens") {
			return (
				<UserTokensView
					pagedTokens={pagedTokens}
					tokenPage={tokenPage}
					tokenPageSize={tokenPageSize}
					tokenTotal={tokenTotal}
					tokenTotalPages={tokenTotalPages}
					onCreate={handleTokenCreate}
					onPageChange={handleTokenPageChange}
					onPageSizeChange={handleTokenPageSizeChange}
					onToggle={handleUserTokenToggle}
					onDelete={handleTokenDelete}
					onReveal={handleTokenReveal}
					editingToken={editingToken}
					onEdit={openTokenEdit}
					onCloseEditModal={closeTokenEdit}
					onEditSubmit={handleTokenEditSubmit}
					onFetchModelCandidates={loadUserModelCandidates}
				/>
			);
		}
		if (activeTab === "usage") {
			return <UserUsageView usage={usage} />;
		}
		return null;
	};

	return (
		<div class="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] lg:grid-cols-[260px_1fr] lg:grid-rows-none">
			{/* Mobile top bar */}
			<div class="sticky top-0 z-40 flex items-center justify-between border-b border-stone-200 bg-white px-4 py-3 lg:hidden">
				<button
					class="flex h-10 w-10 items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900"
					type="button"
					aria-label="切换菜单"
					onClick={toggleMobileMenu}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						stroke-width="2"
						stroke="currentColor"
						class="h-5 w-5"
						aria-hidden="true"
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

			{/* Mobile overlay(常驻渲染:closing 动画期间保持挂载;closed 态可见性/命中由 .drawer-root 处理) */}
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
					onClick={toggleMobileMenu}
					onKeyDown={(e) => {
						if ((e as KeyboardEvent).key === "Escape") toggleMobileMenu();
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
						<span class="text-xs text-stone-500">
							{user.name} ({user.email})
						</span>
					</div>
					<nav class="flex flex-col gap-2.5">
						{userTabs.map((tab) => (
							<button
								class={`flex h-11 w-full items-center rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
									activeTab === tab.id
										? "bg-stone-100 text-stone-900"
										: "text-stone-500 hover:bg-stone-100 hover:text-stone-900"
								}`}
								type="button"
								onClick={() => {
									handleTabChange(tab.id);
									toggleMobileMenu();
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
							onClick={handleLogout}
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
					<span class="text-xs text-stone-500">
						{user.name} ({user.email})
					</span>
				</div>
				<nav class="flex flex-col gap-2.5">
					{userTabs.map((tab) => (
						<button
							class={`flex h-11 w-full items-center rounded-xl px-3.5 py-2.5 text-left text-sm font-medium transition-colors ${
								activeTab === tab.id
									? "bg-stone-100 text-stone-900"
									: "text-stone-500 hover:bg-stone-100 hover:text-stone-900"
							}`}
							type="button"
							onClick={() => handleTabChange(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</nav>
				<div class="mt-8 border-t border-stone-200 pt-4">
					<button
						type="button"
						class="mb-3 block w-full text-center text-xs text-stone-400 hover:text-stone-600"
						onClick={() => onNavigate("/admin")}
					>
						管理后台
					</button>
					<button
						class="h-11 w-full rounded-lg border border-stone-200 bg-transparent px-4 py-2.5 text-sm font-semibold text-stone-500 transition-colors hover:text-stone-900"
						type="button"
						onClick={handleLogout}
					>
						退出
					</button>
				</div>
			</aside>

			<main class="px-4 pt-4 pb-16 sm:px-6 sm:pt-6 md:px-10 md:pt-8">
				<div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h1
							key={activeLabel}
							class="t-view-enter font-['Space_Grotesk'] text-xl md:text-2xl tracking-tight text-stone-900"
						>
							{activeLabel}
						</h1>
						<p class="text-sm text-stone-500">
							余额: ${user.balance.toFixed(2)}
						</p>
					</div>
					<div class="hidden sm:flex items-center gap-3">
						<span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
							{user.email}
						</span>
						<button
							class="h-11 rounded-lg border border-stone-200 bg-transparent px-4 py-2.5 text-sm font-semibold text-stone-500 transition-colors hover:text-stone-900"
							type="button"
							onClick={handleLogout}
						>
							退出
						</button>
					</div>
				</div>
				<div key={activeTab} class="t-view-enter">
					{renderContent()}
				</div>
			</main>
			<SecretValueModal
				isOpen={secretModal !== null}
				title={secretModal?.title ?? ""}
				value={secretModal?.value ?? ""}
				onClose={() => setSecretModal(null)}
			/>
		</div>
	);
};
