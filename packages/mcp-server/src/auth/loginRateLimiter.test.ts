import { describe, it, expect } from "vitest";
import { LoginRateLimiter } from "./loginRateLimiter.js";

const IP = "203.0.113.7";

describe("LoginRateLimiter", () => {
	it("allows attempts under the ceiling and blocks once it is reached", () => {
		const limiter = new LoginRateLimiter({ maxAttempts: 3, windowMs: 1000 });
		const t0 = 1000;
		expect(limiter.check(IP, t0).blocked).toBe(false);
		limiter.recordFailure(IP, t0);
		limiter.recordFailure(IP, t0);
		expect(limiter.check(IP, t0).blocked).toBe(false);
		limiter.recordFailure(IP, t0); // 3rd failure hits the ceiling
		const blocked = limiter.check(IP, t0);
		expect(blocked.blocked).toBe(true);
		expect(blocked.retryAfterSec).toBe(1);
	});

	it("rolls the window off after windowMs and starts fresh", () => {
		const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });
		const t0 = 5000;
		limiter.recordFailure(IP, t0);
		limiter.recordFailure(IP, t0);
		expect(limiter.check(IP, t0).blocked).toBe(true);
		// Past the window: the entry is forgotten.
		expect(limiter.check(IP, t0 + 1000).blocked).toBe(false);
	});

	it("recordSuccess clears the counter", () => {
		const limiter = new LoginRateLimiter({ maxAttempts: 2, windowMs: 1000 });
		const t0 = 0;
		limiter.recordFailure(IP, t0);
		limiter.recordFailure(IP, t0);
		expect(limiter.check(IP, t0).blocked).toBe(true);
		limiter.recordSuccess(IP);
		expect(limiter.check(IP, t0).blocked).toBe(false);
	});

	it("tracks IPs independently", () => {
		const limiter = new LoginRateLimiter({ maxAttempts: 1, windowMs: 1000 });
		const t0 = 0;
		limiter.recordFailure("10.0.0.1", t0);
		expect(limiter.check("10.0.0.1", t0).blocked).toBe(true);
		expect(limiter.check("10.0.0.2", t0).blocked).toBe(false);
	});

	it("evicts the oldest entry when the tracked-IP cap is reached", () => {
		const limiter = new LoginRateLimiter({
			maxAttempts: 1,
			windowMs: 100_000,
			maxTrackedIps: 2,
		});
		limiter.recordFailure("ip-a", 1000); // oldest
		limiter.recordFailure("ip-b", 2000);
		limiter.recordFailure("ip-c", 3000); // forces eviction of ip-a
		expect(limiter.check("ip-a", 3000).blocked).toBe(false); // evicted → fresh
		expect(limiter.check("ip-b", 3000).blocked).toBe(true);
		expect(limiter.check("ip-c", 3000).blocked).toBe(true);
	});
});
