import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { AppEnv, Bindings } from "./env";
import { adminAuth } from "./middleware/adminAuth";
import adminUserRoutes from "./routes/admin-users";
import anthropicProxyRoutes from "./routes/anthropic-proxy";
import authRoutes from "./routes/auth";
import channelRoutes from "./routes/channels";
import dashboardRoutes from "./routes/dashboard";
import inviteCodeRoutes from "./routes/invite-codes";
import modelAliasRoutes from "./routes/model-aliases";
import modelRoutes from "./routes/models";
import monitoringRoutes from "./routes/monitoring";
import newapiChannelRoutes from "./routes/newapiChannels";
import newapiGroupRoutes from "./routes/newapiGroups";
import newapiUserRoutes from "./routes/newapiUsers";
import playgroundRoutes from "./routes/playground";
import proxyRoutes from "./routes/proxy";
import publicRoutes from "./routes/public";
import rechargeRoutes from "./routes/recharge";
import settingsRoutes from "./routes/settings";
import tokenRoutes from "./routes/tokens";
import usageRoutes from "./routes/usage";
import userApiRoutes from "./routes/user-api";
import userAuthRoutes from "./routes/user-auth";
import { loadDebugLogFlag } from "./services/settings";
import { runDailyMaintenance } from "./services/usage-stats";

const app = new Hono<AppEnv>({ strict: false });

app.use("*", async (c, next) => {
	const method = c.req.method;
	const path = c.req.path;
	// Debug request body logging is OFF by default (P2): the default path logs
	// method/path only and never clones or parses the request body — no
	// double-parse / double-residency tax on large payloads. The
	// debug_request_body_log setting (or DEBUG_REQUEST_BODY_LOG env fallback)
	// restores the legacy full form. Flag-load failure degrades to the cheap
	// default (log less, never break the request).
	let debugBodyLog = false;
	if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		try {
			debugBodyLog = await loadDebugLogFlag(c.env.DB, {
				debugRequestLog: c.env.DEBUG_REQUEST_BODY_LOG,
			});
		} catch {
			debugBodyLog = false;
		}
	}
	if (debugBodyLog) {
		const contentType = c.req.header("content-type") ?? "";
		const raw = c.req.raw.clone();
		let bodyType = "unknown";
		let bodyKeys: string[] = [];
		let bodySize = 0;
		try {
			// Fetch spec: json() consumes the body internally (text → JSON.parse),
			// so a failed parse leaves nothing for a text() fallback on the same
			// clone — the old fallback was dead code and non-JSON bodies always
			// degraded to "unreadable". Read text once, then JSON.parse here:
			// non-JSON bodies (plain text / form) keep their body_size instead.
			const text = await raw.text();
			try {
				const payload = JSON.parse(text);
				bodyType = "json";
				if (payload && typeof payload === "object" && !Array.isArray(payload)) {
					bodyKeys = Object.keys(payload);
				}
			} catch {
				bodyType = "text";
				bodySize = text.length;
			}
		} catch {
			// The stream itself failed to read (rare) — nothing usable at all.
			bodyType = "unreadable";
		}
		console.log("[request]", {
			method,
			path,
			content_type: contentType,
			body_type: bodyType,
			body_keys: bodyKeys,
			body_size: bodySize,
		});
	} else {
		console.log("[request]", { method, path });
	}
	await next();
});

app.use("*", logger());
app.use(
	"/api/*",
	cors({
		origin: (_origin, c) => {
			const allowed = c.env.CORS_ORIGIN ?? "*";
			return allowed === "*"
				? "*"
				: allowed.split(",").map((item: string) => item.trim());
		},
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"x-api-key",
			"x-admin-token",
			"New-Api-User",
		],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);
app.use(
	"/v1/*",
	cors({
		origin: "*",
		allowHeaders: ["Content-Type", "Authorization", "x-api-key"],
		allowMethods: ["GET", "POST", "OPTIONS"],
	}),
);
app.use(
	"/anthropic/*",
	cors({
		origin: "*",
		allowHeaders: [
			"Content-Type",
			"Authorization",
			"x-api-key",
			"anthropic-version",
		],
		allowMethods: ["GET", "POST", "OPTIONS"],
	}),
);

app.use("/api/*", async (c, next) => {
	const p = c.req.path;
	if (
		p === "/api/auth/login" ||
		p === "/api/channel" ||
		p.startsWith("/api/channel/") ||
		p === "/api/user" ||
		p.startsWith("/api/user/") ||
		p === "/api/group" ||
		p.startsWith("/api/group/") ||
		p.startsWith("/api/public") ||
		p.startsWith("/api/u/") ||
		p.startsWith("/api/recharge")
	) {
		return next();
	}
	return adminAuth(c, next);
});

app.get("/health", (c) => c.json({ ok: true }));

app.route("/api/auth", authRoutes);
app.route("/api/channels", channelRoutes);
app.route("/api/models", modelRoutes);
app.route("/api/model-aliases", modelAliasRoutes);
app.route("/api/tokens", tokenRoutes);
app.route("/api/usage", usageRoutes);
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/monitoring", monitoringRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/invite-codes", inviteCodeRoutes);
app.route("/api/public", publicRoutes);
app.route("/api/channel", newapiChannelRoutes);
app.route("/api/user", newapiUserRoutes);
app.route("/api/group", newapiGroupRoutes);
app.route("/api/playground", playgroundRoutes);
app.route("/api/users", adminUserRoutes);
app.route("/api/u/auth", userAuthRoutes);
app.route("/api/u", userApiRoutes);
app.route("/api/recharge", rechargeRoutes);

app.route("/v1", proxyRoutes);
app.route("/anthropic/v1", anthropicProxyRoutes);

app.notFound(async (c) => {
	const path = c.req.path;
	if (
		path === "/api" ||
		path.startsWith("/api/") ||
		path === "/v1" ||
		path.startsWith("/v1/") ||
		path === "/anthropic" ||
		path.startsWith("/anthropic/")
	) {
		return c.json({ error: "Not Found" }, 404);
	}
	const assets = (
		c.env as { ASSETS?: { fetch: (input: Request) => Promise<Response> } }
	).ASSETS;
	if (!assets) {
		return c.text("Not Found", 404);
	}

	const res = await assets.fetch(c.req.raw);
	if (res.status !== 404) {
		return res;
	}

	const accept = c.req.header("accept") ?? "";
	const isHtml = accept.includes("text/html");
	const isFile = path.includes(".");
	if (!isHtml || isFile) {
		return res;
	}

	const url = new URL(c.req.url);
	url.pathname = "/index.html";
	return assets.fetch(new Request(url.toString(), c.req.raw));
});

/**
 * Daily cron handler (03:17 UTC, wrangler.toml [triggers]): rollup yesterday,
 * then batched prunes (raw logs / expired sessions / old rollups). Steps are
 * fault-isolated inside runDailyMaintenance. Direct await — a cron invocation
 * keeps the isolate alive for the whole chain (15-minute wall clock budget).
 */
const scheduled = (
	_event: ScheduledEvent,
	env: Bindings,
	_ctx: ExecutionContext,
): Promise<void> => runDailyMaintenance(env.DB);

export default {
	fetch: app.fetch,
	scheduled,
};
