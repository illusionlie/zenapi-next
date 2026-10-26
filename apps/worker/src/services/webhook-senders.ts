/**
 * Outbound webhook senders (design §3): one pure `sendWebhook` per the
 * unified `AlertMessage` structure — each platform adapter renders its own
 * payload shape, the message text itself is shared via `formatMessage`.
 * No retry queue: a failed send is a logged `{ ok: false }` result, the
 * alerting evaluator fans out with Promise.allSettled and moves on.
 */

/** The five supported webhook endpoint types (webhooks.type whitelist). */
export const WEBHOOK_TYPES = [
	"feishu",
	"wecom",
	"dingtalk",
	"slack",
	"generic",
] as const;

export type WebhookType = (typeof WEBHOOK_TYPES)[number];

export function isWebhookType(value: unknown): value is WebhookType {
	return (
		typeof value === "string" &&
		(WEBHOOK_TYPES as readonly string[]).includes(value)
	);
}

/** Single-send timeout — a dead notification endpoint must not stall the cron. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Unified outbound notification message. `lines` are plain text rows; each
 * adapter decides its own layout (text bots get the rendered string, generic
 * endpoints receive the structured object as-is).
 */
export type AlertMessage = {
	title: string;
	lines: string[];
	severity: "info" | "warning" | "critical";
	ts: string;
};

/**
 * Renders the message for the text-bot adapters: title, then each line, then
 * the timestamp footer.
 */
export function formatMessage(message: AlertMessage): string {
	return [message.title, ...message.lines, `时间: ${message.ts}`].join("\n");
}

export type SendResult = { ok: boolean; status?: number };

/**
 * Sends `message` to `url` using the payload shape of `type`. Unknown types
 * fail open (warn + `{ ok: false }`, nothing sent). Network errors and
 * non-2xx responses are both reported as `{ ok: false }` — never thrown, so
 * callers can treat the result as data.
 */
export async function sendWebhook(
	type: string,
	url: string,
	message: AlertMessage,
): Promise<SendResult> {
	if (!isWebhookType(type)) {
		console.warn("[alerts] unknown webhook type, skipping", { type });
		return { ok: false };
	}
	const text = formatMessage(message);
	let body: unknown;
	switch (type) {
		case "feishu":
			// 飞书自定义机器人：https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot
			body = { msg_type: "text", content: { text } };
			break;
		case "wecom":
			// 企业微信群机器人
			body = { msgtype: "text", text: { content: text } };
			break;
		case "dingtalk":
			// 钉钉群机器人（v1 不做加签）
			body = { msgtype: "text", text: { content: text } };
			break;
		case "slack":
			// Slack incoming webhook
			body = { text };
			break;
		case "generic":
			// Structured passthrough — the consumer owns the interpretation.
			body = message;
			break;
	}
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});
		return { ok: response.ok, status: response.status };
	} catch (e) {
		console.warn("[alerts] webhook send failed", {
			type,
			error: String(e),
		});
		return { ok: false };
	}
}
