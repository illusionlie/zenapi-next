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
	/** 主动健康探测开关（0/1，D1 INTEGER 原样；默认 0 = 关；结果只展示不参与路由） */
	probe_enabled?: number | null;
	/** 末次探测 ISO 时间戳（NULL = 从未探测；仅调度器写） */
	last_probe_at?: string | null;
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
	/** 令牌级 RPM 上限:NULL = 跟随全局默认 / 0 = 显式不限 / 正整数 = 每分钟上限 */
	rpm_limit?: number | null;
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

/** 监测页 per-key 健康行（内存活值 + 24h key_tag 归因合并，任务 10-26-key-cooldown-stats）。 */
export type MonitoringKeyStat = {
	/** key 指纹（fnv1a32 前 8 hex），不含明文 */
	key_tag: string;
	cooling: boolean;
	/** 冷却截止 epoch ms；0 = 未冷却 */
	cooling_until: number;
	/** 401/403 失败数（isolate 启动起累计） */
	auth_fails: number;
	/** 429/5xx/网络错失败数（isolate 启动起累计） */
	retryable_fails: number;
	successes: number;
	/** epoch ms；0 = 从未 */
	last_failure_at: number;
	last_success_at: number;
	/** 24h raw 窗口内的持久归因计数 */
	ok_24h: number;
	error_24h: number;
	success_rate_24h: number | null;
};

export type MonitoringChannelKeyStats = {
	channel_id: string;
	keys: MonitoringKeyStat[];
};

/** 监测页单条渠道主动探测记录（channel_probes 行的展示子集，任务 10-26-channel-probe）。 */
export type MonitoringProbeEntry = {
	status: "healthy" | "degraded" | "down";
	checked_at: string;
	latency_ms: number | null;
};

/** 每渠道探测历史（最近 14 条，latest = 最新一条摘要；后端可能未下发——旧 worker 兼容缺席）。 */
export type MonitoringChannelProbes = {
	channel_id: string;
	latest: MonitoringProbeEntry | null;
	history: MonitoringProbeEntry[];
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
	/** 渠道多 Key 健康展开（后端可能未下发——旧 worker 兼容缺席） */
	keyStats?: MonitoringChannelKeyStats[];
	/** 渠道主动探测历史（探测关闭/旧 worker 兼容缺席） */
	probes?: MonitoringChannelProbes[];
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
	/** 令牌级 RPM 全局默认(0 = 关闭;rpm_limit 为 NULL 的令牌跟随此值) */
	token_rpm_default: number;
	/** 60s 窗口内同 IP 鉴权失败节流阈值(0 = 关闭) */
	ip_auth_fail_limit: number;
	/** 渠道失败率报警阈值百分比(0 = 关闭报警) */
	alert_failure_rate_pct: number;
	/** 触发报警的最小窗口样本数(防误报) */
	alert_min_samples: number;
	/** 同渠道报警静默窗口(分钟) */
	alert_silence_minutes: number;
	/** 失败率评估窗口(分钟) */
	alert_window_minutes: number;
	/** 昨日用量日报推送开关(默认关) */
	daily_report_enabled: boolean;
	/** 渠道主动探测间隔分钟数(0 = 总闸关闭,默认 30) */
	probe_interval_minutes?: number;
	/** 缓存读价倍率(缓存读价 = input_price × 倍率,默认 1 = 全价) */
	cache_read_ratio: number;
	/** 缓存写价倍率(缓存写价 = input_price × 倍率,默认 1 = 全价) */
	cache_write_ratio: number;
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
	/** 每模型缓存读绝对价覆盖（null = 未配置，跟随全局倍率） */
	cache_read_price: number | null;
	/** 每模型缓存写绝对价覆盖（null = 未配置，跟随全局倍率） */
	cache_write_price: number | null;
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
	/** 主动健康探测开关（默认关；定时 GET /models 零 token 探测） */
	probe_enabled: boolean;
	models: string;
};

/** 令牌编辑表单(管理台):额度字段以 string 承接 input,提交时转换;
 *  expires_at 为有效期选择器解析后的 ISO 串(空串 = 永久,提交时转 null);
 *  rpm_limit 以 string 承接(空串 = 跟随全局默认,提交时转 null) */
export type TokenForm = {
	name: string;
	quota_total: string;
	quota_used: string;
	allowed_models: string[];
	expires_at: string;
	rpm_limit: string;
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
	/** 令牌级 RPM 全局默认(0 = 关闭),数值字段以 string 承接 input */
	token_rpm_default: string;
	/** IP 鉴权失败节流阈值(0 = 关闭),数值字段以 string 承接 input */
	ip_auth_fail_limit: string;
	/** 渠道失败率报警阈值百分比(0 = 关闭),数值字段以 string 承接 input */
	alert_failure_rate_pct: string;
	/** 报警最小样本数,数值字段以 string 承接 input */
	alert_min_samples: string;
	/** 报警静默窗口(分钟),数值字段以 string 承接 input */
	alert_silence_minutes: string;
	/** 失败率评估窗口(分钟),数值字段以 string 承接 input */
	alert_window_minutes: string;
	/** 缓存读价倍率(默认 1 = 全价;0 = 缓存读免费),数值字段以 string 承接 input */
	cache_read_ratio: string;
	/** 缓存写价倍率(默认 1 = 全价;1.25 等小数合法),数值字段以 string 承接 input */
	cache_write_ratio: string;
	/** "true" / "false" 直传后端（服务端仅接受严格布尔） */
	daily_report_enabled: string;
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

/** Webhook 通知端点类型（与 worker WEBHOOK_TYPES 白名单同构） */
export type WebhookType = "feishu" | "wecom" | "dingtalk" | "slack" | "generic";

export const WEBHOOK_TYPE_LABELS: Record<WebhookType, string> = {
	feishu: "飞书",
	wecom: "企业微信",
	dingtalk: "钉钉",
	slack: "Slack",
	generic: "Generic",
};

export type Webhook = {
	id: string;
	name: string;
	type: WebhookType;
	url: string;
	enabled: boolean;
	created_at: string;
	updated_at: string;
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
		/** 每模型缓存读绝对价覆盖（null = 未配置，跟随全局倍率） */
		cache_read_price: number | null;
		/** 每模型缓存写绝对价覆盖（null = 未配置，跟随全局倍率） */
		cache_write_price: number | null;
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

/** POST /api/backup/import 响应（配置全量替换结果 + 缓存陈旧窗口提示） */
export type BackupImportResult = {
	ok: boolean;
	imported: {
		channels: number;
		model_aliases: number;
		channel_model_aliases: number;
		settings: number;
	};
	cache_staleness: { channels_seconds: number; settings_seconds: number };
};
