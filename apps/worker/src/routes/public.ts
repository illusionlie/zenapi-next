import { Hono } from "hono";
import type { AppEnv } from "../env";
import { extractModelPricings } from "../services/channel-models";
import { listActiveChannels } from "../services/channel-repo";
import { loadAllChannelAliasesGrouped } from "../services/model-aliases";
import {
	getAnnouncement,
	getLdcPaymentEnabled,
	getRegistrationMode,
	getRequireInviteCode,
	getTurnstileConfig,
} from "../services/settings";
import { isTurnstileEnforced } from "../services/turnstile";

const publicRoutes = new Hono<AppEnv>();

/**
 * Lightweight site info endpoint — always accessible.
 */
publicRoutes.get("/site-info", async (c) => {
	const registrationMode = await getRegistrationMode(c.env.DB);
	const linuxdoEnabled = Boolean(c.env.LINUXDO_CLIENT_ID);
	const requireInviteCode = await getRequireInviteCode(c.env.DB);
	const ldcPaymentEnabled = await getLdcPaymentEnabled(c.env.DB);
	const announcement = await getAnnouncement(c.env.DB);
	const turnstileConfig = await getTurnstileConfig(c.env.DB);
	const turnstileEnabled = isTurnstileEnforced(
		turnstileConfig,
		c.env.TURNSTILE_DISABLED,
	);
	return c.json({
		registration_mode: registrationMode,
		linuxdo_enabled: linuxdoEnabled,
		require_invite_code: requireInviteCode,
		ldc_payment_enabled: ldcPaymentEnabled,
		announcement,
		// 有效启用判定（含 TURNSTILE_DISABLED 与键完整性）；secret 永不下发
		turnstile_enabled: turnstileEnabled,
		turnstile_site_key: turnstileEnabled ? turnstileConfig.siteKey : "",
	});
});

/**
 * Public models endpoint — show models with prices and channel names.
 */
publicRoutes.get("/models", async (c) => {
	const channels = await listActiveChannels(c.env.DB);

	// Load alias data
	const aliasGroups = await loadAllChannelAliasesGrouped(c.env.DB);

	// Compute effective mapping
	type ChannelEntry = {
		id: string;
		name: string;
		input_price: number | null;
		output_price: number | null;
		cache_read_price: number | null;
		cache_write_price: number | null;
	};
	const effectiveMap = new Map<
		string,
		{ channels: Map<string, ChannelEntry> }
	>();

	for (const channel of channels) {
		const pricings = extractModelPricings(channel);
		const chAliases = aliasGroups.get(channel.id);

		for (const p of pricings) {
			const aliasInfo = chAliases?.get(p.id);
			const isAliasOnly = aliasInfo?.alias_only ?? false;
			const chInfo: ChannelEntry = {
				id: channel.id,
				name: channel.name,
				input_price: p.input_price ?? null,
				output_price: p.output_price ?? null,
				cache_read_price: p.cache_read_price ?? null,
				cache_write_price: p.cache_write_price ?? null,
			};

			// Original name (unless alias_only)
			if (!isAliasOnly) {
				let entry = effectiveMap.get(p.id);
				if (!entry) {
					entry = { channels: new Map() };
					effectiveMap.set(p.id, entry);
				}
				entry.channels.set(channel.id, chInfo);
			}

			// Alias names
			if (aliasInfo) {
				for (const alias of aliasInfo.aliases) {
					let entry = effectiveMap.get(alias);
					if (!entry) {
						entry = { channels: new Map() };
						effectiveMap.set(alias, entry);
					}
					entry.channels.set(channel.id, chInfo);
				}
			}
		}
	}

	const models: Array<{ id: string; channels: ChannelEntry[] }> = [];
	for (const [callableName, entry] of effectiveMap) {
		models.push({
			id: callableName,
			channels: Array.from(entry.channels.values()),
		});
	}

	return c.json({ models });
});

export default publicRoutes;
