import type { ErrorRequestHandler, Request, RequestHandler } from "express";
import { LoginRateLimiter } from "../auth/loginRateLimiter.js";

// Shared guards for the unauthenticated inbound `/webhooks/*` routes (ADR-048,
// ADR-096 rule 4: every public POST route is rate limited before it goes live).
//
// The limiter is the owner-login failed-attempt limiter reused as-is: it is keyed by
// an opaque string (the client IP), bounded, and in-memory, which is the right shape
// for a single Railway instance. Only FAILED authentications count, so a legitimate
// sender (Slack, Drive, the owner's own tooling) is never throttled by volume; a
// guesser or a flood of unsigned junk is locked out until the window rolls off.

/** Failed deliveries tolerated per IP per window before the route answers 429. */
export const WEBHOOK_MAX_FAILURES = 10;
export const WEBHOOK_FAILURE_WINDOW_MS = 15 * 60 * 1000;

export function createWebhookLimiter(): LoginRateLimiter {
	return new LoginRateLimiter({
		maxAttempts: WEBHOOK_MAX_FAILURES,
		windowMs: WEBHOOK_FAILURE_WINDOW_MS,
	});
}

function clientKey(req: Request): string {
	// `req.ip` honours X-Forwarded-For because http.ts sets `trust proxy` (one Railway hop).
	return req.ip ?? "unknown";
}

/** Reject with 429 before any parsing or auth work when the caller is locked out. */
export function rejectIfLockedOut(limiter: LoginRateLimiter): RequestHandler {
	return (req, res, next) => {
		const { blocked, retryAfterSec } = limiter.check(clientKey(req));
		if (blocked) {
			res.setHeader("Retry-After", String(retryAfterSec ?? 1));
			res.status(429).json({ error: "too many failed attempts" });
			return;
		}
		next();
	};
}

/** Count one failed authentication against the caller. */
export function recordAuthFailure(limiter: LoginRateLimiter, req: Request): void {
	limiter.recordFailure(clientKey(req));
}

/**
 * Router-level error middleware: terse JSON for body-parser failures instead of
 * Express's default HTML stack trace. Never echoes the error message.
 */
export const webhookErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
	if (res.headersSent) {
		next(err);
		return;
	}
	const type = (err as { type?: string } | null)?.type;
	if (type === "entity.too.large") {
		res.status(413).json({ error: "payload too large" });
		return;
	}
	if (type === "entity.parse.failed" || type === "encoding.unsupported" || type === "charset.unsupported") {
		res.status(400).json({ error: "invalid request body" });
		return;
	}
	console.error("webhook: unexpected error:", err instanceof Error ? err.message : String(err));
	res.status(500).json({ error: "internal error" });
};
