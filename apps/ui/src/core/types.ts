export type ChannelApiFormat = "openai" | "anthropic" | "custom" | "responses";

export type Channel = {
	id: string;
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	status: string;
	models_json?: string;
	/** 镜像列：规范化数组首元素（读侧请用 parseChannelApiFormats 解析 api_formats） */
	api_format: ChannelApiFormat;
	/** API 能力声明（JSON 数组字符串，TEXT 列原样透传，如 `"[\"openai\"]"`） */
	api_formats?: string | null;
	/** 每格式端点覆盖（JSON 对象字符串，TEXT 列原样透传，如 `"{\"anthropic\":\"https://x/api/anthropic\"}"`；读侧请用 parseEndpointOverrides 解析） */
	endpoint_overrides?: string | null;
	custom_headers_json?: string | null;
	/** 伪装请求头（JSON 对象字符串；NULL/空 = 不伪装） */
	disguise_headers_json?: string | null;
	/** 伪装系统提示词（前置注入的首条 system；NULL/空 = 不伪装） */
	disguise_system_prompt?: string | null;
	/** 服务端客户端预设 ID（网关实时渲染指纹；NULL/空 = 不启用） */
	disguise_preset?: string | null;
};

/** fetch_models / :id/test 响应中的逐格式探测结果 */
export type ChannelFormatProbeResult = {
	api_format: ChannelApiFormat;
	ok: boolean;
	model_count: number;
	error?: string;
};

export type Token = {
	id: string;
	name: string;
	key_prefix: string;
	quota_total: number | null;
	quota_used: number;
	status: string;
	user_id?: string | null;
	user_name?: string | null;
	user_email?: string | null;
	allowed_channels?: string | null;
	/** 令牌级模型白名单(服务端已还原为数组;null/空数组 = 不限制) */
	allowed_models?: string[] | null;
	/** 可选过期时间(ISO-8601;null = 永久)。状态由渲染层惰性计算,不落库 */
	expires_at?: string | null;
	created_at?: string | null;
	updated_at?: string | null;
};

export type UsageLog = {
	id: string;
	model: string | null;
	channel_id: string | null;
	channel_name?: string | null;
	token_id: string | null;
	token_name?: string | null;
	user_name?: string | null;
	user_email?: string | null;
	request_path?: string | null;
	total_tokens: number | null;
	prompt_tokens?: number | null;
	completion_tokens?: number | null;
	/** 缓存命中输入 tokens（NULL = 上游未报告） */
	cached_input_tokens?: number | null;
	/** 缓存写入 tokens，仅 Anthropic 语义（NULL = 上游未报告） */
	cache_creation_tokens?: number | null;
	cost?: number | null;
	latency_ms: number | null;
	first_token_latency_ms?: number | null;
	stream?: boolean | number | null;
	reasoning_effort?: string | number | null;
	/** 上游 HTTP 状态码（NULL = 未记录） */
	error_code?: number | null;
	/** 上游错误响应体前 512 字符原文，可能为 JSON 或纯文本（NULL = 无错误） */
	error_message?: string | null;
	status: string;
	created_at: string;
};

export type DashboardData = {
	summary: {
		total_requests: number;
		total_tokens: number;
		avg_latency: number;
		total_errors: number;
		cached_tokens: number;
		cache_creation_tokens: number;
		cache_rate: number | null;
	};
	byDay: Array<{
		day: string;
		requests: number;
		tokens: number;
		cached_tokens: number;
		cache_rate: number | null;
	}>;
	byModel: Array<{ model: string; requests: number; tokens: number }>;
	byChannel: Array<{ channel_name: string; requests: number; tokens: number }>;
	byToken: Array<{ token_name: string; requests: number; tokens: number }>;
};

export type MonitoringChannelData = {
	channel_id: string;
	channel_name: string;
	channel_status: string;
	api_format: string;
	/** API 能力声明（JSON 数组字符串；监控后端当前未下发时缺席，解析兜底到 api_format） */
	api_formats?: string | null;
	total_requests: number;
	success_count: number;
	error_count: number;
	success_rate: number | null;
	avg_latency_ms: number;
	last_seen: string | null;
	recent_success_rate: number | null;
	recent_avg_latency_ms: number | null;
};

export type MonitoringDailyTrend = {
	channel_id: string;
	day: string;
	requests: number;
	success: number;
	errors: number;
	success_rate: number;
	avg_latency_ms: number;
};

export type MonitoringErrorDetail = {
	id: string;
	model: string | null;
	channel_id: string | null;
	error_code: number | null;
	error_message: string | null;
	latency_ms: number | null;
	created_at: string;
};

export type MonitoringSlotModel = {
	model: string;
	requests: number;
	success: number;
	errors: number;
	avg_latency_ms: number;
};

export type MonitoringData = {
	summary: {
		total_requests: number;
		total_success: number;
		total_errors: number;
		avg_latency_ms: number;
		success_rate: number;
		active_channels: number;
		total_channels: number;
	};
	recentStatus: {
		total_requests: number;
		total_success: number;
		total_errors: number;
		avg_latency_ms: number;
		success_rate: number;
	};
	channels: MonitoringChannelData[];
	dailyTrends: MonitoringDailyTrend[];
	range: string;
};

export type ModelMonitoringModel = {
	model: string;
	total_requests: number;
	success_count: number;
	error_count: number;
	success_rate: number | null;
	avg_latency_ms: number;
	last_seen: string | null;
	recent_success_rate: number | null;
	recent_avg_latency_ms: number | null;
};

export type ModelMonitoringTrend = {
	model: string;
	day: string;
	requests: number;
	success: number;
	errors: number;
	success_rate: number;
	avg_latency_ms: number;
};

/** GET /api/u/monitoring — model-availability payload, no channel fields. */
export type ModelMonitoringData = {
	summary: {
		total_requests: number;
		total_success: number;
		total_errors: number;
		avg_latency_ms: number;
		success_rate: number;
		active_models: number;
	};
	recentStatus: {
		total_requests: number;
		total_success: number;
		total_errors: number;
		avg_latency_ms: number;
		success_rate: number;
	};
	models: ModelMonitoringModel[];
	dailyTrends: ModelMonitoringTrend[];
	range: string;
};

export type RegistrationMode = "open" | "linuxdo_only" | "closed";

export type Settings = {
	log_retention_days: number;
	session_ttl_hours: number;
	admin_password_set?: boolean;
	registration_mode: RegistrationMode;
	checkin_reward: number;
	require_invite_code: boolean;
	default_balance: number;
	ldc_payment_enabled: boolean;
	ldc_epay_pid: string;
	ldc_epay_key: string;
	ldc_epay_gateway: string;
	ldc_exchange_rate: number;
	announcement: string;
	proxy_extra_headers: string;
	proxy_remove_headers: string;
	proxy_retry_rounds: number;
	proxy_retry_delay_ms: number;
	/** developer 角色透传归一化开关（默认关闭） */
	normalize_developer_role: boolean;
	model_test_prompt: string;
	turnstile_enabled: boolean;
	turnstile_site_key: string;
	/** secret 永不回显，只返回已设置布尔 */
	turnstile_secret_key_set?: boolean;
};

export type ModelChannel = {
	id: string;
	name: string;
	input_price: number | null;
	output_price: number | null;
	avg_latency_ms: number | null;
};

export type ModelItem = {
	id: string;
	real_model_id: string | null;
	channels: ModelChannel[];
	total_requests: number;
	total_tokens: number;
	total_cost: number;
	avg_latency_ms: number | null;
	daily: { day: string; requests: number; tokens: number }[];
};

export type AdminData = {
	channels: Channel[];
	tokens: Token[];
	models: ModelItem[];
	usage: UsageLog[];
	dashboard: DashboardData | null;
	monitoring: MonitoringData | null;
	settings: Settings | null;
};

export type TabId =
	| "dashboard"
	| "monitoring"
	| "channels"
	| "models"
	| "tokens"
	| "usage"
	| "settings"
	| "users"
	| "playground";

export type TabItem = {
	id: TabId;
	label: string;
};

/** 可被端点覆盖的格式键（与 worker EndpointOverrideKey 同构；custom 的 base_url 即完整 URL，不可覆盖） */
export type ChannelEndpointOverrideKey = Exclude<ChannelApiFormat, "custom">;

/** 渠道表单的每格式端点覆盖（扁平字符串形态；空串 = 未覆盖/提交时触发后端清除） */
export type ChannelEndpointOverrides = Record<
	ChannelEndpointOverrideKey,
	string
>;

export type ChannelForm = {
	name: string;
	base_url: string;
	api_key: string;
	weight: number;
	/** 声明的 API 格式集（custom 独占）；提交时整体替换，至少一项 */
	api_formats: ChannelApiFormat[];
	/** 每格式端点覆盖（空串 = 未覆盖）；提交时仅含当前选中非 custom 格式的键 */
	endpoint_overrides: ChannelEndpointOverrides;
	custom_headers: string;
	/** 伪装请求头（JSON 文本，textarea 直读直写；空串 = 不伪装） */
	disguise_headers: string;
	/** 伪装系统提示词（纯文本；空串 = 不伪装） */
	disguise_system_prompt: string;
	/** 服务端客户端预设 ID（网关实时渲染指纹；空串 = 无预设） */
	disguise_preset: string;
	models: string;
};

/** 令牌编辑表单(管理台):额度字段以 string 承接 input,提交时转换;
 *  expires_at 为有效期选择器解析后的 ISO 串(空串 = 永久,提交时转 null) */
export type TokenForm = {
	name: string;
	quota_total: string;
	quota_used: string;
	allowed_models: string[];
	expires_at: string;
};

export type SettingsForm = {
	log_retention_days: string;
	session_ttl_hours: string;
	admin_password: string;
	registration_mode: RegistrationMode;
	checkin_reward: string;
	require_invite_code: string;
	default_balance: string;
	ldc_payment_enabled: string;
	ldc_epay_pid: string;
	ldc_epay_key: string;
	ldc_epay_gateway: string;
	ldc_exchange_rate: string;
	announcement: string;
	proxy_extra_headers: string;
	proxy_remove_headers: string;
	proxy_retry_rounds: string;
	proxy_retry_delay_ms: string;
	/** "true" / "false" 直传后端（服务端仅接受严格布尔） */
	normalize_developer_role: string;
	model_test_prompt: string;
	/** "true" / "false" 直传后端（服务端仅接受这两个字符串） */
	turnstile_enabled: string;
	/** 回显值；空串提交 = 清除 */
	turnstile_site_key: string;
	/** 永不回显：仅承接新输入，留空 = 不提交（保留现值） */
	turnstile_secret_key: string;
};

export type ModelTestStatus = "pending" | "running" | "success" | "failed";

export type ModelTestResult = {
	status: ModelTestStatus;
	elapsed?: number;
	content?: string;
	error?: string;
};

// User types
export type User = {
	id: string;
	email: string;
	name: string;
	role: string;
	balance: number;
	status: string;
	created_at: string;
	updated_at: string;
	linuxdo_id?: string | null;
	linuxdo_username?: string | null;
	allowed_models?: string[] | null;
};

export type UserDashboardData = {
	balance: number;
	total_requests: number;
	total_tokens: number;
	total_cost: number;
	cached_tokens: number;
	cache_creation_tokens: number;
	cache_rate: number | null;
	recent_usage: Array<{
		day: string;
		requests: number;
		cost: number;
		cached_tokens: number;
		cache_rate: number | null;
	}>;
	checked_in_today: boolean;
	checkin_reward: number;
	ldc_payment_enabled: boolean;
	ldc_exchange_rate: number;
};

export type UserTabId =
	| "dashboard"
	| "monitoring"
	| "models"
	| "tokens"
	| "usage";

export type UserTabItem = {
	id: UserTabId;
	label: string;
};

export type PublicModelItem = {
	id: string;
	channels: Array<{
		id: string;
		name: string;
		input_price: number | null;
		output_price: number | null;
	}>;
};

export type InviteCode = {
	id: string;
	code: string;
	max_uses: number;
	used_count: number;
	status: string;
	created_by: string | null;
	created_at: string;
};

export type RechargeOrder = {
	id: string;
	out_trade_no: string;
	ldc_amount: number;
	balance_amount: number;
	status: string;
	created_at: string;
};
