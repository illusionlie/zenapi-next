import { Hono } from "hono";
import type { AppEnv } from "../env";
import { userAuth } from "../middleware/userAuth";
import {
	getLdcEpayGateway,
	getLdcEpayKey,
	getLdcEpayPid,
	getLdcExchangeRate,
	getLdcPaymentEnabled,
} from "../services/settings";
import { md5Hex } from "../utils/crypto";
import { jsonError } from "../utils/http";
import { nowIso } from "../utils/time";

const recharge = new Hono<AppEnv>();

/**
 * Generates the epay sign: sort non-empty params by key, join as k=v&, append key, MD5.
 */
function epaySign(params: Record<string, string>, key: string): string {
	const sorted = Object.keys(params)
		.filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "")
		.sort();
	const str = sorted.map((k) => `${k}=${params[k]}`).join("&");
	return md5Hex(str + key);
}

/**
 * POST /create — create a recharge order and redirect to LDC payment.
 */
recharge.post("/create", userAuth, async (c) => {
	const userId = c.get("userId") as string;
	const body = await c.req.json().catch(() => null);
	if (!body) {
		return jsonError(c, 400, "missing_body", "missing_body");
	}

	const ldcAmount = Number(body.ldc_amount);
	if (!ldcAmount || ldcAmount <= 0) {
		return jsonError(c, 400, "invalid_ldc_amount", "invalid_ldc_amount");
	}
	// Check ≤ 2 decimal places
	const parts = String(body.ldc_amount).split(".");
	if (parts.length > 1 && parts[1].length > 2) {
		return jsonError(c, 400, "invalid_ldc_amount", "ldc_amount_max_2_decimals");
	}

	const enabled = await getLdcPaymentEnabled(c.env.DB);
	if (!enabled) {
		return jsonError(c, 403, "ldc_payment_disabled", "ldc_payment_disabled");
	}

	const pid = await getLdcEpayPid(c.env.DB);
	const key = await getLdcEpayKey(c.env.DB);
	const gateway = await getLdcEpayGateway(c.env.DB);
	const exchangeRate = await getLdcExchangeRate(c.env.DB);

	if (!pid || !key) {
		return jsonError(
			c,
			500,
			"ldc_payment_not_configured",
			"ldc_payment_not_configured",
		);
	}

	const balanceAmount = Math.round(ldcAmount * exchangeRate * 100) / 100;
	const now = Date.now();
	const random = Math.random().toString(36).slice(2, 8);
	const outTradeNo = `ZEN-${now}-${random}`;
	const id = crypto.randomUUID();
	const nowStr = nowIso();

	await c.env.DB.prepare(
		"INSERT INTO recharge_orders (id, user_id, out_trade_no, ldc_amount, balance_amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
	)
		.bind(id, userId, outTradeNo, ldcAmount, balanceAmount, nowStr, nowStr)
		.run();

	// Build base URL for callbacks
	const reqUrl = new URL(c.req.url);
	const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
	const notifyUrl = `${baseUrl}/api/recharge/notify`;
	const returnUrl = `${baseUrl}/api/recharge/return?out_trade_no=${encodeURIComponent(outTradeNo)}`;

	const params: Record<string, string> = {
		pid,
		type: "epay",
		out_trade_no: outTradeNo,
		notify_url: notifyUrl,
		return_url: returnUrl,
		name: "ZenAPI Next 充值",
		money: ldcAmount.toFixed(2),
	};

	const sign = epaySign(params, key);
	params.sign = sign;
	params.sign_type = "MD5";

	// Submit to gateway
	try {
		const submitUrl = `${gateway.replace(/\/+$/, "")}/pay/submit.php`;
		const formBody = Object.entries(params)
			.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
			.join("&");

		const resp = await fetch(submitUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: formBody,
			redirect: "manual",
		});

		const location = resp.headers.get("Location");
		if (location) {
			return c.json({ order_id: id, redirect_url: location });
		}

		// Some gateways return 200 with HTML form or JSON
		if (resp.status >= 200 && resp.status < 400) {
			// Try to get redirect from response body (some gateways return it in JSON)
			const text = await resp.text();
			// Check if it's a URL directly
			if (text.startsWith("http")) {
				return c.json({ order_id: id, redirect_url: text.trim() });
			}
			// Build a GET URL with params as fallback
			const getUrl = `${submitUrl}?${formBody}`;
			return c.json({ order_id: id, redirect_url: getUrl });
		}

		return jsonError(c, 502, "gateway_error", "gateway_error");
	} catch {
		return jsonError(c, 502, "gateway_unreachable", "gateway_unreachable");
	}
});

/**
 * GET /notify — async callback from LDC gateway (public, no auth).
 */
recharge.get("/notify", async (c) => {
	const query = c.req.query();
	const key = await getLdcEpayKey(c.env.DB);

	if (!key) {
		return c.text("fail");
	}

	// Verify sign
	const receivedSign = query.sign ?? "";
	const paramsForSign: Record<string, string> = {};
	for (const [k, v] of Object.entries(query)) {
		if (k !== "sign" && k !== "sign_type" && v !== "") {
			paramsForSign[k] = v;
		}
	}
	const expectedSign = epaySign(paramsForSign, key);

	if (receivedSign !== expectedSign) {
		return c.text("fail");
	}

	if (query.trade_status !== "TRADE_SUCCESS") {
		return c.text("fail");
	}

	const outTradeNo = query.out_trade_no;
	if (!outTradeNo) {
		return c.text("fail");
	}

	const order = await c.env.DB.prepare(
		"SELECT id, user_id, balance_amount, status FROM recharge_orders WHERE out_trade_no = ?",
	)
		.bind(outTradeNo)
		.first<{
			id: string;
			user_id: string;
			balance_amount: number;
			status: string;
		}>();

	if (!order || order.status === "completed") {
		return c.text("success");
	}

	const now = nowIso();
	const tradeNo = query.trade_no ?? "";

	await c.env.DB.prepare(
		"UPDATE recharge_orders SET status = 'completed', trade_no = ?, updated_at = ? WHERE id = ?",
	)
		.bind(tradeNo, now, order.id)
		.run();

	await c.env.DB.prepare(
		"UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?",
	)
		.bind(order.balance_amount, now, order.user_id)
		.run();

	return c.text("success");
});

/**
 * GET /return — browser redirect landing after payment.
 */
recharge.get("/return", async (c) => {
	return c.redirect("/user?recharge=ok");
});

/**
 * GET /status/:id — check order status (user-authenticated).
 */
recharge.get("/status/:id", userAuth, async (c) => {
	const userId = c.get("userId") as string;
	const orderId = c.req.param("id");

	const order = await c.env.DB.prepare(
		"SELECT id, ldc_amount, balance_amount, status FROM recharge_orders WHERE id = ? AND user_id = ?",
	)
		.bind(orderId, userId)
		.first<{
			id: string;
			ldc_amount: number;
			balance_amount: number;
			status: string;
		}>();

	if (!order) {
		return jsonError(c, 404, "order_not_found", "order_not_found");
	}

	return c.json({
		status: order.status,
		ldc_amount: order.ldc_amount,
		balance_amount: order.balance_amount,
	});
});

/**
 * GET /orders — list recent orders (user-authenticated).
 */
recharge.get("/orders", userAuth, async (c) => {
	const userId = c.get("userId") as string;

	const result = await c.env.DB.prepare(
		"SELECT id, out_trade_no, ldc_amount, balance_amount, status, created_at FROM recharge_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
	)
		.bind(userId)
		.all();

	return c.json({ orders: result.results ?? [] });
});

export default recharge;
