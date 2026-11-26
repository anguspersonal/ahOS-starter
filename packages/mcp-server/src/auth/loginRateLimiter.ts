/**
 * Brute-force throttle for the single-owner login gate (`/owner-login`).
 *
 * The whole endpoint's security rests on one shared password, and it is designed to be
 * reachable from anywhere — so an unbounded guess rate is the dominant risk. This is a
 * small in-memory, per-IP limiter: every failed attempt counts toward a window, and once
 * the ceiling is hit the IP is locked out until the window rolls off. Successful logins
 * clear the counter so a legitimate owner who fat-fingers the password a few times isn't
 * stuck behind their own lockout after getting it right.
 *
 * In-memory is deliberate and sufficient for a single-owner server on one instance: there
 * is no horizontal scale-out to share state across (one Railway service), and a process
 * restart resetting the counters is an acceptable trade for zero external dependencies.
 * If this ever runs multi-instance, swap the Map for a shared store (Redis/Postgres).
 */
export type RateLimiterOptions = {
	/** Failed attempts allowed within the window before lockout. */
	maxAttempts?: number;
	/** Rolling window over which failures accumulate (ms). */
	windowMs?: number;
	/** Cap on tracked IPs, so a spray of distinct source IPs can't grow the Map unbounded. */
	maxTrackedIps?: number;
};

type Attempt = { count: number; firstAt: number };

const DEFAULTS = {
	maxAttempts: 5,
	windowMs: 15 * 60 * 1000, // 15 minutes
	maxTrackedIps: 10_000,
};

export class LoginRateLimiter {
	private readonly attempts = new Map<string, Attempt>();
	private readonly maxAttempts: number;
	private readonly windowMs: number;
	private readonly maxTrackedIps: number;

	constructor(opts: RateLimiterOptions = {}) {
		this.maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
		this.windowMs = opts.windowMs ?? DEFAULTS.windowMs;
		this.maxTrackedIps = opts.maxTrackedIps ?? DEFAULTS.maxTrackedIps;
	}

	/**
	 * Whether `ip` is currently locked out. When blocked, `retryAfterSec` is the whole
	 * number of seconds until the window rolls off (for a `Retry-After` header).
	 */
	check(ip: string, now: number = Date.now()): {
		blocked: boolean;
		retryAfterSec?: number;
	} {
		const entry = this.attempts.get(ip);
		if (!entry) return { blocked: false };
		if (now - entry.firstAt >= this.windowMs) {
			// Window expired — forget it so the next attempt starts fresh.
			this.attempts.delete(ip);
			return { blocked: false };
		}
		if (entry.count >= this.maxAttempts) {
			const retryAfterSec = Math.ceil(
				(entry.firstAt + this.windowMs - now) / 1000,
			);
			return { blocked: true, retryAfterSec: Math.max(retryAfterSec, 1) };
		}
		return { blocked: false };
	}

	/** Record a failed password attempt, starting or extending the window for `ip`. */
	recordFailure(ip: string, now: number = Date.now()): void {
		const entry = this.attempts.get(ip);
		if (!entry || now - entry.firstAt >= this.windowMs) {
			this.evictIfFull();
			this.attempts.set(ip, { count: 1, firstAt: now });
			return;
		}
		entry.count += 1;
	}

	/** Clear an IP's counter after a successful login. */
	recordSuccess(ip: string): void {
		this.attempts.delete(ip);
	}

	/**
	 * If the Map is at capacity, drop the oldest-windowed entry to make room. A spray of
	 * unique IPs is itself an attack signal, but it must not be allowed to OOM the process.
	 */
	private evictIfFull(): void {
		if (this.attempts.size < this.maxTrackedIps) return;
		let oldestIp: string | undefined;
		let oldestAt = Infinity;
		for (const [ip, entry] of this.attempts) {
			if (entry.firstAt < oldestAt) {
				oldestAt = entry.firstAt;
				oldestIp = ip;
			}
		}
		if (oldestIp !== undefined) this.attempts.delete(oldestIp);
	}
}
