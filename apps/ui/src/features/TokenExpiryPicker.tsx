import { useState } from "hono/jsx/dom";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 有效期预设:numeric 值为天数(点击即按 now+N天 解析);permanent/custom 走专门分支 */
const EXPIRY_PRESETS = [
	{ value: "permanent", label: "永久" },
	{ value: "1d", label: "1 天" },
	{ value: "7d", label: "7 天" },
	{ value: "30d", label: "30 天" },
	{ value: "custom", label: "自定义" },
] as const;

const pad2 = (value: number) => String(value).padStart(2, "0");

/** ISO → datetime-local 输入值(本地时区,分钟精度);空/非法回退空串 */
const isoToDatetimeLocal = (iso: string): string => {
	if (!iso) {
		return "";
	}
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
		date.getDate(),
	)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/** datetime-local 输入值 → ISO;空/非法 → ""(= 永久,由提示文案交代) */
const resolveDatetimeLocal = (raw: string): string => {
	if (!raw) {
		return "";
	}
	const ms = new Date(raw).getTime();
	if (Number.isNaN(ms)) {
		return "";
	}
	return new Date(ms).toISOString();
};

type TokenExpiryPickerProps = {
	/** 解析后的截止时刻(ISO);空串 = 永久 */
	value: string;
	onChange: (next: string) => void;
	/** 输入 id 前缀(同一页面创建/编辑模态共存时避免撞 id) */
	idPrefix: string;
};

/**
 * 有效期选择器(管理台与用户端令牌表单共用):预设 1 天 / 7 天 / 30 天 /
 * 自定义(datetime-local)/ 永久(默认)。每次交互即时解析出最终 ISO 值回调给
 * 调用方——预设按钮在点击时刻取 now,自定义输入逐次同步;空的自定义输入 =
 * 永久(与服务端「空串/null → 永久」三态一致)。
 */
export const TokenExpiryPicker = ({
	value,
	onChange,
	idPrefix,
}: TokenExpiryPickerProps) => {
	const [preset, setPreset] = useState<string>(value ? "custom" : "permanent");
	const [customValue, setCustomValue] = useState<string>(() =>
		isoToDatetimeLocal(value),
	);

	const applyPreset = (nextPreset: string) => {
		setPreset(nextPreset);
		if (nextPreset === "permanent") {
			onChange("");
			return;
		}
		if (nextPreset === "custom") {
			onChange(resolveDatetimeLocal(customValue));
			return;
		}
		const days = Number.parseInt(nextPreset, 10);
		if (Number.isFinite(days) && days > 0) {
			onChange(new Date(Date.now() + days * DAY_MS).toISOString());
		}
	};

	const handleCustomChange = (raw: string) => {
		setCustomValue(raw);
		if (preset === "custom") {
			onChange(resolveDatetimeLocal(raw));
		}
	};

	return (
		<div>
			<label
				class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
				for={`${idPrefix}-expiry-preset`}
			>
				有效期
			</label>
			<div class="flex flex-wrap items-center gap-2">
				<select
					class="rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
					id={`${idPrefix}-expiry-preset`}
					value={preset}
					onChange={(event) =>
						applyPreset((event.currentTarget as HTMLSelectElement)?.value ?? "")
					}
				>
					{EXPIRY_PRESETS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
				{preset === "custom" ? (
					<input
						class="w-full sm:w-auto rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
						type="datetime-local"
						value={customValue}
						onInput={(event) =>
							handleCustomChange(
								(event.currentTarget as HTMLInputElement)?.value ?? "",
							)
						}
					/>
				) : null}
			</div>
			<p class="mt-1 text-xs text-stone-400">
				{preset === "custom"
					? "选择截止日期时间，未选择 = 永久"
					: "到期后令牌将被拒绝使用，可随时改期恢复"}
			</p>
		</div>
	);
};
