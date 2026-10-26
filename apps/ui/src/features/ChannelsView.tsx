import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "hono/jsx/dom";
import { CLIENT_PRESETS, type ClientPreset } from "../core/client-presets";
import {
	CHANNEL_API_FORMATS,
	CHANNEL_ENDPOINT_OVERRIDE_FORMATS,
	formatBadgeColors,
	formatLabels,
} from "../core/constants";
import type {
	Channel,
	ChannelApiFormat,
	ChannelEndpointOverrideKey,
	ChannelForm,
	ModelTestResult,
} from "../core/types";
import { buildPageItems, parseChannelApiFormats } from "../core/utils";
import type { ModelAliasesMap } from "../UserApp";
import { Modal } from "./Modal";
import { ToggleSwitch } from "./ToggleSwitch";

type ParsedModel = {
	id: string;
	input_price: string;
	output_price: string;
	enabled: boolean;
};

/**
 * Parses the per-line model format `id|input|output|enabled`.
 * Legacy 5-segment lines (`id|input|output|<obsolete>|enabled`) are
 * tolerated: the removed flag at index 3 is ignored and enabled is read
 * from index 4.
 */
function parseModelLines(text: string): ParsedModel[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const parts = line.split("|");
			const enabledRaw = parts.length > 4 ? parts[4] : parts[3];
			const hasExplicitEnabled =
				enabledRaw !== undefined && enabledRaw.trim() !== "";
			return {
				id: parts[0].trim(),
				input_price: parts[1]?.trim() ?? "",
				output_price: parts[2]?.trim() ?? "",
				enabled: hasExplicitEnabled ? enabledRaw.trim() !== "0" : true,
			};
		});
}

function rebuildModelsText(models: ParsedModel[]): string {
	return models
		.map((m) => {
			if (m.input_price || m.output_price || m.enabled === false) {
				return `${m.id}|${m.input_price}|${m.output_price}|${m.enabled ? "1" : "0"}`;
			}
			return m.id;
		})
		.join("\n");
}

type ModelPricingEditorProps = {
	models: string;
	onModelsChange: (value: string) => void;
};

const ModelPricingEditor = ({
	models,
	onModelsChange,
}: ModelPricingEditorProps) => {
	const parsed = parseModelLines(models);
	if (parsed.length === 0) return null;

	const enabledCount = parsed.filter((m) => m.enabled).length;
	const allEnabled = enabledCount === parsed.length;
	const noneEnabled = enabledCount === 0;

	const updatePrice = (
		index: number,
		field: "input_price" | "output_price",
		value: string,
	) => {
		const updated = [...parsed];
		updated[index] = { ...updated[index], [field]: value };
		onModelsChange(rebuildModelsText(updated));
	};

	const updateEnabled = (index: number, value: boolean) => {
		const updated = [...parsed];
		updated[index] = { ...updated[index], enabled: value };
		onModelsChange(rebuildModelsText(updated));
	};

	const toggleAllEnabled = (value: boolean) => {
		const updated = parsed.map((m) => ({ ...m, enabled: value }));
		onModelsChange(rebuildModelsText(updated));
	};

	return (
		<div class="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
			<div class="mb-2 flex items-center justify-between flex-wrap gap-2">
				<p class="text-xs font-medium uppercase tracking-widest text-stone-400">
					模型定价
				</p>
				<div class="flex items-center gap-1.5 flex-wrap">
					<span class="text-xs text-stone-400">
						{enabledCount}/{parsed.length} 启用
					</span>
					<button
						type="button"
						class={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors ${
							allEnabled
								? "bg-stone-200 text-stone-500"
								: "bg-blue-100 text-blue-700 hover:bg-blue-200"
						}`}
						onClick={() => toggleAllEnabled(true)}
						disabled={allEnabled}
					>
						全部启用
					</button>
					<button
						type="button"
						class={`rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors ${
							noneEnabled
								? "bg-stone-200 text-stone-500"
								: "bg-stone-100 text-stone-600 hover:bg-stone-200"
						}`}
						onClick={() => toggleAllEnabled(false)}
						disabled={noneEnabled}
					>
						全部禁用
					</button>
				</div>
			</div>
			<div class="space-y-2">
				{parsed.map((m, i) => (
					<div
						key={`${m.id}-${i}`}
						class={`flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2 ${!m.enabled ? "opacity-50" : ""}`}
					>
						<div class="flex min-w-0 flex-1 items-center gap-2">
							<button
								type="button"
								class={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold transition-colors ${
									m.enabled
										? "border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100"
										: "border-stone-200 bg-white text-stone-400 hover:bg-stone-100 hover:text-stone-600"
								}`}
								onClick={() => updateEnabled(i, !m.enabled)}
							>
								{m.enabled ? "启用" : "禁用"}
							</button>
							<span
								class={`min-w-0 truncate text-xs font-medium ${m.enabled ? "text-stone-700" : "text-stone-400 line-through"}`}
							>
								{m.id}
							</span>
						</div>
						<div class="flex shrink-0 items-center gap-1.5">
							<label
								class="text-xs text-stone-400"
								htmlFor={`model-input-price-${i}`}
							>
								输入
							</label>
							<input
								id={`model-input-price-${i}`}
								class="w-20 rounded border border-stone-200 bg-white px-2 py-1 text-xs text-stone-900 placeholder:text-stone-300 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-200"
								type="number"
								min="0"
								step="0.01"
								placeholder="0"
								value={m.input_price}
								onInput={(e) =>
									updatePrice(
										i,
										"input_price",
										(e.currentTarget as HTMLInputElement).value,
									)
								}
							/>
							<label
								class="text-xs text-stone-400"
								htmlFor={`model-output-price-${i}`}
							>
								输出
							</label>
							<input
								id={`model-output-price-${i}`}
								class="w-20 rounded border border-stone-200 bg-white px-2 py-1 text-xs text-stone-900 placeholder:text-stone-300 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-200"
								type="number"
								min="0"
								step="0.01"
								placeholder="0"
								value={m.output_price}
								onInput={(e) =>
									updatePrice(
										i,
										"output_price",
										(e.currentTarget as HTMLInputElement).value,
									)
								}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
};

type ChannelsViewProps = {
	channelForm: ChannelForm;
	channelPage: number;
	channelPageSize: number;
	channelTotal: number;
	channelTotalPages: number;
	pagedChannels: Channel[];
	channelSearch: string;
	editingChannel: Channel | null;
	isChannelModalOpen: boolean;
	channelAliasState: ModelAliasesMap;
	onChannelAliasStateChange: (state: ModelAliasesMap) => void;
	onCreate: () => void;
	onCloseModal: () => void;
	onEdit: (channel: Channel) => void;
	onSubmit: (event: Event) => void;
	onTest: (id: string) => void;
	onToggle: (id: string, status: string) => void;
	onDelete: (id: string) => void;
	onPageChange: (next: number) => void;
	onPageSizeChange: (next: number) => void;
	onSearchChange: (value: string) => void;
	onFormChange: (patch: Partial<ChannelForm>) => void;
	fetchingModels: boolean;
	fetchedModels: string[] | null;
	fetchedSearch: string;
	selectedFetched: Set<string>;
	onFetchModels: () => void;
	onConfirmFetched: () => void;
	onCancelFetched: () => void;
	onFetchedSearchChange: (value: string) => void;
	onToggleFetched: (modelId: string) => void;
	onToggleAllFetched: (visible: string[], select: boolean) => void;
	modelTestResults: Record<string, ModelTestResult>;
	modelTestRunning: boolean;
	modelTestPrompt: string;
	onRunModelTests: (models: string[], text: string) => Promise<void>;
	onStopModelTests: () => void;
	onRetryModelTest: (model: string, text: string) => Promise<void>;
};

const pageSizeOptions = [10, 20, 50];

/**
 * 服务端客户端预设（网关每请求实时渲染指纹，渠道行只存 ID 指针）。
 * ID 白名单与 worker services/client-presets.ts 的 CLIENT_PRESET_IDS 同步——
 * 预设本体是代码常量不进 DB，UI 仅承载选择与文案。
 */
const SERVER_CLIENT_PRESETS: Array<{ id: string; label: string }> = [
	{ id: "opencode_zen_v1", label: "OpenCode Zen v1（免费档指纹）" },
];

const baseUrlPlaceholders: Record<ChannelApiFormat, string> = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/anthropic",
	custom: "https://example.com/v1/chat/completions",
	responses: "https://api.openai.com/v1",
};

/** 端点覆盖输入框 placeholder：留空时的 Base URL 推导形态（引导填写语义） */
const endpointOverridePlaceholders: Record<ChannelEndpointOverrideKey, string> =
	{
		openai: "留空则按 Base URL 推导（…/chat/completions）",
		responses: "留空则按 Base URL 推导（…/responses）",
		anthropic: "留空则按 Base URL 推导（…/v1/messages，勿含 /v1）",
	};

/**
 * Renders the channels management view.
 */
export const ChannelsView = ({
	channelForm,
	channelPage,
	channelPageSize,
	channelTotal,
	channelTotalPages,
	pagedChannels,
	channelSearch,
	editingChannel,
	isChannelModalOpen,
	channelAliasState,
	onChannelAliasStateChange,
	onCreate,
	onCloseModal,
	onEdit,
	onSubmit,
	onTest,
	onToggle,
	onDelete,
	onPageChange,
	onPageSizeChange,
	onSearchChange,
	onFormChange,
	fetchingModels,
	fetchedModels,
	fetchedSearch,
	selectedFetched,
	onFetchModels,
	onConfirmFetched,
	onCancelFetched,
	onFetchedSearchChange,
	onToggleFetched,
	onToggleAllFetched,
	modelTestResults,
	modelTestRunning,
	modelTestPrompt,
	onRunModelTests,
	onStopModelTests,
	onRetryModelTest,
}: ChannelsViewProps) => {
	const isEditing = Boolean(editingChannel);
	const pageItems = buildPageItems(channelPage, channelTotalPages);

	// Local UI state for expanded alias editors
	const [expandedAliasModels, setExpandedAliasModels] = useState<Set<string>>(
		new Set(),
	);

	// —— 模型测试区块本地状态（纯展示 + 回调，不发请求） ——
	const [modelTestExpanded, setModelTestExpanded] = useState(false);
	const [modelTestText, setModelTestText] = useState(modelTestPrompt);
	const [selectedTestModels, setSelectedTestModels] = useState<Set<string>>(
		() => new Set<string>(),
	);
	const [testSearch, setTestSearch] = useState("");
	// 弹窗打开沿重置：文本回 settings 默认、清空勾选与搜索（运行中可临时改，
	// 不写回设置）
	const wasModalOpenRef = useRef(false);
	const [disguiseHeadersInvalid, setDisguiseHeadersInvalid] = useState(false);
	const [appliedPresetId, setAppliedPresetId] = useState<string | null>(null);
	useEffect(() => {
		if (isChannelModalOpen && !wasModalOpenRef.current) {
			setModelTestText(modelTestPrompt);
			setSelectedTestModels(new Set());
			setTestSearch("");
			setModelTestExpanded(false);
			setDisguiseHeadersInvalid(false);
			setAppliedPresetId(null);
		}
		wasModalOpenRef.current = isChannelModalOpen;
	}, [isChannelModalOpen, modelTestPrompt]);

	// Parse model IDs from the pipe-delimited models text
	const parsedModelIds = useMemo(
		() =>
			channelForm.models
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => line.split("|")[0].trim())
				.filter(Boolean),
		[channelForm.models],
	);

	// IDs already present in the models textarea (for pre-check + badge)
	const existingModelIdSet = useMemo(
		() => new Set(parsedModelIds),
		[parsedModelIds],
	);

	// Filtered & visible fetched models for the picker modal
	const visibleFetched = useMemo(
		() =>
			fetchedModels
				? fetchedModels.filter((m) =>
						m.toLowerCase().includes(fetchedSearch.toLowerCase()),
					)
				: [],
		[fetchedModels, fetchedSearch],
	);
	const allVisibleFetchedSelected =
		visibleFetched.length > 0 &&
		visibleFetched.every((m) => selectedFetched.has(m));

	// Selected models that confirm would actually add (excluding existing ones)
	const newSelectedCount = useMemo(
		() =>
			[...selectedFetched].filter((id) => !existingModelIdSet.has(id)).length,
		[selectedFetched, existingModelIdSet],
	);

	// —— API 格式多选（custom 独占：勾选即清空其余并禁用其余 chip，切出后恢复可选） ——
	const selectedFormats = channelForm.api_formats;
	const hasCustom = selectedFormats.includes("custom");
	const isPureAnthropic =
		selectedFormats.length === 1 && selectedFormats[0] === "anthropic";
	// base_url 存储约定：保留版本路径（如 /v1）；anthropic 端点在请求时自动
	// 规范化，多格式含 anthropic 也沿用通用 openai 形态提示，仅纯 anthropic
	// 渠道（存储经 normalizeBaseUrl）提示 anthropic 形态
	const baseUrlPlaceholder = hasCustom
		? baseUrlPlaceholders.custom
		: isPureAnthropic
			? baseUrlPlaceholders.anthropic
			: baseUrlPlaceholders.openai;
	const toggleApiFormat = useCallback(
		(format: ChannelApiFormat) => {
			const current = channelForm.api_formats;
			if (format === "custom") {
				// custom 独占：勾选即独占；再点取消 → 清空（提交前由「至少一项」校验兜底）
				onFormChange({
					api_formats: current.includes("custom") ? [] : ["custom"],
				});
				return;
			}
			onFormChange({
				api_formats: current.includes(format)
					? current.filter((item) => item !== format)
					: [...current, format],
			});
		},
		[channelForm.api_formats, onFormChange],
	);

	// —— 模型测试派生状态 ——
	const visibleTestModels = useMemo(
		() =>
			parsedModelIds.filter((m) =>
				m.toLowerCase().includes(testSearch.toLowerCase()),
			),
		[parsedModelIds, testSearch],
	);
	// 保持候选列表顺序，避免勾选顺序影响测试顺序
	const selectedTestList = useMemo(
		() => parsedModelIds.filter((id) => selectedTestModels.has(id)),
		[parsedModelIds, selectedTestModels],
	);
	const hasTestTarget =
		channelForm.base_url.trim() !== "" && channelForm.api_key.trim() !== "";
	const testDisabledHint = !hasTestTarget
		? "请先填写 Base URL 与 API Key"
		: selectedFormats.length === 0
			? "请先选择至少一种 API 格式"
			: selectedTestList.length === 0
				? "请先勾选要测试的模型"
				: "";
	// 结果按候选模型顺序排列（不在候选中的残留结果排在末尾）
	const testResultEntries = useMemo(() => {
		const order = new Map(parsedModelIds.map((id, index) => [id, index]));
		return Object.entries(modelTestResults).sort(
			([a], [b]) =>
				(order.get(a) ?? Number.MAX_SAFE_INTEGER) -
					(order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b),
		);
	}, [modelTestResults, parsedModelIds]);
	const testSuccessCount = testResultEntries.filter(
		([, result]) => result.status === "success",
	).length;

	const toggleTestModel = useCallback((modelId: string) => {
		setSelectedTestModels((prev) => {
			const next = new Set(prev);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});
	}, []);

	const selectAllVisibleTest = useCallback(() => {
		setSelectedTestModels((prev) => {
			const next = new Set(prev);
			for (const id of visibleTestModels) next.add(id);
			return next;
		});
	}, [visibleTestModels]);

	const invertVisibleTest = useCallback(() => {
		setSelectedTestModels((prev) => {
			const next = new Set(prev);
			for (const id of visibleTestModels) {
				if (next.has(id)) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	}, [visibleTestModels]);

	const toggleAliasExpanded = useCallback((modelId: string) => {
		setExpandedAliasModels((prev) => {
			const next = new Set(prev);
			if (next.has(modelId)) next.delete(modelId);
			else next.add(modelId);
			return next;
		});
	}, []);

	const addAlias = useCallback(
		(modelId: string, alias: string) => {
			const trimmed = alias.trim();
			if (!trimmed) return;
			onChannelAliasStateChange({
				...channelAliasState,
				[modelId]: {
					aliases: [
						...(channelAliasState[modelId]?.aliases ?? []),
						...(channelAliasState[modelId]?.aliases?.includes(trimmed)
							? []
							: [trimmed]),
					],
					alias_only: channelAliasState[modelId]?.alias_only ?? false,
				},
			});
		},
		[channelAliasState, onChannelAliasStateChange],
	);

	const removeAlias = useCallback(
		(modelId: string, index: number) => {
			const existing = channelAliasState[modelId];
			if (!existing) return;
			onChannelAliasStateChange({
				...channelAliasState,
				[modelId]: {
					...existing,
					aliases: existing.aliases.filter((_, i) => i !== index),
				},
			});
		},
		[channelAliasState, onChannelAliasStateChange],
	);

	const toggleAliasOnly = useCallback(
		(modelId: string, checked: boolean) => {
			onChannelAliasStateChange({
				...channelAliasState,
				[modelId]: {
					aliases: channelAliasState[modelId]?.aliases ?? [],
					alias_only: checked,
				},
			});
		},
		[channelAliasState, onChannelAliasStateChange],
	);

	// —— 客户端伪装（纯 UI 交互：预设覆盖填充 / JSON 失焦校验 / 清空） ——
	// 快照预设应用 = 关闭服务端预设（互斥：disguise_preset 置空，指纹改由
	// 下方可编辑的快照头/提示词承载）
	const applyPreset = useCallback(
		(preset: ClientPreset) => {
			onFormChange({
				disguise_headers: JSON.stringify(preset.headers, null, 2),
				disguise_system_prompt: preset.systemPrompt,
				disguise_preset: "",
			});
			setAppliedPresetId(preset.id);
			setDisguiseHeadersInvalid(false);
		},
		[onFormChange],
	);

	const validateDisguiseHeaders = useCallback(() => {
		const text = channelForm.disguise_headers.trim();
		if (text === "") {
			setDisguiseHeadersInvalid(false);
			return;
		}
		try {
			const parsed: unknown = JSON.parse(text);
			setDisguiseHeadersInvalid(
				typeof parsed !== "object" || parsed === null || Array.isArray(parsed),
			);
		} catch {
			setDisguiseHeadersInvalid(true);
		}
	}, [channelForm.disguise_headers]);

	const clearDisguise = useCallback(() => {
		onFormChange({
			disguise_headers: "",
			disguise_system_prompt: "",
			disguise_preset: "",
		});
		setAppliedPresetId(null);
		setDisguiseHeadersInvalid(false);
	}, [onFormChange]);

	// 最近一次选中预设的快照说明（note：来源锚点 / 版本锦点 / 省略头与动态段），小字展示
	const appliedPresetNote = appliedPresetId
		? (CLIENT_PRESETS.find((p) => p.id === appliedPresetId)?.note ?? null)
		: null;
	return (
		<div class="space-y-5">
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
							渠道列表
						</h3>
						<p class="text-xs text-stone-500">状态、权重与操作入口集中展示。</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<input
							class="h-10 md:h-9 w-full rounded-full border border-stone-200 bg-white px-4 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 sm:w-52"
							type="text"
							placeholder="搜索渠道..."
							value={channelSearch}
							onInput={(e) =>
								onSearchChange((e.currentTarget as HTMLInputElement).value)
							}
						/>
						<button
							class="h-10 md:h-9 rounded-full bg-stone-900 px-4 text-xs font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
							type="button"
							onClick={onCreate}
						>
							新增渠道
						</button>
					</div>
				</div>

				{/* Desktop table layout */}
				<div class="mt-4 hidden md:block overflow-hidden rounded-xl border border-stone-200">
					<div class="grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.5fr)_minmax(0,0.7fr)_minmax(0,0.6fr)_minmax(0,1.6fr)] gap-3 bg-stone-50 px-4 py-3 text-xs uppercase tracking-widest text-stone-500">
						<div>渠道</div>
						<div>格式</div>
						<div>状态</div>
						<div>权重</div>
						<div>操作</div>
					</div>
					{pagedChannels.length === 0 ? (
						<div class="px-4 py-10 text-center text-sm text-stone-500">
							暂无渠道，请先创建。
						</div>
					) : (
						<div class="divide-y divide-stone-100">
							{pagedChannels.map((channel) => {
								const isActive = channel.status === "active";
								return (
									<div
										class={`grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.5fr)_minmax(0,0.7fr)_minmax(0,0.6fr)_minmax(0,1.6fr)] items-center gap-3 px-4 py-4 text-sm ${
											editingChannel?.id === channel.id
												? "bg-amber-50/60"
												: "bg-white"
										}`}
										key={channel.id}
									>
										<div class="flex min-w-0 flex-col">
											<span class="truncate font-semibold text-stone-900">
												{channel.name}
											</span>
											<span
												class="truncate text-xs text-stone-500"
												title={channel.base_url}
											>
												{channel.base_url}
											</span>
										</div>
										<div class="flex flex-wrap gap-1">
											{parseChannelApiFormats(channel).map((format) => (
												<span
													key={format}
													class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${formatBadgeColors[format]}`}
												>
													{formatLabels[format]}
												</span>
											))}
										</div>
										<div>
											<span
												class={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
													isActive
														? "border-emerald-100 bg-emerald-50 text-emerald-600"
														: "border-stone-200 bg-stone-100 text-stone-500"
												}`}
											>
												{isActive ? "启用" : "禁用"}
											</span>
										</div>
										<div class="text-sm font-semibold text-stone-700">
											{channel.weight}
										</div>
										<div class="flex flex-wrap gap-2">
											<button
												class="h-9 rounded-full border border-stone-200 bg-stone-100 px-3 text-xs font-semibold text-stone-900 transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onTest(channel.id)}
											>
												连通测试
											</button>
											<button
												class="h-9 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onToggle(channel.id, channel.status)}
											>
												{isActive ? "禁用" : "启用"}
											</button>
											<button
												class="h-9 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onEdit(channel)}
											>
												编辑
											</button>
											<button
												class="h-9 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onDelete(channel.id)}
											>
												删除
											</button>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* Mobile card layout */}
				<div class="mt-4 md:hidden space-y-3">
					{pagedChannels.length === 0 ? (
						<div class="px-4 py-10 text-center text-sm text-stone-500 rounded-xl border border-stone-200">
							暂无渠道，请先创建。
						</div>
					) : (
						pagedChannels.map((channel) => {
							const isActive = channel.status === "active";
							return (
								<div
									class={`rounded-xl border border-stone-200 p-4 ${
										editingChannel?.id === channel.id
											? "bg-amber-50/60"
											: "bg-white"
									}`}
									key={channel.id}
								>
									<div class="flex items-start justify-between gap-2">
										<div class="min-w-0 flex-1">
											<div class="flex items-center gap-2 flex-wrap">
												<span class="truncate font-semibold text-stone-900 text-sm">
													{channel.name}
												</span>
												{parseChannelApiFormats(channel).map((format) => (
													<span
														key={format}
														class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${formatBadgeColors[format]}`}
													>
														{formatLabels[format]}
													</span>
												))}
											</div>
											<span
												class="block truncate text-xs text-stone-500 mt-1"
												title={channel.base_url}
											>
												{channel.base_url}
											</span>
										</div>
										<span
											class={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
												isActive
													? "border-emerald-100 bg-emerald-50 text-emerald-600"
													: "border-stone-200 bg-stone-100 text-stone-500"
											}`}
										>
											{isActive ? "启用" : "禁用"}
										</span>
									</div>
									<div class="mt-2 text-xs text-stone-500">
										权重:{" "}
										<span class="font-semibold text-stone-700">
											{channel.weight}
										</span>
									</div>
									<div class="mt-3 flex flex-wrap gap-2">
										<button
											class="h-10 rounded-full border border-stone-200 bg-stone-100 px-3 text-xs font-semibold text-stone-900 transition-shadow duration-200 hover:shadow-lg"
											type="button"
											onClick={() => onTest(channel.id)}
										>
											连通测试
										</button>
										<button
											class="h-10 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[color,background-color,border-color,box-shadow] duration-200 hover:text-stone-900 hover:shadow-lg"
											type="button"
											onClick={() => onToggle(channel.id, channel.status)}
										>
											{isActive ? "禁用" : "启用"}
										</button>
										<button
											class="h-10 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[color,background-color,border-color,box-shadow] duration-200 hover:text-stone-900 hover:shadow-lg"
											type="button"
											onClick={() => onEdit(channel)}
										>
											编辑
										</button>
										<button
											class="h-10 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-500 transition-[color,background-color,border-color,box-shadow] duration-200 hover:text-stone-900 hover:shadow-lg"
											type="button"
											onClick={() => onDelete(channel.id)}
										>
											删除
										</button>
									</div>
								</div>
							);
						})
					)}
				</div>

				<div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-stone-500">
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-xs text-stone-500">
							共 {channelTotal} 条 · {channelTotalPages} 页
						</span>
						<button
							class="h-10 w-10 md:h-8 md:w-8 rounded-full border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
							type="button"
							disabled={channelPage <= 1}
							onClick={() => onPageChange(Math.max(1, channelPage - 1))}
						>
							&lt;
						</button>
						{pageItems.map((item, index) =>
							item === "ellipsis" ? (
								<span class="px-2 text-xs text-stone-400" key={`e-${index}`}>
									...
								</span>
							) : (
								<button
									class={`h-10 min-w-10 md:h-8 md:min-w-8 rounded-full border px-3 text-xs font-semibold transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white ${
										item === channelPage
											? "border-stone-900 bg-stone-900 text-white shadow-md"
											: "border-stone-200 bg-white text-stone-600 hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-md"
									}`}
									type="button"
									key={item}
									onClick={() => onPageChange(item)}
								>
									{item}
								</button>
							),
						)}
						<button
							class="h-10 w-10 md:h-8 md:w-8 rounded-full border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
							type="button"
							disabled={channelPage >= channelTotalPages}
							onClick={() =>
								onPageChange(Math.min(channelTotalPages, channelPage + 1))
							}
						>
							&gt;
						</button>
					</div>
					<label class="flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs text-stone-500">
						每页条数
						<select
							class="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-700 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							value={channelPageSize}
							onChange={(event) => {
								onPageSizeChange(
									Number((event.currentTarget as HTMLSelectElement).value),
								);
							}}
						>
							{pageSizeOptions.map((size) => (
								<option key={size} value={size}>
									{size}
								</option>
							))}
						</select>
					</label>
				</div>
			</div>
			<Modal
				isOpen={isChannelModalOpen}
				onClose={onCloseModal}
				sheet
				panelClass="w-full max-w-3xl rounded-t-2xl md:rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
			>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
							{isEditing ? "编辑渠道" : "新增渠道"}
						</h3>
						<p class="text-xs text-stone-500">
							{isEditing
								? `正在编辑：${editingChannel?.name ?? ""}`
								: "填写渠道信息并保存。"}
						</p>
					</div>
					<button
						class="h-10 md:h-9 rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
						type="button"
						onClick={onCloseModal}
					>
						关闭
					</button>
				</div>
				<form class="mt-4 grid gap-3.5" onSubmit={onSubmit}>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="channel-name"
						>
							名称
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="channel-name"
							name="name"
							value={channelForm.name}
							required
							onInput={(event) =>
								onFormChange({
									name: (event.currentTarget as HTMLInputElement).value,
								})
							}
						/>
					</div>
					<fieldset class="min-w-0">
						<legend class="mb-1.5 text-xs uppercase tracking-widest text-stone-500">
							API 格式（可多选）
						</legend>
						<div class="flex flex-wrap gap-2">
							{CHANNEL_API_FORMATS.map((format) => {
								const selected = selectedFormats.includes(format);
								const disabled = hasCustom && format !== "custom";
								return (
									<button
										type="button"
										key={format}
										aria-pressed={selected}
										disabled={disabled}
										onClick={() => toggleApiFormat(format)}
										class={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
											selected
												? formatBadgeColors[format]
												: "border-stone-200 bg-white text-stone-500 hover:bg-stone-50 hover:text-stone-700"
										}`}
									>
										{formatLabels[format]}
									</button>
								);
							})}
						</div>
						{selectedFormats.length === 0 && (
							<p class="mt-1.5 text-xs text-amber-600">
								请至少选择一种 API 格式
							</p>
						)}
						{hasCustom && (
							<p class="mt-1.5 text-xs text-stone-400">
								Custom 为独占格式：Base URL 即完整请求 URL，不可与其他格式组合。
							</p>
						)}
					</fieldset>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="channel-base"
						>
							{hasCustom ? "完整请求 URL" : "Base URL（含版本路径，如 /v1）"}
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="channel-base"
							name="base_url"
							placeholder={baseUrlPlaceholder}
							value={channelForm.base_url}
							required
							onInput={(event) =>
								onFormChange({
									base_url: (event.currentTarget as HTMLInputElement).value,
								})
							}
						/>
						{selectedFormats.includes("anthropic") && !isPureAnthropic && (
							<p class="mt-1 text-xs text-stone-400">
								含 Anthropic 格式：/v1/messages 端点按请求自动规范化，Base URL
								保留版本路径即可。
							</p>
						)}
					</div>
					{/* 每格式端点覆盖（可选，高级项）：仅按当前选中的非 custom 格式渲染；
						未选格式不渲染也不提交，custom 独占时整体不出现 */}
					{CHANNEL_ENDPOINT_OVERRIDE_FORMATS.filter((format) =>
						selectedFormats.includes(format),
					).map((format) => (
						<div key={format}>
							<label
								class="mb-1 block text-xs uppercase tracking-widest text-stone-400"
								for={`channel-endpoint-${format}`}
							>
								{formatLabels[format]} 端点覆盖（可选）
							</label>
							<input
								class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								id={`channel-endpoint-${format}`}
								name={`endpoint_override_${format}`}
								placeholder={endpointOverridePlaceholders[format]}
								value={channelForm.endpoint_overrides[format]}
								onInput={(event) =>
									onFormChange({
										endpoint_overrides: {
											...channelForm.endpoint_overrides,
											[format]: (event.currentTarget as HTMLInputElement).value,
										},
									})
								}
							/>
						</div>
					))}
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="channel-key"
						>
							API Key
						</label>
						<textarea
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 font-mono"
							id="channel-key"
							name="api_key"
							rows={3}
							placeholder={"每行一个 API Key（可留空）"}
							value={channelForm.api_key}
							onInput={(event) =>
								onFormChange({
									api_key: (event.currentTarget as HTMLTextAreaElement).value,
								})
							}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="channel-weight"
						>
							权重
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="channel-weight"
							name="weight"
							type="number"
							min="0"
							step="any"
							value={channelForm.weight}
							onInput={(event) =>
								onFormChange({
									weight: Number(
										(event.currentTarget as HTMLInputElement).value || 0,
									),
								})
							}
						/>
					</div>
					{/* 主动探测开关：默认关（公益站/中转站禁测活）；探测仅 GET /models，
						零 token 消耗，结果只展示、不参与路由裁决 */}
					<div class="rounded-lg border border-stone-200 bg-stone-50 p-3">
						<label
							class="flex cursor-pointer items-center justify-between gap-3"
							for="channel-probe-enabled"
						>
							<span class="min-w-0">
								<span class="block text-xs font-medium uppercase tracking-widest text-stone-400">
									主动探测
								</span>
								<span class="mt-0.5 block text-xs text-stone-400">
									定时 GET /models 连通性探测，零 token
									消耗；公益站/中转站请勿开启
								</span>
							</span>
							<span class="shrink-0">
								<ToggleSwitch
									id="channel-probe-enabled"
									checked={channelForm.probe_enabled}
									onChange={(checked) =>
										onFormChange({ probe_enabled: checked })
									}
								/>
							</span>
						</label>
					</div>
					<div>
						<div class="mb-1.5 flex items-center justify-between gap-2">
							<label
								class="block text-xs uppercase tracking-widest text-stone-500"
								for="channel-models"
							>
								模型列表
							</label>
							<button
								type="button"
								disabled={fetchingModels}
								onClick={onFetchModels}
								class="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
							>
								{fetchingModels ? "拉取中…" : "拉取模型"}
							</button>
						</div>
						<textarea
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 font-mono"
							id="channel-models"
							rows={3}
							placeholder="每行一个模型 ID，如：&#10;gpt-4o&#10;claude-sonnet-4-20250514"
							value={channelForm.models}
							onInput={(event) =>
								onFormChange({
									models: (event.currentTarget as HTMLTextAreaElement).value,
								})
							}
						/>
						<p class="mt-1 text-xs text-stone-400">
							每行一个模型 ID，留空则由连通测试自动获取。
						</p>
						<ModelPricingEditor
							models={channelForm.models}
							onModelsChange={(value) => onFormChange({ models: value })}
						/>
						{/* Per-model alias editor */}
						{parsedModelIds.length > 0 && (
							<div class="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
								<p class="mb-2 text-xs font-medium uppercase tracking-widest text-stone-400">
									模型别名配置
								</p>
								<div class="space-y-1">
									{parsedModelIds.map((modelId) => {
										const config = channelAliasState[modelId];
										const aliasCount = config?.aliases?.length ?? 0;
										const isExpanded = expandedAliasModels.has(modelId);
										return (
											<div class="rounded-lg border border-stone-200 bg-white">
												<button
													type="button"
													class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-stone-50"
													onClick={() => toggleAliasExpanded(modelId)}
												>
													<span class="text-xs text-stone-400">
														{isExpanded ? "▼" : "▶"}
													</span>
													<span class="flex-1 truncate font-mono text-xs text-stone-800">
														{modelId}
													</span>
													{aliasCount > 0 && (
														<span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
															{aliasCount} 个别名
														</span>
													)}
												</button>
												{isExpanded && (
													<div class="border-t border-stone-100 px-3 py-2.5">
														{config?.aliases && config.aliases.length > 0 && (
															<div class="mb-2 space-y-1.5">
																{config.aliases.map((alias, index) => (
																	<div class="flex items-center gap-2 rounded border border-stone-100 bg-stone-50 px-2 py-1.5">
																		<span class="flex-1 break-all font-mono text-xs text-stone-700">
																			{alias}
																		</span>
																		<button
																			type="button"
																			class="rounded px-1.5 py-0.5 text-xs text-red-400 hover:bg-red-50 hover:text-red-600"
																			onClick={() =>
																				removeAlias(modelId, index)
																			}
																		>
																			删除
																		</button>
																	</div>
																))}
															</div>
														)}
														<div class="flex gap-1.5">
															<input
																type="text"
																class="flex-1 rounded border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-200"
																placeholder="输入别名..."
																onKeyDown={(e) => {
																	if (e.key === "Enter") {
																		e.preventDefault();
																		const input =
																			e.currentTarget as HTMLInputElement;
																		addAlias(modelId, input.value);
																		input.value = "";
																	}
																}}
															/>
															<button
																type="button"
																class="rounded border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
																onClick={(e) => {
																	const input = (e.currentTarget as HTMLElement)
																		.previousElementSibling as HTMLInputElement;
																	addAlias(modelId, input.value);
																	input.value = "";
																}}
															>
																添加
															</button>
														</div>
														{(config?.aliases?.length ?? 0) > 0 && (
															<label class="mt-2 flex cursor-pointer items-center gap-2 rounded border border-stone-100 bg-stone-50 px-2 py-1.5">
																<input
																	type="checkbox"
																	checked={config?.alias_only ?? false}
																	onChange={(e) =>
																		toggleAliasOnly(
																			modelId,
																			(e.currentTarget as HTMLInputElement)
																				.checked,
																		)
																	}
																	class="accent-amber-500"
																/>
																<span class="text-xs text-stone-700">
																	仅限别名
																</span>
																<span class="text-xs text-stone-400">
																	— 隐藏原始模型名
																</span>
															</label>
														)}
													</div>
												)}
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="channel-custom-headers"
						>
							自定义请求头 (JSON)
						</label>
						<textarea
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="channel-custom-headers"
							rows={3}
							placeholder={'{"X-Custom-Header": "value"}'}
							value={channelForm.custom_headers}
							onInput={(event) =>
								onFormChange({
									custom_headers: (event.currentTarget as HTMLTextAreaElement)
										.value,
								})
							}
						/>
						<p class="mt-1 text-xs text-stone-500">
							对所有 API
							格式生效。同名头覆盖系统设置中的全局注入头与内置鉴权头。
						</p>
					</div>
					{/* 客户端伪装：预设选中即覆盖填充两字段（存储解析后的具体值，可再手工微调） */}
					<div class="rounded-lg border border-stone-200 bg-stone-50 p-3">
						<div class="mb-2.5 flex items-center justify-between gap-2">
							<p class="text-xs font-medium uppercase tracking-widest text-stone-400">
								客户端伪装
							</p>
							<button
								type="button"
								class="rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700"
								onClick={clearDisguise}
							>
								清除伪装
							</button>
						</div>
						<div class="mb-2.5">
							<label
								class="mb-1 block text-xs uppercase tracking-widest text-stone-400"
								for="channel-disguise-preset"
							>
								预设客户端
							</label>
							<select
								class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								id="channel-disguise-preset"
								value={channelForm.disguise_preset}
								onChange={(event) => {
									const id = (event.currentTarget as HTMLSelectElement).value;
									// 服务端预设：仅置 form.disguise_preset（网关实时渲染），
									// 不灌下方快照 textareas
									if (SERVER_CLIENT_PRESETS.some((p) => p.id === id)) {
										onFormChange({ disguise_preset: id });
										return;
									}
									// 快照预设：保持既有 applyPreset 行为（互斥清空服务端
									// 预设）；「无预设」仅清服务端预设，不动快照字段
									const preset = CLIENT_PRESETS.find((p) => p.id === id);
									if (preset) applyPreset(preset);
									else onFormChange({ disguise_preset: "" });
								}}
							>
								<option value="">无预设</option>
								<optgroup label="服务端预设（网关实时渲染）">
									{SERVER_CLIENT_PRESETS.map((preset) => (
										<option key={preset.id} value={preset.id}>
											{preset.label}
										</option>
									))}
								</optgroup>
								<optgroup label="快照预设（填入下方可编辑）">
									{CLIENT_PRESETS.map((preset) => (
										<option key={preset.id} value={preset.id}>
											{preset.name}
											{preset.testing ? "（测试）" : ""}
										</option>
									))}
								</optgroup>
							</select>
							<p class="mt-1 text-xs text-stone-400">
								选中预设即用其快照值覆盖填充下方两字段（可再手工微调）；（测试）=
								指纹存在未验证环节，建议实测验证后再投入使用。
							</p>
							{channelForm.disguise_preset !== "" && (
								<p class="mt-1 text-xs leading-relaxed text-amber-600">
									指纹由网关每请求实时渲染（会话稳定 ID / 按协议 UA / body
									合规），下方伪装头与提示词可叠加覆盖。
								</p>
							)}
							{appliedPresetNote && (
								<p class="mt-1 text-xs leading-relaxed text-stone-400">
									预设快照说明：{appliedPresetNote}
								</p>
							)}
						</div>
						<div class="mb-2.5">
							<label
								class="mb-1 block text-xs uppercase tracking-widest text-stone-400"
								for="channel-disguise-headers"
							>
								伪装请求头 (JSON)
							</label>
							<textarea
								class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								id="channel-disguise-headers"
								rows={3}
								placeholder='{"User-Agent": "..."}'
								value={channelForm.disguise_headers}
								onInput={(event) =>
									onFormChange({
										disguise_headers: (
											event.currentTarget as HTMLTextAreaElement
										).value,
									})
								}
								onBlur={validateDisguiseHeaders}
							/>
							{disguiseHeadersInvalid && (
								<p class="mt-1 text-xs text-amber-600">
									伪装请求头不是合法的 JSON
									对象，保存后将按空配置处理（不阻断提交）。
								</p>
							)}
						</div>
						<div>
							<label
								class="mb-1 block text-xs uppercase tracking-widest text-stone-400"
								for="channel-disguise-prompt"
							>
								伪装系统提示词
							</label>
							<textarea
								class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								id="channel-disguise-prompt"
								rows={6}
								placeholder="留空不注入提示词"
								value={channelForm.disguise_system_prompt}
								onInput={(event) =>
									onFormChange({
										disguise_system_prompt: (
											event.currentTarget as HTMLTextAreaElement
										).value,
									})
								}
							/>
						</div>
						<div class="mt-2 space-y-1 text-xs text-stone-400">
							<p>
								作用范围：伪装请求头与系统提示词对全部代理路径及模型测试生效；连通性测试与拉取模型仅注入伪装请求头。
							</p>
							<p>
								伪装请求头的值支持动态占位符（每上游请求实时生成）：
								{"{{uuid}}"}、{"{{timestamp_ms}}"}、{"{{opencode_request_id}}"}
								、{"{{opencode_session_id}}"}
								；未知占位符按字面值发送（渠道级自定义请求头与全局注入/剔除头不解释占位符）。
							</p>
							<p>
								同名请求头优先级：渠道级自定义请求头 &gt; 伪装请求头 &gt;
								全局注入头；伪装系统提示词前置为首条 system，用户自带 system
								顺延保留。
							</p>
							<p class="text-amber-600">
								警示：伪装请求头会覆盖同名内置鉴权头（如 Authorization /
								x-api-key），配置不当可能导致上游 401。
							</p>
						</div>
					</div>
					{/* 模型测试：内嵌折叠区块，展示 + 回调，请求由 AdminApp 统一发起 */}
					<div class="rounded-lg border border-stone-200 bg-stone-50">
						<button
							type="button"
							class="flex w-full items-center gap-2 px-3 py-2.5 text-left"
							onClick={() => setModelTestExpanded((prev) => !prev)}
						>
							<span class="text-xs text-stone-400">
								{modelTestExpanded ? "▼" : "▶"}
							</span>
							<span class="flex-1 text-xs font-medium uppercase tracking-widest text-stone-400">
								模型测试
							</span>
							{modelTestRunning && (
								<span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
									测试中…
								</span>
							)}
							{!modelTestRunning && testResultEntries.length > 0 && (
								<span
									class={`rounded-full px-2 py-0.5 text-xs font-semibold ${
										testSuccessCount === testResultEntries.length
											? "bg-emerald-100 text-emerald-700"
											: "bg-stone-200 text-stone-600"
									}`}
								>
									{testSuccessCount}/{testResultEntries.length} 成功
								</span>
							)}
						</button>
						{modelTestExpanded && (
							<div class="border-t border-stone-100 px-3 py-3">
								{parsedModelIds.length === 0 ? (
									<p class="py-2 text-center text-sm text-stone-400">
										请先在上方填写模型列表
									</p>
								) : (
									<div class="space-y-2.5">
										<div>
											<div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
												<p class="text-xs text-stone-500">
													选择要测试的模型（{selectedTestList.length}/
													{parsedModelIds.length}）
												</p>
												<div class="flex items-center gap-1.5">
													<input
														type="text"
														placeholder="搜索模型…"
														value={testSearch}
														onInput={(e) =>
															setTestSearch(
																(e.currentTarget as HTMLInputElement).value,
															)
														}
														class="w-32 rounded border border-stone-200 bg-white px-2 py-1 text-xs text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-200"
													/>
													<button
														type="button"
														onClick={selectAllVisibleTest}
														class="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
													>
														全选
													</button>
													<button
														type="button"
														onClick={invertVisibleTest}
														class="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
													>
														反选
													</button>
												</div>
											</div>
											<div class="max-h-40 space-y-0.5 overflow-y-auto rounded border border-stone-200 bg-white p-1.5">
												{visibleTestModels.length === 0 ? (
													<p class="py-2 text-center text-xs text-stone-400">
														无匹配模型
													</p>
												) : (
													visibleTestModels.map((modelId) => (
														<label
															key={modelId}
															class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm transition-colors hover:bg-stone-50"
														>
															<input
																type="checkbox"
																checked={selectedTestModels.has(modelId)}
																onChange={() => toggleTestModel(modelId)}
																class="accent-amber-500"
															/>
															<span class="min-w-0 break-all font-mono text-xs text-stone-700">
																{modelId}
															</span>
														</label>
													))
												)}
											</div>
										</div>
										<div>
											<label
												class="mb-1 block text-xs uppercase tracking-widest text-stone-400"
												for="channel-test-prompt"
											>
												测试文本
											</label>
											<textarea
												id="channel-test-prompt"
												rows={2}
												value={modelTestText}
												onInput={(e) =>
													setModelTestText(
														(e.currentTarget as HTMLTextAreaElement).value,
													)
												}
												class="w-full rounded border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-200"
											/>
											<p class="mt-1 text-xs text-stone-400">
												初始取系统设置中的「模型测试文本」，此处修改仅影响当次测试。
											</p>
										</div>
										<div class="flex flex-wrap items-center gap-2">
											{modelTestRunning ? (
												<button
													type="button"
													onClick={onStopModelTests}
													class="h-8 rounded-full border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-600 transition-colors hover:bg-red-100"
												>
													停止
												</button>
											) : (
												<button
													type="button"
													disabled={testDisabledHint !== ""}
													onClick={() =>
														onRunModelTests(selectedTestList, modelTestText)
													}
													class="h-8 rounded-full bg-stone-900 px-3 text-xs font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												>
													开始测试
												</button>
											)}
											{!modelTestRunning && testDisabledHint && (
												<span class="text-xs text-stone-400">
													{testDisabledHint}
												</span>
											)}
										</div>
										{testResultEntries.length > 0 && (
											<div class="space-y-1">
												{testResultEntries.map(([modelId, result]) => (
													<div
														key={modelId}
														class="flex items-start gap-2 rounded border border-stone-100 bg-white px-2 py-1.5"
													>
														<span class="mt-1 shrink-0">
															{result.status === "running" ? (
																<span
																	aria-hidden="true"
																	class="block h-2.5 w-2.5 animate-spin rounded-full border-2 border-amber-400 border-t-transparent"
																/>
															) : (
																<span
																	aria-hidden="true"
																	class={`block h-2.5 w-2.5 rounded-full ${
																		result.status === "success"
																			? "bg-emerald-500"
																			: result.status === "failed"
																				? "bg-red-500"
																				: "bg-stone-300"
																	}`}
																/>
															)}
														</span>
														<span class="w-2/5 shrink-0 truncate font-mono text-xs text-stone-700">
															{modelId}
														</span>
														<span
															class={`min-w-0 flex-1 break-all text-xs ${
																result.status === "success"
																	? "text-emerald-600"
																	: result.status === "failed"
																		? "text-red-600"
																		: result.status === "running"
																			? "text-amber-600"
																			: "text-stone-400"
															}`}
														>
															{result.status === "success" &&
																`${result.elapsed}ms · ${result.content}`}
															{result.status === "failed" && result.error}
															{result.status === "running" && "测试中…"}
															{result.status === "pending" && "待测试"}
														</span>
														{result.status === "failed" && (
															<button
																type="button"
																onClick={() =>
																	onRetryModelTest(modelId, modelTestText)
																}
																class="shrink-0 rounded border border-stone-200 bg-white px-1.5 py-0.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
															>
																重试
															</button>
														)}
													</div>
												))}
											</div>
										)}
									</div>
								)}
							</div>
						)}
					</div>
					<div class="flex flex-wrap items-center justify-end gap-2 pt-2">
						<button
							class="h-10 rounded-full border border-stone-200 bg-stone-50 px-4 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
							type="button"
							onClick={onCloseModal}
						>
							取消
						</button>
						<button
							class="h-10 rounded-full bg-stone-900 px-5 text-xs font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
							type="submit"
						>
							{isEditing ? "保存修改" : "创建渠道"}
						</button>
					</div>
				</form>
			</Modal>
			<Modal
				isOpen={fetchedModels !== null}
				onClose={onCancelFetched}
				backdropClass="bg-black/40"
				panelClass="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-xl"
			>
				{/* fetchedModels 兼任开关与数据,closing 动画期间已置 null,children 必须 guard 防止解引用崩溃 */}
				{fetchedModels !== null && (
					<>
						<div class="flex items-center justify-between border-b border-stone-100 px-4 py-3">
							<h3 class="text-sm font-semibold text-stone-800">
								选择模型
								<span class="ml-1 text-xs font-normal text-stone-400">
									共 {fetchedModels.length} 个
								</span>
							</h3>
							<button
								type="button"
								onClick={onCancelFetched}
								class="text-stone-400 hover:text-stone-600"
							>
								✕
							</button>
						</div>
						<div class="flex items-center gap-2 border-b border-stone-100 px-4 py-2.5">
							<input
								type="text"
								placeholder="搜索模型…"
								value={fetchedSearch}
								onInput={(e) =>
									onFetchedSearchChange(
										(e.currentTarget as HTMLInputElement).value,
									)
								}
								class="flex-1 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-200"
							/>
							<button
								type="button"
								onClick={() =>
									onToggleAllFetched(visibleFetched, !allVisibleFetchedSelected)
								}
								class="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600 hover:bg-stone-50"
							>
								{allVisibleFetchedSelected ? "取消全选" : "全选"}
							</button>
						</div>
						<div class="flex-1 overflow-y-auto px-4 py-2">
							{fetchedModels.length === 0 ? (
								<p class="py-6 text-center text-sm text-stone-400">
									上游未返回模型
								</p>
							) : visibleFetched.length === 0 ? (
								<p class="py-6 text-center text-sm text-stone-400">
									无匹配模型
								</p>
							) : (
								<div class="space-y-0.5">
									{visibleFetched.map((m) => (
										<label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-stone-50">
											<input
												type="checkbox"
												checked={selectedFetched.has(m)}
												onChange={() => onToggleFetched(m)}
												class="accent-amber-500"
											/>
											<span class="min-w-0 break-all font-mono text-xs text-stone-700">
												{m}
											</span>
											{existingModelIdSet.has(m) && (
												<span class="ml-auto shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-500">
													已存在
												</span>
											)}
										</label>
									))}
								</div>
							)}
						</div>
						<div class="flex items-center justify-end gap-2 border-t border-stone-100 px-4 py-3">
							<button
								type="button"
								onClick={onCancelFetched}
								class="rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-50"
							>
								取消
							</button>
							<button
								type="button"
								onClick={onConfirmFetched}
								class="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
							>
								确认加入（新增 {newSelectedCount}）
							</button>
						</div>
					</>
				)}
			</Modal>
		</div>
	);
};
