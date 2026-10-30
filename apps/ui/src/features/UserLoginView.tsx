import { useState } from "hono/jsx/dom";
import type { RegistrationMode } from "../core/types";
import { BrandMark } from "./BrandMark";
import { Turnstile } from "./Turnstile";

type UserLoginViewProps = {
	onSubmit: (account: string, password: string, turnstileToken: string) => void;
	onGoRegister: () => void;
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

export const UserLoginView = ({
	onSubmit,
	onGoRegister,
	onNavigate,
	linuxdoEnabled,
	registrationMode,
	requireInviteCode,
	turnstileEnabled,
	turnstileSiteKey,
	turnstileToken,
	onTurnstileToken,
	turnstileResetSignal,
}: UserLoginViewProps) => {
	const [account, setAccount] = useState("");
	const [password, setPassword] = useState("");
	const [inviteCode, setInviteCode] = useState("");

	const handleSubmit = (e: Event) => {
		e.preventDefault();
		onSubmit(account, password, turnstileToken);
	};

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
				<p class="text-sm text-stone-500">登录您的账户。</p>
				<form class="mt-6 grid gap-4" onSubmit={handleSubmit}>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="user-account"
						>
							邮箱 / 用户名
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="user-account"
							type="text"
							required
							value={account}
							onInput={(e) =>
								setAccount((e.currentTarget as HTMLInputElement)?.value ?? "")
							}
						/>
					</div>
					<div>
						<label
							class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
							for="user-password"
						>
							密码
						</label>
						<input
							class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
							id="user-password"
							type="password"
							required
							value={password}
							onInput={(e) =>
								setPassword((e.currentTarget as HTMLInputElement)?.value ?? "")
							}
						/>
					</div>
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
						登录
					</button>
				</form>
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
						{requireInviteCode && (
							<div class="mb-3">
								<label
									class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
									for="login-invite"
								>
									邀请码（新用户注册需要）
								</label>
								<input
									class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
									id="login-invite"
									type="text"
									placeholder="已有账户可留空"
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
							使用 Linux DO 登录
						</button>
					</div>
				)}
				<p class="mt-4 text-center text-sm text-stone-500">
					{registrationMode !== "closed" && (
						<>
							没有账户？{" "}
							<button
								type="button"
								class="text-amber-600 hover:text-amber-700"
								onClick={onGoRegister}
							>
								注册
							</button>
						</>
					)}
				</p>
			</div>
		</div>
	);
};
