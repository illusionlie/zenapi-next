import { afterEach, describe, expect, it, vi } from "vitest";
import { runPostResponse } from "../apps/worker/src/utils/post-response";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Flushes the fire-and-forget branch's microtask + timer chain. */
function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("runPostResponse", () => {
	it("hands the task to executionCtx.waitUntil when available", async () => {
		const waited: Array<Promise<unknown>> = [];
		const c = {
			executionCtx: {
				waitUntil: (p: Promise<unknown>) => {
					waited.push(p);
				},
			},
		};
		let ran = false;

		runPostResponse(c, async () => {
			ran = true;
		});

		expect(waited).toHaveLength(1);
		await waited[0];
		expect(ran).toBe(true);
	});

	it("degrades to fire-and-forget when executionCtx is missing", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let ran = false;

		runPostResponse({}, async () => {
			ran = true;
		});
		await flush();

		expect(ran).toBe(true);
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("logs and survives a rejecting task in the degraded branch", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		runPostResponse(undefined, async () => {
			throw new Error("billing write boom");
		});
		await flush();

		expect(errSpy).toHaveBeenCalledTimes(1);
		const [label, detail] = errSpy.mock.calls[0] as [string, unknown];
		expect(label).toBe("[post-response] background task failed");
		expect(String(detail)).toContain("billing write boom");
	});

	it("treats a throwing executionCtx getter (Hono outside Workers) as missing", async () => {
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// Hono's c.executionCtx getter throws when no ExecutionContext exists;
		// the helper must catch instead of failing the request path.
		const c = Object.defineProperty({}, "executionCtx", {
			get() {
				throw new Error("execution context not found");
			},
		});
		let ran = false;

		runPostResponse(c, async () => {
			ran = true;
		});
		await flush();

		expect(ran).toBe(true);
		expect(errSpy).not.toHaveBeenCalled();
	});

	it("falls back to fire-and-forget when executionCtx lacks waitUntil", async () => {
		let ran = false;

		runPostResponse(
			{ executionCtx: {} },
			async () => {
				ran = true;
			},
		);
		await flush();

		expect(ran).toBe(true);
	});
});
