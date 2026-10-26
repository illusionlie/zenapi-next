import { beforeEach, describe, expect, it } from "vitest";
import {
	checkTokenRpm,
	hasTokenRpmRequests,
	ipAuthFailureCount,
	ipThrottleRetryAfterSec,
	isIpThrottled,
	noteTokenRpmArrival,
	RATE_LIMIT_WINDOW_MS,
	recordIpAuthFailure,
	resetRateLimiterState,
} from "../apps/worker/src/services/rate-limiter";

/**
 * 滑动窗原语直测（design.md §8）：全部 now 注入（确定性锚点，禁 fake-timer
 * 依赖执行耗时）。窗口边界取严格语义：ts > now - 60_000 存活，恰好 60s 视为
 * 过期（t0 记录在 now = t0 + 60_000 时已出窗）。
 */

const T0 = 1_700_000_000_000; // 任意固定 epoch 锚点

beforeEach(() => {
	resetRateLimiterState();
});

describe("checkTokenRpm - sliding window boundaries", () => {
	it("allows exactly limit arrivals per window, denies the limit+1-th", () => {
		expect(checkTokenRpm("tok", 3, T0)).toEqual({ allowed: true, retryAfterSec: 0 });
		expect(checkTokenRpm("tok", 3, T0 + 1)).toEqual({ allowed: true, retryAfterSec: 0 });
		expect(checkTokenRpm("tok", 3, T0 + 2)).toEqual({ allowed: true, retryAfterSec: 0 });
		expect(checkTokenRpm("tok", 3, T0 + 3)).toEqual({
			allowed: false,
			retryAfterSec: 60, // oldest = T0 → 剩余整窗
		});
	});

	it("window slides: entries age out strictly past the 60s boundary", () => {
		checkTokenRpm("tok", 2, T0);
		checkTokenRpm("tok", 2, T0 + 1);
		expect(checkTokenRpm("tok", 2, T0 + 30_000).allowed).toBe(false);

		// T0 恰好过期（ts <= cutoff 出窗），T0+1 仍占窗 → 只剩 1 个 → 放行 + 记账
		expect(checkTokenRpm("tok", 2, T0 + RATE_LIMIT_WINDOW_MS).allowed).toBe(
			true,
		);
		// 同一时刻再查：窗口已满 [T0+1, T0+60_000] → 拒绝，Retry-After 锚定
		// T0+1（剩余 1ms → ceil 1s）
		expect(checkTokenRpm("tok", 2, T0 + RATE_LIMIT_WINDOW_MS)).toEqual({
			allowed: false,
			retryAfterSec: 1,
		});
	});

	it("allows also count as arrivals (rate-of-arrival, not success rate)", () => {
		// limit 1：第一次 allowed 记账后，同窗第二次即被拒
		expect(checkTokenRpm("tok", 1, T0).allowed).toBe(true);
		expect(checkTokenRpm("tok", 1, T0).allowed).toBe(false);
	});

	it("denied requests do not occupy the window", () => {
		checkTokenRpm("tok", 1, T0); // allowed, window = [T0]
		// 连续三次拒绝：窗口不增长，Retry-After 始终锚定 T0（剩余 60-i 秒）
		for (let i = 1; i <= 3; i++) {
			expect(checkTokenRpm("tok", 1, T0 + i * 1000)).toEqual({
				allowed: false,
				retryAfterSec: 60 - i,
			});
		}
		// 窗口内仍只有 1 条：限制放宽到 2 立即放行（拒绝没占窗）
		expect(checkTokenRpm("tok", 2, T0 + 4_000).allowed).toBe(true);
	});

	it("retryAfterSec = ceil(window remainder), floored at 1s", () => {
		checkTokenRpm("tok", 1, T0);
		// 剩余 50_000ms → 50
		expect(checkTokenRpm("tok", 1, T0 + 10_000).retryAfterSec).toBe(50);
		// 剩余 1ms → ceil(0.001) = 1
		expect(checkTokenRpm("tok", 1, T0 + 59_999).retryAfterSec).toBe(1);
		// 剩余恰好 0 不会出现（该时间戳已出窗 → 放行），防御性下限由 min 1 保证
		expect(checkTokenRpm("tok", 1, T0 + 59_999).allowed).toBe(false);
		expect(checkTokenRpm("tok", 1, T0 + 60_000).allowed).toBe(true);
	});

	it("limit <= 0 (off) is always allowed and records nothing", () => {
		expect(checkTokenRpm("tok", 0, T0)).toEqual({ allowed: true, retryAfterSec: 0 });
		expect(checkTokenRpm("tok", -5, T0)).toEqual({ allowed: true, retryAfterSec: 0 });
		expect(checkTokenRpm("tok", Number.NaN, T0).allowed).toBe(true);
		expect(hasTokenRpmRequests("tok", T0)).toBe(false);
	});

	it("keys are independent (per-token windows)", () => {
		checkTokenRpm("tok-a", 1, T0);
		expect(checkTokenRpm("tok-b", 1, T0).allowed).toBe(true);
		expect(checkTokenRpm("tok-a", 1, T0).allowed).toBe(false);
	});
});

describe("hasTokenRpmRequests / noteTokenRpmArrival (lazy-settings helpers)", () => {
	it("peek on an unknown token is false and stays read-only", () => {
		for (let i = 0; i < 5; i++) {
			expect(hasTokenRpmRequests("fresh", T0)).toBe(false);
		}
	});

	it("noteTokenRpmArrival records an arrival that a later check can deny on", () => {
		noteTokenRpmArrival("tok", T0);
		expect(hasTokenRpmRequests("tok", T0 + 1)).toBe(true);
		// 窗口已有 1 条：limit 1 的检查立即拒绝（记账与判定共用同一窗口）
		expect(checkTokenRpm("tok", 1, T0 + 1).allowed).toBe(false);
	});

	it("noted arrivals age out of the window like checked ones", () => {
		noteTokenRpmArrival("tok", T0);
		expect(hasTokenRpmRequests("tok", T0 + RATE_LIMIT_WINDOW_MS)).toBe(false);
	});
});

describe("IP auth failure throttle", () => {
	it("records failures and throttles at count >= limit", () => {
		expect(isIpThrottled("1.2.3.4", 3, T0)).toBe(false);
		recordIpAuthFailure("1.2.3.4", T0);
		recordIpAuthFailure("1.2.3.4", T0 + 100);
		expect(isIpThrottled("1.2.3.4", 3, T0 + 200)).toBe(false);
		recordIpAuthFailure("1.2.3.4", T0 + 200);
		expect(isIpThrottled("1.2.3.4", 3, T0 + 300)).toBe(true);
	});

	it("count peek is read-only for unknown IPs", () => {
		for (let i = 0; i < 5; i++) {
			expect(ipAuthFailureCount("9.9.9.9", T0)).toBe(0);
		}
		expect(isIpThrottled("9.9.9.9", 1, T0)).toBe(false);
	});

	it("limit <= 0 (off) never throttles regardless of failures", () => {
		for (let i = 0; i < 10; i++) {
			recordIpAuthFailure("1.2.3.4", T0 + i);
		}
		expect(isIpThrottled("1.2.3.4", 0, T0 + 100)).toBe(false);
		expect(isIpThrottled("1.2.3.4", -1, T0 + 100)).toBe(false);
	});

	it("failures age out: the window slides and the throttle lifts", () => {
		for (let i = 0; i < 5; i++) {
			recordIpAuthFailure("1.2.3.4", T0 + i * 1_000);
		}
		expect(isIpThrottled("1.2.3.4", 5, T0 + 5_000)).toBe(true);
		// T0 失败出窗（恰好 60s），窗口剩 4 条 < 5 → 解除
		expect(isIpThrottled("1.2.3.4", 5, T0 + RATE_LIMIT_WINDOW_MS)).toBe(
			false,
		);
		expect(ipAuthFailureCount("1.2.3.4", T0 + RATE_LIMIT_WINDOW_MS)).toBe(4);
	});

	it("ipThrottleRetryAfterSec anchors on the oldest in-window failure", () => {
		recordIpAuthFailure("1.2.3.4", T0);
		recordIpAuthFailure("1.2.3.4", T0 + 500);
		expect(ipThrottleRetryAfterSec("1.2.3.4", T0 + 1_000)).toBe(59); // 锚定 T0
		// 无记录 / 窗口已空 → 0
		expect(ipThrottleRetryAfterSec("8.8.8.8", T0)).toBe(0);
		expect(
			ipThrottleRetryAfterSec("1.2.3.4", T0 + RATE_LIMIT_WINDOW_MS + 500),
		).toBe(0);
	});

	it("IPs are independent", () => {
		recordIpAuthFailure("1.1.1.1", T0);
		expect(ipAuthFailureCount("2.2.2.2", T0)).toBe(0);
	});
});

describe("map sweep (anti-bloat guard)", () => {
	it("sweeps fully-expired keys once size exceeds the cap", () => {
		// 10_001 个 token 在 T0 各记一笔（插入途中触发清扫，但窗口全新鲜 → 无可删）
		for (let i = 0; i <= 10_000; i++) {
			noteTokenRpmArrival(`tok-${i}`, T0);
		}
		expect(hasTokenRpmRequests("tok-0", T0 + 1)).toBe(true);

		// 全部过期后再 touch 一个新键 → 全量清扫回收过期键
		const later = T0 + RATE_LIMIT_WINDOW_MS + 1;
		noteTokenRpmArrival("tok-new", later);
		expect(hasTokenRpmRequests("tok-0", later)).toBe(false);
		expect(hasTokenRpmRequests("tok-10_000", later)).toBe(false);
		expect(hasTokenRpmRequests("tok-new", later)).toBe(true);
	});

	it("sweep keeps keys with live windows", () => {
		noteTokenRpmArrival("old-but-live", T0 + 30_000);
		for (let i = 0; i <= 10_000; i++) {
			noteTokenRpmArrival(`expired-${i}`, T0);
		}
		noteTokenRpmArrival("trigger", T0 + RATE_LIMIT_WINDOW_MS + 1);
		// T0+30_000 仍在窗（存活于 T0+60_001 时刻：cutoff = 1，ts=30_000 > 1）
		expect(hasTokenRpmRequests("old-but-live", T0 + RATE_LIMIT_WINDOW_MS + 1)).toBe(
			true,
		);
		expect(hasTokenRpmRequests("expired-0", T0 + RATE_LIMIT_WINDOW_MS + 1)).toBe(
			false,
		);
	});
});

describe("resetRateLimiterState", () => {
	it("clears both domains", () => {
		noteTokenRpmArrival("tok", T0);
		recordIpAuthFailure("1.2.3.4", T0);
		resetRateLimiterState();
		expect(hasTokenRpmRequests("tok", T0 + 1)).toBe(false);
		expect(ipAuthFailureCount("1.2.3.4", T0 + 1)).toBe(0);
	});
});
