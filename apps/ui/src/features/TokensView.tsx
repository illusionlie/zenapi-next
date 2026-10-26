import type { Token, TokenForm } from "../core/types";
import {
	buildPageItems,
	formatDateTime,
	getTokenExpiryState,
} from "../core/utils";
import { Modal } from "./Modal";
import { ModelAllowlistPicker } from "./ModelAllowlistPicker";
import { TokenExpiryPicker } from "./TokenExpiryPicker";

type TokensViewProps = {
	pagedTokens: Token[];
	tokenPage: number;
	tokenPageSize: number;
	tokenTotal: number;
	tokenTotalPages: number;
	isTokenModalOpen: boolean;
	onCreate: () => void;
	onCloseModal: () => void;
	onPageChange: (next: number) => void;
	onPageSizeChange: (next: number) => void;
	onSubmit: (event: Event) => void;
	onReveal: (id: string) => void;
	onToggle: (id: string, status: string) => void;
	onDelete: (id: string) => void;
	editingToken: Token | null;
	tokenForm: TokenForm;
	onTokenFormChange: (patch: Partial<TokenForm>) => void;
	/** 创建模态的有效期(选择器解析后的 ISO;空串 = 永久),随 tokenCreateModels 同构提升 */
	tokenCreateExpiresAt: string;
	onTokenCreateExpiresAtChange: (next: string) => void;
	createSelectedModels: Set<string>;
	onCreateModelsChange: (next: Set<string>) => void;
	onEdit: (token: Token) => void;
	onCloseEditModal: () => void;
	onEditSubmit: (event: Event) => void;
	onFetchModelCandidates: () => Promise<string[]>;
};

const pageSizeOptions = [10, 20, 50];

/** 「模型限制」单元格:无限制显示「全部」,有限制显示「N 个模型」徽章(title 列明细) */
export const renderModelLimit = (token: Token) => {
	const models = token.allowed_models ?? [];
	if (models.length === 0) {
		return <span class="text-xs text-stone-400">全部</span>;
	}
	return (
		<span
			class="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-600"
			title={models.join("\n")}
		>
			{models.length} 个模型
		</span>
	);
};

/** 「有效期」状态(渲染层惰性计算,不落库):已过期红徽标 / 剩余时长;永久(NULL)不渲染 */
export const renderTokenExpiry = (token: Token) => {
	const state = getTokenExpiryState(token.expires_at);
	if (state.kind === "permanent") {
		return null;
	}
	if (state.kind === "expired") {
		return (
			<span class="inline-flex items-center rounded-full border border-red-100 bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600">
				已过期
			</span>
		);
	}
	return (
		<span
			class="text-xs text-stone-400"
			title={formatDateTime(state.expiresAt)}
		>
			剩余 {state.remainingLabel}
		</span>
	);
};

/**
 * Renders the tokens management view.
 */
export const TokensView = ({
	pagedTokens,
	tokenPage,
	tokenPageSize,
	tokenTotal,
	tokenTotalPages,
	isTokenModalOpen,
	onCreate,
	onCloseModal,
	onPageChange,
	onPageSizeChange,
	onSubmit,
	onReveal,
	onToggle,
	onDelete,
	editingToken,
	tokenForm,
	onTokenFormChange,
	tokenCreateExpiresAt,
	onTokenCreateExpiresAtChange,
	createSelectedModels,
	onCreateModelsChange,
	onEdit,
	onCloseEditModal,
	onEditSubmit,
	onFetchModelCandidates,
}: TokensViewProps) => {
	const pageItems = buildPageItems(tokenPage, tokenTotalPages);
	return (
		<div class="space-y-5">
			<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
							令牌列表
						</h3>
						<p class="text-xs text-stone-500">
							统一管理令牌状态、额度与操作入口。
						</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<button
							class="h-10 md:h-9 rounded-full bg-stone-900 px-4 text-xs font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
							type="button"
							onClick={onCreate}
						>
							新增令牌
						</button>
					</div>
				</div>

				{/* Desktop table */}
				<div class="mt-4 hidden md:block overflow-hidden rounded-xl border border-stone-200">
					<div class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3 bg-stone-50 px-4 py-3 text-xs uppercase tracking-widest text-stone-500">
						<div>名称</div>
						<div>归属用户</div>
						<div>状态</div>
						<div>已用/额度</div>
						<div>模型限制</div>
						<div>前缀</div>
						<div>创建时间</div>
						<div>操作</div>
					</div>
					{pagedTokens.length === 0 ? (
						<div class="px-4 py-10 text-center text-sm text-stone-500">
							暂无令牌，请先创建。
						</div>
					) : (
						<div class="divide-y divide-stone-100">
							{pagedTokens.map((tokenItem) => {
								const isActive = tokenItem.status === "active";
								return (
									<div
										class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1.2fr)] items-center gap-3 px-4 py-4 text-sm"
										key={tokenItem.id}
									>
										<div class="flex min-w-0 flex-col">
											<span class="truncate font-semibold text-stone-900">
												{tokenItem.name}
											</span>
										</div>
										<div class="min-w-0">
											{tokenItem.user_name ? (
												<span
													class="truncate block text-sm text-stone-700"
													title={tokenItem.user_email ?? ""}
												>
													{tokenItem.user_name}
												</span>
											) : (
												<span class="text-sm text-stone-400">-</span>
											)}
										</div>
										<div class="flex flex-col items-start gap-1">
											<span
												class={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
													isActive
														? "border-emerald-100 bg-emerald-50 text-emerald-600"
														: "border-stone-200 bg-stone-100 text-stone-500"
												}`}
											>
												{isActive ? "启用" : "禁用"}
											</span>
											{renderTokenExpiry(tokenItem)}
										</div>
										<div class="text-sm font-semibold text-stone-700">
											{tokenItem.quota_used} / {tokenItem.quota_total ?? "∞"}
										</div>
										<div>{renderModelLimit(tokenItem)}</div>
										<div class="text-sm text-stone-700">
											{tokenItem.key_prefix ?? "-"}
										</div>
										<div class="text-sm text-stone-700">
											{formatDateTime(tokenItem.created_at)}
										</div>
										<div class="flex flex-wrap gap-2">
											<button
												class="h-9 rounded-full border border-stone-200 bg-stone-100 px-3 text-xs font-semibold text-stone-900 transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onReveal(tokenItem.id)}
											>
												复制
											</button>
											<button
												class="h-9 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onEdit(tokenItem)}
											>
												编辑
											</button>
											<button
												class="h-9 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onToggle(tokenItem.id, tokenItem.status)}
											>
												切换
											</button>
											<button
												class="h-9 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
												type="button"
												onClick={() => onDelete(tokenItem.id)}
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
					{pagedTokens.length === 0 ? (
						<div class="px-4 py-10 text-center text-sm text-stone-500 rounded-xl border border-stone-200">
							暂无令牌，请先创建。
						</div>
					) : (
						pagedTokens.map((tokenItem) => {
							const isActive = tokenItem.status === "active";
							return (
								<div
									class="rounded-xl border border-stone-200 bg-white p-4"
									key={tokenItem.id}
								>
									<div class="flex items-start justify-between gap-2">
										<div class="min-w-0 flex-1">
											<span class="truncate font-semibold text-stone-900 text-sm block">
												{tokenItem.name}
											</span>
											<span class="text-xs text-stone-500 mt-0.5 block">
												{tokenItem.key_prefix ?? "-"}
											</span>
										</div>
										<div class="flex shrink-0 flex-col items-end gap-1">
											<span
												class={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
													isActive
														? "border-emerald-100 bg-emerald-50 text-emerald-600"
														: "border-stone-200 bg-stone-100 text-stone-500"
												}`}
											>
												{isActive ? "启用" : "禁用"}
											</span>
											{renderTokenExpiry(tokenItem)}
										</div>
									</div>
									<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
										{tokenItem.user_name && (
											<span>
												用户:{" "}
												<span class="font-semibold text-stone-700">
													{tokenItem.user_name}
												</span>
											</span>
										)}
										<span>
											额度:{" "}
											<span class="font-semibold text-stone-700">
												{tokenItem.quota_used} / {tokenItem.quota_total ?? "∞"}
											</span>
										</span>
										<span>
											模型:{" "}
											<span class="font-semibold text-stone-700">
												{(tokenItem.allowed_models?.length ?? 0) > 0
													? `${tokenItem.allowed_models?.length} 个模型`
													: "全部"}
											</span>
										</span>
										<span>{formatDateTime(tokenItem.created_at)}</span>
									</div>
									<div class="mt-3 flex flex-wrap gap-2">
										<button
											class="h-10 rounded-full border border-stone-200 bg-stone-100 px-3 text-xs font-semibold text-stone-900 transition-shadow duration-200 hover:shadow-lg"
											type="button"
											onClick={() => onReveal(tokenItem.id)}
										>
											复制
										</button>
										<button
											class="h-10 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[color,background-color,border-color,box-shadow] duration-200 hover:text-stone-900 hover:shadow-lg"
											type="button"
											onClick={() => onEdit(tokenItem)}
										>
											编辑
										</button>
										<button
											class="h-10 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 transition-[color,background-color,border-color,box-shadow] duration-200 hover:text-stone-900 hover:shadow-lg"
											type="button"
											onClick={() => onToggle(tokenItem.id, tokenItem.status)}
										>
											切换
										</button>
										<button
											class="h-10 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-500 transition-[color,background-color,border-color,box-shadow] duration-200 hover:text-stone-900 hover:shadow-lg"
											type="button"
											onClick={() => onDelete(tokenItem.id)}
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
							共 {tokenTotal} 条 · {tokenTotalPages} 页
						</span>
						<button
							class="h-10 w-10 md:h-8 md:w-8 rounded-full border border-stone-200 bg-white text-xs font-semibold text-stone-600 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
							type="button"
							disabled={tokenPage <= 1}
							onClick={() => onPageChange(Math.max(1, tokenPage - 1))}
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
										item === tokenPage
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
							disabled={tokenPage >= tokenTotalPages}
							onClick={() =>
								onPageChange(Math.min(tokenTotalPages, tokenPage + 1))
							}
						>
							&gt;
						</button>
					</div>
					<label class="flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs text-stone-500">
						每页条数
						<select
							class="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs text-stone-700 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							value={tokenPageSize}
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
				isOpen={isTokenModalOpen}
				onClose={onCloseModal}
				sheet
				panelClass="w-full max-w-xl rounded-t-2xl md:rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl"
			>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
							生成令牌
						</h3>
						<p class="text-xs text-stone-500">创建后可在列表中查看与管理。</p>
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
							for="token-name"
						>
							名称
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="token-name"
							name="name"
							required
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="token-quota"
						>
							额度（可选）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="token-quota"
							name="quota_total"
							type="number"
							min="0"
							placeholder="留空表示无限"
						/>
					</div>
					<TokenExpiryPicker
						idPrefix="token-create"
						value={tokenCreateExpiresAt}
						onChange={onTokenCreateExpiresAtChange}
					/>
					<ModelAllowlistPicker
						label="模型白名单"
						emptyHint="未选择 = 不限制，可调用全部可用模型"
						selected={createSelectedModels}
						onChange={onCreateModelsChange}
						fetchCandidates={onFetchModelCandidates}
					/>
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
							生成令牌
						</button>
					</div>
				</form>
			</Modal>

			{/* Edit token modal */}
			<Modal
				isOpen={editingToken !== null}
				onClose={onCloseEditModal}
				sheet
				panelClass="w-full max-w-xl rounded-t-2xl md:rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl"
			>
				{/* onClose 同步置空 editingToken,closing 动画期间内容须 guard 空引用(先例 UsersView) */}
				{editingToken && (
					<>
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div>
								<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
									编辑令牌
								</h3>
								<p class="text-xs text-stone-500">
									修改名称、额度与模型白名单。
								</p>
							</div>
							<button
								class="h-10 md:h-9 rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
								type="button"
								onClick={onCloseEditModal}
							>
								关闭
							</button>
						</div>
						<form class="mt-4 grid gap-3.5" onSubmit={onEditSubmit}>
							<div>
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="token-edit-name"
								>
									名称
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="token-edit-name"
									name="name"
									type="text"
									required
									value={tokenForm.name}
									onInput={(e) =>
										onTokenFormChange({
											name: (e.currentTarget as HTMLInputElement)?.value ?? "",
										})
									}
								/>
							</div>
							<div class="grid gap-3.5 sm:grid-cols-2">
								<div>
									<label
										class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
										for="token-edit-quota-total"
									>
										额度总额
									</label>
									<input
										class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
										id="token-edit-quota-total"
										type="number"
										min="0"
										placeholder="留空表示无限"
										value={tokenForm.quota_total}
										onInput={(e) =>
											onTokenFormChange({
												quota_total:
													(e.currentTarget as HTMLInputElement)?.value ?? "",
											})
										}
									/>
								</div>
								<div>
									<label
										class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
										for="token-edit-quota-used"
									>
										已用额度
									</label>
									<input
										class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
										id="token-edit-quota-used"
										type="number"
										min="0"
										placeholder="清空提交即归零"
										value={tokenForm.quota_used}
										onInput={(e) =>
											onTokenFormChange({
												quota_used:
													(e.currentTarget as HTMLInputElement)?.value ?? "",
											})
										}
									/>
								</div>
							</div>
							<TokenExpiryPicker
								idPrefix="token-edit"
								value={tokenForm.expires_at}
								onChange={(next) => onTokenFormChange({ expires_at: next })}
							/>
							<ModelAllowlistPicker
								label="模型白名单"
								emptyHint="未选择 = 不限制，可调用全部可用模型"
								selected={new Set(tokenForm.allowed_models)}
								onChange={(next) =>
									onTokenFormChange({ allowed_models: [...next] })
								}
								fetchCandidates={onFetchModelCandidates}
								initialModels={editingToken.allowed_models ?? []}
							/>
							<div class="flex flex-wrap items-center justify-end gap-2 pt-2">
								<button
									class="h-10 rounded-full border border-stone-200 bg-stone-50 px-4 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
									type="button"
									onClick={onCloseEditModal}
								>
									取消
								</button>
								<button
									class="h-10 rounded-full bg-stone-900 px-5 text-xs font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
									type="submit"
								>
									保存
								</button>
							</div>
						</form>
					</>
				)}
			</Modal>
		</div>
	);
};
