import type { Child } from "hono/jsx/dom";
import { useEffect, useMemo, useRef, useState } from "hono/jsx/dom";
import type { ModelItem } from "../core/types";
import { buildPageItems } from "../core/utils";
import { Modal } from "./Modal";

type ModelsViewProps = {
	models: ModelItem[];
	onAliasSave?: (
		modelId: string,
		aliases: string[],
		aliasOnly?: boolean,
	) => Promise<void>;
	onPriceSave?: (
		modelId: string,
		prices: Array<{
			channel_id: string;
			input_price: number;
			output_price: number;
			cache_read_price: number | null;
			cache_write_price: number | null;
		}>,
	) => Promise<void>;
};

const MiniSparkline = ({
	data,
}: {
	data: { day: string; requests: number; tokens: number }[];
}) => {
	if (data.length === 0) return null;
	const values = data.map((d) => d.requests);
	const max = Math.max(...values, 1);
	const width = 120;
	const height = 32;
	const padding = 2;
	const step = (width - padding * 2) / Math.max(values.length - 1, 1);

	const points = values
		.map((v, i) => {
			const x = padding + i * step;
			const y = height - padding - (v / max) * (height - padding * 2);
			return `${x},${y}`;
		})
		.join(" ");

	const areaPoints = `${padding},${height - padding} ${points} ${padding + (values.length - 1) * step},${height - padding}`;

	return (
		<svg
			width={width}
			height={height}
			class="inline-block"
			viewBox={`0 0 ${width} ${height}`}
			role="img"
			aria-label="每日请求趋势"
		>
			<polygon points={areaPoints} fill="rgba(245,158,11,0.15)" />
			<polyline
				points={points}
				fill="none"
				stroke="rgb(245,158,11)"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	);
};

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

function formatPrice(n: number | null): string {
	if (n == null) return "-";
	return `$${n}`;
}

const ModelCard = ({
	model,
	onAliasClick,
	onPriceClick,
}: {
	model: ModelItem;
	onAliasClick?: () => void;
	onPriceClick?: () => void;
}) => {
	return (
		<div class="rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
			<div class="mb-2 flex items-start justify-between gap-2">
				<div class="min-w-0 flex-1">
					<h4 class="break-all font-['Space_Grotesk'] text-sm font-semibold tracking-tight text-stone-900">
						{model.id}
					</h4>
					{model.real_model_id && (
						<p class="mt-0.5 break-all text-xs text-amber-600">
							→ {model.real_model_id}
						</p>
					)}
				</div>
				<div class="flex shrink-0 items-center gap-1.5">
					{onAliasClick && !model.real_model_id && (
						<button
							type="button"
							class="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-500 transition-colors hover:border-amber-300 hover:text-amber-600"
							onClick={onAliasClick}
						>
							别名
						</button>
					)}
					{onPriceClick && !model.real_model_id && (
						<button
							type="button"
							class="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-500 transition-colors hover:border-emerald-300 hover:text-emerald-600"
							onClick={onPriceClick}
						>
							定价
						</button>
					)}
					<span class="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">
						{model.channels.length} 渠道
					</span>
				</div>
			</div>

			{model.avg_latency_ms != null && (
				<p class="mb-3 text-xs text-stone-400">
					平均延迟 {model.avg_latency_ms}ms
				</p>
			)}

			{model.channels.length > 0 && (
				<div class="mb-3 rounded-lg bg-stone-50 p-2.5">
					<p class="mb-1.5 text-xs font-medium uppercase tracking-widest text-stone-400">
						渠道价格
					</p>
					<div class="space-y-1">
						{model.channels.map((ch) => (
							<div
								key={ch.id}
								class="flex items-center justify-between text-xs"
							>
								<span class="truncate text-stone-600">{ch.name}</span>
								<span class="shrink-0 pl-2 text-stone-500">
									{ch.input_price != null || ch.output_price != null ? (
										<>
											<span class="text-emerald-600">
												{formatPrice(ch.input_price)}
											</span>
											{" / "}
											<span class="text-blue-600">
												{formatPrice(ch.output_price)}
											</span>
											<span class="ml-1 text-stone-400">/1M</span>
											{ch.cache_read_price != null && (
												<span class="ml-1.5 text-stone-400">
													缓存读{" "}
													<span class="text-teal-600">
														{formatPrice(ch.cache_read_price)}
													</span>
												</span>
											)}
											{ch.cache_write_price != null && (
												<span class="ml-1.5 text-stone-400">
													缓存写{" "}
													<span class="text-orange-600">
														{formatPrice(ch.cache_write_price)}
													</span>
												</span>
											)}
										</>
									) : (
										<span class="text-stone-300">未设置</span>
									)}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{model.daily.length > 0 && (
				<div class="mb-3">
					<MiniSparkline data={model.daily} />
				</div>
			)}

			<div class="flex flex-wrap gap-x-3 gap-y-1 border-t border-stone-100 pt-2.5 text-xs text-stone-500">
				<span>
					请求{" "}
					<span class="font-medium text-stone-700">
						{formatNumber(model.total_requests)}
					</span>
				</span>
				<span>
					Token{" "}
					<span class="font-medium text-stone-700">
						{formatNumber(model.total_tokens)}
					</span>
				</span>
				<span>
					费用{" "}
					<span class="font-medium text-stone-700">
						{formatCost(model.total_cost)}
					</span>
				</span>
			</div>
		</div>
	);
};

const AliasEditModal = ({
	modelId,
	initialAliases,
	initialAliasOnly,
	onSave,
	onClose,
}: {
	modelId: string;
	initialAliases: string[];
	initialAliasOnly: boolean;
	onSave: (aliases: string[], aliasOnly: boolean) => Promise<void>;
	onClose: () => void;
}) => {
	const [aliases, setAliases] = useState<string[]>(() => [...initialAliases]);
	const [aliasOnly, setAliasOnly] = useState(initialAliasOnly);
	const [newAlias, setNewAlias] = useState("");
	const [saving, setSaving] = useState(false);
	const [closing, setClosing] = useState(false);
	const closeTimerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (closeTimerRef.current !== null) {
				clearTimeout(closeTimerRef.current);
			}
		},
		[],
	);

	// closing 包装：先播收场动画，结束后再交容器卸载（容器条件挂载 = state 天然重置）
	const handleClose = () => {
		if (closing) {
			return;
		}
		setClosing(true);
		const duration =
			parseFloat(
				getComputedStyle(document.documentElement).getPropertyValue(
					"--modal-close-dur",
				),
			) || 150;
		closeTimerRef.current = window.setTimeout(onClose, duration);
	};

	const handleAdd = () => {
		const trimmed = newAlias.trim();
		if (!trimmed) return;
		if (aliases.includes(trimmed)) return;
		setAliases((prev) => [...prev, trimmed]);
		setNewAlias("");
	};

	const handleRemove = (index: number) => {
		setAliases((prev) => prev.filter((_, i) => i !== index));
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			await onSave(aliases, aliasOnly);
			handleClose();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			isOpen={!closing}
			onClose={handleClose}
			sheet
			panelClass="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-stone-200 bg-white p-6 shadow-2xl md:rounded-2xl"
		>
			<div class="flex items-start justify-between gap-3">
				<div>
					<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						编辑别名
					</h3>
					<p class="break-all text-xs text-stone-500">模型：{modelId}</p>
				</div>
				<button
					type="button"
					class="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
					onClick={handleClose}
				>
					关闭
				</button>
			</div>

			<div class="mt-4 space-y-2">
				{aliases.length === 0 && (
					<p class="py-4 text-center text-sm text-stone-400">
						暂无别名，在下方添加
					</p>
				)}
				{aliases.map((alias, index) => (
					<div
						key={alias}
						class="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2"
					>
						<span class="flex-1 break-all font-mono text-sm text-stone-800">
							{alias}
						</span>
						<button
							type="button"
							class="rounded-full px-2 py-0.5 text-xs text-red-400 transition-colors hover:bg-red-50 hover:text-red-600"
							onClick={() => handleRemove(index)}
						>
							删除
						</button>
					</div>
				))}
			</div>

			<div class="mt-4 flex gap-2">
				<input
					type="text"
					class="flex-1 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
					placeholder="输入别名..."
					value={newAlias}
					onInput={(e) =>
						setNewAlias((e.currentTarget as HTMLInputElement)?.value ?? "")
					}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleAdd();
						}
					}}
				/>
				<button
					type="button"
					class="rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-50"
					onClick={handleAdd}
				>
					添加
				</button>
			</div>

			{aliases.length > 0 && (
				<label class="mt-3 flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5">
					<input
						type="checkbox"
						checked={aliasOnly}
						onChange={(e) =>
							setAliasOnly((e.currentTarget as HTMLInputElement).checked)
						}
						class="accent-amber-500"
					/>
					<span class="text-sm text-stone-700">仅限别名</span>
					<span class="text-xs text-stone-400">
						— 隐藏原始模型名，只能通过别名调用
					</span>
				</label>
			)}

			<div class="mt-5 flex items-center justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-50"
					onClick={handleClose}
				>
					取消
				</button>
				<button
					type="button"
					class="rounded-lg border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-60"
					disabled={saving}
					onClick={handleSave}
				>
					{saving ? "保存中..." : "保存"}
				</button>
			</div>
		</Modal>
	);
};

const PriceEditModal = ({
	modelId,
	channels,
	onSave,
	onClose,
}: {
	modelId: string;
	channels: Array<{
		id: string;
		name: string;
		input_price: number | null;
		output_price: number | null;
		cache_read_price: number | null;
		cache_write_price: number | null;
	}>;
	onSave: (
		prices: Array<{
			channel_id: string;
			input_price: number;
			output_price: number;
			cache_read_price: number | null;
			cache_write_price: number | null;
		}>,
	) => Promise<void>;
	onClose: () => void;
}) => {
	const [prices, setPrices] = useState(() =>
		channels.map((ch) => ({
			channel_id: ch.id,
			name: ch.name,
			input_price: ch.input_price != null ? String(ch.input_price) : "",
			output_price: ch.output_price != null ? String(ch.output_price) : "",
			cache_read_price:
				ch.cache_read_price != null ? String(ch.cache_read_price) : "",
			cache_write_price:
				ch.cache_write_price != null ? String(ch.cache_write_price) : "",
		})),
	);
	const [batchInput, setBatchInput] = useState("");
	const [batchOutput, setBatchOutput] = useState("");
	const [saving, setSaving] = useState(false);
	const [closing, setClosing] = useState(false);
	const closeTimerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (closeTimerRef.current !== null) {
				clearTimeout(closeTimerRef.current);
			}
		},
		[],
	);

	// closing 包装：先播收场动画，结束后再交容器卸载（容器条件挂载 = state 天然重置）
	const handleClose = () => {
		if (closing) {
			return;
		}
		setClosing(true);
		const duration =
			parseFloat(
				getComputedStyle(document.documentElement).getPropertyValue(
					"--modal-close-dur",
				),
			) || 150;
		closeTimerRef.current = window.setTimeout(onClose, duration);
	};

	const handleFieldChange = (
		index: number,
		field:
			| "input_price"
			| "output_price"
			| "cache_read_price"
			| "cache_write_price",
		value: string,
	) => {
		setPrices((prev) =>
			prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)),
		);
	};

	const handleBatchApply = () => {
		setPrices((prev) =>
			prev.map((p) => ({
				...p,
				input_price: batchInput !== "" ? batchInput : p.input_price,
				output_price: batchOutput !== "" ? batchOutput : p.output_price,
			})),
		);
	};

	const handleSave = async () => {
		setSaving(true);
		try {
			const payload = prices.map((p) => ({
				channel_id: p.channel_id,
				input_price: p.input_price !== "" ? Number(p.input_price) : 0,
				output_price: p.output_price !== "" ? Number(p.output_price) : 0,
				// 空串 = 清除（null → 回落全局倍率）；有值 = 设置绝对价
				cache_read_price:
					p.cache_read_price !== "" ? Number(p.cache_read_price) : null,
				cache_write_price:
					p.cache_write_price !== "" ? Number(p.cache_write_price) : null,
			}));
			await onSave(payload);
			handleClose();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			isOpen={!closing}
			onClose={handleClose}
			sheet
			panelClass="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-stone-200 bg-white p-6 shadow-2xl md:rounded-2xl"
		>
			<div class="flex items-start justify-between gap-3">
				<div>
					<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						编辑价格
					</h3>
					<p class="break-all text-xs text-stone-500">模型：{modelId}</p>
				</div>
				<button
					type="button"
					class="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50"
					onClick={handleClose}
				>
					关闭
				</button>
			</div>

			<div class="mt-4 space-y-2">
				<div class="grid grid-cols-[1fr_4rem_4rem_4rem_4rem] gap-2 text-xs font-medium text-stone-400">
					<span>渠道</span>
					<span class="text-center">输入价</span>
					<span class="text-center">输出价</span>
					<span class="text-center">缓存读</span>
					<span class="text-center">缓存写</span>
				</div>
				{prices.map((p, index) => (
					<div
						key={p.channel_id}
						class="grid grid-cols-[1fr_4rem_4rem_4rem_4rem] items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2"
					>
						<span class="truncate text-sm text-stone-700">{p.name}</span>
						<input
							type="number"
							step="any"
							class="w-full rounded-md border border-stone-200 bg-white px-2 py-1 text-center text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							value={p.input_price}
							onInput={(e) =>
								handleFieldChange(
									index,
									"input_price",
									(e.currentTarget as HTMLInputElement)?.value ?? "",
								)
							}
						/>
						<input
							type="number"
							step="any"
							class="w-full rounded-md border border-stone-200 bg-white px-2 py-1 text-center text-sm text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							value={p.output_price}
							onInput={(e) =>
								handleFieldChange(
									index,
									"output_price",
									(e.currentTarget as HTMLInputElement)?.value ?? "",
								)
							}
						/>
						<input
							type="number"
							step="any"
							placeholder="全局"
							class="w-full rounded-md border border-stone-200 bg-white px-2 py-1 text-center text-sm text-stone-900 placeholder:text-stone-300 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							value={p.cache_read_price}
							onInput={(e) =>
								handleFieldChange(
									index,
									"cache_read_price",
									(e.currentTarget as HTMLInputElement)?.value ?? "",
								)
							}
						/>
						<input
							type="number"
							step="any"
							placeholder="全局"
							class="w-full rounded-md border border-stone-200 bg-white px-2 py-1 text-center text-sm text-stone-900 placeholder:text-stone-300 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							value={p.cache_write_price}
							onInput={(e) =>
								handleFieldChange(
									index,
									"cache_write_price",
									(e.currentTarget as HTMLInputElement)?.value ?? "",
								)
							}
						/>
					</div>
				))}
				<p class="text-xs text-stone-400">
					缓存读/写留空 = 跟随系统设置的缓存倍率；填写则按绝对价（USD/1M）覆盖。
				</p>
			</div>

			<div class="mt-4 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-3">
				<p class="mb-2 text-xs font-medium text-stone-500">批量设置</p>
				<div class="flex items-center gap-2">
					<input
						type="number"
						step="any"
						class="w-24 rounded-md border border-stone-200 bg-white px-2 py-1 text-center text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
						placeholder="输入价格"
						value={batchInput}
						onInput={(e) =>
							setBatchInput((e.currentTarget as HTMLInputElement)?.value ?? "")
						}
					/>
					<input
						type="number"
						step="any"
						class="w-24 rounded-md border border-stone-200 bg-white px-2 py-1 text-center text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
						placeholder="输出价格"
						value={batchOutput}
						onInput={(e) =>
							setBatchOutput((e.currentTarget as HTMLInputElement)?.value ?? "")
						}
					/>
					<button
						type="button"
						class="rounded-lg border border-stone-200 bg-white px-3 py-1 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-50"
						onClick={handleBatchApply}
					>
						应用全部
					</button>
				</div>
			</div>

			<div class="mt-5 flex items-center justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-50"
					onClick={handleClose}
				>
					取消
				</button>
				<button
					type="button"
					class="rounded-lg border border-stone-900 bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-60"
					disabled={saving}
					onClick={handleSave}
				>
					{saving ? "保存中..." : "保存"}
				</button>
			</div>
		</Modal>
	);
};

const pageSizeOptions = [12, 24, 48];

export const ModelsView = ({
	models,
	onAliasSave,
	onPriceSave,
}: ModelsViewProps) => {
	const [search, setSearch] = useState("");
	const [pageSize, setPageSize] = useState(12);
	const [page, setPage] = useState(1);
	const [aliasModelId, setAliasModelId] = useState<string | null>(null);
	const [priceModelId, setPriceModelId] = useState<string | null>(null);

	const filtered = search
		? models.filter((m) => {
				const lower = search.toLowerCase();
				return m.id.toLowerCase().includes(lower);
			})
		: models;

	const total = filtered.length;
	const totalPages = useMemo(
		() => Math.max(1, Math.ceil(total / pageSize)),
		[total, pageSize],
	);

	// Reset page when search or pageSize changes
	useEffect(() => {
		setPage(1);
	}, [search, pageSize]);

	useEffect(() => {
		setPage((prev) => Math.min(prev, totalPages));
	}, [totalPages]);

	const pagedModels = useMemo(() => {
		const start = (page - 1) * pageSize;
		return filtered.slice(start, start + pageSize);
	}, [filtered, page, pageSize]);

	const pageItems = useMemo(
		() => buildPageItems(page, totalPages),
		[page, totalPages],
	);

	// For alias editing, we need to find all aliases for this real model
	// by looking at other models that have real_model_id pointing to it
	const getAliasesForModel = (
		modelId: string,
	): { aliases: string[]; aliasOnly: boolean } => {
		const aliases: string[] = [];
		let aliasOnly = false;
		for (const m of models) {
			if (m.real_model_id === modelId) {
				aliases.push(m.id);
				aliasOnly = true; // If there are alias entries, check if original is missing
			}
		}
		// If the original model is not in the list, it means alias_only is true
		const originalExists = models.some(
			(m) => m.id === modelId && m.real_model_id === null,
		);
		aliasOnly = aliases.length > 0 && !originalExists;
		return { aliases, aliasOnly };
	};

	const aliasModel = aliasModelId
		? (models.find((m) => m.id === aliasModelId && m.real_model_id === null) ??
			null)
		: null;

	const priceModel = priceModelId
		? (models.find((m) => m.id === priceModelId) ?? null)
		: null;

	return (
		<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
			<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex flex-wrap items-center gap-3">
					<h3 class="mb-0 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						模型广场
					</h3>
					<span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
						{filtered.length} / {models.length} 个模型
					</span>
				</div>
				<input
					class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 sm:w-64"
					type="text"
					placeholder="搜索模型..."
					value={search}
					onInput={(e) => {
						const target = e.currentTarget as HTMLInputElement | null;
						setSearch(target?.value ?? "");
					}}
				/>
			</div>
			{filtered.length === 0 ? (
				<div class="py-12 text-center text-sm text-stone-400">
					{models.length === 0 ? "暂无模型数据" : "未找到匹配的模型"}
				</div>
			) : (
				<>
					<div class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
						{pagedModels.map((model) => (
							<ModelCard
								key={model.id}
								model={model}
								onAliasClick={
									onAliasSave && !model.real_model_id
										? () => setAliasModelId(model.id)
										: undefined
								}
								onPriceClick={
									onPriceSave && !model.real_model_id
										? () => setPriceModelId(model.id)
										: undefined
								}
							/>
						))}
					</div>
					{/* Pagination */}
					<div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-stone-500">
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-xs text-stone-500">
								共 {total} 条 · {totalPages} 页
							</span>
							<button
								class="h-10 w-10 md:h-8 md:w-8 rounded-full border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
								type="button"
								disabled={page <= 1}
								onClick={() => setPage(Math.max(1, page - 1))}
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
											item === page
												? "border-stone-900 bg-stone-900 text-white shadow-md"
												: "border-stone-200 bg-white text-stone-600 hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-md"
										}`}
										type="button"
										key={item}
										onClick={() => setPage(item)}
									>
										{item}
									</button>
								),
							)}
							<button
								class="h-10 w-10 md:h-8 md:w-8 rounded-full border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
								type="button"
								disabled={page >= totalPages}
								onClick={() => setPage(Math.min(totalPages, page + 1))}
							>
								&gt;
							</button>
						</div>
						<label class="flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs text-stone-500">
							每页条数
							<select
								class="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-700 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								value={pageSize}
								onChange={(event) => {
									setPageSize(
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
				</>
			)}
			{aliasModel &&
				onAliasSave &&
				(() => {
					const { aliases, aliasOnly } = getAliasesForModel(aliasModel.id);
					return (
						<AliasEditModal
							modelId={aliasModel.id}
							initialAliases={aliases}
							initialAliasOnly={aliasOnly}
							onSave={(newAliases, newAliasOnly) =>
								onAliasSave(aliasModel.id, newAliases, newAliasOnly)
							}
							onClose={() => setAliasModelId(null)}
						/>
					);
				})()}
			{priceModel && onPriceSave && (
				<PriceEditModal
					modelId={priceModel.id}
					channels={priceModel.channels}
					onSave={(prices) => onPriceSave(priceModel.id, prices)}
					onClose={() => setPriceModelId(null)}
				/>
			)}
		</div>
	);
};
