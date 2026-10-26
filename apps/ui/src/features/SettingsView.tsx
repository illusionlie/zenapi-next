import { useEffect, useMemo, useRef, useState } from "hono/jsx/dom";
import type {
	InviteCode,
	RegistrationMode,
	SettingsForm,
	Webhook,
	WebhookType,
} from "../core/types";
import { WEBHOOK_TYPE_LABELS } from "../core/types";
import { ToggleSwitch } from "./ToggleSwitch";

type SettingsViewProps = {
	settingsForm: SettingsForm;
	adminPasswordSet: boolean;
	turnstileSecretKeySet: boolean;
	onSubmit: (event: Event) => void;
	onFormChange: (patch: Partial<SettingsForm>) => void;
	inviteCodes: InviteCode[];
	webhooks: Webhook[];
	onAddWebhook: (payload: {
		name: string;
		type: WebhookType;
		url: string;
	}) => Promise<void>;
	onToggleWebhook: (id: string, enabled: boolean) => Promise<void>;
	onDeleteWebhook: (id: string) => Promise<void>;
	onTestWebhook: (id: string) => Promise<void>;
	onGenerateCodes: (
		count: number,
		maxUses: number,
		prefix: string,
	) => Promise<void>;
	onDeleteCode: (id: string) => Promise<void>;
	onExportCodes: () => Promise<void>;
	onExportBackup: () => Promise<void>;
	onImportBackup: (payloadText: string) => Promise<void>;
};

/** 类型徽标配色（按平台约定色，generic 中性灰） */
const webhookTypeBadgeClass: Record<WebhookType, string> = {
	feishu: "bg-blue-50 text-blue-600",
	wecom: "bg-green-50 text-green-600",
	dingtalk: "bg-sky-50 text-sky-600",
	slack: "bg-purple-50 text-purple-600",
	generic: "bg-stone-100 text-stone-500",
};

const registrationModeOptions: {
	value: RegistrationMode;
	label: string;
	desc: string;
}[] = [
	{
		value: "open",
		label: "开放注册",
		desc: "允许通过邮箱密码和 Linux DO 注册",
	},
	{
		value: "linuxdo_only",
		label: "仅 Linux DO",
		desc: "仅允许通过 Linux DO 登录注册",
	},
	{
		value: "closed",
		label: "关闭注册",
		desc: "不接受新用户注册，已有用户可正常登录",
	},
];

export const SettingsView = ({
	settingsForm,
	adminPasswordSet,
	turnstileSecretKeySet,
	onSubmit,
	onFormChange,
	inviteCodes,
	webhooks,
	onAddWebhook,
	onToggleWebhook,
	onDeleteWebhook,
	onTestWebhook,
	onGenerateCodes,
	onDeleteCode,
	onExportCodes,
	onExportBackup,
	onImportBackup,
}: SettingsViewProps) => {
	const [genCount, setGenCount] = useState("10");
	const [genMaxUses, setGenMaxUses] = useState("1");
	const [genPrefix, setGenPrefix] = useState("ZEN-");
	const announcementRef = useRef<HTMLTextAreaElement>(null);
	const modelTestPromptRef = useRef<HTMLTextAreaElement>(null);
	const [backupText, setBackupText] = useState("");
	const [backupImporting, setBackupImporting] = useState(false);
	// Webhook 添加表单（本地态，添加成功后清空；错误由上层 toast 承担）
	const [whName, setWhName] = useState("");
	const [whType, setWhType] = useState<WebhookType>("feishu");
	const [whUrl, setWhUrl] = useState("");
	const [whAdding, setWhAdding] = useState(false);
	const [whTesting, setWhTesting] = useState<string | null>(null);

	// enabled toggle 门控：两把密钥（现值 + 未保存的输入）解析后任一为空则不可开启
	const turnstileSiteKeyReady = settingsForm.turnstile_site_key.trim() !== "";
	const turnstileSecretReady =
		turnstileSecretKeySet || settingsForm.turnstile_secret_key !== "";
	const turnstileToggleDisabled =
		!turnstileSiteKeyReady || !turnstileSecretReady;

	// 备份导入预览：本地解析载荷结构并统计各表条数（提交前最后一步校验在
	// 服务端，预览仅用于确认与双重确认文案）
	type BackupPreview =
		| {
				ok: true;
				channels: number;
				modelAliases: number;
				channelAliases: number;
				settings: number;
		  }
		| { ok: false; error: string }
		| null;
	const backupPreview = useMemo<BackupPreview>(() => {
		if (backupText.trim() === "") {
			return null;
		}
		try {
			const parsed = JSON.parse(backupText) as Record<string, unknown>;
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			) {
				return { ok: false, error: "不是有效的备份 JSON 对象" };
			}
			if (parsed.version !== 1) {
				return {
					ok: false,
					error: `不支持的备份版本：${String(parsed.version)}`,
				};
			}
			const countArray = (value: unknown) =>
				Array.isArray(value) ? value.length : 0;
			const settings = parsed.settings;
			return {
				ok: true,
				channels: countArray(parsed.channels),
				modelAliases: countArray(parsed.model_aliases),
				channelAliases: countArray(parsed.channel_model_aliases),
				settings:
					typeof settings === "object" && settings !== null
						? Object.keys(settings).length
						: 0,
			};
		} catch {
			return { ok: false, error: "JSON 解析失败，请检查备份文件内容" };
		}
	}, [backupText]);

	const handleBackupFileChange = async (file: File | undefined) => {
		if (!file) {
			return;
		}
		try {
			setBackupText(await file.text());
		} catch {
			// 文件读取失败：清空预览，粘贴框作为兜底入口
			setBackupText("");
		}
	};

	const handleBackupImportClick = async () => {
		if (!backupPreview?.ok || backupImporting) {
			return;
		}
		// 双重确认（design §3：完全覆盖不可逆）
		const first = window.confirm(
			`导入将完全覆盖现有配置（渠道 / 别名 / 设置），且不可逆。\n\n` +
				`载荷：渠道 ${backupPreview.channels} 条、模型别名 ${backupPreview.modelAliases} 条、` +
				`渠道别名 ${backupPreview.channelAliases} 条、设置 ${backupPreview.settings} 项。\n\n确定继续？`,
		);
		if (!first) {
			return;
		}
		const second = window.confirm(
			"再次确认：此操作不可逆。建议先「导出当前配置」留存后再继续。确定导入？",
		);
		if (!second) {
			return;
		}
		setBackupImporting(true);
		try {
			await onImportBackup(backupText);
			// 成功才清空输入；失败保留内容便于修正（错误提示由上层 toast 承担）
			setBackupText("");
		} catch {
			/* handled by caller toast */
		} finally {
			setBackupImporting(false);
		}
	};

	useEffect(() => {
		if (
			announcementRef.current &&
			announcementRef.current.value !== settingsForm.announcement
		) {
			announcementRef.current.value = settingsForm.announcement;
		}
	}, [settingsForm.announcement]);

	useEffect(() => {
		if (
			modelTestPromptRef.current &&
			modelTestPromptRef.current.value !== settingsForm.model_test_prompt
		) {
			modelTestPromptRef.current.value = settingsForm.model_test_prompt;
		}
	}, [settingsForm.model_test_prompt]);

	// Webhook 添加：本地校验非空后交上层（服务端再做 type 白名单 + https 校验），
	// 成功后由上层重拉列表，这里只清空输入
	const handleWebhookAddClick = async () => {
		if (whAdding || !whName.trim() || !whUrl.trim()) {
			return;
		}
		setWhAdding(true);
		try {
			await onAddWebhook({
				name: whName.trim(),
				type: whType,
				url: whUrl.trim(),
			});
			setWhName("");
			setWhUrl("");
		} finally {
			setWhAdding(false);
		}
	};

	const handleWebhookTestClick = async (id: string) => {
		if (whTesting) {
			return;
		}
		setWhTesting(id);
		try {
			await onTestWebhook(id);
		} finally {
			setWhTesting(null);
		}
	};

	return (
		<div class="space-y-5">
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<div class="mb-4 flex items-center justify-between">
					<h3 class="mb-0 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						系统设置
					</h3>
				</div>
				<form class="grid gap-3.5 lg:grid-cols-2" onSubmit={onSubmit}>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="retention"
						>
							日志保留天数
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="retention"
							name="log_retention_days"
							type="number"
							min="1"
							value={settingsForm.log_retention_days}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									log_retention_days: target?.value ?? "",
								});
							}}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="session-ttl"
						>
							会话时长（小时）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="session-ttl"
							name="session_ttl_hours"
							type="number"
							min="1"
							value={settingsForm.session_ttl_hours}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									session_ttl_hours: target?.value ?? "",
								});
							}}
						/>
					</div>
					<div class="lg:col-span-2">
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="admin-password"
						>
							管理员密码
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="admin-password"
							name="admin_password"
							type="password"
							placeholder={
								adminPasswordSet
									? "已设置，留空则不修改"
									: "未设置，保存后即为登录密码"
							}
							value={settingsForm.admin_password}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									admin_password: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							密码状态：{adminPasswordSet ? "已设置" : "未设置"}
						</p>
					</div>
					<div class="lg:col-span-2">
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="registration-mode"
						>
							注册模式
						</label>
						<select
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="registration-mode"
							name="registration_mode"
							value={settingsForm.registration_mode}
							onChange={(event) => {
								const target = event.currentTarget as HTMLSelectElement | null;
								onFormChange({
									registration_mode: (target?.value ??
										"open") as RegistrationMode,
								});
							}}
						>
							{registrationModeOptions.map((opt) => (
								<option
									key={opt.value}
									value={opt.value}
									selected={settingsForm.registration_mode === opt.value}
								>
									{opt.label} — {opt.desc}
								</option>
							))}
						</select>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="checkin-reward"
						>
							签到奖励额度
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="checkin-reward"
							name="checkin_reward"
							type="number"
							min="0.01"
							step="0.01"
							value={settingsForm.checkin_reward}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									checkin_reward: target?.value ?? "",
								});
							}}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="default-balance"
						>
							新用户初始额度
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="default-balance"
							name="default_balance"
							type="number"
							min="0"
							step="0.01"
							value={settingsForm.default_balance}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									default_balance: target?.value ?? "",
								});
							}}
						/>
					</div>
					<div class="flex items-end">
						<label
							class="flex cursor-pointer items-center gap-2.5 text-sm text-stone-700"
							for="setting-require-invite-code"
						>
							<ToggleSwitch
								id="setting-require-invite-code"
								checked={settingsForm.require_invite_code === "true"}
								onChange={(checked) => {
									onFormChange({
										require_invite_code: checked ? "true" : "false",
									});
								}}
							/>
							需要邀请码注册
						</label>
					</div>
					<div class="lg:col-span-2 border-t border-stone-100 pt-4 mt-1">
						<h4 class="mb-3 text-sm font-semibold text-stone-700">
							LDC 支付设置
						</h4>
						<label
							class="flex cursor-pointer items-center gap-2.5 text-sm text-stone-700"
							for="setting-ldc-payment-enabled"
						>
							<ToggleSwitch
								id="setting-ldc-payment-enabled"
								checked={settingsForm.ldc_payment_enabled === "true"}
								onChange={(checked) => {
									onFormChange({
										ldc_payment_enabled: checked ? "true" : "false",
									});
								}}
							/>
							启用 LDC 支付充值
						</label>
					</div>
					{settingsForm.ldc_payment_enabled === "true" && (
						<>
							<div>
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="ldc-epay-pid"
								>
									商户 PID
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="ldc-epay-pid"
									name="ldc_epay_pid"
									type="text"
									value={settingsForm.ldc_epay_pid}
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onFormChange({
											ldc_epay_pid: target?.value ?? "",
										});
									}}
								/>
							</div>
							<div>
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="ldc-epay-key"
								>
									商户密钥
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="ldc-epay-key"
									name="ldc_epay_key"
									type="password"
									value={settingsForm.ldc_epay_key}
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onFormChange({
											ldc_epay_key: target?.value ?? "",
										});
									}}
								/>
							</div>
							<div>
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="ldc-epay-gateway"
								>
									支付网关
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="ldc-epay-gateway"
									name="ldc_epay_gateway"
									type="text"
									placeholder="https://credit.linux.do/epay"
									value={settingsForm.ldc_epay_gateway}
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onFormChange({
											ldc_epay_gateway: target?.value ?? "",
										});
									}}
								/>
							</div>
							<div>
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="ldc-exchange-rate"
								>
									汇率 (1 LDC = ? 余额)
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="ldc-exchange-rate"
									name="ldc_exchange_rate"
									type="number"
									min="0.001"
									step="any"
									value={settingsForm.ldc_exchange_rate}
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onFormChange({
											ldc_exchange_rate: target?.value ?? "",
										});
									}}
								/>
							</div>
						</>
					)}
					<div class="lg:col-span-2 border-t border-stone-100 pt-4 mt-1">
						<h4 class="mb-3 text-sm font-semibold text-stone-700">
							Turnstile 人机验证
						</h4>
						<label
							class={`flex items-center gap-2.5 text-sm text-stone-700 ${turnstileToggleDisabled ? "cursor-not-allowed" : "cursor-pointer"}`}
							for="setting-turnstile-enabled"
						>
							<ToggleSwitch
								id="setting-turnstile-enabled"
								checked={settingsForm.turnstile_enabled === "true"}
								disabled={turnstileToggleDisabled}
								onChange={(checked) => {
									onFormChange({
										turnstile_enabled: checked ? "true" : "false",
									});
								}}
							/>
							启用登录 / 注册人机验证
						</label>
						{turnstileToggleDisabled && (
							<p class="mt-1 text-xs text-stone-500">
								启用前需先填写 Site Key 与 Secret Key（Secret
								已设置则无需重填）。
							</p>
						)}
						<div class="mt-3 grid gap-3.5 lg:grid-cols-2">
							<div>
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="turnstile-site-key"
								>
									Site Key（公开，可回显）
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="turnstile-site-key"
									name="turnstile_site_key"
									type="text"
									maxLength={200}
									value={settingsForm.turnstile_site_key}
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onFormChange({
											turnstile_site_key: target?.value ?? "",
										});
									}}
								/>
							</div>
							<div>
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="turnstile-secret-key"
								>
									Secret Key（服务端密钥，不回显）
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="turnstile-secret-key"
									name="turnstile_secret_key"
									type="password"
									placeholder={
										turnstileSecretKeySet
											? "已设置，留空保持不变"
											: "未设置，填入后保存生效"
									}
									value={settingsForm.turnstile_secret_key}
									onInput={(event) => {
										const target =
											event.currentTarget as HTMLInputElement | null;
										onFormChange({
											turnstile_secret_key: target?.value ?? "",
										});
									}}
								/>
								<p class="mt-1 text-xs text-stone-500">
									密码状态：{turnstileSecretKeySet ? "已设置" : "未设置"}
								</p>
							</div>
						</div>
						<p class="mt-1 text-xs text-stone-500">
							在
							<a
								class="mx-1 text-amber-600 hover:text-amber-700"
								href="https://dash.cloudflare.com/?to=/:account/turnstile"
								target="_blank"
								rel="noreferrer"
							>
								Cloudflare Dashboard
							</a>
							创建 Turnstile 站点后填入两把密钥再打开开关。
							本地联调可使用官方测试密钥（总是通过）：Site Key
							<code class="mx-1 font-mono">1x00000000000000000000AA</code>/
							Secret Key
							<code class="mx-1 font-mono">
								1x0000000000000000000000000000000AA
							</code>
							。
						</p>
					</div>
					<div class="lg:col-span-2 border-t border-stone-100 pt-4 mt-1">
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="announcement"
						>
							站点公告
						</label>
						<textarea
							ref={announcementRef}
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="announcement"
							name="announcement"
							rows={3}
							placeholder="输入公告内容，所有用户进入站点时会看到此公告。留空则不显示。"
							onInput={(event) => {
								const target =
									event.currentTarget as HTMLTextAreaElement | null;
								onFormChange({
									announcement: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							设置后，所有用户登录进入站点时会收到公告通知。清空公告内容即可关闭。
						</p>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="proxy-retry-rounds"
						>
							代理重试轮数
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="proxy-retry-rounds"
							name="proxy_retry_rounds"
							type="number"
							min="1"
							max="10"
							value={settingsForm.proxy_retry_rounds}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									proxy_retry_rounds: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							上游失败（5xx/429）后的渠道轮换重试轮数，范围 1–10。
						</p>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="proxy-retry-delay-ms"
						>
							重试间隔（毫秒）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="proxy-retry-delay-ms"
							name="proxy_retry_delay_ms"
							type="number"
							min="0"
							max="60000"
							value={settingsForm.proxy_retry_delay_ms}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									proxy_retry_delay_ms: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							每轮重试之间的等待间隔，范围 0–60000
							毫秒。键缺失时回退环境变量与内置默认值。
						</p>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="token-rpm-default"
						>
							令牌默认 RPM 上限
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="token-rpm-default"
							name="token_rpm_default"
							type="number"
							min="0"
							max="1000000"
							placeholder="0"
							value={settingsForm.token_rpm_default}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									token_rpm_default: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							未单独设置 RPM 的令牌遵循此每分钟请求上限，0 = 关闭。近似限流：按
							Worker 实例独立计数。
						</p>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="ip-auth-fail-limit"
						>
							IP 鉴权失败阈值
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="ip-auth-fail-limit"
							name="ip_auth_fail_limit"
							type="number"
							min="0"
							max="1000000"
							placeholder="0"
							value={settingsForm.ip_auth_fail_limit}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									ip_auth_fail_limit: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							同一 IP 60 秒窗口内鉴权失败达到阈值后临时拒绝后续请求（429），0 =
							关闭。
						</p>
					</div>
					<div class="lg:col-span-2">
						<label
							class="flex cursor-pointer items-center gap-2.5 text-sm text-stone-700"
							for="setting-normalize-developer-role"
						>
							<ToggleSwitch
								id="setting-normalize-developer-role"
								checked={settingsForm.normalize_developer_role === "true"}
								onChange={(checked) => {
									onFormChange({
										normalize_developer_role: checked ? "true" : "false",
									});
								}}
							/>
							developer 角色归一化
						</label>
						<p class="mt-1 text-xs text-stone-500">
							开启后，透传请求体中 developer 角色的消息将改写为 system
							再发往上游（兼容智谱 GLM 等不识别 developer
							角色的上游）。注意：developer 指令优先级语义会降级为
							system；对原生支持 developer 的 OpenAI 官方端点建议保持关闭。
						</p>
					</div>
					<div class="lg:col-span-2">
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="proxy-extra-headers"
						>
							额外注入请求头 (JSON)
						</label>
						<textarea
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="proxy-extra-headers"
							name="proxy_extra_headers"
							rows={3}
							placeholder='{"X-Trace-Id": "zen", "X-Env": "prod"}'
							value={settingsForm.proxy_extra_headers}
							onInput={(event) => {
								const target =
									event.currentTarget as HTMLTextAreaElement | null;
								onFormChange({
									proxy_extra_headers: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							仅对计费代理请求（/v1 与 /anthropic/v1）生效，Playground
							对话测试与渠道连通性测试不套用。同名头优先级：渠道级自定义请求头
							&gt; 全局注入 &gt; 系统内置头；覆盖 Authorization / x-api-key
							等鉴权头可能导致上游 401，请谨慎配置。
						</p>
					</div>
					<div class="lg:col-span-2">
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="proxy-remove-headers"
						>
							剔除请求头 (JSON)
						</label>
						<textarea
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="proxy-remove-headers"
							name="proxy_remove_headers"
							rows={3}
							placeholder='["user-agent", "x-client-id"]'
							value={settingsForm.proxy_remove_headers}
							onInput={(event) => {
								const target =
									event.currentTarget as HTMLTextAreaElement | null;
								onFormChange({
									proxy_remove_headers: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							JSON
							字符串数组，列出的客户端请求头不会转发给上游。作用范围与优先级同「额外注入请求头」。注意：剔除是无差别的，同名内置鉴权头（如
							Authorization）也会被删除，请勿剔除代理鉴权依赖的头。
						</p>
					</div>
					<div class="lg:col-span-2">
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="model-test-prompt"
						>
							模型测试文本
						</label>
						<textarea
							ref={modelTestPromptRef}
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="model-test-prompt"
							name="model_test_prompt"
							rows={3}
							placeholder="你好，请直接回复 OK 以确认服务可用。"
							onInput={(event) => {
								const target =
									event.currentTarget as HTMLTextAreaElement | null;
								onFormChange({
									model_test_prompt: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							渠道编辑弹窗内「模型测试」的默认对话文本。留空时服务端使用内置默认值；弹窗内可临时覆盖，仅影响当次测试。
						</p>
					</div>
					<div class="flex items-end lg:col-span-2">
						<button
							class="h-11 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
							type="submit"
						>
							保存设置
						</button>
					</div>
				</form>
			</div>
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<div class="mb-4 flex items-center justify-between">
					<h3 class="mb-0 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						备份与恢复
					</h3>
					<button
						type="button"
						class="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white transition-shadow hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60"
						onClick={onExportBackup}
					>
						导出当前配置
					</button>
				</div>
				<p class="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
					导出文件包含全部渠道配置与
					<strong>API Key 明文</strong>
					（不含用户 / 令牌 / 用量 / 充值数据，管理员密码哈希与 Turnstile
					密钥已排除）。请妥善保管，避免泄露。
				</p>
				<div class="grid gap-3">
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="backup-file"
						>
							选择备份文件
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-stone-600 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="backup-file"
							type="file"
							accept="application/json,.json"
							onInput={(event) => {
								const input = event.currentTarget as HTMLInputElement | null;
								const file = input?.files?.[0];
								if (file) {
									void handleBackupFileChange(file);
								}
							}}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="backup-paste"
						>
							或粘贴备份 JSON
						</label>
						<textarea
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-xs text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="backup-paste"
							rows={5}
							placeholder='{"version":1,"exportedAt":"...","channels":[...]}'
							value={backupText}
							onInput={(event) => {
								const target =
									event.currentTarget as HTMLTextAreaElement | null;
								setBackupText(target?.value ?? "");
							}}
						/>
					</div>
					{backupPreview && (
						<div
							class={`rounded-lg px-3 py-2 text-xs ${
								backupPreview.ok
									? "bg-stone-50 text-stone-600"
									: "border border-red-200 bg-red-50 text-red-600"
							}`}
						>
							{backupPreview.ok
								? `将导入：渠道 ${backupPreview.channels} 条、模型别名 ${backupPreview.modelAliases} 条、渠道别名 ${backupPreview.channelAliases} 条、设置 ${backupPreview.settings} 项（导入后缓存最长 30 秒内生效）`
								: backupPreview.error}
						</div>
					)}
					<div>
						<button
							type="button"
							class="h-10 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
							disabled={!backupPreview?.ok || backupImporting}
							onClick={() => {
								void handleBackupImportClick();
							}}
						>
							{backupImporting ? "导入中…" : "导入并完全覆盖现有配置"}
						</button>
						<p class="mt-1 text-xs text-stone-500">
							导入为
							<strong>全量替换</strong>
							：先清空渠道 / 别名 /
							载荷内设置再写入，失败整体回滚；用户、令牌、用量与充值数据不受影响。
						</p>
					</div>
				</div>
			</div>
			{settingsForm.require_invite_code === "true" && (
				<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
					<div class="mb-4 flex items-center justify-between">
						<h3 class="font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
							邀请码管理
						</h3>
						<button
							type="button"
							class="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-[color,background-color,border-color,box-shadow] hover:border-stone-300 hover:shadow-sm"
							onClick={onExportCodes}
						>
							导出可用码
						</button>
					</div>
					<div class="mb-4 flex flex-wrap items-end gap-3">
						<div>
							<label
								class="mb-1 block text-xs text-stone-500"
								htmlFor="invite-gen-count"
							>
								数量
							</label>
							<input
								id="invite-gen-count"
								type="number"
								min="1"
								max="100"
								class="w-20 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								value={genCount}
								onInput={(e) =>
									setGenCount(
										(e.currentTarget as HTMLInputElement)?.value ?? "10",
									)
								}
							/>
						</div>
						<div>
							<label
								class="mb-1 block text-xs text-stone-500"
								htmlFor="invite-gen-max-uses"
							>
								最大使用次数
							</label>
							<input
								id="invite-gen-max-uses"
								type="number"
								min="1"
								class="w-20 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								value={genMaxUses}
								onInput={(e) =>
									setGenMaxUses(
										(e.currentTarget as HTMLInputElement)?.value ?? "1",
									)
								}
							/>
						</div>
						<div>
							<label
								class="mb-1 block text-xs text-stone-500"
								htmlFor="invite-gen-prefix"
							>
								前缀
							</label>
							<input
								id="invite-gen-prefix"
								type="text"
								class="w-24 rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								value={genPrefix}
								onInput={(e) =>
									setGenPrefix(
										(e.currentTarget as HTMLInputElement)?.value ?? "ZEN-",
									)
								}
							/>
						</div>
						<button
							type="button"
							class="h-[34px] rounded-lg bg-stone-900 px-3 text-xs font-semibold text-white transition-shadow hover:shadow-lg"
							onClick={() =>
								onGenerateCodes(
									Number(genCount) || 10,
									Number(genMaxUses) || 1,
									genPrefix || "ZEN-",
								)
							}
						>
							批量生成
						</button>
					</div>
					{inviteCodes.length === 0 ? (
						<p class="py-4 text-center text-sm text-stone-400">暂无邀请码</p>
					) : (
						<div class="overflow-x-auto">
							<table class="w-full text-left text-sm">
								<thead>
									<tr class="border-b border-stone-100 text-xs uppercase tracking-widest text-stone-400">
										<th class="pb-2 pr-4 font-medium">邀请码</th>
										<th class="pb-2 pr-4 font-medium">最大次数</th>
										<th class="pb-2 pr-4 font-medium">已使用</th>
										<th class="pb-2 pr-4 font-medium">状态</th>
										<th class="pb-2 pr-4 font-medium">创建时间</th>
										<th class="pb-2 font-medium">操作</th>
									</tr>
								</thead>
								<tbody>
									{inviteCodes.map((code) => (
										<tr key={code.id} class="border-b border-stone-50">
											<td class="py-2 pr-4 font-['Space_Grotesk'] text-stone-700">
												{code.code}
											</td>
											<td class="py-2 pr-4 text-stone-600">{code.max_uses}</td>
											<td class="py-2 pr-4 text-stone-600">
												{code.used_count}
											</td>
											<td class="py-2 pr-4">
												<span
													class={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
														code.used_count >= code.max_uses
															? "bg-stone-100 text-stone-500"
															: "bg-green-50 text-green-600"
													}`}
												>
													{code.used_count >= code.max_uses ? "已用完" : "可用"}
												</span>
											</td>
											<td class="py-2 pr-4 text-xs text-stone-500">
												{code.created_at?.slice(0, 16)}
											</td>
											<td class="py-2">
												<button
													type="button"
													class="text-xs text-red-500 hover:text-red-700"
													onClick={() => onDeleteCode(code.id)}
												>
													删除
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<div class="mb-4 flex items-center justify-between">
					<h3 class="mb-0 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						通知与报警
					</h3>
				</div>
				<p class="mb-4 text-xs text-stone-500">
					每 5 分钟评估各渠道近期窗口失败率：达到阈值且样本量达标时向全部启用的
					Webhook
					推送报警（同渠道在静默窗口内不重复）；失败率回落到阈值一半以下后发送恢复通知。
				</p>
				<form class="grid gap-3.5 lg:grid-cols-2" onSubmit={onSubmit}>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="alert-failure-rate-pct"
						>
							失败率报警阈值（%）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="alert-failure-rate-pct"
							name="alert_failure_rate_pct"
							type="number"
							min="0"
							max="100"
							value={settingsForm.alert_failure_rate_pct}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									alert_failure_rate_pct: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							窗口内错误请求占比达到该阈值即触发报警，0 = 关闭报警。
						</p>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="alert-min-samples"
						>
							最小样本量（请求次数）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="alert-min-samples"
							name="alert_min_samples"
							type="number"
							min="0"
							max="10000"
							value={settingsForm.alert_min_samples}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									alert_min_samples: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							窗口内请求次数不足时不报警，防止低流量渠道误报。
						</p>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="alert-window-minutes"
						>
							评估窗口（分钟）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="alert-window-minutes"
							name="alert_window_minutes"
							type="number"
							min="5"
							max="120"
							value={settingsForm.alert_window_minutes}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									alert_window_minutes: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							失败率统计的回看窗口，范围 5–120 分钟。
						</p>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="alert-silence-minutes"
						>
							报警静默窗口（分钟）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="alert-silence-minutes"
							name="alert_silence_minutes"
							type="number"
							min="1"
							max="1440"
							value={settingsForm.alert_silence_minutes}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								onFormChange({
									alert_silence_minutes: target?.value ?? "",
								});
							}}
						/>
						<p class="mt-1 text-xs text-stone-500">
							同渠道两次报警之间的最小间隔，范围 1–1440 分钟。
						</p>
					</div>
					<div class="lg:col-span-2">
						<label
							class="flex cursor-pointer items-center gap-2.5 text-sm text-stone-700"
							for="setting-daily-report"
						>
							<ToggleSwitch
								id="setting-daily-report"
								checked={settingsForm.daily_report_enabled === "true"}
								onChange={(checked) => {
									onFormChange({
										daily_report_enabled: checked ? "true" : "false",
									});
								}}
							/>
							启用每日用量日报
						</label>
						<p class="mt-1 text-xs text-stone-500">
							每日 03:17 UTC（维护任务之后）聚合昨日请求量 / Tokens / 消费额 /
							错误率与 Top 渠道、模型，推送到全部启用的 Webhook。
						</p>
					</div>
					<div class="flex items-end lg:col-span-2">
						<button
							class="h-11 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
							type="submit"
						>
							保存报警设置
						</button>
					</div>
				</form>
				<div class="mt-5 border-t border-stone-100 pt-4">
					<h4 class="mb-3 text-sm font-semibold text-stone-700">
						Webhook 通知通道
					</h4>
					{webhooks.length === 0 ? (
						<p class="py-2 text-center text-sm text-stone-400">
							暂无 Webhook，添加后开始接收报警与日报
						</p>
					) : (
						<div class="overflow-x-auto">
							<table class="w-full text-left text-sm">
								<thead>
									<tr class="border-b border-stone-100 text-xs uppercase tracking-widest text-stone-400">
										<th class="pb-2 pr-4 font-medium">名称</th>
										<th class="pb-2 pr-4 font-medium">类型</th>
										<th class="pb-2 pr-4 font-medium">地址</th>
										<th class="pb-2 pr-4 font-medium">启用</th>
										<th class="pb-2 font-medium">操作</th>
									</tr>
								</thead>
								<tbody>
									{webhooks.map((hook) => (
										<tr key={hook.id} class="border-b border-stone-50">
											<td class="py-2 pr-4 text-stone-700">{hook.name}</td>
											<td class="py-2 pr-4">
												<span
													class={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${webhookTypeBadgeClass[hook.type]}`}
												>
													{WEBHOOK_TYPE_LABELS[hook.type]}
												</span>
											</td>
											<td
												class="max-w-[16rem] truncate py-2 pr-4 font-mono text-xs text-stone-500"
												title={hook.url}
											>
												{hook.url}
											</td>
											<td class="py-2 pr-4">
												<ToggleSwitch
													id={`webhook-enabled-${hook.id}`}
													checked={hook.enabled}
													onChange={(checked) => {
														void onToggleWebhook(hook.id, checked);
													}}
												/>
											</td>
											<td class="py-2">
												<button
													type="button"
													class="mr-3 text-xs text-amber-600 hover:text-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
													disabled={whTesting === hook.id}
													onClick={() => {
														void handleWebhookTestClick(hook.id);
													}}
												>
													{whTesting === hook.id ? "发送中…" : "测试"}
												</button>
												<button
													type="button"
													class="text-xs text-red-500 hover:text-red-700"
													onClick={() => onDeleteWebhook(hook.id)}
												>
													删除
												</button>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					<div class="mt-4 grid gap-3 lg:grid-cols-[10rem_9rem_1fr_auto]">
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							placeholder="名称，如 运维群"
							type="text"
							value={whName}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								setWhName(target?.value ?? "");
							}}
						/>
						<select
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							value={whType}
							onChange={(event) => {
								const target = event.currentTarget as HTMLSelectElement | null;
								setWhType((target?.value ?? "feishu") as WebhookType);
							}}
						>
							{(Object.keys(WEBHOOK_TYPE_LABELS) as WebhookType[]).map(
								(type) => (
									<option key={type} value={type}>
										{WEBHOOK_TYPE_LABELS[type]}
									</option>
								),
							)}
						</select>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							placeholder="https://… 机器人 Webhook 地址"
							type="text"
							value={whUrl}
							onInput={(event) => {
								const target = event.currentTarget as HTMLInputElement | null;
								setWhUrl(target?.value ?? "");
							}}
						/>
						<button
							type="button"
							class="h-[38px] rounded-lg bg-stone-900 px-4 text-xs font-semibold text-white transition-shadow hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-60"
							disabled={whAdding || !whName.trim() || !whUrl.trim()}
							onClick={() => {
								void handleWebhookAddClick();
							}}
						>
							{whAdding ? "添加中…" : "添加"}
						</button>
					</div>
					<p class="mt-2 text-xs text-stone-500">
						支持飞书 / 企业微信 / 钉钉 / Slack 群机器人与 Generic 自定义端点
						（收到统一 JSON 消息结构）；地址须为
						https。保存前可先添加再用「测试」验证送达。
					</p>
				</div>
			</div>
		</div>
	);
};
