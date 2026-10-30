import { useCallback, useEffect, useState } from "hono/jsx/dom";
import { createApiFetch } from "./core/api";
import { toast } from "./core/toast";
import type { RegistrationMode } from "./core/types";
import { BrandMark } from "./features/BrandMark";
import { UserLoginView } from "./features/UserLoginView";
import { UserRegisterView } from "./features/UserRegisterView";

const normalizePath = (path: string) => {
	if (path.length <= 1) return "/";
	return path.replace(/\/+$/, "") || "/";
};

type PublicAppProps = {
	onUserLogin: (token: string) => void;
	onNavigate: (path: string) => void;
	linuxdoEnabled: boolean;
	registrationMode: RegistrationMode;
	requireInviteCode: boolean;
	turnstileEnabled: boolean;
	turnstileSiteKey: string;
};

export const PublicApp = ({
	onUserLogin,
	onNavigate,
	linuxdoEnabled,
	registrationMode,
	requireInviteCode,
	turnstileEnabled,
	turnstileSiteKey,
}: PublicAppProps) => {
	const [page, setPage] = useState<"login" | "register">(() => {
		const normalized = normalizePath(window.location.pathname);
		if (normalized === "/register") return "register";
		return "login";
	});
	const [turnstileToken, setTurnstileToken] = useState("");
	const [turnstileResetSignal, setTurnstileResetSignal] = useState(0);

	const apiFetch = useCallback(() => createApiFetch(null, () => {}), []);

	useEffect(() => {
		const handlePopState = () => {
			const normalized = normalizePath(window.location.pathname);
			if (normalized === "/register") setPage("register");
			else setPage("login");
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	// Handle Linux DO OAuth callback
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const linuxdoToken = params.get("linuxdo_token");
		const linuxdoError = params.get("linuxdo_error");
		if (linuxdoToken) {
			// Clean up URL
			history.replaceState(null, "", "/login");
			onUserLogin(linuxdoToken);
		} else if (linuxdoError) {
			history.replaceState(null, "", "/login");
			const errorMessages: Record<string, string> = {
				missing_code_or_state: "授权失败：缺少授权码",
				missing_state_cookie: "授权失败：状态验证失败",
				state_mismatch: "授权失败：状态不匹配",
				token_exchange_failed: "授权失败：令牌交换失败",
				user_info_failed: "授权失败：获取用户信息失败",
				linuxdo_account_restricted: "授权失败：Linux DO 账号受限",
				user_disabled: "授权失败：用户已被禁用",
				registration_disabled: "授权失败：注册已关闭",
				invalid_invite_code: "授权失败：邀请码无效或已用完",
			};
			toast.error(errorMessages[linuxdoError] ?? `授权失败：${linuxdoError}`);
		}
	}, [onUserLogin]);

	const navigate = useCallback((target: "login" | "register") => {
		const paths = { login: "/login", register: "/register" };
		history.pushState(null, "", paths[target]);
		setPage(target);
	}, []);

	const handleLogin = useCallback(
		async (account: string, password: string, loginTurnstileToken: string) => {
			try {
				const api = apiFetch();
				const result = await api<{ token: string }>("/api/u/auth/login", {
					method: "POST",
					body: JSON.stringify({
						account,
						password,
						turnstile_token: loginTurnstileToken,
					}),
				});
				onUserLogin(result.token);
			} catch (error) {
				toast.error((error as Error).message);
				// token 一次性：任何提交失败都重置 widget 换取新 token
				setTurnstileResetSignal((signal) => signal + 1);
			}
		},
		[apiFetch, onUserLogin],
	);

	const handleRegister = useCallback(
		async (
			email: string,
			name: string,
			password: string,
			inviteCode?: string,
			registerTurnstileToken?: string,
		) => {
			try {
				const api = apiFetch();
				const result = await api<{ token: string }>("/api/u/auth/register", {
					method: "POST",
					body: JSON.stringify({
						email,
						name,
						password,
						invite_code: inviteCode,
						turnstile_token: registerTurnstileToken ?? "",
					}),
				});
				onUserLogin(result.token);
			} catch (error) {
				toast.error((error as Error).message);
				// token 一次性：任何提交失败都重置 widget 换取新 token
				setTurnstileResetSignal((signal) => signal + 1);
			}
		},
		[apiFetch, onUserLogin],
	);

	if (page === "register") {
		return (
			<div class="min-h-screen bg-linear-to-b from-white via-stone-50 to-stone-100 font-['IBM_Plex_Sans'] text-stone-900 antialiased">
				<nav class="border-b border-stone-200 bg-white px-6 py-3">
					<div class="mx-auto flex max-w-6xl items-center justify-between">
						<button
							type="button"
							class="font-['Space_Grotesk'] text-lg font-semibold tracking-tight text-stone-900"
							onClick={() => onNavigate("/")}
						>
							<BrandMark size="md" />
						</button>
						<div class="flex gap-3">
							<button
								type="button"
								class="rounded-lg px-4 py-2 text-sm text-stone-500 hover:text-stone-900"
								onClick={() => navigate("login")}
							>
								登录
							</button>
							<button
								type="button"
								class="rounded-lg px-4 py-2 text-sm text-stone-400 hover:text-stone-600"
								onClick={() => onNavigate("/admin")}
							>
								管理后台
							</button>
						</div>
					</div>
				</nav>
				<UserRegisterView
					onSubmit={handleRegister}
					onGoLogin={() => navigate("login")}
					onNavigate={onNavigate}
					linuxdoEnabled={linuxdoEnabled}
					registrationMode={registrationMode}
					requireInviteCode={requireInviteCode}
					turnstileEnabled={turnstileEnabled}
					turnstileSiteKey={turnstileSiteKey}
					turnstileToken={turnstileToken}
					onTurnstileToken={setTurnstileToken}
					turnstileResetSignal={turnstileResetSignal}
				/>
			</div>
		);
	}

	// Login page (default)
	return (
		<div class="min-h-screen bg-linear-to-b from-white via-stone-50 to-stone-100 font-['IBM_Plex_Sans'] text-stone-900 antialiased">
			<nav class="border-b border-stone-200 bg-white px-6 py-3">
				<div class="mx-auto flex max-w-6xl items-center justify-between">
					<button
						type="button"
						class="font-['Space_Grotesk'] text-lg font-semibold tracking-tight text-stone-900"
						onClick={() => onNavigate("/")}
					>
						<BrandMark size="md" />
					</button>
					<div class="flex gap-3">
						{registrationMode !== "closed" && (
							<button
								type="button"
								class="rounded-lg px-4 py-2 text-sm text-stone-500 hover:text-stone-900"
								onClick={() => navigate("register")}
							>
								注册
							</button>
						)}
						<button
							type="button"
							class="rounded-lg px-4 py-2 text-sm text-stone-400 hover:text-stone-600"
							onClick={() => onNavigate("/admin")}
						>
							管理后台
						</button>
					</div>
				</div>
			</nav>
			<UserLoginView
				onSubmit={handleLogin}
				onGoRegister={() => navigate("register")}
				onNavigate={onNavigate}
				linuxdoEnabled={linuxdoEnabled}
				registrationMode={registrationMode}
				requireInviteCode={requireInviteCode}
				turnstileEnabled={turnstileEnabled}
				turnstileSiteKey={turnstileSiteKey}
				turnstileToken={turnstileToken}
				onTurnstileToken={setTurnstileToken}
				turnstileResetSignal={turnstileResetSignal}
			/>
		</div>
	);
};
