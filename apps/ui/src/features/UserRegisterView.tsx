import { useState } from "hono/jsx/dom";
import type { RegistrationMode } from "../core/types";
import { BrandMark } from "./BrandMark";
import { Turnstile } from "./Turnstile";

type UserRegisterViewProps = {
	onSubmit: (
		email: string,
		name: string,
		password: string,
		inviteCode?: string,
		turnstileToken?: string,
	) => void;
	onGoLogin: () => void;
	onNavigate: (path: string) => void;
	linuxdoEnabled: boolean;
	registrationMode: RegistrationMode;
	requireInviteCode: boolean;
	turnstileEnabled: boolean;
	turnstileSiteKey: string;
	turnstileToken: string;
	onTurnstileToken: (token: string) => void;
	turnstileResetSignal: number;
};

export const UserRegisterView = ({
	onSubmit,
	onGoLogin,
	onNavigate,
	linuxdoEnabled,
	registrationMode,
	requireInviteCode,
	turnstileEnabled,
	turnstileSiteKey,
	turnstileToken,
	onTurnstileToken,
	turnstileResetSignal,
}: UserRegisterViewProps) => {
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [inviteCode, setInviteCode] = useState("");
	const [error, setError] = useState("");

	const handleSubmit = (e: Event) => {
		e.preventDefault();
		setError("");
		if (password.length < 6) {
			setError("密码至少 6 个字符");
			return;
		}
		if (password !== confirmPassword) {
			setError("两次密码不一致");
			return;
		}
		if (requireInviteCode && !inviteCode.trim()) {
			setError("请输入邀请码");
			return;
		}
		onSubmit(
			email,
			name,
			password,
			inviteCode.trim() || undefined,
			turnstileToken,
		);
	};

	if (registrationMode === "closed") {
		return (
			<div class="mx-auto flex min-h-[calc(100vh-57px)] items-center justify-center px-4 py-8">
				<div class="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-8 shadow-lg">
					<button
						type="button"
						class="mb-2 font-['Space_Grotesk'] text-2xl tracking-tight text-stone-900"
						onClick={() => onNavigate("/")}
					>
						<BrandMark size="lg" />
					</button>
					<p class="text-sm text-stone-500">注册已关闭，暂不接受新用户注册。</p>
					<p class="mt-4 text-center text-sm text-stone-500">
						已有账户？{" "}
						<button
							type="button"
							class="text-amber-600 hover:text-amber-700"
							onClick={onGoLogin}
						>
							登录
						</button>
					</p>
				</div>
			</div>
		);
	}

	if (registrationMode === "linuxdo_only") {
		return (
			<div class="mx-auto flex min-h-[calc(100vh-57px)] items-center justify-center px-4 py-8">
				<div class="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-8 shadow-lg">
					<button
						type="button"
						class="mb-2 font-['Space_Grotesk'] text-2xl tracking-tight text-stone-900"
						onClick={() => onNavigate("/")}
					>
						<BrandMark size="lg" />
					</button>
					<p class="text-sm text-stone-500">仅支持通过 Linux DO 注册。</p>
					{linuxdoEnabled && (
						<div class="mt-6">
							{requireInviteCode && (
								<div class="mb-4">
									<label
										class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
										for="reg-invite-ldo"
									>
										邀请码
									</label>
									<input
										class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
										id="reg-invite-ldo"
										type="text"
										placeholder="请输入邀请码"
										value={inviteCode}
										onInput={(e) =>
											setInviteCode(
												(e.currentTarget as HTMLInputElement)?.value ?? "",
											)
										}
									/>
								</div>
							)}
							<button
								type="button"
								class="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-sm font-semibold text-stone-700 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md"
								onClick={() => {
									const url =
										requireInviteCode && inviteCode.trim()
											? `/api/u/auth/linuxdo?invite_code=${encodeURIComponent(inviteCode.trim())}`
											: "/api/u/auth/linuxdo";
									window.location.href = url;
								}}
							>
								<svg
									class="h-5 w-5"
									viewBox="0 0 24 24"
									fill="none"
									xmlns="http://www.w3.org/2000/svg"
									aria-hidden="true"
								>
									<path
										d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"
										fill="currentColor"
									/>
								</svg>
								使用 Linux DO 注册
							</button>
						</div>
					)}
					<p class="mt-4 text-center text-sm text-stone-500">
						已有账户？{" "}
						<button
							type="button"
							class="text-amber-600 hover:text-amber-700"
							onClick={onGoLogin}
						>
							登录
						</button>
					</p>
				</div>
			</div>
		);
	}

	return (
		<div class="mx-auto flex min-h-[calc(100vh-57px)] items-center justify-center px-4 py-8">
			<div class="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-8 shadow-lg">
				<button
					type="button"
					class="mb-2 font-['Space_Grotesk'] text-2xl tracking-tight text-stone-900"
					onClick={() => onNavigate("/")}
				>
					<BrandMark size="lg" />
				</button>
				<p class="text-sm text-stone-500">创建新账户。</p>
				<form class="mt-6 grid gap-4" onSubmit={handleSubmit}>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="reg-email"
						>
							邮箱
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="reg-email"
							type="email"
							required
							value={email}
							onInput={(e) =>
								setEmail((e.currentTarget as HTMLInputElement)?.value ?? "")
							}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="reg-name"
						>
							用户名
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="reg-name"
							type="text"
							required
							value={name}
							onInput={(e) =>
								setName((e.currentTarget as HTMLInputElement)?.value ?? "")
							}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="reg-password"
						>
							密码
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="reg-password"
							type="password"
							required
							value={password}
							onInput={(e) =>
								setPassword((e.currentTarget as HTMLInputElement)?.value ?? "")
							}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="reg-confirm"
						>
							确认密码
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="reg-confirm"
							type="password"
							required
							value={confirmPassword}
							onInput={(e) =>
								setConfirmPassword(
									(e.currentTarget as HTMLInputElement)?.value ?? "",
								)
							}
						/>
					</div>
					{requireInviteCode && (
						<div>
							<label
								class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
								for="reg-invite"
							>
								邀请码
							</label>
							<input
								class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
								id="reg-invite"
								type="text"
								required
								placeholder="请输入邀请码"
								value={inviteCode}
								onInput={(e) =>
									setInviteCode(
										(e.currentTarget as HTMLInputElement)?.value ?? "",
									)
								}
							/>
						</div>
					)}
					{turnstileEnabled && turnstileSiteKey && (
						<Turnstile
							siteKey={turnstileSiteKey}
							onToken={onTurnstileToken}
							resetSignal={turnstileResetSignal}
						/>
					)}
					<button
						class="h-11 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg"
						type="submit"
					>
						注册
					</button>
				</form>
				{error && (
					<div class="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
						{error}
					</div>
				)}
				{linuxdoEnabled && (
					<div class="mt-4">
						<div class="relative my-3">
							<div class="absolute inset-0 flex items-center">
								<div class="w-full border-t border-stone-200" />
							</div>
							<div class="relative flex justify-center text-xs">
								<span class="bg-white px-2 text-stone-400">或</span>
							</div>
						</div>
						<button
							type="button"
							class="flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-stone-200 bg-white px-4 py-2.5 text-sm font-semibold text-stone-700 transition-[transform,box-shadow,color,background-color,border-color] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md"
							onClick={() => {
								const url =
									requireInviteCode && inviteCode.trim()
										? `/api/u/auth/linuxdo?invite_code=${encodeURIComponent(inviteCode.trim())}`
										: "/api/u/auth/linuxdo";
								window.location.href = url;
							}}
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								xmlns="http://www.w3.org/2000/svg"
								aria-hidden="true"
							>
								<path
									d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"
									fill="currentColor"
								/>
							</svg>
							使用 Linux DO 登录
						</button>
					</div>
				)}
				<p class="mt-4 text-center text-sm text-stone-500">
					已有账户？{" "}
					<button
						type="button"
						class="text-amber-600 hover:text-amber-700"
						onClick={onGoLogin}
					>
						登录
					</button>
				</p>
			</div>
		</div>
	);
};
