import { useState } from "hono/jsx/dom";
import type { PublicModelItem } from "../core/types";

type UserModelsViewProps = {
	models: PublicModelItem[];
};

function formatPrice(n: number | null): string {
	if (n == null) return "-";
	return `$${n}`;
}

export const UserModelsView = ({ models }: UserModelsViewProps) => {
	const [search, setSearch] = useState("");

	const filtered = search
		? models.filter((m) => {
				const lower = search.toLowerCase();
				return m.id.toLowerCase().includes(lower);
			})
		: models;

	return (
		<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
			<div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div class="flex flex-wrap items-center gap-3">
					<h3 class="font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
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
				<div class="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
					{filtered.map((model) => {
						return (
							<div class="rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
								<div class="mb-2 flex items-start justify-between gap-2">
									<div class="min-w-0 flex-1">
										<h4 class="break-all font-['Space_Grotesk'] text-sm font-semibold tracking-tight text-stone-900">
											{model.id}
										</h4>
									</div>
									<span class="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">
										{model.channels.length} 渠道
									</span>
								</div>
								{model.channels.length > 0 && (
									<div class="rounded-lg bg-stone-50 p-2.5">
										<p class="mb-1.5 text-xs font-medium uppercase tracking-widest text-stone-400">
											渠道价格
										</p>
										<div class="space-y-1">
											{model.channels.map((ch) => (
												<div class="flex items-center justify-between text-xs">
													<span class="truncate text-stone-600">{ch.name}</span>
													<span class="shrink-0 pl-2 text-stone-500">
														{ch.input_price != null ||
														ch.output_price != null ? (
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
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};
