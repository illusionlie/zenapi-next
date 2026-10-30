import { BrandMark } from "./BrandMark";
import { Turnstile } from "./Turnstile";

type LoginViewProps = {
	onSubmit: (event: Event) => void;
	onNavigate: (path: string) => void;
	/** site-info 未到达、Turnstile 状态未知（FR6 时序） */
	turnstilePending: boolean;
	turnstileEnabled: boolean;
	turnstileSiteKey: string;
	turnstileToken: string;
	onTurnstileToken: (token: string) => void;
	turnstileResetSignal: number;
};

/**
 * Renders the admin login view.
 *
 * Args:
 *   props: Login view props.
 *
 * Returns:
 *   Login JSX element.
 */
export const LoginView = ({
	onSubmit,
	onNavigate,
	turnstilePending,
	turnstileEnabled,
	turnstileSiteKey,
	turnstileToken,
	onTurnstileToken,
	turnstileResetSignal,
}: LoginViewProps) => {
	const submitDisabled =
		turnstilePending || (turnstileEnabled && turnstileToken === "");
	return (
		<div class="mx-auto mt-24 max-w-md rounded-2xl border border-stone-200 bg-white p-8 shadow-lg">
			<button
				type="button"
				class="mb-2 font-['Space_Grotesk'] text-2xl tracking-tight text-stone-900"
				onClick={() => onNavigate("/")}
			>
				<BrandMark size="lg" />
			</button>
			<p class="text-sm text-stone-500">请输入管理员密码登录管理台。</p>
			<form class="mt-6 grid gap-4" onSubmit={onSubmit}>
				<div>
					<label
						class="mb-1.5 block text-xs uppercase tracking-widest text-stone-500"
						for="password"
					>
						管理员密码
					</label>
					<input
						class="w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-900 placeholder:text-stone-400 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200"
						id="password"
						name="password"
						type="password"
						required
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
					class="h-11 rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white transition-[transform,box-shadow] duration-200 ease-smooth-out hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-60"
					disabled={submitDisabled}
					type="submit"
				>
					登录
				</button>
			</form>
		</div>
	);
};
