import type {
	AdminData,
	ChannelApiFormat,
	ChannelEndpointOverrideKey,
	ChannelForm,
	SettingsForm,
	TabItem,
	TokenForm,
	UserTabItem,
} from "./types";

export const apiBase = import.meta.env.VITE_API_BASE ?? "";

export const tabs: TabItem[] = [
	{ id: "dashboard", label: "数据面板" },
	{ id: "monitoring", label: "可用性监测" },
	{ id: "channels", label: "渠道管理" },
	{ id: "models", label: "模型广场" },
	{ id: "tokens", label: "令牌管理" },
	{ id: "usage", label: "使用日志" },
	{ id: "settings", label: "系统设置" },
	{ id: "users", label: "用户管理" },
	{ id: "playground", label: "对话测试" },
];

export const userTabs: UserTabItem[] = [
	{ id: "dashboard", label: "仪表盘" },
	{ id: "monitoring", label: "状态" },
	{ id: "models", label: "模型广场" },
	{ id: "tokens", label: "我的令牌" },
	{ id: "usage", label: "使用日志" },
];

export const initialData: AdminData = {
	channels: [],
	tokens: [],
	models: [],
	usage: [],
	dashboard: null,
	monitoring: null,
	settings: null,
};

export const initialChannelForm: ChannelForm = {
	name: "",
	base_url: "",
	api_key: "",
	weight: 1,
	api_formats: ["openai"],
	endpoint_overrides: { openai: "", responses: "", anthropic: "" },
	custom_headers: "",
	disguise_headers: "",
	disguise_system_prompt: "",
	disguise_preset: "",
	probe_enabled: false,
	models: "",
};

/** 渠道可选 API 格式（custom 独占，不可与其他格式组合） */
export const CHANNEL_API_FORMATS: ChannelApiFormat[] = [
	"openai",
	"responses",
	"anthropic",
	"custom",
];

/** 可配置端点覆盖的格式键（custom 独占语义不可覆盖；顺序与规范序一致） */
export const CHANNEL_ENDPOINT_OVERRIDE_FORMATS: ChannelEndpointOverrideKey[] = [
	"openai",
	"responses",
	"anthropic",
];

/** API 格式展示名（渠道表单 chip / 列表与监控徽章共用） */
export const formatLabels: Record<ChannelApiFormat, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	custom: "Custom",
	responses: "Responses",
};

/** API 格式徽章配色（与 formatLabels 同 key 共用） */
export const formatBadgeColors: Record<ChannelApiFormat, string> = {
	openai: "border-blue-100 bg-blue-50 text-blue-600",
	anthropic: "border-orange-100 bg-orange-50 text-orange-600",
	custom: "border-purple-100 bg-purple-50 text-purple-600",
	responses: "border-teal-100 bg-teal-50 text-teal-600",
};

export const initialTokenForm: TokenForm = {
	name: "",
	quota_total: "",
	quota_used: "",
	allowed_models: [],
	expires_at: "",
	rpm_limit: "",
};

export const initialSettingsForm: SettingsForm = {
	log_retention_days: "30",
	session_ttl_hours: "12",
	admin_password: "",
	registration_mode: "open",
	checkin_reward: "0.5",
	require_invite_code: "false",
	default_balance: "0",
	ldc_payment_enabled: "false",
	ldc_epay_pid: "",
	ldc_epay_key: "",
	ldc_epay_gateway: "https://credit.linux.do/epay",
	ldc_exchange_rate: "0.1",
	announcement: "",
	proxy_extra_headers: "",
	proxy_remove_headers: "",
	proxy_retry_rounds: "2",
	proxy_retry_delay_ms: "200",
	token_rpm_default: "0",
	ip_auth_fail_limit: "0",
	alert_failure_rate_pct: "50",
	alert_min_samples: "5",
	alert_silence_minutes: "30",
	alert_window_minutes: "15",
	cache_read_ratio: "1",
	cache_write_ratio: "1",
	daily_report_enabled: "false",
	normalize_developer_role: "false",
	model_test_prompt: "",
	turnstile_enabled: "false",
	turnstile_site_key: "",
	turnstile_secret_key: "",
};
