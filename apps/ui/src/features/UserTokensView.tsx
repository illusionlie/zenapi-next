import { useState } from "hono/jsx/dom";
import type { Token } from "../core/types";
import { buildPageItems, formatDateTime } from "../core/utils";
import { Modal } from "./Modal";
import { ModelAllowlistPicker } from "./ModelAllowlistPicker";
import { TokenExpiryPicker } from "./TokenExpiryPicker";
import { renderModelLimit, renderTokenExpiry } from "./TokensView";

type UserTokensViewProps = {
	pagedTokens: Token[];
	tokenPage: number;
	tokenPageSize: number;
	tokenTotal: number;
	tokenTotalPages: number;
	// 创建表单状态留在组件内,提交时回调 (name, allowedModels, expiresAt, rpmLimit);
	// expiresAt 为选择器解析后的 ISO(空串 = 永久);rpmLimit 空串 = 跟随全局默认
	onCreate: (
		name: string,
		allowedModels: string[],
		expiresAt: string,
		rpmLimit: string,
	) => void;
	onPageChange: (next: number) => void;
	onPageSizeChange: (next: number) => void;
	onToggle: (id: string, status: string) => void;
	onDelete: (id: string) => void;
	onReveal: (id: string) => void;
	editingToken: Token | null;
	onEdit: (token: Token) => void;
	onCloseEditModal: () => void;
	onEditSubmit: (data: {
		name: string;
		allowedModels: string[];
		expiresAt: string;
		rpmLimit: string;
	}) => void;
	onFetchModelCandidates: () => Promise<string[]>;
};

const pageSizeOptions = [10, 20, 50];

const tokenGridCols =
	"grid-cols-[minmax(0,1.2fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1.2fr)]";

/**
 * Renders the user-side tokens view (aligned with the admin TokensView).
 */
export const UserTokensView = ({
	pagedTokens,
	tokenPage,
	tokenPageSize,
	tokenTotal,
	tokenTotalPages,
	onCreate,
	onPageChange,
	onPageSizeChange,
	onToggle,
	onDelete,
	onReveal,
	editingToken,
	onEdit,
	onCloseEditModal,
	onEditSubmit,
	onFetchModelCandidates,
}: UserTokensViewProps) => {
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [tokenName, setTokenName] = useState("");
	const [createSelectedModels, setCreateSelectedModels] = useState<Set<string>>(
		() => new Set<string>(),
	);
	// 创建模态的有效期(选择器解析后的 ISO;空串 = 永久),随 resetModal 重置
	const [createExpiresAt, setCreateExpiresAt] = useState("");
	// 创建模态的 RPM 上限(空串 = 跟随全局默认),随 resetModal 重置
	const [createRpmLimit, setCreateRpmLimit] = useState("");
	const pageItems = buildPageItems(tokenPage, tokenTotalPages);

	const resetModal = () => {
		setShowCreateModal(false);
		setTokenName("");
		setCreateSelectedModels(new Set());
		setCreateExpiresAt("");
		setCreateRpmLimit("");
	};

	const openCreate = () => {
		setTokenName("");
		setCreateSelectedModels(new Set());
		setCreateExpiresAt("");
		setCreateRpmLimit("");
		setShowCreateModal(true);
	};

	const handleCreate = (e: Event) => {
		e.preventDefault();
		if (!tokenName.trim()) return;
		onCreate(
			tokenName.trim(),
			[...createSelectedModels],
			createExpiresAt,
			createRpmLimit,
		);
		resetModal();
	};

	return (
		<div class="rounded-2xl border border-stone-200 bg-white p-5 shadow-lg">
			<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
				<div class="flex items-center gap-3">
					<h3 class="font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						我的令牌
					</h3>
					<span class="rounded-full bg-stone-100 px-2.5 py-1 text-xs text-stone-500">
						{tokenTotal} 个
					</span>
				</div>
				<button
					class="h-10 md:h-9 rounded-full bg-stone-900 px-4 text-xs font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
					type="button"
					onClick={openCreate}
				>
					创建令牌
				</button>
			</div>

			{/* Desktop table */}
			<div class="mt-4 hidden md:block overflow-hidden rounded-xl border border-stone-200">
				<div
					class={`grid ${tokenGridCols} gap-3 bg-stone-50 px-4 py-3 text-xs uppercase tracking-widest text-stone-500`}
				>
					<div>名称</div>
					<div>前缀</div>
					<div>已用/额度</div>
					<div>模型限制</div>
					<div>状态</div>
					<div>创建时间</div>
					<div>操作</div>
				</div>
				{pagedTokens.length === 0 ? (
					<div class="px-4 py-10 text-center text-sm text-stone-500">
						暂无令牌，点击上方按钮创建。
					</div>
				) : (
					<div class="divide-y divide-stone-100">
						{pagedTokens.map((tokenItem) => {
							const isActive = tokenItem.status === "active";
							return (
								<div
									class={`grid ${tokenGridCols} items-center gap-3 px-4 py-4 text-sm`}
									key={tokenItem.id}
								>
									<div class="flex min-w-0 flex-col">
										<span class="truncate font-semibold text-stone-900">
											{tokenItem.name}
										</span>
									</div>
									<div class="text-sm text-stone-700">
										{tokenItem.key_prefix ?? "-"}
									</div>
									<div class="text-sm font-semibold text-stone-700">
										{tokenItem.quota_used} / {tokenItem.quota_total ?? "∞"}
									</div>
									<div>{renderModelLimit(tokenItem)}</div>
									<div class="flex flex-col items-start gap-1">
										<span
											class={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${
												isActive
													? "border-emerald-100 bg-emerald-50 text-emerald-600"
													: "border-stone-200 bg-stone-100 text-stone-500"
											}`}
										>
											{isActive ? "启用" : "停用"}
										</span>
										{renderTokenExpiry(tokenItem)}
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
											{isActive ? "停用" : "启用"}
										</button>
										<button
											class="h-9 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-red-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-red-600 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
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
			<div class="mt-4 space-y-3 md:hidden">
				{pagedTokens.length === 0 ? (
					<div class="rounded-xl border border-stone-200 px-4 py-10 text-center text-sm text-stone-500">
						暂无令牌，点击上方按钮创建。
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
										<span class="block truncate text-sm font-semibold text-stone-900">
											{tokenItem.name}
										</span>
										<span class="mt-0.5 block text-xs text-stone-500">
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
											{isActive ? "启用" : "停用"}
										</span>
										{renderTokenExpiry(tokenItem)}
									</div>
								</div>
								<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
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
										{isActive ? "停用" : "启用"}
									</button>
									<button
										class="h-10 rounded-full border border-stone-200 bg-white px-3 text-xs font-semibold text-red-500 transition-[color,background-color,border-color,box-shadow] duration-200 hover:text-red-600 hover:shadow-lg"
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

			{/* Pagination */}
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

			{/* Create token modal */}
			<Modal
				isOpen={showCreateModal}
				onClose={resetModal}
				sheet
				panelClass="w-full max-w-xl rounded-t-2xl md:rounded-2xl border border-stone-200 bg-white p-6 shadow-2xl"
			>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div>
						<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
							创建令牌
						</h3>
						<p class="text-xs text-stone-500">创建后可在列表中查看与管理。</p>
					</div>
					<button
						class="h-10 md:h-9 rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
						type="button"
						onClick={resetModal}
					>
						关闭
					</button>
				</div>
				<form class="mt-4 grid gap-3.5" onSubmit={handleCreate}>
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
							type="text"
							required
							value={tokenName}
							onInput={(e) =>
								setTokenName((e.currentTarget as HTMLInputElement)?.value ?? "")
							}
						/>
					</div>
					<TokenExpiryPicker
						idPrefix="user-token-create"
						value={createExpiresAt}
						onChange={setCreateExpiresAt}
					/>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="user-token-rpm-limit"
						>
							RPM 上限（可选）
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="user-token-rpm-limit"
							type="number"
							min="0"
							placeholder="留空 = 跟随全局默认，0 = 不限"
							value={createRpmLimit}
							onInput={(e) =>
								setCreateRpmLimit(
									(e.currentTarget as HTMLInputElement)?.value ?? "",
								)
							}
						/>
						<p class="mt-1 text-xs text-stone-500">
							每分钟请求上限：留空 = 跟随全局默认，0 = 显式不限，正整数 =
							每分钟上限。
						</p>
					</div>
					<ModelAllowlistPicker
						label="模型白名单"
						emptyHint="未选择 = 不限制，可调用全部可用模型"
						selected={createSelectedModels}
						onChange={setCreateSelectedModels}
						fetchCandidates={onFetchModelCandidates}
					/>
					<div class="flex flex-wrap items-center justify-end gap-2 pt-2">
						<button
							class="h-10 rounded-full border border-stone-200 bg-stone-50 px-4 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
							type="button"
							onClick={resetModal}
						>
							取消
						</button>
						<button
							class="h-10 rounded-full bg-stone-900 px-5 text-xs font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
							type="submit"
						>
							创建令牌
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
				{/* onClose 同步置空 editingToken,closing 动画期间内容须 guard 空引用(先例 UsersView);
				    内层表单以条件挂载 + useState 初值实现「打开时重置」(先例 ModelsView) */}
				{editingToken && (
					<EditTokenForm
						key={editingToken.id}
						token={editingToken}
						fetchCandidates={onFetchModelCandidates}
						onCancel={onCloseEditModal}
						onSubmit={onEditSubmit}
					/>
				)}
			</Modal>
		</div>
	);
};

type EditTokenFormProps = {
	token: Token;
	fetchCandidates: () => Promise<string[]>;
	onCancel: () => void;
	onSubmit: (data: {
		name: string;
		allowedModels: string[];
		expiresAt: string;
		rpmLimit: string;
	}) => void;
};

/** 编辑令牌表单:名称 + 模型白名单 + 有效期 + RPM 上限,无任何额度字段(额度仅管理员可改) */
const EditTokenForm = ({
	token,
	fetchCandidates,
	onCancel,
	onSubmit,
}: EditTokenFormProps) => {
	const [name, setName] = useState(token.name);
	const [selectedModels, setSelectedModels] = useState<Set<string>>(
		() => new Set(token.allowed_models ?? []),
	);
	// 有效期(选择器解析后的 ISO;空串 = 永久),回填现值(含已过期时刻 → 可改期续约)
	const [expiresAt, setExpiresAt] = useState(token.expires_at ?? "");
	// RPM 上限回填现值;NULL → 空 = 跟随全局默认
	const [rpmLimit, setRpmLimit] = useState(
		token.rpm_limit == null ? "" : String(token.rpm_limit),
	);

	const handleSubmit = (e: Event) => {
		e.preventDefault();
		onSubmit({
			name: name.trim(),
			allowedModels: [...selectedModels],
			expiresAt,
			rpmLimit,
		});
	};

	return (
		<>
			<div class="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 class="mb-1 font-['Space_Grotesk'] text-lg tracking-tight text-stone-900">
						编辑令牌
					</h3>
					<p class="text-xs text-stone-500">修改名称、有效期与模型白名单。</p>
				</div>
				<button
					class="h-10 md:h-9 rounded-full border border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
					type="button"
					onClick={onCancel}
				>
					关闭
				</button>
			</div>
			<form class="mt-4 grid gap-3.5" onSubmit={handleSubmit}>
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
						type="text"
						required
						value={name}
						onInput={(e) =>
							setName((e.currentTarget as HTMLInputElement)?.value ?? "")
						}
					/>
				</div>
				<TokenExpiryPicker
					idPrefix="user-token-edit"
					value={expiresAt}
					onChange={setExpiresAt}
				/>
				<div>
					<label
						class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
						for="user-token-edit-rpm-limit"
					>
						RPM 上限（可选）
					</label>
					<input
						class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
						id="user-token-edit-rpm-limit"
						type="number"
						min="0"
						placeholder="留空 = 跟随全局默认，0 = 不限"
						value={rpmLimit}
						onInput={(e) =>
							setRpmLimit((e.currentTarget as HTMLInputElement)?.value ?? "")
						}
					/>
					<p class="mt-1 text-xs text-stone-500">
						每分钟请求上限：留空 = 跟随全局默认，0 = 显式不限，正整数 =
						每分钟上限。
					</p>
				</div>
				<ModelAllowlistPicker
					label="模型白名单"
					emptyHint="未选择 = 不限制，可调用全部可用模型"
					selected={selectedModels}
					onChange={setSelectedModels}
					fetchCandidates={fetchCandidates}
					initialModels={token.allowed_models ?? []}
				/>
				<div class="flex flex-wrap items-center justify-end gap-2 pt-2">
					<button
						class="h-10 rounded-full border border-stone-200 bg-stone-50 px-4 text-xs font-semibold text-stone-500 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:text-stone-900 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
						type="button"
						onClick={onCancel}
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
	);
};
