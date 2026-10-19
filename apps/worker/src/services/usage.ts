import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "../utils/time";
import { pruneUsageLogsBatched } from "./usage-stats";

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
};

/**
 * Inserts a usage record and settles billing (token quota + user balance) in a
 * single D1 batch, which executes atomically: a mid-batch failure rolls back
 * everything, so there is never a "logged but not billed" intermediate state.
 */
export async function recordUsage(
	db: D1Database,
	input: UsageInput,
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
				"INSERT INTO usage_logs (id, token_id, channel_id, model, request_path, total_tokens, prompt_tokens, completion_tokens, cached_input_tokens, cache_creation_tokens, cost, latency_ms, first_token_latency_ms, stream, reasoning_effort, status, error_code, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

	try {
		await db.batch(statements);
	} catch (e) {
		// Billing is a post-response epilogue: the upstream response already
		// succeeded, so rethrowing cannot help the client. But it must stay
		// visible — log with context instead of swallowing silently.
		console.error("[usage] billing batch failed", {
			tokenId: input.tokenId,
			userId: input.userId,
			cost: input.cost,
			error: String(e),
		});
	}
}

/**
 * Deletes usage logs older than the retention window, in bounded batches
 * (delegates to pruneUsageLogsBatched — the old single-statement DELETE could
 * hit the D1 per-statement time limit on large tables).
 */
export async function pruneUsageLogs(
	db: D1Database,
	retentionDays: number,
): Promise<number> {
	const cutoff = new Date();
	cutoff.setDate(cutoff.getDate() - retentionDays);
	return pruneUsageLogsBatched(db, cutoff.toISOString());
}
