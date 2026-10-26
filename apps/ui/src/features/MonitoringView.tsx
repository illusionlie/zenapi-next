import { useCallback, useMemo, useState } from "hono/jsx/dom";
import { apiBase, formatBadgeColors, formatLabels } from "../core/constants";
import type {
	MonitoringChannelData,
	MonitoringDailyTrend,
	MonitoringData,
	MonitoringErrorDetail,
	MonitoringKeyStat,
	MonitoringProbeEntry,
	MonitoringSlotModel,
} from "../core/types";
import { parseChannelApiFormats } from "../core/utils";
import { DotLoader } from "./DotLoader";
import { barColor, formatSlotLabel, generateSlots } from "./monitoring-shared";
import { SkeletonBlock } from "./ViewSkeleton";

type MonitoringViewProps = {
	monitoring: MonitoringData | null;
	token: string;
	onLoaded: (data: MonitoringData) => void;
};

const RANGE_OPTIONS = ["15m", "1h", "1d", "7d", "30d"] as const;
const RANGE_LABELS: Record<string, string> = {
	"15m": "15 分钟",
	"1h": "1 小时",
	"1d": "1 天",
	"7d": "7 天",
	"30d": "30 天",
};

const rateColor = (rate: number | null) => {
	if (rate === null) return "text-stone-400";
	if (rate >= 99) return "text-green-600";
	if (rate >= 95) return "text-yellow-600";
	return "text-red-600";
};

const statusLabel = (rate: number | null) => {
	if (rate === null) return "无数据";
	if (rate >= 99) return "正常";
	if (rate >= 95) return "降级";
	return "异常";
};

const statusDot = (rate: number | null) => {
	if (rate === null) return "bg-stone-300";
	if (rate >= 99) return "bg-green-500";
	if (rate >= 95) return "bg-yellow-500";
	return "bg-red-500";
};

// —— 主动探测色条（任务 10-26-channel-probe）：配色与上行 uptime 条同源 ——
const PROBE_STRIP_CELLS = 14;

const probeColor = (status: MonitoringProbeEntry["status"]) => {
	if (status === "healthy") return "#22c55e"; // green-500
	if (status === "degraded") return "#eab308"; // yellow-500
	return "#ef4444"; // red-500
};
const PROBE_NO_DATA_COLOR = "#e7e5e4"; // stone-200, 同 barColor(null)

const probeStatusLabel = (status: MonitoringProbeEntry["status"]) => {
	if (status === "healthy") return "正常";
	if (status === "degraded") return "降级";
	return "宕机";
};

/** 最近 14 格探测条数据：history 是最新在前，展示取旧→新、左侧灰格补齐。 */
const buildProbeCells = (
	history: MonitoringProbeEntry[],
): Array<MonitoringProbeEntry | null> => {
	const chronological = [...history].reverse();
	const pad = PROBE_STRIP_CELLS - chronological.length;
	if (pad > 0) {
		return [...Array.from({ length: pad }, () => null), ...chronological];
	}
	return chronological.slice(-PROBE_STRIP_CELLS);
};

const probeCellTitle = (entry: MonitoringProbeEntry | null) => {
	if (!entry) return "无探测数据";
	const latency = entry.latency_ms !== null ? ` · ${entry.latency_ms}ms` : "";
	return `${entry.checked_at} · ${probeStatusLabel(entry.status)}${latency}`;
};

type ChannelBarProps = {
	channel: MonitoringChannelData;
	slots: string[];
	range: string;
	trendMap: Map<string, MonitoringDailyTrend>;
	token: string;
	keyStats?: MonitoringKeyStat[];
	probeHistory?: MonitoringProbeEntry[];
};

const ChannelBar = ({
	channel,
	slots,
	range,
	trendMap,
	token,
	keyStats,
	probeHistory,
}: ChannelBarProps) => {
	const [hoveredSlot, setHoveredSlot] = useState<string | null>(null);
	const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
	const [slotModels, setSlotModels] = useState<MonitoringSlotModel[]>([]);
	const [errorDetails, setErrorDetails] = useState<MonitoringErrorDetail[]>([]);
	const [loadingDetails, setLoadingDetails] = useState(false);
	const [showKeys, setShowKeys] = useState(false);

	const hoveredTrend = hoveredSlot
		? trendMap.get(`${channel.channel_id}|${hoveredSlot}`)
		: null;

	const handleSlotClick = async (slot: string) => {
		const trend = trendMap.get(`${channel.channel_id}|${slot}`);
		if (!trend) return;

		if (selectedSlot === slot) {
			setSelectedSlot(null);
			setSlotModels([]);
			setErrorDetails([]);
			return;
		}

		setSelectedSlot(slot);
		setLoadingDetails(true);
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (token) headers.Authorization = `Bearer ${token}`;
			const res = await fetch(
				`${apiBase}/api/monitoring/slot-details?slot=${encodeURIComponent(slot)}&channel_id=${encodeURIComponent(String(channel.channel_id))}&range=${range}`,
				{ headers },
			);
			if (res.ok) {
				const data = (await res.json()) as {
					models: MonitoringSlotModel[];
					errors: MonitoringErrorDetail[];
				};
				setSlotModels(data.models);
				setErrorDetails(data.errors);
			}
		} catch {
			/* ignore */
		} finally {
			setLoadingDetails(false);
		}
	};

	const closePanel = () => {
		setSelectedSlot(null);
		setSlotModels([]);
		setErrorDetails([]);
	};

	return (
		<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
			{/* Header row */}
			<div class="mb-3 flex flex-wrap items-center justify-between gap-2">
				<div class="flex items-center gap-2.5">
					<span
						class={`inline-block h-2.5 w-2.5 rounded-full ${statusDot(channel.success_rate)}`}
					/>
					<span class="font-medium text-stone-900">{channel.channel_name}</span>
					{parseChannelApiFormats(channel).map((format) => (
						<span
							key={format}
							class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${formatBadgeColors[format]}`}
						>
							{formatLabels[format]}
						</span>
					))}
					{channel.channel_status !== "active" && (
						<span class="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-400">
							停用
						</span>
					)}
				</div>
				<div class="flex items-center gap-3 text-xs text-stone-500">
					<span class={`font-medium ${rateColor(channel.success_rate)}`}>
						{channel.success_rate !== null ? `${channel.success_rate}%` : "-"}
					</span>
					<span>
						{channel.total_requests > 0 ? `${channel.avg_latency_ms}ms` : "-"}
					</span>
					<span class={`font-medium ${rateColor(channel.success_rate)}`}>
						{statusLabel(channel.success_rate)}
					</span>
					<button
						type="button"
						class={`rounded-lg px-2 py-1 text-xs font-medium transition ${
							showKeys
								? "bg-stone-900 text-white"
								: "bg-stone-100 text-stone-600 hover:bg-stone-200"
						}`}
						onClick={() => setShowKeys((v) => !v)}
					>
						Key 健康
					</button>
				</div>
			</div>

			{/* Uptime bars */}
			<div class="flex gap-px">
				{slots.map((slot) => {
					const trend = trendMap.get(`${channel.channel_id}|${slot}`);
					const rate = trend ? trend.success_rate : null;
					const isSelected = selectedSlot === slot;
					return (
						<button
							type="button"
							key={slot}
							class="relative flex-1 cursor-pointer"
							aria-label={`查看 ${formatSlotLabel(slot, range)} 请求详情`}
							aria-pressed={isSelected}
							onMouseEnter={() => setHoveredSlot(slot)}
							onMouseLeave={() => setHoveredSlot(null)}
							onClick={() => handleSlotClick(slot)}
						>
							<div
								class={`h-8 rounded-sm transition-opacity hover:opacity-80 ${isSelected ? "ring-2 ring-stone-900 ring-offset-1" : ""}`}
								style={{ backgroundColor: barColor(rate) }}
							/>
						</button>
					);
				})}
			</div>

			{/* Slot labels */}
			<div class="mt-1 flex justify-between text-xs text-stone-400">
				<span>{formatSlotLabel(slots[0], range)}</span>
				<span>{formatSlotLabel(slots[slots.length - 1], range)}</span>
			</div>

			{/* Hover tooltip */}
			{hoveredSlot && (
				<div class="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-xs text-stone-600">
					<span class="font-medium text-stone-800">
						{formatSlotLabel(hoveredSlot, range)}
					</span>
					{hoveredTrend ? (
						<span>
							{" "}
							&mdash; {hoveredTrend.requests} 请求, 成功率{" "}
							<span
								class={`font-medium ${rateColor(hoveredTrend.success_rate)}`}
							>
								{hoveredTrend.success_rate}%
							</span>
							, 延迟 {hoveredTrend.avg_latency_ms}ms
							{hoveredTrend.errors > 0 && (
								<span class="text-red-500"> ({hoveredTrend.errors} 错误)</span>
							)}
						</span>
					) : (
						<span class="text-stone-400"> &mdash; 无请求</span>
					)}
				</div>
			)}

			{/* 主动探测色条：14 格（旧→新，左灰补齐），悬停显示时间/状态/延迟；
				仅对有探测记录的渠道渲染（未开启探测的渠道不占位） */}
			{probeHistory && probeHistory.length > 0 && (
				<div class="mt-2 flex items-center gap-2">
					<span class="shrink-0 text-xs text-stone-400">主动探测</span>
					<div class="flex flex-1 gap-px">
						{buildProbeCells(probeHistory).map((entry, index) => (
							<span
								key={entry ? entry.checked_at : `empty-${index}`}
								class="h-2 flex-1 rounded-sm"
								style={{
									backgroundColor: entry
										? probeColor(entry.status)
										: PROBE_NO_DATA_COLOR,
								}}
								title={probeCellTitle(entry)}
							/>
						))}
					</div>
					{probeHistory[0] && (
						<span
							class={`shrink-0 text-xs font-medium ${probeHistory[0].status === "healthy" ? "text-green-600" : probeHistory[0].status === "degraded" ? "text-yellow-600" : "text-red-600"}`}
						>
							{probeStatusLabel(probeHistory[0].status)}
							{probeHistory[0].latency_ms !== null &&
								` ${probeHistory[0].latency_ms}ms`}
						</span>
					)}
				</div>
			)}

			{/* Per-key health panel (multi-key channels) */}
			{showKeys && (
				<div class="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
					<div class="mb-2 flex items-center justify-between">
						<span class="text-sm font-medium text-stone-800">Key 健康</span>
						<span class="text-xs text-stone-400">仅显示指纹，不显示明文</span>
					</div>
					{(!keyStats || keyStats.length === 0) && (
						<div class="text-xs text-stone-400">
							暂无 key 维度数据（单 key 渠道或该实例尚无流量）
						</div>
					)}
					{keyStats && keyStats.length > 0 && (
						<table class="w-full text-xs">
							<thead>
								<tr class="border-b border-stone-200 text-left text-stone-500">
									<th class="pb-1 font-medium">指纹</th>
									<th class="pb-1 font-medium">状态</th>
									<th class="pb-1 text-right font-medium">鉴权失败</th>
									<th class="pb-1 text-right font-medium">重试失败</th>
									<th class="pb-1 text-right font-medium">成功</th>
									<th class="pb-1 text-right font-medium">24h 成功率</th>
								</tr>
							</thead>
							<tbody>
								{keyStats.map((k) => (
									<tr key={k.key_tag} class="border-b border-stone-100">
										<td class="py-1 font-mono text-stone-700">{k.key_tag}</td>
										<td class="py-1">
											{k.cooling ? (
												<span class="rounded bg-red-100 px-1.5 py-0.5 font-medium text-red-700">
													冷却中
												</span>
											) : (
												<span class="rounded bg-green-100 px-1.5 py-0.5 text-green-700">
													正常
												</span>
											)}
										</td>
										<td
											class={`py-1 text-right ${k.auth_fails > 0 ? "font-medium text-red-600" : "text-stone-400"}`}
										>
											{k.auth_fails}
										</td>
										<td
											class={`py-1 text-right ${k.retryable_fails > 0 ? "text-yellow-600" : "text-stone-400"}`}
										>
											{k.retryable_fails}
										</td>
										<td class="py-1 text-right text-stone-600">
											{k.successes}
										</td>
										<td
											class={`py-1 text-right ${rateColor(k.success_rate_24h)}`}
										>
											{k.success_rate_24h !== null
												? `${k.success_rate_24h}%`
												: "-"}
											<span class="ml-1 text-stone-400">
												({k.ok_24h}/{k.ok_24h + k.error_24h})
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					<div class="mt-2 text-xs text-stone-400">
						鉴权失败（401/403）与重试失败（429/5xx/网络错）为本实例启动以来的累计值；
						24h 成功率来自持久化末次归因（usage_logs.key_tag）。
					</div>
				</div>
			)}

			{/* Slot details panel */}
			{selectedSlot && (
				<div class="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
					<div class="mb-2 flex items-center justify-between">
						<span class="text-sm font-medium text-stone-800">
							{formatSlotLabel(selectedSlot, range)} 请求详情
						</span>
						<button
							type="button"
							class="text-xs text-stone-400 hover:text-stone-600"
							onClick={closePanel}
						>
							关闭
						</button>
					</div>
					{loadingDetails ? (
						<div class="space-y-1.5" aria-hidden="true">
							<SkeletonBlock class="h-3 w-full" />
							<SkeletonBlock class="h-3 w-5/6" />
							<SkeletonBlock class="h-3 w-2/3" />
						</div>
					) : (
						<>
							{/* Model summary table */}
							{slotModels.length > 0 && (
								<table class="w-full text-xs">
									<thead>
										<tr class="border-b border-stone-200 text-left text-stone-500">
											<th class="pb-1 font-medium">模型</th>
											<th class="pb-1 text-right font-medium">请求</th>
											<th class="pb-1 text-right font-medium">成功</th>
											<th class="pb-1 text-right font-medium">错误</th>
											<th class="pb-1 text-right font-medium">延迟</th>
										</tr>
									</thead>
									<tbody>
										{slotModels.map((m) => (
											<tr key={m.model} class="border-b border-stone-100">
												<td class="py-1 font-mono text-stone-700">{m.model}</td>
												<td class="py-1 text-right text-stone-600">
													{m.requests}
												</td>
												<td class="py-1 text-right text-green-600">
													{m.success}
												</td>
												<td
													class={`py-1 text-right ${m.errors > 0 ? "text-red-600 font-medium" : "text-stone-400"}`}
												>
													{m.errors}
												</td>
												<td class="py-1 text-right text-stone-500">
													{m.avg_latency_ms}ms
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}

							{/* Error details */}
							{errorDetails.length > 0 && (
								<div class="mt-3 rounded-lg border border-red-200 bg-red-50 p-2">
									<div class="mb-1.5 text-xs font-medium text-red-800">
										错误详情 ({errorDetails.length})
									</div>
									<div class="max-h-60 space-y-2 overflow-y-auto">
										{errorDetails.map((err) => (
											<div
												key={err.id}
												class="rounded bg-white p-2 text-xs shadow-sm"
											>
												<div class="flex items-center gap-2">
													{err.error_code && (
														<span class="font-mono font-medium text-red-600">
															{err.error_code}
														</span>
													)}
													{err.model && (
														<span class="text-stone-600">{err.model}</span>
													)}
													{err.latency_ms != null && (
														<span class="text-stone-400">
															{err.latency_ms}ms
														</span>
													)}
													<span class="ml-auto text-stone-400">
														{err.created_at}
													</span>
												</div>
												{err.error_message && (
													<pre class="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-all rounded bg-red-50 p-1 text-xs text-red-700">
														{err.error_message}
													</pre>
												)}
											</div>
										))}
									</div>
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
};

export const MonitoringView = ({
	monitoring,
	token,
	onLoaded,
}: MonitoringViewProps) => {
	const [range, setRange] = useState("15m");
	const [loading, setLoading] = useState(false);

	const fetchData = useCallback(
		async (r: string) => {
			setLoading(true);
			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
				};
				if (token) headers.Authorization = `Bearer ${token}`;
				const res = await fetch(`${apiBase}/api/monitoring?range=${r}`, {
					headers,
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as MonitoringData;
				onLoaded(data);
			} catch {
				/* silently ignore */
			} finally {
				setLoading(false);
			}
		},
		[token, onLoaded],
	);

	const handleRangeChange = useCallback(
		(r: string) => {
			setRange(r);
			fetchData(r);
		},
		[fetchData],
	);

	const slots = useMemo(() => generateSlots(range), [range]);

	const trendMap = useMemo(() => {
		const map = new Map<string, MonitoringDailyTrend>();
		if (!monitoring) return map;
		for (const t of monitoring.dailyTrends) {
			map.set(`${t.channel_id}|${t.day}`, t);
		}
		return map;
	}, [monitoring]);

	const keyStatsMap = useMemo(() => {
		const map = new Map<string, MonitoringKeyStat[]>();
		for (const entry of monitoring?.keyStats ?? []) {
			map.set(entry.channel_id, entry.keys);
		}
		return map;
	}, [monitoring]);

	const probeHistoryMap = useMemo(() => {
		const map = new Map<string, MonitoringProbeEntry[]>();
		for (const entry of monitoring?.probes ?? []) {
			map.set(entry.channel_id, entry.history);
		}
		return map;
	}, [monitoring]);

	if (!monitoring) {
		return (
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				暂无数据
			</div>
		);
	}

	const { summary, channels } = monitoring;
	const recent = monitoring.recentStatus;

	// Overall status based on last 15 minutes
	const overallStatus =
		recent.success_rate >= 99
			? "所有系统正常运行"
			: recent.success_rate >= 95
				? "部分系统降级"
				: "系统异常";

	return (
		<div class="space-y-5">
			{/* Time range selector */}
			<div class="flex items-center gap-2">
				{RANGE_OPTIONS.map((r) => (
					<button
						key={r}
						type="button"
						onClick={() => handleRangeChange(r)}
						disabled={loading}
						class={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
							range === r
								? "bg-stone-900 text-white"
								: "bg-stone-100 text-stone-600 hover:bg-stone-200"
						} ${loading ? "opacity-50" : ""}`}
					>
						{RANGE_LABELS[r]}
					</button>
				))}
				{loading && <DotLoader class="text-stone-400" />}
			</div>

			{/* Overall status banner (always based on last 15 minutes) */}
			<div
				class={`flex items-center gap-3 rounded-2xl border p-5 shadow-lg ${
					recent.success_rate >= 99
						? "border-green-200 bg-green-50"
						: recent.success_rate >= 95
							? "border-yellow-200 bg-yellow-50"
							: "border-red-200 bg-red-50"
				}`}
			>
				<span
					class={`inline-block h-3 w-3 rounded-full ${statusDot(recent.success_rate)}`}
				/>
				<span class={`text-lg font-semibold ${rateColor(recent.success_rate)}`}>
					{overallStatus}
				</span>
				<span class="ml-auto text-sm text-stone-500">
					近 15 分钟: {recent.total_requests} 请求 &middot;{" "}
					{recent.success_rate}% 成功率 &middot; {recent.avg_latency_ms}ms 延迟
				</span>
			</div>

			{/* Global overview cards */}
			<div class="grid grid-cols-1 gap-5 sm:grid-cols-3">
				<div class="flex flex-col gap-1.5 rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
					<span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
						整体成功率
					</span>
					<div
						class={`text-2xl font-semibold ${rateColor(summary.success_rate)}`}
					>
						{summary.success_rate}%
					</div>
					<span class="font-['Space_Grotesk'] text-xs text-stone-500">
						成功 {summary.total_success} / 错误 {summary.total_errors}
					</span>
				</div>
				<div class="flex flex-col gap-1.5 rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
					<span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
						活跃渠道
					</span>
					<div class="text-2xl font-semibold text-stone-900">
						{summary.active_channels}
						<span class="text-base font-normal text-stone-400">
							{" "}
							/ {summary.total_channels}
						</span>
					</div>
					<span class="font-['Space_Grotesk'] text-xs text-stone-500">
						有流量渠道数
					</span>
				</div>
				<div class="flex flex-col gap-1.5 rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
					<span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
						平均延迟
					</span>
					<div class="text-2xl font-semibold text-stone-900">
						{summary.avg_latency_ms} ms
					</div>
					<span class="font-['Space_Grotesk'] text-xs text-stone-500">
						{summary.total_requests} 次请求
					</span>
				</div>
			</div>

			{/* Per-channel uptime bars */}
			{channels.map((ch) => (
				<ChannelBar
					key={ch.channel_id}
					channel={ch}
					slots={slots}
					range={range}
					trendMap={trendMap}
					token={token}
					keyStats={keyStatsMap.get(ch.channel_id)}
					probeHistory={probeHistoryMap.get(ch.channel_id)}
				/>
			))}

			{/* Legend */}
			<div class="flex flex-wrap items-center gap-4 px-1 text-xs text-stone-400">
				<div class="flex items-center gap-1.5">
					<span class="inline-block h-3 w-3 rounded-sm bg-green-500" /> 正常
					(&ge;99%)
				</div>
				<div class="flex items-center gap-1.5">
					<span class="inline-block h-3 w-3 rounded-sm bg-yellow-500" /> 降级
					(&ge;95%)
				</div>
				<div class="flex items-center gap-1.5">
					<span class="inline-block h-3 w-3 rounded-sm bg-red-500" /> 异常
					(&lt;95%)
				</div>
				<div class="flex items-center gap-1.5">
					<span class="inline-block h-3 w-3 rounded-sm bg-stone-200" /> 无数据
				</div>
			</div>
		</div>
	);
};
