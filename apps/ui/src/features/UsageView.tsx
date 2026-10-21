import { useEffect, useMemo, useState } from "hono/jsx/dom";
import type { UsageLog } from "../core/types";
import { buildPageItems, formatDateTime } from "../core/utils";

type UsageViewProps = {
	usage: UsageLog[];
	onRefresh: () => void;
};

const pageSizeOptions = [50, 100, 200];

/** 表格列数（展开详情行 colSpan 与空态行 colSpan 同步引用） */
const columnCount = 11;

const formatTokens = (value: number | null | undefined) =>
	value === null || value === undefined ? "-" : value;

const formatSeconds = (value: number | null | undefined) => {
	if (value === null || value === undefined || Number.isNaN(value)) {
		return "-";
	}
	return `${(value / 1000).toFixed(2)} s`;
};

const formatStream = (value: boolean | number | null | undefined) => {
	if (value === null || value === undefined) {
		return "-";
	}
	if (typeof value === "number") {
		return value > 0 ? "是" : "否";
	}
	return value ? "是" : "否";
};

const isStreamTruthy = (value: boolean | number | null | undefined) => {
	if (value === null || value === undefined) {
		return false;
	}
	if (typeof value === "number") {
		return value > 0;
	}
	return value;
};

const formatCost = (value: number | null | undefined) => {
	if (value === null || value === undefined) {
		return "-";
	}
	if (value === 0) {
		return "$0";
	}
	if (value < 0.01) {
		return `$${value.toFixed(4)}`;
	}
	return `$${value.toFixed(2)}`;
};

/**
 * Renders a "name (fallback)" composite: both present → "name (fallback)",
 * only name → name, only fallback → "#fallback", neither → "-".
 */
const formatRef = (
	name: string | null | undefined,
	fallback: string | null | undefined,
) => {
	const hasName = typeof name === "string" && name !== "";
	const hasFallback = typeof fallback === "string" && fallback !== "";
	if (hasName && hasFallback) {
		return `${name} (${fallback})`;
	}
	if (hasName) {
		return name;
	}
	if (hasFallback) {
		return `#${fallback}`;
	}
	return "-";
};

type ErrorMessageParts = {
	/** JSON 可解析时提取的可读主消息；null = 按纯文本原样展示 */
	summary: string | null;
	/** 原始报文（等宽小字辅助展示） */
	raw: string;
};

/**
 * Parses an upstream error payload (first 512 chars of the response body)
 * into a readable summary plus the raw payload. Non-JSON text (e.g. the
 * retry-exhausted fallback "upstream_unavailable") degrades to raw display.
 */
const parseErrorMessage = (raw: string): ErrorMessageParts => {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			const inner = record.error;
			if (
				inner !== null &&
				typeof inner === "object" &&
				!Array.isArray(inner)
			) {
				const message = (inner as Record<string, unknown>).message;
				if (typeof message === "string" && message.trim() !== "") {
					return { summary: message, raw };
				}
			}
			if (typeof record.message === "string" && record.message.trim() !== "") {
				return { summary: record.message, raw };
			}
		}
	} catch {
		/* 非 JSON 载荷，原样展示 */
	}
	return { summary: null, raw };
};

type DetailItemProps = {
	label: string;
	value: string | number;
	mono?: boolean;
};

const DetailItem = ({ label, value, mono }: DetailItemProps) => (
	<div class="min-w-0">
		<dt class="text-[11px] tracking-wider text-stone-400 uppercase">{label}</dt>
		<dd
			class={`mt-0.5 break-all text-sm text-stone-700${mono ? " font-mono" : ""}`}
		>
			{value}
		</dd>
	</div>
);

/**
 * Renders the full detail of one usage log row inside the expandable panel.
 */
const UsageDetailPanel = ({ log }: { log: UsageLog }) => {
	const rawMessage = log.error_message ?? "";
	const showErrorBlock = log.status === "error" && rawMessage.trim() !== "";
	const errorParts = showErrorBlock ? parseErrorMessage(rawMessage) : null;
	return (
		<div class="space-y-4">
			<dl class="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
				<DetailItem label="请求路径" value={log.request_path ?? "-"} mono />
				<DetailItem label="时间" value={log.created_at} mono />
				<DetailItem label="模型" value={log.model ?? "-"} />
				<DetailItem
					label="渠道"
					value={formatRef(log.channel_name, log.channel_id)}
				/>
				<DetailItem
					label="令牌"
					value={formatRef(log.token_name, log.token_id)}
				/>
				<DetailItem
					label="用户"
					value={formatRef(log.user_name, log.user_email)}
				/>
				<DetailItem
					label="输入 Tokens"
					value={formatTokens(log.prompt_tokens)}
				/>
				<DetailItem
					label="输出 Tokens"
					value={formatTokens(log.completion_tokens)}
				/>
				<DetailItem label="总 Tokens" value={formatTokens(log.total_tokens)} />
				<DetailItem
					label="缓存命中 Tokens"
					value={formatTokens(log.cached_input_tokens)}
				/>
				<DetailItem
					label="缓存写入 Tokens"
					value={formatTokens(log.cache_creation_tokens)}
				/>
				<DetailItem label="费用" value={formatCost(log.cost)} mono />
				<DetailItem label="总用时" value={formatSeconds(log.latency_ms)} />
				<DetailItem
					label="首 token 延迟"
					value={formatSeconds(log.first_token_latency_ms)}
				/>
				<DetailItem label="流式" value={formatStream(log.stream)} />
				<DetailItem
					label="推理强度"
					value={
						log.reasoning_effort === null || log.reasoning_effort === undefined
							? "-"
							: String(log.reasoning_effort)
					}
				/>
			</dl>
			{showErrorBlock && errorParts ? (
				<div class="rounded-xl border border-red-200 bg-red-50/60 p-3">
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-[11px] font-semibold tracking-wider text-red-500 uppercase">
							错误
						</span>
						{log.error_code !== null && log.error_code !== undefined && (
							<span class="rounded-full border border-red-200 bg-white px-2 py-0.5 text-xs font-medium text-red-600">
								HTTP {log.error_code}
							</span>
						)}
					</div>
					{errorParts.summary !== null && (
						<p class="mt-2 break-all text-sm text-red-700">
							{errorParts.summary}
						</p>
					)}
					<details class="mt-2">
						<summary class="cursor-pointer text-xs text-stone-500 transition-colors duration-200 hover:text-stone-700">
							原始报文
						</summary>
						<pre class="mt-2 max-h-48 overflow-auto rounded-lg bg-white p-3 font-mono text-xs break-all whitespace-pre-wrap text-stone-600">
							{errorParts.raw}
						</pre>
					</details>
				</div>
			) : (
				<div class="flex items-center gap-2 text-xs text-stone-400">
					<span class="shrink-0 text-[11px] tracking-wider uppercase">
						错误信息
					</span>
					<span>
						{log.error_code !== null && log.error_code !== undefined
							? `错误码 ${log.error_code}`
							: "-"}
					</span>
				</div>
			)}
		</div>
	);
};

/**
 * Renders the usage logs view.
 *
 * Args:
 *   props: Usage view props.
 *
 * Returns:
 *   Usage JSX element.
 */
export const UsageView = ({ usage, onRefresh }: UsageViewProps) => {
	const [pageSize, setPageSize] = useState(50);
	const [page, setPage] = useState(1);
	const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
	const total = usage.length;
	const totalPages = useMemo(
		() => Math.max(1, Math.ceil(total / pageSize)),
		[total, pageSize],
	);

	const toggleExpanded = (id: string) => {
		setExpandedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	useEffect(() => {
		setPage(1);
	}, [pageSize]);

	useEffect(() => {
		setPage((prev) => Math.min(prev, totalPages));
	}, [totalPages]);

	const pagedUsage = useMemo(() => {
		const start = (page - 1) * pageSize;
		return usage.slice(start, start + pageSize);
	}, [usage, page, pageSize]);
	const pageItems = useMemo(
		() => buildPageItems(page, totalPages),
		[page, totalPages],
	);

	return (
		<div class="flex h-full flex-col rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
			<div class="flex flex-wrap items-center justify-between gap-3 shrink-0">
				<div>
					<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						使用日志
					</h3>
					<p class="text-xs text-stone-500">
						追踪每次调用的令牌与关键性能指标，点击行查看详情。
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<button
						class="h-10 md:h-9 rounded-full border border-stone-200 bg-stone-100 px-4 text-xs font-semibold text-stone-900 transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
						type="button"
						onClick={onRefresh}
					>
						刷新
					</button>
				</div>
			</div>
			<div class="mt-4 flex-1 overflow-hidden rounded-xl border border-stone-200">
				<div class="h-full overflow-auto">
					<table class="min-w-[1100px] w-full border-collapse text-sm">
						<thead>
							<tr>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									时间
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									模型
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									渠道
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									令牌
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									用户
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									输入 Tokens
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									输出 Tokens
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									用时
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									流式
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									推理强度
								</th>
								<th class="sticky top-0 border-b border-stone-200 bg-stone-50 px-3 py-2.5 text-left text-xs uppercase tracking-widest text-stone-500">
									状态
								</th>
							</tr>
						</thead>
						<tbody>
							{pagedUsage.length === 0 ? (
								<tr>
									<td
										class="px-3 py-10 text-center text-sm text-stone-500"
										colSpan={columnCount}
									>
										暂无日志。
									</td>
								</tr>
							) : (
								pagedUsage.flatMap((log) => {
									const expanded = expandedIds.has(log.id);
									return [
										<tr
											class={`cursor-pointer transition-colors duration-200 hover:bg-stone-50${expanded ? " bg-stone-100/60" : ""}`}
											key={log.id}
											onClick={() => toggleExpanded(log.id)}
											onKeyDown={(event) => {
												if (event.target !== event.currentTarget) {
													return;
												}
												if (event.key === "Enter" || event.key === " ") {
													toggleExpanded(log.id);
												}
											}}
										>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												<div class="flex items-center gap-1.5">
													<button
														aria-expanded={expanded ? "true" : "false"}
														aria-label={
															expanded ? "收起日志详情" : "展开日志详情"
														}
														class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors duration-200 hover:bg-stone-200 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70"
														type="button"
														onClick={(event) => {
															event.stopPropagation();
															toggleExpanded(log.id);
														}}
													>
														<svg
															aria-hidden="true"
															class={`h-3.5 w-3.5 transition-transform duration-200${expanded ? " rotate-90" : ""}`}
															fill="none"
															stroke="currentColor"
															stroke-width="2"
															viewBox="0 0 24 24"
														>
															<path
																d="M9 5l7 7-7 7"
																stroke-linecap="round"
																stroke-linejoin="round"
															/>
														</svg>
													</button>
													<span>{formatDateTime(log.created_at)}</span>
												</div>
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{log.model ?? "-"}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{log.channel_name ?? log.channel_id ?? "-"}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{log.token_name ?? log.token_id ?? "-"}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{log.user_name ?? "-"}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{formatTokens(log.prompt_tokens)}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{formatTokens(log.completion_tokens)}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												<div class="flex flex-col leading-tight">
													<span>{formatSeconds(log.latency_ms)}</span>
													{isStreamTruthy(log.stream) &&
														log.first_token_latency_ms !== null &&
														log.first_token_latency_ms !== undefined && (
															<span class="text-xs text-stone-400">
																首 {formatSeconds(log.first_token_latency_ms)}
															</span>
														)}
												</div>
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{formatStream(log.stream)}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm text-stone-700">
												{log.reasoning_effort ?? "-"}
											</td>
											<td class="border-b border-stone-200 px-3 py-2.5 text-left text-sm">
												<span
													class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
														log.status === "error"
															? "border-red-200 bg-red-50 text-red-600"
															: "border-stone-200 bg-stone-100 text-stone-600"
													}`}
												>
													{log.status}
												</span>
											</td>
										</tr>,
										...(expanded
											? [
													<tr class="bg-stone-50" key={`${log.id}-detail`}>
														<td
															class="border-b border-stone-200 px-3 py-3"
															colSpan={columnCount}
														>
															<UsageDetailPanel log={log} />
														</td>
													</tr>,
												]
											: []),
									];
								})
							)}
						</tbody>
					</table>
				</div>
			</div>
			<div class="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-stone-500 shrink-0">
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-xs text-stone-500">共 {totalPages} 页</span>
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
		</div>
	);
};
