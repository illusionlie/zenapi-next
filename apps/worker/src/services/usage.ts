import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "../utils/time";
import { pruneUsageLogsBatched, retentionCutoffIso } from "./usage-stats";

export type UsageInput = {
	tokenId?: string | null;
	channelId?: string | null;
	model?: string | null;
	requestPath?: string | null;
	totalTokens?: number | null;
	promptTokens?: number | null;
	completionTokens?: number | null;
	cachedInputTokens?: number | null;
	cacheCreationTokens?: number | null;
	cost?: number | null;
	userId?: string | null;
	latencyMs?: number | null;
	firstTokenLatencyMs?: number | null;
	stream?: boolean | number | null;
	reasoningEffort?: string | number | null;
	status?: string | null;
	errorCode?: number | null;
	errorMessage?: string | null;
	/** 8-hex fingerprint of the serving (ok) / last-attempted (error) key. */
	keyTag?: string | null;
};

/** Max batch attempts: the initial call plus exactly one delayed retry. */
const BILLING_BATCH_MAX_ATTEMPTS = 2;
const BILLING_RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inserts a usage record and settles billing (token quota + user balance) in a
 * single D1 batch, which executes atomically: a mid-batch failure rolls back
 * everything, so there is never a "logged but not billed" intermediate state.
 *
 * A failed batch is retried once after `opts.retryDelayMs` (default 250ms):
 * D1 transient hiccups (overloaded / dropped connection) make up most batch
 * failures, and because the failed batch rolled back entirely, replaying the
 * same statements carries no half-state risk. The success path pays zero
 * extra latency — exactly one batch call, no delay.
 */
export async function recordUsage(
	db: D1Database,
	input: UsageInput,
	opts: { retryDelayMs?: number } = {},
): Promise<void> {
	const id = crypto.randomUUID();
	const createdAt = nowIso();
	const streamValue =
		input.stream === null || input.stream === undefined
			? null
			: typeof input.stream === "number"
				? input.stream
				: input.stream
					? 1
					: 0;
	const reasoningValue =
		input.reasoningEffort === null || input.reasoningEffort === undefined
			? null
			: String(input.reasoningEffort);
	const statements = [
		db
			.prepare(
				"INSERT INTO usage_logs (id, token_id, channel_id, model, request_path, total_tokens, prompt_tokens, completion_tokens, cached_input_tokens, cache_creation_tokens, cost, latency_ms, first_token_latency_ms, stream, reasoning_effort, status, error_code, error_message, key_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				id,
				input.tokenId ?? null,
				input.channelId ?? null,
				input.model ?? null,
				input.requestPath ?? null,
				input.totalTokens ?? 0,
				input.promptTokens ?? 0,
				input.completionTokens ?? 0,
				input.cachedInputTokens ?? null,
				input.cacheCreationTokens ?? null,
				input.cost ?? 0,
				input.latencyMs ?? 0,
				input.firstTokenLatencyMs ?? null,
				streamValue,
				reasoningValue,
				input.status ?? "ok",
				input.errorCode ?? null,
				input.errorMessage ?? null,
				input.keyTag ?? null,
				createdAt,
			),
	];

	if (input.tokenId && input.totalTokens) {
		statements.push(
			db
				.prepare(
					"UPDATE tokens SET quota_used = quota_used + ?, updated_at = ? WHERE id = ?",
				)
				.bind(input.totalTokens, createdAt, input.tokenId),
		);
	}
	if (input.userId && (input.cost ?? 0) > 0) {
		// MAX(0, …) clamps in SQL: the balance never goes negative even under
		// concurrent deductions (decided 2026-10-19). usage_logs.cost still
		// records the real cost; the difference (cost − actual deduction) only
		// appears on low-balance edges and is auditable against usage_logs.
		statements.push(
			db
				.prepare(
					"UPDATE users SET balance = MAX(0, balance - ?), updated_at = ? WHERE id = ?",
				)
				.bind(input.cost, createdAt, input.userId),
		);
	}

	const retryDelayMs = opts.retryDelayMs ?? BILLING_RETRY_DELAY_MS;
	let attempts = 0;
	let lastError: unknown = null;
	while (attempts < BILLING_BATCH_MAX_ATTEMPTS) {
		if (attempts > 0) {
			await delay(retryDelayMs);
		}
		attempts += 1;
		try {
			await db.batch(statements);
			return;
		} catch (e) {
			lastError = e;
		}
	}
	// Billing is a post-response epilogue: the upstream response already
	// succeeded, so rethrowing cannot help the client. But it must stay
	// visible — log with context instead of swallowing silently. The payload
	// carries the full accounting shape (model / channel / tokens / status)
	// so a Logpush-sink failure line can rebuild the lost stats row offline.
	console.error("[usage] billing batch failed", {
		tokenId: input.tokenId,
		userId: input.userId,
		cost: input.cost,
		model: input.model,
		channelId: input.channelId,
		requestPath: input.requestPath,
		promptTokens: input.promptTokens,
		completionTokens: input.completionTokens,
		totalTokens: input.totalTokens,
		status: input.status,
		attempts,
		error: String(lastError),
	});
}

/**
 * Deletes usage logs older than the retention window, in bounded batches
 * (delegates to pruneUsageLogsBatched — the old single-statement DELETE could
 * hit the D1 per-statement time limit on large tables). Returns the deleted
 * row count; a tripped round fuse leaves the rest to the next call.
 */
export async function pruneUsageLogs(
	db: D1Database,
	retentionDays: number,
): Promise<number> {
	const { deleted } = await pruneUsageLogsBatched(
		db,
		retentionCutoffIso(new Date(), retentionDays),
	);
	return deleted;
}
