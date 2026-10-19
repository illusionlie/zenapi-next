import { useCallback, useMemo, useState } from "hono/jsx/dom";
import { createApiFetch } from "../core/api";
import { toast } from "../core/toast";
import type { User, UserDashboardData } from "../core/types";
import { cacheRateColor, formatCacheRate } from "../core/utils";

type UserDashboardProps = {
	data: UserDashboardData | null;
	user: User;
	token: string;
	updateToken: (next: string | null) => void;
	linuxdoEnabled: boolean;
	onUnbind: () => void;
	onUserRefresh: () => void;
};

function formatCost(n: number): string {
	if (n === 0) return "$0.00";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

function formatNumber(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export const UserDashboard = ({
	data,
	user,
	token,
	updateToken,
	linuxdoEnabled,
	onUnbind,
	onUserRefresh,
}: UserDashboardProps) => {
	const [checkinLoading, setCheckinLoading] = useState(false);
	const [rechargeAmount, setRechargeAmount] = useState("");
	const [rechargeLoading, setRechargeLoading] = useState(false);
	const [rechargeError, setRechargeError] = useState("");

	const apiFetch = useMemo(
		() => createApiFetch(token, () => updateToken(null)),
		[token, updateToken],
	);

	const handleCheckin = useCallback(async () => {
		setCheckinLoading(true);
		try {
			const result = await apiFetch<{
				ok?: boolean;
				already_checked_in?: boolean;
				reward?: number;
			}>("/api/u/checkin", {
				method: "POST",
			});
			if (result.already_checked_in) {
				toast.info("今日已签到");
			} else if (result.ok) {
				toast.success(`签到成功，获得 $${result.reward?.toFixed(2) ?? "0"}`);
				onUserRefresh();
			}
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setCheckinLoading(false);
		}
	}, [apiFetch, onUserRefresh]);

	const handleRecharge = useCallback(async () => {
		const amount = Number(rechargeAmount);
		if (!amount || amount <= 0) {
			setRechargeError("请输入有效的充值金额");
			return;
		}
		setRechargeLoading(true);
		setRechargeError("");
		try {
			const result = await apiFetch<{ order_id: string; redirect_url: string }>(
				"/api/recharge/create",
				{
					method: "POST",
					body: JSON.stringify({ ldc_amount: amount }),
				},
			);
			if (result.redirect_url) {
				window.location.href = result.redirect_url;
			}
		} catch (error) {
			toast.error((error as Error).message);
		} finally {
			setRechargeLoading(false);
		}
	}, [apiFetch, rechargeAmount]);

	if (!data) {
		return (
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<p class="text-sm text-stone-400">加载中...</p>
			</div>
		);
	}

	return (
		<div class="space-y-5">
			{/* Check-in card */}
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<div class="flex items-center justify-between">
					<div>
						<h3 class="font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
							每日签到
						</h3>
						<p class="text-xs text-stone-500">
							每日签到可获得 ${data.checkin_reward.toFixed(2)} 余额
						</p>
					</div>
					{data.checked_in_today ? (
						<button
							type="button"
							disabled
							class="rounded-lg bg-stone-100 px-5 py-2.5 text-sm font-semibold text-stone-400 cursor-not-allowed"
						>
							已签到
						</button>
					) : (
						<button
							type="button"
							disabled={checkinLoading}
							class="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg disabled:opacity-60"
							onClick={handleCheckin}
						>
							{checkinLoading ? "签到中..." : "签到"}
						</button>
					)}
				</div>
			</div>

			{/* Recharge card */}
			{data.ldc_payment_enabled && (
				<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
					<h3 class="font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						LDC 充值
					</h3>
					<p class="mb-3 text-xs text-stone-500">
						1 LDC = ${data.ldc_exchange_rate} 余额
					</p>
					<div class="flex flex-col gap-3 sm:flex-row sm:items-end">
						<div class="flex-1">
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
								htmlFor="recharge-amount"
							>
								LDC 积分数量
							</label>
							<input
								id="recharge-amount"
								class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								type="number"
								min="1"
								step="1"
								placeholder="输入 LDC 积分数量"
								value={rechargeAmount}
								onInput={(e) =>
									setRechargeAmount(
										(e.currentTarget as HTMLInputElement)?.value ?? "",
									)
								}
							/>
						</div>
						<button
							type="button"
							disabled={rechargeLoading || !rechargeAmount}
							class="h-[42px] rounded-lg bg-stone-900 px-5 text-sm font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
							onClick={handleRecharge}
						>
							{rechargeLoading ? "处理中..." : "充值"}
						</button>
					</div>
					{rechargeAmount && Number(rechargeAmount) > 0 && (
						<p class="mt-2 text-sm text-stone-600">
							支付 {rechargeAmount} LDC 积分 → 获得 $
							{(Number(rechargeAmount) * data.ldc_exchange_rate).toFixed(2)}{" "}
							余额
						</p>
					)}
					{rechargeError && (
						<div class="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
							{rechargeError}
						</div>
					)}
				</div>
			)}

			{/* Stats cards */}
			<div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<div class="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
					<p class="text-xs font-medium uppercase tracking-widest text-stone-400">
						余额
					</p>
					<p class="mt-1 font-['Space_Grotesk'] text-2xl font-semibold text-stone-900">
						${user.balance.toFixed(2)}
					</p>
				</div>
				<div class="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
					<p class="text-xs font-medium uppercase tracking-widest text-stone-400">
						总请求
					</p>
					<p class="mt-1 font-['Space_Grotesk'] text-2xl font-semibold text-stone-900">
						{formatNumber(data.total_requests)}
					</p>
				</div>
				<div class="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
					<p class="text-xs font-medium uppercase tracking-widest text-stone-400">
						总 Token
					</p>
					<p class="mt-1 font-['Space_Grotesk'] text-2xl font-semibold text-stone-900">
						{formatNumber(data.total_tokens)}
					</p>
				</div>
				<div class="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
					<p class="text-xs font-medium uppercase tracking-widest text-stone-400">
						总费用
					</p>
					<p class="mt-1 font-['Space_Grotesk'] text-2xl font-semibold text-stone-900">
						{formatCost(data.total_cost)}
					</p>
				</div>
				<div class="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
					<p class="text-xs font-medium uppercase tracking-widest text-stone-400">
						缓存命中率
					</p>
					<p class="mt-1 font-['Space_Grotesk'] text-2xl font-semibold text-stone-900">
						{formatCacheRate(data.cache_rate)}
					</p>
					<p class="text-xs text-stone-500">
						命中 {formatNumber(data.cached_tokens)} tokens
					</p>
				</div>
			</div>

			{/* Account binding */}
			{linuxdoEnabled && (
				<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
					<h3 class="mb-4 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						账号绑定
					</h3>
					<div class="flex items-center justify-between">
						<div>
							<p class="text-sm font-medium text-stone-700">Linux DO</p>
							<p class="text-xs text-stone-500">
								{user.linuxdo_id ? `已绑定 (ID: ${user.linuxdo_id})` : "未绑定"}
							</p>
						</div>
						<div>
							{user.linuxdo_id ? (
								<button
									type="button"
									class="rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-600 transition-colors hover:border-red-200 hover:text-red-600"
									onClick={onUnbind}
								>
									解除绑定
								</button>
							) : (
								<a
									href={`/api/u/auth/linuxdo/bind?token=${encodeURIComponent(token)}`}
									class="inline-flex rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 transition-[transform,box-shadow,color,background-color,border-color] ease-smooth-out hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md"
								>
									绑定 Linux DO
								</a>
							)}
						</div>
					</div>
				</div>
			)}

			{/* Recent usage */}
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<h3 class="mb-4 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
					最近使用
				</h3>
				{data.recent_usage.length === 0 ? (
					<p class="py-8 text-center text-sm text-stone-400">暂无使用记录</p>
				) : (
					<div class="overflow-x-auto">
						<table class="w-full text-left text-sm">
							<thead>
								<tr class="border-b border-stone-100 text-xs uppercase tracking-widest text-stone-400">
									<th class="pb-2 pr-4 font-medium">日期</th>
									<th class="pb-2 pr-4 font-medium">请求数</th>
									<th class="pb-2 pr-4 font-medium">费用</th>
									<th class="pb-2 font-medium">缓存命中</th>
								</tr>
							</thead>
							<tbody>
								{data.recent_usage.map((item) => (
									<tr class="border-b border-stone-50">
										<td class="py-2 pr-4 text-stone-600">{item.day}</td>
										<td class="py-2 pr-4 text-stone-600">{item.requests}</td>
										<td class="py-2 pr-4 text-stone-600">
											{formatCost(item.cost)}
										</td>
										<td class="py-2 text-stone-600">
											<div class="flex items-center gap-2">
												<span class="w-14 shrink-0 tabular-nums">
													{formatNumber(item.cached_tokens)}
												</span>
												<div class="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-stone-100">
													<div
														class="h-full rounded-full"
														style={{
															width: `${Math.round((item.cache_rate ?? 0) * 100)}%`,
															backgroundColor: cacheRateColor(item.cache_rate),
														}}
													/>
												</div>
												<span>{formatCacheRate(item.cache_rate)}</span>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
};
