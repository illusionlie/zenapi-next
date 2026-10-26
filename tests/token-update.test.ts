import { describe, expect, it } from "vitest";
import {
	resolveExpiresAtValue,
	resolveTokenUpdate,
	resolveUserTokenUpdate,
} from "../apps/worker/src/services/token-update";
import type {
	ExistingToken,
	UserExistingToken,
} from "../apps/worker/src/services/token-update";

const existing: ExistingToken = {
	name: "old-name",
	quota_total: 100,
	quota_used: 20,
	status: "active",
	allowed_channels: '["ch1"]',
	allowed_models: '["gpt-4o"]',
	expires_at: "2099-01-01T00:00:00.000Z",
};

const valuesOf = (body: unknown) => {
	const result = resolveTokenUpdate(body, existing);
	if (!result.ok) {
		throw new Error(`expected ok, got error: ${result.error}`);
	}
	return result.values;
};

describe("resolveTokenUpdate", () => {
	describe("body validation", () => {
		it("rejects a non-object body with missing_body", () => {
			expect(resolveTokenUpdate(null, existing)).toEqual({
				ok: false,
				error: "missing_body",
			});
			expect(resolveTokenUpdate(undefined, existing)).toEqual({
				ok: false,
				error: "missing_body",
			});
			expect(resolveTokenUpdate("str", existing)).toEqual({
				ok: false,
				error: "missing_body",
			});
			expect(resolveTokenUpdate(42, existing)).toEqual({
				ok: false,
				error: "missing_body",
			});
			expect(resolveTokenUpdate([], existing)).toEqual({
				ok: false,
				error: "missing_body",
			});
		});
	});

	describe("undefined keeps existing values", () => {
		it("returns every existing value for an empty body", () => {
			expect(resolveTokenUpdate({}, existing)).toEqual({
				ok: true,
				values: { ...existing },
			});
		});

		it("keeps only the untouched fields on a partial update", () => {
			const values = valuesOf({ name: "new-name" });
			expect(values.name).toBe("new-name");
			expect(values.quota_total).toBe(100);
			expect(values.quota_used).toBe(20);
			expect(values.status).toBe("active");
			expect(values.allowed_channels).toBe('["ch1"]');
			expect(values.allowed_models).toBe('["gpt-4o"]');
			expect(values.expires_at).toBe("2099-01-01T00:00:00.000Z");
		});
	});

	describe("name", () => {
		it("keeps the existing name for undefined/null", () => {
			expect(valuesOf({}).name).toBe("old-name");
			expect(valuesOf({ name: null }).name).toBe("old-name");
		});

		it("sets a non-empty string name", () => {
			expect(valuesOf({ name: "new-name" }).name).toBe("new-name");
		});

		it("rejects empty / whitespace-only / non-string names", () => {
			expect(resolveTokenUpdate({ name: "" }, existing)).toEqual({
				ok: false,
				error: "invalid_name",
			});
			expect(resolveTokenUpdate({ name: "   " }, existing)).toEqual({
				ok: false,
				error: "invalid_name",
			});
			expect(resolveTokenUpdate({ name: 123 }, existing)).toEqual({
				ok: false,
				error: "invalid_name",
			});
		});
	});

	describe("quota_total", () => {
		it("keeps the existing value for undefined", () => {
			expect(valuesOf({}).quota_total).toBe(100);
		});

		it("clears to NULL (unlimited) for null", () => {
			expect(valuesOf({ quota_total: null }).quota_total).toBeNull();
		});

		it("sets a finite non-negative number", () => {
			expect(valuesOf({ quota_total: 0 }).quota_total).toBe(0);
			expect(valuesOf({ quota_total: 55.5 }).quota_total).toBe(55.5);
		});

		it("rejects negative / non-number / non-finite values", () => {
			expect(resolveTokenUpdate({ quota_total: -1 }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
			expect(resolveTokenUpdate({ quota_total: "50" }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
			expect(resolveTokenUpdate({ quota_total: NaN }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
			expect(resolveTokenUpdate({ quota_total: Infinity }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
		});
	});

	describe("quota_used", () => {
		it("keeps the existing value for undefined and null", () => {
			expect(valuesOf({}).quota_used).toBe(20);
			expect(valuesOf({ quota_used: null }).quota_used).toBe(20);
		});

		it("sets a non-negative integer (including zero)", () => {
			expect(valuesOf({ quota_used: 0 }).quota_used).toBe(0);
			expect(valuesOf({ quota_used: 5 }).quota_used).toBe(5);
		});

		it("rejects negative / fractional / non-number values", () => {
			expect(resolveTokenUpdate({ quota_used: -1 }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
			expect(resolveTokenUpdate({ quota_used: 1.5 }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
			expect(resolveTokenUpdate({ quota_used: "0" }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
			expect(resolveTokenUpdate({ quota_used: NaN }, existing)).toEqual({
				ok: false,
				error: "invalid_quota",
			});
		});
	});

	describe("status", () => {
		it("keeps the existing value for undefined and null", () => {
			expect(valuesOf({}).status).toBe("active");
			expect(valuesOf({ status: null }).status).toBe("active");
		});

		it("accepts active and disabled", () => {
			expect(valuesOf({ status: "disabled" }).status).toBe("disabled");
			expect(valuesOf({ status: "active" }).status).toBe("active");
		});

		it("rejects any other value", () => {
			expect(resolveTokenUpdate({ status: "paused" }, existing)).toEqual({
				ok: false,
				error: "invalid_status",
			});
			expect(resolveTokenUpdate({ status: 1 }, existing)).toEqual({
				ok: false,
				error: "invalid_status",
			});
		});
	});

	describe("allowed_channels", () => {
		it("keeps the existing value for undefined", () => {
			expect(valuesOf({}).allowed_channels).toBe('["ch1"]');
		});

		it("clears to NULL for null", () => {
			expect(valuesOf({ allowed_channels: null }).allowed_channels).toBeNull();
		});

		it("passes other values through JSON.stringify without interpretation", () => {
			expect(valuesOf({ allowed_channels: ["ch2"] }).allowed_channels).toBe(
				'["ch2"]',
			);
			expect(
				valuesOf({ allowed_channels: { m1: ["ch1"] } }).allowed_channels,
			).toBe('{"m1":["ch1"]}');
			expect(valuesOf({ allowed_channels: [] }).allowed_channels).toBe("[]");
		});
	});

	describe("allowed_models", () => {
		it("keeps the existing value for undefined", () => {
			expect(valuesOf({}).allowed_models).toBe('["gpt-4o"]');
		});

		it("clears to NULL (unrestricted) for null and []", () => {
			expect(valuesOf({ allowed_models: null }).allowed_models).toBeNull();
			expect(valuesOf({ allowed_models: [] }).allowed_models).toBeNull();
		});

		it("serializes a valid array of non-empty strings", () => {
			expect(valuesOf({ allowed_models: ["gpt-4o"] }).allowed_models).toBe(
				'["gpt-4o"]',
			);
			expect(
				valuesOf({ allowed_models: [" a ", "b"] }).allowed_models,
			).toBe('["a","b"]');
		});

		it("rejects non-arrays, non-string elements and whitespace-only elements", () => {
			expect(resolveTokenUpdate({ allowed_models: "gpt-4o" }, existing)).toEqual(
				{
					ok: false,
					error: "invalid_allowed_models",
				},
			);
			expect(resolveTokenUpdate({ allowed_models: [1] }, existing)).toEqual({
				ok: false,
				error: "invalid_allowed_models",
			});
			expect(
				resolveTokenUpdate({ allowed_models: ["gpt-4o", ""] }, existing),
			).toEqual({
				ok: false,
				error: "invalid_allowed_models",
			});
			expect(
				resolveTokenUpdate({ allowed_models: ["   "] }, existing),
			).toEqual({
				ok: false,
				error: "invalid_allowed_models",
			});
		});
	});

	describe("expires_at", () => {
		const futureIso = () => new Date(Date.now() + 3600_000).toISOString();
		const pastIso = () => new Date(Date.now() - 3600_000).toISOString();

		it("keeps the existing value for undefined", () => {
			expect(valuesOf({}).expires_at).toBe("2099-01-01T00:00:00.000Z");
		});

		it("clears to NULL (permanent) for null and empty string", () => {
			expect(valuesOf({ expires_at: null }).expires_at).toBeNull();
			expect(valuesOf({ expires_at: "" }).expires_at).toBeNull();
		});

		it("sets and normalizes a future ISO-8601 value", () => {
			const iso = futureIso();
			expect(valuesOf({ expires_at: iso }).expires_at).toBe(iso);
			// 归一化:无毫秒的合法 ISO 输入 → toISOString 存储不变量
			expect(valuesOf({ expires_at: "2099-06-01T08:00:00Z" }).expires_at).toBe(
				"2099-06-01T08:00:00.000Z",
			);
		});

		it("rejects past dates, garbage strings and non-strings", () => {
			expect(resolveTokenUpdate({ expires_at: pastIso() }, existing)).toEqual({
				ok: false,
				error: "invalid_expires_at",
			});
			expect(resolveTokenUpdate({ expires_at: "tomorrow" }, existing)).toEqual({
				ok: false,
				error: "invalid_expires_at",
			});
			expect(resolveTokenUpdate({ expires_at: 42 }, existing)).toEqual({
				ok: false,
				error: "invalid_expires_at",
			});
		});

		it("renewal path: an expired token PATCHed to the future yields a future value", () => {
			// 「已过期令牌续期」的 resolver 半段(tokenAuth 半段见 token-auth.test.ts)
			const expired: ExistingToken = { ...existing, expires_at: pastIso() };
			const result = resolveTokenUpdate({ expires_at: futureIso() }, expired);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(new Date(result.values.expires_at ?? 0).getTime()).toBeGreaterThan(
					Date.now(),
				);
			}
		});
	});

	describe("combined updates", () => {
		it("applies several valid fields in one pass", () => {
			const values = valuesOf({
				name: "renamed",
				quota_total: null,
				quota_used: 0,
				status: "disabled",
				allowed_channels: null,
				allowed_models: ["claude-sonnet-4"],
				expires_at: null,
			});
			expect(values).toEqual({
				name: "renamed",
				quota_total: null,
				quota_used: 0,
				status: "disabled",
				allowed_channels: null,
				allowed_models: '["claude-sonnet-4"]',
				expires_at: null,
			});
		});

		it("does not mutate the existing row", () => {
			valuesOf({ name: "renamed", quota_total: null, expires_at: null });
			expect(existing.quota_total).toBe(100);
			expect(existing.name).toBe("old-name");
			expect(existing.expires_at).toBe("2099-01-01T00:00:00.000Z");
		});
	});
});

const userExisting: UserExistingToken = {
	name: "old-name",
	status: "active",
	allowed_models: '["gpt-4o"]',
	expires_at: "2099-01-01T00:00:00.000Z",
};

const userValuesOf = (body: unknown) => {
	const result = resolveUserTokenUpdate(body, userExisting);
	if (!result.ok) {
		throw new Error(`expected ok, got error: ${result.error}`);
	}
	return result.values;
};

describe("resolveUserTokenUpdate", () => {
	describe("body validation", () => {
		it("rejects array and primitive bodies with missing_body", () => {
			expect(resolveUserTokenUpdate(null, userExisting)).toEqual({
				ok: false,
				error: "missing_body",
			});
			expect(resolveUserTokenUpdate(undefined, userExisting)).toEqual({
				ok: false,
				error: "missing_body",
			});
			expect(resolveUserTokenUpdate("str", userExisting)).toEqual({
				ok: false,
				error: "missing_body",
			});
			expect(resolveUserTokenUpdate([], userExisting)).toEqual({
				ok: false,
				error: "missing_body",
			});
		});
	});

	describe("undefined keeps existing values", () => {
		it("returns every existing value for an empty body", () => {
			expect(resolveUserTokenUpdate({}, userExisting)).toEqual({
				ok: true,
				values: { ...userExisting },
			});
		});
	});

	describe("name", () => {
		it("keeps the existing name for undefined/null", () => {
			expect(userValuesOf({}).name).toBe("old-name");
			expect(userValuesOf({ name: null }).name).toBe("old-name");
		});

		it("rejects empty / whitespace-only / non-string names", () => {
			expect(resolveUserTokenUpdate({ name: "" }, userExisting)).toEqual({
				ok: false,
				error: "invalid_name",
			});
			expect(resolveUserTokenUpdate({ name: "   " }, userExisting)).toEqual({
				ok: false,
				error: "invalid_name",
			});
			expect(resolveUserTokenUpdate({ name: 123 }, userExisting)).toEqual({
				ok: false,
				error: "invalid_name",
			});
		});
	});

	describe("status", () => {
		it("accepts active and disabled", () => {
			expect(userValuesOf({ status: "active" }).status).toBe("active");
			expect(userValuesOf({ status: "disabled" }).status).toBe("disabled");
		});

		it("keeps the existing status for undefined/null", () => {
			expect(userValuesOf({}).status).toBe("active");
			expect(userValuesOf({ status: null }).status).toBe("active");
		});

		it("rejects any other value", () => {
			expect(resolveUserTokenUpdate({ status: "enabled" }, userExisting)).toEqual({
				ok: false,
				error: "invalid_status",
			});
			expect(resolveUserTokenUpdate({ status: "paused" }, userExisting)).toEqual({
				ok: false,
				error: "invalid_status",
			});
			expect(resolveUserTokenUpdate({ status: 1 }, userExisting)).toEqual({
				ok: false,
				error: "invalid_status",
			});
		});
	});

	describe("allowed_models", () => {
		it("keeps the existing value for undefined", () => {
			expect(userValuesOf({}).allowed_models).toBe('["gpt-4o"]');
		});

		it("clears to NULL (unrestricted) for null", () => {
			expect(userValuesOf({ allowed_models: null }).allowed_models).toBeNull();
		});

		it("serializes a valid array of non-empty strings", () => {
			expect(userValuesOf({ allowed_models: ["m1"] }).allowed_models).toBe(
				'["m1"]',
			);
			expect(
				userValuesOf({ allowed_models: [" a ", "b"] }).allowed_models,
			).toBe('["a","b"]');
		});

		it("rejects non-arrays, non-string elements and whitespace-only elements", () => {
			expect(
				resolveUserTokenUpdate({ allowed_models: "gpt-4o" }, userExisting),
			).toEqual({
				ok: false,
				error: "invalid_allowed_models",
			});
			expect(resolveUserTokenUpdate({ allowed_models: [1] }, userExisting)).toEqual({
				ok: false,
				error: "invalid_allowed_models",
			});
			expect(
				resolveUserTokenUpdate({ allowed_models: ["m1", ""] }, userExisting),
			).toEqual({
				ok: false,
				error: "invalid_allowed_models",
			});
		});
	});

	describe("expires_at", () => {
		const futureIso = () => new Date(Date.now() + 3600_000).toISOString();
		const pastIso = () => new Date(Date.now() - 3600_000).toISOString();

		it("keeps the existing value for undefined", () => {
			expect(userValuesOf({}).expires_at).toBe("2099-01-01T00:00:00.000Z");
		});

		it("clears to NULL (permanent) for null and empty string", () => {
			expect(userValuesOf({ expires_at: null }).expires_at).toBeNull();
			expect(userValuesOf({ expires_at: "" }).expires_at).toBeNull();
		});

		it("sets and normalizes a future ISO value", () => {
			const iso = futureIso();
			expect(userValuesOf({ expires_at: iso }).expires_at).toBe(iso);
		});

		it("rejects past dates and non-strings", () => {
			expect(
				resolveUserTokenUpdate({ expires_at: pastIso() }, userExisting),
			).toEqual({ ok: false, error: "invalid_expires_at" });
			expect(
				resolveUserTokenUpdate({ expires_at: "soon" }, userExisting),
			).toEqual({ ok: false, error: "invalid_expires_at" });
			expect(
				resolveUserTokenUpdate({ expires_at: true }, userExisting),
			).toEqual({ ok: false, error: "invalid_expires_at" });
		});
	});

	describe("combined updates", () => {
		it("applies name, status, allowed_models and expires_at in one pass", () => {
			const values = userValuesOf({
				name: "renamed",
				status: "disabled",
				allowed_models: ["claude-sonnet-4"],
				expires_at: null,
			});
			expect(values).toEqual({
				name: "renamed",
				status: "disabled",
				allowed_models: '["claude-sonnet-4"]',
				expires_at: null,
			});
		});

		it("does not mutate the existing row", () => {
			userValuesOf({ name: "renamed", status: "disabled", expires_at: null });
			expect(userExisting.name).toBe("old-name");
			expect(userExisting.status).toBe("active");
			expect(userExisting.allowed_models).toBe('["gpt-4o"]');
			expect(userExisting.expires_at).toBe("2099-01-01T00:00:00.000Z");
		});
	});
});

describe("resolveExpiresAtValue (POST 创建语义的单一校验门)", () => {
	const futureIso = () => new Date(Date.now() + 3600_000).toISOString();
	const pastIso = () => new Date(Date.now() - 3600_000).toISOString();

	it("treats undefined / null / empty string as permanent (NULL)", () => {
		expect(resolveExpiresAtValue(undefined)).toEqual({ ok: true, value: null });
		expect(resolveExpiresAtValue(null)).toEqual({ ok: true, value: null });
		expect(resolveExpiresAtValue("")).toEqual({ ok: true, value: null });
	});

	it("accepts a future ISO value and normalizes it", () => {
		const iso = futureIso();
		expect(resolveExpiresAtValue(iso)).toEqual({ ok: true, value: iso });
		expect(resolveExpiresAtValue("2099-06-01T08:00:00Z")).toEqual({
			ok: true,
			value: "2099-06-01T08:00:00.000Z",
		});
	});

	it("rejects past dates, unparseable strings and non-strings", () => {
		expect(resolveExpiresAtValue(pastIso())).toEqual({
			ok: false,
			error: "invalid_expires_at",
		});
		expect(resolveExpiresAtValue("garbage")).toEqual({
			ok: false,
			error: "invalid_expires_at",
		});
		expect(resolveExpiresAtValue(42)).toEqual({
			ok: false,
			error: "invalid_expires_at",
		});
	});
});
