import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "hono/jsx/dom";
import { createApiFetch } from "./core/api";
import {
	CHANNEL_ENDPOINT_OVERRIDE_FORMATS,
	initialChannelForm,
	initialData,
	initialSettingsForm,
	initialTokenForm,
	tabs,
} from "./core/constants";
import { toast } from "./core/toast";
import type {
	AdminData,
	BackupImportResult,
	Channel,
	ChannelEndpointOverrideKey,
	ChannelForm,
	ChannelFormatProbeResult,
	DashboardData,
	InviteCode,
	ModelItem,
	ModelTestResult,
	MonitoringData,
	Settings,
	SettingsForm,
	TabId,
	Token,
	TokenForm,
	UsageLog,
	User,
	Webhook,
	WebhookType,
} from "./core/types";
import {
	parseChannelApiFormats,
	parseEndpointOverrides,
	toggleStatus,
} from "./core/utils";
import { AppLayout } from "./features/AppLayout";
import { ChannelsView } from "./features/ChannelsView";
import { DashboardView } from "./features/DashboardView";
import { ModelsView } from "./features/ModelsView";
import { MonitoringView } from "./features/MonitoringView";
import { PlaygroundView } from "./features/PlaygroundView";
import { SecretValueModal } from "./features/SecretValueModal";
import { SettingsView } from "./features/SettingsView";
import { TokensView } from "./features/TokensView";
import { UsageView } from "./features/UsageView";
import { UsersView } from "./features/UsersView";
import type { SkeletonVariant } from "./features/ViewSkeleton";
import { ViewSkeleton } from "./features/ViewSkeleton";
import type { ModelAliasesMap } from "./UserApp";

type AdminAppProps = {
	token: string;
	updateToken: (next: string | null) => void;
	onNavigate: (path: string) => void;
};

const normalizePath = (path: string) => {
	if (path.length <= 1) return "/";
	return path.replace(/\/+$/, "") || "/";
};

const adminTabToPath: Record<TabId, string> = {
	dashboard: "/admin",
	monitoring: "/admin/monitoring",
	channels: "/admin/channels",
	models: "/admin/models",
	tokens: "/admin/tokens",
	usage: "/admin/usage",
	settings: "/admin/settings",
	users: "/admin/users",
	playground: "/admin/playground",
};

const adminPathToTab: Record<string, TabId> = {
	"/admin": "dashboard",
	"/admin/monitoring": "monitoring",
	"/admin/channels": "channels",
	"/admin/models": "models",
	"/admin/tokens": "tokens",
	"/admin/usage": "usage",
	"/admin/settings": "settings",
	"/admin/users": "users",
	"/admin/playground": "playground",
};

/**
 * 端点覆盖提交体：仅含当前选中非 custom 格式的键（未选格式的键不出现，
 * 规避后端 undeclared_format 400；custom 独占/全未选 → 空对象，无害）。
 * 键值恒传（空串 = 触发后端清除该键），且整个字段恒不省略以表达「以表单
 * 为准」——PATCH 语义中字段缺省 = 保留现值。
 *
 * Args:
 *   form: Current channel form state.
 *
 * Returns:
 *   endpoint_overrides payload object for POST/PATCH/fetch_models/test-model.
 */
const buildEndpointOverridesPayload = (
	form: ChannelForm,
): Partial<Record<ChannelEndpointOverrideKey, string>> => {
	const payload: Partial<Record<ChannelEndpointOverrideKey, string>> = {};
	for (const format of CHANNEL_ENDPOINT_OVERRIDE_FORMATS) {
		if (form.api_formats.includes(format)) {
			payload[format] = form.endpoint_overrides[format].trim();
		}
	}
	return payload;
};

// tab → 骨架屏变体:按内容布局归类(与 adminTabToPath 同层,两端 tab 集合不同故不做全局常量)
const tabToSkeletonVariant: Record<TabId, SkeletonVariant> = {
	dashboard: "stats",
	monitoring: "generic",
	channels: "table",
	models: "table",
	tokens: "table",
	usage: "table",
	settings: "form",
	users: "table",
	playground: "generic",
};

// 模型测试并发上限：每模型一次独立 API 调用（各自一个 Worker invocation，
// 仅 1 个子请求），并发 4 兼顾速度与上游限流（PRD 约束）
const MODEL_TEST_CONCURRENCY = 4;

export const AdminApp = ({ token, updateToken, onNavigate }: AdminAppProps) => {
	const [activeTab, setActiveTab] = useState<TabId>(() => {
		const normalized = normalizePath(window.location.pathname);
		return adminPathToTab[normalized] ?? "dashboard";
	});
	const [loading, setLoading] = useState(false);
	const [data, setData] = useState<AdminData>(initialData);
	const [settingsForm, setSettingsForm] =
		useState<SettingsForm>(initialSettingsForm);
	const [channelPage, setChannelPage] = useState(1);
	const [channelPageSize, setChannelPageSize] = useState(10);
	const [channelSearch, setChannelSearch] = useState("");
	const [tokenPage, setTokenPage] = useState(1);
	const [tokenPageSize, setTokenPageSize] = useState(10);
	const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
	const [channelForm, setChannelForm] = useState<ChannelForm>(() => ({
		...initialChannelForm,
	}));
	const [isChannelModalOpen, setChannelModalOpen] = useState(false);
	const [channelModelAliases, setChannelModelAliases] = useState<
		Record<string, ModelAliasesMap>
	>({});
	const [channelAliasState, setChannelAliasState] = useState<ModelAliasesMap>(
		{},
	);
	const [fetchingModels, setFetchingModels] = useState(false);
	const [fetchedModels, setFetchedModels] = useState<string[] | null>(null);
	const [fetchedSearch, setFetchedSearch] = useState("");
	const [selectedFetched, setSelectedFetched] = useState<Set<string>>(
		() => new Set<string>(),
	);
	const [modelTestResults, setModelTestResults] = useState<
		Record<string, ModelTestResult>
	>({});
	const [modelTestRunning, setModelTestRunning] = useState(false);
	// 模型测试会话代次：新批次/关闭弹窗时递增，使旧请求的写入失效
	const modelTestRunIdRef = useRef(0);
	// 当前批次的停止函数（闭包持有本地 stopped 标记），stopModelTests 调用
	const modelTestStopFnRef = useRef<(() => void) | null>(null);
	const [isTokenModalOpen, setTokenModalOpen] = useState(false);
	// 令牌编辑态(参照渠道编辑先例 editingChannel + channelForm)
	const [editingToken, setEditingToken] = useState<Token | null>(null);
	const [tokenForm, setTokenForm] = useState<TokenForm>(initialTokenForm);
	// 创建模态的白名单选择(受控提升至容器,遵循 state-management 规范;
	// openTokenCreate/提交成功时重置,等效「模态关闭时重置」)
	const [tokenCreateModels, setTokenCreateModels] = useState<Set<string>>(
		() => new Set<string>(),
	);
	// 创建模态的有效期(选择器解析后的 ISO;空串 = 永久),与 tokenCreateModels 同构管理
	const [tokenCreateExpiresAt, setTokenCreateExpiresAt] = useState("");
	const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);
	const [users, setUsers] = useState<User[]>([]);
	const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
	const [webhooks, setWebhooks] = useState<Webhook[]>([]);
	const [secretModal, setSecretModal] = useState<{
		title: string;
		value: string;
	} | null>(null);

	const apiFetch = useMemo(
		() => createApiFetch(token, () => updateToken(null)),
		[token, updateToken],
	);

	const loadDashboard = useCallback(async () => {
		const dashboard = await apiFetch<DashboardData>("/api/dashboard");
		setData((prev) => ({ ...prev, dashboard }));
	}, [apiFetch]);

	const loadMonitoring = useCallback(async () => {
		const monitoring = await apiFetch<MonitoringData>(
			"/api/monitoring?range=15m",
		);
		setData((prev) => ({ ...prev, monitoring }));
	}, [apiFetch]);

	const loadChannels = useCallback(async () => {
		const result = await apiFetch<{
			channels: Channel[];
			channel_aliases?: Record<string, ModelAliasesMap>;
		}>("/api/channels");
		setData((prev) => ({ ...prev, channels: result.channels }));
		setChannelModelAliases(result.channel_aliases ?? {});
	}, [apiFetch]);

	const loadModels = useCallback(async () => {
		const result = await apiFetch<{ models: ModelItem[] }>("/api/models");
		setData((prev) => ({ ...prev, models: result.models }));
	}, [apiFetch]);

	const loadTokens = useCallback(async () => {
		const result = await apiFetch<{ tokens: Token[] }>("/api/tokens");
		setData((prev) => ({ ...prev, tokens: result.tokens }));
	}, [apiFetch]);

	const loadUsage = useCallback(async () => {
		const result = await apiFetch<{ logs: UsageLog[] }>("/api/usage?limit=200");
		setData((prev) => ({ ...prev, usage: result.logs }));
	}, [apiFetch]);

	const loadSettings = useCallback(async () => {
		const settings = await apiFetch<Settings>("/api/settings");
		setData((prev) => ({ ...prev, settings }));
		setSettingsForm({
			log_retention_days: String(settings.log_retention_days ?? 30),
			session_ttl_hours: String(settings.session_ttl_hours ?? 12),
			admin_password: "",
			registration_mode: settings.registration_mode ?? "open",
			checkin_reward: String(settings.checkin_reward ?? 0.5),
			require_invite_code: settings.require_invite_code ? "true" : "false",
			default_balance: String(settings.default_balance ?? 0),
			ldc_payment_enabled: settings.ldc_payment_enabled ? "true" : "false",
			ldc_epay_pid: settings.ldc_epay_pid ?? "",
			ldc_epay_key: settings.ldc_epay_key ?? "",
			ldc_epay_gateway:
				settings.ldc_epay_gateway ?? "https://credit.linux.do/epay",
			ldc_exchange_rate: String(settings.ldc_exchange_rate ?? 0.1),
			announcement: settings.announcement ?? "",
			proxy_extra_headers: settings.proxy_extra_headers ?? "",
			proxy_remove_headers: settings.proxy_remove_headers ?? "",
			proxy_retry_rounds: String(settings.proxy_retry_rounds ?? 2),
			proxy_retry_delay_ms: String(settings.proxy_retry_delay_ms ?? 200),
			// 客户端限流两键(GET 返回 clamp 后有效值,缺失回退 0 = 关闭)
			token_rpm_default: String(settings.token_rpm_default ?? 0),
			ip_auth_fail_limit: String(settings.ip_auth_fail_limit ?? 0),
			// 报警四键 + 日报开关(GET 返回 clamp 后有效值)
			alert_failure_rate_pct: String(settings.alert_failure_rate_pct ?? 50),
			alert_min_samples: String(settings.alert_min_samples ?? 5),
			alert_silence_minutes: String(settings.alert_silence_minutes ?? 30),
			alert_window_minutes: String(settings.alert_window_minutes ?? 15),
			daily_report_enabled: settings.daily_report_enabled ? "true" : "false",
			normalize_developer_role: settings.normalize_developer_role
				? "true"
				: "false",
			model_test_prompt: settings.model_test_prompt ?? "",
			turnstile_enabled: settings.turnstile_enabled ? "true" : "false",
			turnstile_site_key: settings.turnstile_site_key ?? "",
			turnstile_secret_key: "",
		});
		if (settings.require_invite_code) {
			const result = await apiFetch<{ codes: InviteCode[] }>(
				"/api/invite-codes",
			);
			setInviteCodes(result.codes);
		}
	}, [apiFetch]);

	const loadUsers = useCallback(async () => {
		const result = await apiFetch<{ users: User[] }>("/api/users");
		setUsers(result.users);
	}, [apiFetch]);

	const loadWebhooks = useCallback(async () => {
		const result = await apiFetch<{ webhooks: Webhook[] }>("/api/webhooks");
		setWebhooks(result.webhooks);
	}, [apiFetch]);

	const loadModelCandidates = useCallback(async (): Promise<string[]> => {
		const result = await apiFetch<{ models: ModelItem[] }>("/api/models");
		return result.models.map((m) => m.id);
	}, [apiFetch]);

	const loadTab = useCallback(
		async (tabId: TabId) => {
			setLoading(true);
			try {
				if (tabId === "dashboard") await loadDashboard();
				if (tabId === "monitoring") await loadMonitoring();
				if (tabId === "channels") {
					await loadChannels();
					await loadSettings();
				}
				if (tabId === "models") await loadModels();
				if (tabId === "tokens") await loadTokens();
				if (tabId === "usage") await loadUsage();
				if (tabId === "settings") {
					await loadSettings();
					await loadWebhooks();
				}
				if (tabId === "users") await loadUsers();
				if (tabId === "playground") {
					/* no data to preload */
				}
			} catch (error) {
				toast.error((error as Error).message);
			} finally {
				setLoading(false);
			}
		},
		[
			loadChannels,
			loadDashboard,
			loadModels,
			loadMonitoring,
			loadSettings,
			loadTokens,
			loadUsage,
			loadUsers,
			loadWebhooks,
		],
	);

	useEffect(() => {
		loadTab(activeTab);
	}, [activeTab, loadTab]);

	useEffect(() => {
		const handlePopState = () => {
			const normalized = normalizePath(window.location.pathname);
			setActiveTab(adminPathToTab[normalized] ?? "dashboard");
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	const handleLogout = useCallback(async () => {
		await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => null);
		updateToken(null);
	}, [apiFetch, updateToken]);

	const handleChannelFormChange = useCallback((patch: Partial<ChannelForm>) => {
		setChannelForm((prev) => ({ ...prev, ...patch }));
	}, []);

	const handleSettingsFormChange = useCallback(
		(patch: Partial<SettingsForm>) => {
			setSettingsForm((prev) => ({ ...prev, ...patch }));
		},
		[],
	);

	const handleChannelPageChange = useCallback(
		(next: number) => setChannelPage(next),
		[],
	);
	const handleChannelPageSizeChange = useCallback((next: number) => {
		setChannelPageSize(next);
		setChannelPage(1);
	}, []);
	const handleChannelSearchChange = useCallback((value: string) => {
		setChannelSearch(value);
		setChannelPage(1);
	}, []);
	const handleTokenPageChange = useCallback(
		(next: number) => setTokenPage(next),
		[],
	);
	const handleTokenPageSizeChange = useCallback((next: number) => {
		setTokenPageSize(next);
		setTokenPage(1);
	}, []);

	const handleTabChange = useCallback((tabId: TabId) => {
		const nextPath = adminTabToPath[tabId];
		const normalized = normalizePath(window.location.pathname);
		if (normalized !== nextPath) {
			history.pushState(null, "", nextPath);
		}
		setActiveTab(tabId);
		setMobileMenuOpen(false);
	}, []);

	const toggleMobileMenu = useCallback(
		() => setMobileMenuOpen((prev) => !prev),
		[],
	);

	const closeChannelModal = useCallback(() => {
		// 使在途模型测试请求的写入失效并停止调度，清理结果（PRD：结果仅存
		// 在于当前弹窗会话）
		modelTestRunIdRef.current += 1;
		modelTestStopFnRef.current?.();
		modelTestStopFnRef.current = null;
		setModelTestResults({});
		setModelTestRunning(false);
		setEditingChannel(null);
		setChannelForm({ ...initialChannelForm });
		setChannelAliasState({});
		setChannelModalOpen(false);
	}, []);

	const openChannelCreate = useCallback(() => {
		setEditingChannel(null);
		setChannelForm({ ...initialChannelForm });
		setChannelAliasState({});
		setChannelModalOpen(true);
	}, []);

	const openTokenCreate = useCallback(() => {
		setTokenCreateModels(new Set());
		setTokenCreateExpiresAt("");
		setTokenModalOpen(true);
	}, []);

	const handleTokenCreateModelsChange = useCallback((next: Set<string>) => {
		setTokenCreateModels(next);
	}, []);

	const openTokenEdit = useCallback((target: Token) => {
		setEditingToken(target);
		setTokenForm({
			name: target.name,
			quota_total: target.quota_total == null ? "" : String(target.quota_total),
			quota_used: String(target.quota_used),
			allowed_models: [...(target.allowed_models ?? [])],
			// 已过期/未来时刻都回填为解析后的 ISO(选择器进「自定义」档);NULL → 空 = 永久
			expires_at: target.expires_at ?? "",
			// RPM 上限回填现值;NULL → 空 = 跟随全局默认
			rpm_limit: target.rpm_limit == null ? "" : String(target.rpm_limit),
		});
	}, []);

	const closeTokenEdit = useCallback(() => {
		setEditingToken(null);
		setTokenForm({ ...initialTokenForm });
	}, []);

	const handleTokenFormChange = useCallback((patch: Partial<TokenForm>) => {
		setTokenForm((prev) => ({ ...prev, ...patch }));
	}, []);

	const startChannelEdit = useCallback(
		(channel: Channel) => {
			setEditingChannel(channel);
			let modelsList = "";
			const modelIds: string[] = [];
			if (channel.models_json) {
				try {
					const parsed = JSON.parse(channel.models_json);
					const arr = Array.isArray(parsed)
						? parsed
						: Array.isArray(parsed?.data)
							? parsed.data
							: [];
					modelsList = arr
						.map((m: unknown) => {
							if (typeof m === "string") {
								modelIds.push(m);
								return m;
							}
							const obj = m as {
								id?: string;
								input_price?: number;
								output_price?: number;
								enabled?: boolean;
							};
							const id = obj?.id ?? "";
							if (!id) return "";
							modelIds.push(id);
							const ip = obj?.input_price;
							const op = obj?.output_price;
							const en = obj?.enabled;
							if (ip != null || op != null || en != null) {
								return `${id}|${ip ?? ""}|${op ?? ""}|${en === false ? "0" : "1"}`;
							}
							return id;
						})
						.filter(Boolean)
						.join("\n");
				} catch {
					/* ignore */
				}
			}
			setChannelForm({
				name: channel.name ?? "",
				base_url: channel.base_url ?? "",
				api_key: channel.api_key ?? "",
				weight: channel.weight ?? 1,
				// 读侧兜底链：api_formats JSON 串 → 镜像 api_format → ["openai"]
				api_formats: parseChannelApiFormats(channel),
				// 读侧容错解析：endpoint_overrides JSON 串 → 扁平形态（畸形 → 全空串）
				endpoint_overrides: parseEndpointOverrides(channel),
				custom_headers: channel.custom_headers_json ?? "",
				disguise_headers: channel.disguise_headers_json ?? "",
				disguise_system_prompt: channel.disguise_system_prompt ?? "",
				disguise_preset: channel.disguise_preset ?? "",
				// D1 INTEGER 原样（0/1）；缺省/脏值一律视为关
				probe_enabled: channel.probe_enabled === 1,
				models: modelsList,
			});
			// Initialize alias state from per-channel alias map for this channel's models
			const perChannelMap = channelModelAliases[channel.id] ?? {};
			const initial: ModelAliasesMap = {};
			for (const mid of modelIds) {
				if (perChannelMap[mid]) {
					initial[mid] = {
						aliases: [...perChannelMap[mid].aliases],
						alias_only: perChannelMap[mid].alias_only,
					};
				}
			}
			setChannelAliasState(initial);
			setChannelModalOpen(true);
		},
		[channelModelAliases],
	);

	const closeTokenModal = useCallback(() => setTokenModalOpen(false), []);

	const handleChannelSubmit = useCallback(
		async (event: Event) => {
			event.preventDefault();
			const channelName = channelForm.name.trim();
			const normalizedName = channelName.toLowerCase();
			const nameExists = data.channels.some(
				(channel) =>
					channel.name.trim().toLowerCase() === normalizedName &&
					channel.id !== editingChannel?.id,
			);
			if (nameExists) {
				toast.error("渠道名称已存在，请使用其他名称");
				return;
			}
			// 格式声明不可为空（后端对空数组返回 400 invalid_api_formats，前端先行拦截不发请求）
			if (channelForm.api_formats.length === 0) {
				toast.error("请至少选择一种 API 格式");
				return;
			}
			try {
				const modelsArray = channelForm.models
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean)
					.map((line) => {
						const parts = line.split("|");
						const id = parts[0].trim();
						const entry: {
							id: string;
							input_price?: number;
							output_price?: number;
							enabled?: boolean;
						} = { id };
						if (parts.length > 1 && parts[1].trim()) {
							entry.input_price = Number(parts[1].trim());
						}
						if (parts.length > 2 && parts[2].trim()) {
							entry.output_price = Number(parts[2].trim());
						}
						if (parts.length > 3) {
							// 4-segment format: id|input|output|enabled (legacy 5-segment
							// obsolete flag at index 3 is ignored)
							entry.enabled = parts[3].trim() !== "0";
						}
						return entry;
					});
				// Build model_aliases payload from alias state
				const modelIds = modelsArray.map((m) => m.id);
				const aliasPayload: Record<
					string,
					{ aliases: string[]; alias_only: boolean }
				> = {};
				for (const mid of modelIds) {
					if (channelAliasState[mid]) {
						aliasPayload[mid] = channelAliasState[mid];
					}
				}
				const body = {
					name: channelName,
					base_url: channelForm.base_url.trim(),
					api_key: channelForm.api_key.trim(),
					weight: Number(channelForm.weight),
					// 格式声明整体替换（api_formats 优先于 legacy 单值 api_format）
					api_formats: channelForm.api_formats,
					// 恒传对象（仅选中格式键）：空串 = 清除该键，缺省 = 保留现值
					endpoint_overrides: buildEndpointOverridesPayload(channelForm),
					custom_headers: channelForm.custom_headers.trim() || undefined,
					// 伪装字段恒传 trim 后的字符串：PATCH 空串 = 清除现值（AC1 清空保存即关闭伪装）
					disguise_headers: channelForm.disguise_headers.trim(),
					disguise_system_prompt: channelForm.disguise_system_prompt.trim(),
					// 服务端预设同构透传：空串 = 关闭预设（后端 trim-or-null），
					// 白名单值 = 启用；与快照伪装头/提示词互斥由表单交互保证
					disguise_preset: channelForm.disguise_preset.trim(),
					// 恒传布尔（表单即真相）：后端严格布尔归一 0/1，缺省 = 保留现值
					probe_enabled: channelForm.probe_enabled,
					models: modelsArray.length > 0 ? modelsArray : undefined,
					model_aliases:
						Object.keys(aliasPayload).length > 0 ? aliasPayload : undefined,
				};
				if (editingChannel) {
					await apiFetch(`/api/channels/${editingChannel.id}`, {
						method: "PATCH",
						body: JSON.stringify(body),
					});
					toast.success("渠道已更新");
				} else {
					await apiFetch("/api/channels", {
						method: "POST",
						body: JSON.stringify(body),
					});
					toast.success("渠道已创建");
				}
				closeChannelModal();
				await loadChannels();
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[
			apiFetch,
			channelForm,
			channelAliasState,
			closeChannelModal,
			data.channels,
			editingChannel,
			loadChannels,
		],
	);

	const handleTokenSubmit = useCallback(
		async (event: Event) => {
			event.preventDefault();
			const form = event.currentTarget as HTMLFormElement;
			const formData = new FormData(form);
			const payload = Object.fromEntries(formData.entries()) as Record<
				string,
				FormDataEntryValue
			>;
			try {
				const result = await apiFetch<{ token: string }>("/api/tokens", {
					method: "POST",
					body: JSON.stringify({
						name: payload.name,
						quota_total: payload.quota_total
							? Number(payload.quota_total)
							: null,
						// 有效期:空串 = 永久(null);ISO 串由后端校验须晚于当前时刻
						expires_at:
							tokenCreateExpiresAt.trim() === "" ? null : tokenCreateExpiresAt,
						// RPM 上限三态:空串 = 跟随全局默认(null);0 = 显式不限;正整数 = 上限
						rpm_limit:
							payload.rpm_limit === "" || payload.rpm_limit === undefined
								? null
								: Number(payload.rpm_limit),
						// 仅在选择模型时携带;缺省由服务端落 NULL(不限制)
						...(tokenCreateModels.size > 0
							? { allowed_models: [...tokenCreateModels] }
							: {}),
					}),
				});
				toast.success("令牌已创建");
				setSecretModal({ title: "新令牌已创建", value: result.token });
				form.reset();
				setTokenCreateModels(new Set());
				setTokenCreateExpiresAt("");
				setTokenModalOpen(false);
				setTokenPage(1);
				await loadTokens();
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadTokens, tokenCreateExpiresAt, tokenCreateModels],
	);

	// 编辑提交:三态 PATCH —— 额度总额空串→null(清回无限),已用额度清空提交即归零,
	// allowed_models 恒传数组(空数组 = 清回不限制),expires_at 恒传(空串→null = 永久)
	const handleTokenEditSubmit = useCallback(
		async (event: Event) => {
			event.preventDefault();
			if (!editingToken) return;
			try {
				await apiFetch(`/api/tokens/${editingToken.id}`, {
					method: "PATCH",
					body: JSON.stringify({
						name: tokenForm.name.trim(),
						quota_total:
							tokenForm.quota_total.trim() === ""
								? null
								: Number(tokenForm.quota_total),
						quota_used: Number(tokenForm.quota_used || 0),
						allowed_models: tokenForm.allowed_models,
						expires_at:
							tokenForm.expires_at.trim() === "" ? null : tokenForm.expires_at,
						// RPM 上限三态:空串 = 跟随全局默认(null);0 = 显式不限;正整数 = 上限
						rpm_limit:
							tokenForm.rpm_limit.trim() === ""
								? null
								: Number(tokenForm.rpm_limit),
					}),
				});
				toast.success("令牌已更新");
				closeTokenEdit();
				await loadTokens();
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, closeTokenEdit, editingToken, loadTokens, tokenForm],
	);

	const handleSettingsSubmit = useCallback(
		async (event: Event) => {
			event.preventDefault();
			const retention = Number(settingsForm.log_retention_days);
			const sessionTtlHours = Number(settingsForm.session_ttl_hours);
			const payload: Record<string, number | string | boolean> = {
				log_retention_days: retention,
				session_ttl_hours: sessionTtlHours,
				registration_mode: settingsForm.registration_mode,
				checkin_reward: Number(settingsForm.checkin_reward),
				require_invite_code: settingsForm.require_invite_code === "true",
				default_balance: Number(settingsForm.default_balance),
				ldc_payment_enabled: settingsForm.ldc_payment_enabled === "true",
				ldc_epay_pid: settingsForm.ldc_epay_pid,
				ldc_epay_key: settingsForm.ldc_epay_key,
				ldc_epay_gateway: settingsForm.ldc_epay_gateway,
				ldc_exchange_rate: Number(settingsForm.ldc_exchange_rate),
				announcement: settingsForm.announcement,
				proxy_extra_headers: settingsForm.proxy_extra_headers,
				proxy_remove_headers: settingsForm.proxy_remove_headers,
				proxy_retry_rounds: Number(settingsForm.proxy_retry_rounds),
				proxy_retry_delay_ms: Number(settingsForm.proxy_retry_delay_ms),
				token_rpm_default: Number(settingsForm.token_rpm_default),
				ip_auth_fail_limit: Number(settingsForm.ip_auth_fail_limit),
				alert_failure_rate_pct: Number(settingsForm.alert_failure_rate_pct),
				alert_min_samples: Number(settingsForm.alert_min_samples),
				alert_silence_minutes: Number(settingsForm.alert_silence_minutes),
				alert_window_minutes: Number(settingsForm.alert_window_minutes),
				daily_report_enabled: settingsForm.daily_report_enabled === "true",
				normalize_developer_role:
					settingsForm.normalize_developer_role === "true",
				model_test_prompt: settingsForm.model_test_prompt,
				turnstile_enabled: settingsForm.turnstile_enabled,
				turnstile_site_key: settingsForm.turnstile_site_key,
			};
			const password = settingsForm.admin_password.trim();
			if (password) {
				payload.admin_password = password;
			}
			// secret 永不回显：留空 = 不提交该键（服务端保留现值）；输入了才覆盖
			const turnstileSecret = settingsForm.turnstile_secret_key;
			if (turnstileSecret) {
				payload.turnstile_secret_key = turnstileSecret;
			}
			try {
				await apiFetch("/api/settings", {
					method: "PUT",
					body: JSON.stringify(payload),
				});
				await loadSettings();
				setSettingsForm((prev) => ({
					...prev,
					admin_password: "",
					turnstile_secret_key: "",
				}));
				toast.success("设置已更新");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadSettings, settingsForm],
	);

	const handleFetchModels = useCallback(async () => {
		if (!channelForm.base_url.trim()) {
			toast.error("请先填写 Base URL");
			return;
		}
		if (channelForm.api_formats.length === 0) {
			toast.error("请至少选择一种 API 格式");
			return;
		}
		setFetchingModels(true);
		try {
			const result = await apiFetch<{
				ok: boolean;
				models: string[];
				results?: ChannelFormatProbeResult[];
				probe_warnings?: string[];
			}>("/api/channels/fetch_models", {
				method: "POST",
				body: JSON.stringify({
					base_url: channelForm.base_url.trim(),
					api_key: channelForm.api_key.trim(),
					api_formats: channelForm.api_formats,
					// 与提交同构：仅选中格式键，让探测打在与保存一致的端点上
					endpoint_overrides: buildEndpointOverridesPayload(channelForm),
					custom_headers: channelForm.custom_headers.trim() || undefined,
					disguise_headers: channelForm.disguise_headers.trim(),
					disguise_system_prompt: channelForm.disguise_system_prompt.trim(),
				}),
			});
			// 多格式逐格式探测：部分失败不整体失败，轻量一行提示失败格式
			const failedFormats = (result.results ?? [])
				.filter((probe) => !probe.ok)
				.map((probe) => probe.api_format);
			if (failedFormats.length > 0) {
				toast.error(`部分格式探测失败：${failedFormats.join("、")}`);
			}
			setFetchedModels(result.models);
			// 默认全不选；仅预勾选模型列表中已存在的模型
			const existingIds = new Set(
				channelForm.models
					.split("\n")
					.map((line) => line.split("|")[0]?.trim() ?? "")
					.filter(Boolean),
			);
			setSelectedFetched(
				new Set(result.models.filter((id) => existingIds.has(id))),
			);
			setFetchedSearch("");
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setFetchingModels(false);
		}
	}, [apiFetch, channelForm]);

	const toggleFetchedModel = useCallback((modelId: string) => {
		setSelectedFetched((prev) => {
			const next = new Set(prev);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});
	}, []);

	const toggleAllFetched = useCallback((visible: string[], select: boolean) => {
		setSelectedFetched((prev) => {
			const next = new Set(prev);
			for (const id of visible) {
				if (select) next.add(id);
				else next.delete(id);
			}
			return next;
		});
	}, []);

	const confirmFetchedModels = useCallback(() => {
		if (!fetchedModels) return;
		const existingIds = new Set(
			channelForm.models
				.split("\n")
				.map((line) => line.split("|")[0]?.trim() ?? "")
				.filter(Boolean),
		);
		const additions: string[] = [];
		for (const id of fetchedModels) {
			if (selectedFetched.has(id) && !existingIds.has(id)) {
				additions.push(id);
			}
		}
		if (additions.length === 0) {
			setFetchedModels(null);
			toast.info("没有新模型可加入（已存在或未选择）");
			return;
		}
		const prefix =
			channelForm.models.length > 0 && !channelForm.models.endsWith("\n")
				? "\n"
				: "";
		setChannelForm((prev) => ({
			...prev,
			models: prev.models + prefix + additions.join("\n"),
		}));
		setFetchedModels(null);
		toast.success(`已加入 ${additions.length} 个模型`);
	}, [channelForm.models, fetchedModels, selectedFetched]);

	const cancelFetchedModels = useCallback(() => {
		setFetchedModels(null);
	}, []);

	const handleChannelTest = useCallback(
		async (id: string) => {
			try {
				const result = await apiFetch<{ models: Array<{ id: string }> }>(
					`/api/channels/${id}/test`,
					{ method: "POST" },
				);
				await loadChannels();
				toast.success(`连通测试完成，模型数 ${result.models?.length ?? 0}`);
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadChannels],
	);

	// 单模型真实请求测试。请求体始终携带编辑表单当前配置 + editingChannel?.id
	// （表单即真相：支持未保存渠道，也避免脏表单测到库中旧配置）；runId 用于
	// 新批次/关弹窗后在途请求的写入失效
	const runSingleModelTest = useCallback(
		async (model: string, text: string, runId: number) => {
			setModelTestResults((prev) => ({
				...prev,
				[model]: { status: "running" },
			}));
			try {
				const result = await apiFetch<{
					ok: boolean;
					elapsed: number;
					content?: string;
					error?: string;
				}>("/api/channels/test-model", {
					method: "POST",
					body: JSON.stringify({
						id: editingChannel?.id,
						base_url: channelForm.base_url.trim(),
						api_key: channelForm.api_key.trim(),
						// 目标格式由后端按 chat 偏好序从声明集选出
						api_formats: channelForm.api_formats,
						// 与提交同构：仅选中格式键，让测试打在与保存一致的端点上
						endpoint_overrides: buildEndpointOverridesPayload(channelForm),
						custom_headers: channelForm.custom_headers.trim(),
						disguise_headers: channelForm.disguise_headers.trim(),
						disguise_system_prompt: channelForm.disguise_system_prompt.trim(),
						// 表单即真相：服务端预设随测试请求透传（免费模型验收路径
						// test-model 必须与主代理渲染同一指纹）
						disguise_preset: channelForm.disguise_preset.trim(),
						model,
						text,
					}),
				});
				if (modelTestRunIdRef.current !== runId) return;
				setModelTestResults((prev) => ({
					...prev,
					[model]: {
						status: result.ok ? "success" : "failed",
						elapsed: result.elapsed,
						content: result.content,
						error: result.error,
					},
				}));
			} catch (error) {
				if (modelTestRunIdRef.current !== runId) return;
				setModelTestResults((prev) => ({
					...prev,
					[model]: {
						status: "failed",
						error: (error as Error).message,
					},
				}));
			}
		},
		[apiFetch, channelForm, editingChannel],
	);

	// 批量测试：并发 4 的 worker-pool（递归取下一个），逐个完成即写状态触发
	// 渲染；停止标记让未开始项保持 pending 并结束运行
	const runModelTests = useCallback(
		async (models: string[], text: string) => {
			if (models.length === 0) return;
			const runId = modelTestRunIdRef.current + 1;
			modelTestRunIdRef.current = runId;
			let stopped = false;
			modelTestStopFnRef.current = () => {
				stopped = true;
			};
			setModelTestRunning(true);
			setModelTestResults(
				Object.fromEntries(
					models.map((model) => [model, { status: "pending" as const }]),
				),
			);
			let nextIndex = 0;
			const runNext = async (): Promise<void> => {
				if (stopped) return;
				const index = nextIndex;
				if (index >= models.length) return;
				nextIndex = index + 1;
				await runSingleModelTest(models[index], text, runId);
				await runNext();
			};
			await Promise.all(
				Array.from(
					{ length: Math.min(MODEL_TEST_CONCURRENCY, models.length) },
					() => runNext(),
				),
			);
			if (modelTestRunIdRef.current === runId) {
				setModelTestRunning(false);
			}
		},
		[runSingleModelTest],
	);

	const stopModelTests = useCallback(() => {
		modelTestStopFnRef.current?.();
	}, []);

	const retryModelTest = useCallback(
		async (model: string, text: string) => {
			await runSingleModelTest(model, text, modelTestRunIdRef.current);
		},
		[runSingleModelTest],
	);

	const handleChannelDelete = useCallback(
		async (id: string) => {
			if (!window.confirm("确定要删除该渠道吗？此操作不可撤销。")) return;
			try {
				await apiFetch(`/api/channels/${id}`, { method: "DELETE" });
				await loadChannels();
				toast.success("渠道已删除");
				if (editingChannel?.id === id) {
					closeChannelModal();
				}
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, closeChannelModal, editingChannel, loadChannels],
	);

	const handleChannelToggle = useCallback(
		async (id: string, status: string) => {
			try {
				const next = toggleStatus(status);
				await apiFetch(`/api/channels/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ status: next }),
				});
				await loadChannels();
				toast.success(`渠道已${next === "active" ? "启用" : "停用"}`);
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadChannels],
	);

	const handleTokenDelete = useCallback(
		async (id: string) => {
			if (!window.confirm("确定要删除该令牌吗？此操作不可撤销。")) return;
			try {
				await apiFetch(`/api/tokens/${id}`, { method: "DELETE" });
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
					`/api/tokens/${id}/reveal`,
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

	const handleTokenToggle = useCallback(
		async (id: string, status: string) => {
			try {
				const next = toggleStatus(status);
				await apiFetch(`/api/tokens/${id}`, {
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

	const handleGenerateCodes = useCallback(
		async (count: number, maxUses: number, prefix: string) => {
			try {
				await apiFetch("/api/invite-codes", {
					method: "POST",
					body: JSON.stringify({ count, max_uses: maxUses, prefix }),
				});
				const result = await apiFetch<{ codes: InviteCode[] }>(
					"/api/invite-codes",
				);
				setInviteCodes(result.codes);
				toast.success("邀请码已生成");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch],
	);

	const handleDeleteCode = useCallback(
		async (id: string) => {
			try {
				await apiFetch(`/api/invite-codes/${id}`, { method: "DELETE" });
				const result = await apiFetch<{ codes: InviteCode[] }>(
					"/api/invite-codes",
				);
				setInviteCodes(result.codes);
				toast.success("邀请码已删除");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch],
	);

	const handleExportCodes = useCallback(async () => {
		try {
			const res = await fetch("/api/invite-codes/export", {
				headers: { "x-admin-token": token },
			});
			const text = await res.text();
			try {
				await navigator.clipboard.writeText(text);
				toast.success("已复制到剪贴板");
			} catch {
				setSecretModal({ title: "邀请码导出", value: text });
			}
		} catch (error) {
			toast.error((error as Error).message);
		}
	}, [token]);

	// Webhook 通知通道 CRUD（/api/webhooks）：增删改后重拉列表，测试按钮
	// 真实发送样例消息并按返回的 ok/status 提示；错误统一 toast，promise 不
	// 向 SettingsView 传播 reject
	const handleWebhookAdd = useCallback(
		async (payload: { name: string; type: WebhookType; url: string }) => {
			try {
				await apiFetch("/api/webhooks", {
					method: "POST",
					body: JSON.stringify(payload),
				});
				await loadWebhooks();
				toast.success("Webhook 已添加");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadWebhooks],
	);

	const handleWebhookToggle = useCallback(
		async (id: string, enabled: boolean) => {
			try {
				await apiFetch(`/api/webhooks/${id}`, {
					method: "PATCH",
					body: JSON.stringify({ enabled }),
				});
				await loadWebhooks();
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadWebhooks],
	);

	const handleWebhookDelete = useCallback(
		async (id: string) => {
			try {
				await apiFetch(`/api/webhooks/${id}`, { method: "DELETE" });
				await loadWebhooks();
				toast.success("Webhook 已删除");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadWebhooks],
	);

	const handleWebhookTest = useCallback(
		async (id: string) => {
			try {
				const result = await apiFetch<{
					ok: boolean;
					status: number | null;
				}>("/api/webhooks/test", {
					method: "POST",
					body: JSON.stringify({ id }),
				});
				if (result.ok) {
					toast.success("测试消息已送达");
				} else {
					toast.error(
						`测试发送失败${result.status ? `（HTTP ${result.status}）` : ""}`,
					);
				}
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch],
	);

	// 配置备份导出：下载 JSON（含渠道 API Key 明文，警示由 SettingsView 文案承担）
	const handleBackupExport = useCallback(async () => {
		try {
			const res = await fetch("/api/backup/export", {
				headers: { "x-admin-token": token },
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(payload?.error ?? `HTTP ${res.status}`);
			}
			const disposition = res.headers.get("content-disposition") ?? "";
			const filename =
				disposition.match(/filename="([^"]+)"/)?.[1] ??
				`zenapi-backup-${new Date().toISOString().slice(0, 10)}.json`;
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			anchor.click();
			URL.revokeObjectURL(url);
			toast.success("备份已导出（含 API Key 明文，请妥善保管）");
		} catch (error) {
			toast.error((error as Error).message);
		}
	}, [token]);

	// 配置备份导入：POST JSON 文本（先清后写单事务），成功后刷新渠道缓存。
	// 失败时 toast 后 rethrow，SettingsView 保留输入内容便于修正。
	const handleBackupImport = useCallback(
		async (payloadText: string) => {
			try {
				const result = await apiFetch<BackupImportResult>(
					"/api/backup/import",
					{
						method: "POST",
						body: payloadText,
					},
				);
				toast.success(
					`导入成功：渠道 ${result.imported.channels} 条、模型别名 ${result.imported.model_aliases} 条、渠道别名 ${result.imported.channel_model_aliases} 条、设置 ${result.imported.settings} 项（缓存最长 30 秒内生效）`,
				);
				await loadChannels().catch(() => null);
			} catch (error) {
				toast.error((error as Error).message);
				throw error;
			}
		},
		[apiFetch, loadChannels],
	);

	const handleUsageRefresh = useCallback(async () => {
		try {
			await loadUsage();
			toast.success("日志已刷新");
		} catch (error) {
			toast.error((error as Error).message);
		}
	}, [loadUsage]);

	const handleAliasSave = useCallback(
		async (modelId: string, aliases: string[], aliasOnly?: boolean) => {
			try {
				await apiFetch(`/api/model-aliases/${encodeURIComponent(modelId)}`, {
					method: "PUT",
					body: JSON.stringify({ aliases, alias_only: aliasOnly ?? false }),
				});
				await loadModels();
				toast.success("别名已保存");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadModels],
	);

	const handlePriceSave = useCallback(
		async (
			modelId: string,
			prices: Array<{
				channel_id: string;
				input_price: number;
				output_price: number;
			}>,
		) => {
			try {
				await apiFetch(`/api/models/prices/${encodeURIComponent(modelId)}`, {
					method: "PUT",
					body: JSON.stringify({ prices }),
				});
				await loadModels();
				toast.success("价格已保存");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadModels],
	);

	const handleMonitoringLoaded = useCallback((monitoring: MonitoringData) => {
		setData((prev) => ({ ...prev, monitoring }));
	}, []);

	const handleUserCreate = useCallback(
		async (userData: {
			email: string;
			name: string;
			password: string;
			balance?: number;
		}) => {
			try {
				await apiFetch("/api/users", {
					method: "POST",
					body: JSON.stringify(userData),
				});
				await loadUsers();
				toast.success("用户已创建");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadUsers],
	);

	const handleUserUpdate = useCallback(
		async (id: string, patch: Record<string, unknown>) => {
			try {
				await apiFetch(`/api/users/${id}`, {
					method: "PATCH",
					body: JSON.stringify(patch),
				});
				await loadUsers();
				toast.success("用户已更新");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadUsers],
	);

	const handleUserDelete = useCallback(
		async (id: string) => {
			if (!window.confirm("确定要删除该用户吗？此操作不可撤销。")) return;
			try {
				await apiFetch(`/api/users/${id}`, { method: "DELETE" });
				await loadUsers();
				toast.success("用户已删除");
			} catch (error) {
				toast.error((error as Error).message);
			}
		},
		[apiFetch, loadUsers],
	);

	const filteredChannels = useMemo(() => {
		if (!channelSearch) return data.channels;
		const lower = channelSearch.toLowerCase();
		return data.channels.filter(
			(ch) =>
				ch.name.toLowerCase().includes(lower) ||
				ch.base_url.toLowerCase().includes(lower),
		);
	}, [data.channels, channelSearch]);
	const channelTotal = filteredChannels.length;
	const channelTotalPages = useMemo(
		() => Math.max(1, Math.ceil(channelTotal / channelPageSize)),
		[channelTotal, channelPageSize],
	);
	const pagedChannels = useMemo(() => {
		const start = (channelPage - 1) * channelPageSize;
		return filteredChannels.slice(start, start + channelPageSize);
	}, [channelPage, channelPageSize, filteredChannels]);
	const tokenTotal = data.tokens.length;
	const tokenTotalPages = useMemo(
		() => Math.max(1, Math.ceil(tokenTotal / tokenPageSize)),
		[tokenTotal, tokenPageSize],
	);
	const pagedTokens = useMemo(() => {
		const start = (tokenPage - 1) * tokenPageSize;
		return data.tokens.slice(start, start + tokenPageSize);
	}, [data.tokens, tokenPage, tokenPageSize]);

	useEffect(() => {
		setChannelPage((prev) => Math.min(prev, channelTotalPages));
	}, [channelTotalPages]);

	useEffect(() => {
		setTokenPage((prev) => Math.min(prev, tokenTotalPages));
	}, [tokenTotalPages]);

	const activeLabel = useMemo(
		() => tabs.find((tab) => tab.id === activeTab)?.label ?? "管理台",
		[activeTab],
	);

	const renderContent = () => {
		if (loading) {
			return (
				<ViewSkeleton variant={tabToSkeletonVariant[activeTab] ?? "generic"} />
			);
		}
		if (activeTab === "dashboard") {
			return <DashboardView dashboard={data.dashboard} />;
		}
		if (activeTab === "monitoring") {
			return (
				<MonitoringView
					monitoring={data.monitoring}
					token={token}
					onLoaded={handleMonitoringLoaded}
				/>
			);
		}
		if (activeTab === "channels") {
			return (
				<ChannelsView
					channelForm={channelForm}
					channelPage={channelPage}
					channelPageSize={channelPageSize}
					channelTotal={channelTotal}
					channelTotalPages={channelTotalPages}
					pagedChannels={pagedChannels}
					channelSearch={channelSearch}
					editingChannel={editingChannel}
					isChannelModalOpen={isChannelModalOpen}
					channelAliasState={channelAliasState}
					onChannelAliasStateChange={setChannelAliasState}
					onCreate={openChannelCreate}
					onCloseModal={closeChannelModal}
					onEdit={startChannelEdit}
					onSubmit={handleChannelSubmit}
					onTest={handleChannelTest}
					onToggle={handleChannelToggle}
					onDelete={handleChannelDelete}
					onPageChange={handleChannelPageChange}
					onPageSizeChange={handleChannelPageSizeChange}
					onSearchChange={handleChannelSearchChange}
					onFormChange={handleChannelFormChange}
					fetchingModels={fetchingModels}
					fetchedModels={fetchedModels}
					fetchedSearch={fetchedSearch}
					selectedFetched={selectedFetched}
					onFetchModels={handleFetchModels}
					onConfirmFetched={confirmFetchedModels}
					onCancelFetched={cancelFetchedModels}
					onFetchedSearchChange={setFetchedSearch}
					onToggleFetched={toggleFetchedModel}
					onToggleAllFetched={toggleAllFetched}
					modelTestResults={modelTestResults}
					modelTestRunning={modelTestRunning}
					modelTestPrompt={data.settings?.model_test_prompt ?? ""}
					onRunModelTests={runModelTests}
					onStopModelTests={stopModelTests}
					onRetryModelTest={retryModelTest}
				/>
			);
		}
		if (activeTab === "models") {
			return (
				<ModelsView
					models={data.models}
					onAliasSave={handleAliasSave}
					onPriceSave={handlePriceSave}
				/>
			);
		}
		if (activeTab === "tokens") {
			return (
				<TokensView
					pagedTokens={pagedTokens}
					tokenPage={tokenPage}
					tokenPageSize={tokenPageSize}
					tokenTotal={tokenTotal}
					tokenTotalPages={tokenTotalPages}
					isTokenModalOpen={isTokenModalOpen}
					onCreate={openTokenCreate}
					onCloseModal={closeTokenModal}
					onPageChange={handleTokenPageChange}
					onPageSizeChange={handleTokenPageSizeChange}
					onSubmit={handleTokenSubmit}
					onReveal={handleTokenReveal}
					onToggle={handleTokenToggle}
					onDelete={handleTokenDelete}
					editingToken={editingToken}
					tokenForm={tokenForm}
					onTokenFormChange={handleTokenFormChange}
					tokenCreateExpiresAt={tokenCreateExpiresAt}
					onTokenCreateExpiresAtChange={setTokenCreateExpiresAt}
					createSelectedModels={tokenCreateModels}
					onCreateModelsChange={handleTokenCreateModelsChange}
					onEdit={openTokenEdit}
					onCloseEditModal={closeTokenEdit}
					onEditSubmit={handleTokenEditSubmit}
					onFetchModelCandidates={loadModelCandidates}
				/>
			);
		}
		if (activeTab === "usage") {
			return <UsageView usage={data.usage} onRefresh={handleUsageRefresh} />;
		}
		if (activeTab === "settings") {
			return (
				<SettingsView
					settingsForm={settingsForm}
					adminPasswordSet={data.settings?.admin_password_set ?? false}
					turnstileSecretKeySet={
						data.settings?.turnstile_secret_key_set ?? false
					}
					onSubmit={handleSettingsSubmit}
					onFormChange={handleSettingsFormChange}
					inviteCodes={inviteCodes}
					webhooks={webhooks}
					onAddWebhook={handleWebhookAdd}
					onToggleWebhook={handleWebhookToggle}
					onDeleteWebhook={handleWebhookDelete}
					onTestWebhook={handleWebhookTest}
					onGenerateCodes={handleGenerateCodes}
					onDeleteCode={handleDeleteCode}
					onExportCodes={handleExportCodes}
					onExportBackup={handleBackupExport}
					onImportBackup={handleBackupImport}
				/>
			);
		}
		if (activeTab === "users") {
			return (
				<UsersView
					users={users}
					onCreate={handleUserCreate}
					onUpdate={handleUserUpdate}
					onDelete={handleUserDelete}
					onFetchModelCandidates={loadModelCandidates}
				/>
			);
		}
		if (activeTab === "playground") {
			return <PlaygroundView token={token} />;
		}
		return (
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				未知模块
			</div>
		);
	};

	return (
		<>
			<AppLayout
				tabs={tabs}
				activeTab={activeTab}
				activeLabel={activeLabel}
				token={token}
				isMobileMenuOpen={isMobileMenuOpen}
				onTabChange={handleTabChange}
				onToggleMobileMenu={toggleMobileMenu}
				onLogout={handleLogout}
				onNavigate={onNavigate}
			>
				<div key={activeTab} class="t-view-enter">
					{renderContent()}
				</div>
			</AppLayout>
			<SecretValueModal
				isOpen={secretModal !== null}
				title={secretModal?.title ?? ""}
				value={secretModal?.value ?? ""}
				onClose={() => setSecretModal(null)}
			/>
		</>
	);
};
