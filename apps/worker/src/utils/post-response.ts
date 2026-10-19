type ExecutionContextLike = {
	waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * Runs a post-response task (usage recording, billing) without blocking the
 * response. When a Workers ExecutionContext is available the task is handed
 * to `waitUntil`; otherwise it degrades to fire-and-forget with console.error
 * logging (same semantics as the streaming usage path).
 *
 * Hono's `c.executionCtx` is a getter that THROWS outside the Workers runtime
 * (vitest, some Node setups) — it must be accessed inside try/catch, never
 * through a type-asserted optional chain (quality-guidelines gotcha).
 */
export function runPostResponse(
	c: unknown,
	task: () => Promise<unknown>,
): void {
	let executionCtx: ExecutionContextLike | null = null;
	try {
		executionCtx =
			(c as { executionCtx?: ExecutionContextLike | undefined }).executionCtx ??
			null;
	} catch {
		executionCtx = null;
	}
	if (executionCtx?.waitUntil) {
		executionCtx.waitUntil(task());
	} else {
		task().catch((e) => {
			console.error("[post-response] background task failed", String(e));
		});
	}
}
