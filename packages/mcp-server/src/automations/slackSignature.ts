import { createHmac, timingSafeEqual } from "node:crypto";

// Slack request verification (ADR-048).
// Every Slack Events API request carries:
//   X-Slack-Signature: v0=<hex>
//   X-Slack-Request-Timestamp: <seconds since epoch>
// HMAC-SHA256 of "v0:<timestamp>:<rawBody>" keyed by SLACK_SIGNING_SECRET.
// See https://api.slack.com/authentication/verifying-requests-from-slack.

/** Compute the expected Slack `v0=<hex>` signature. */
export function computeSlackSignature(
	signingSecret: string,
	timestamp: string | number,
	rawBody: string | Buffer,
): string {
	// Byte-faithful: never round-trip the raw bytes through a UTF-8 string.
	const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
	const basestring = Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), bodyBytes]);
	return `v0=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;
}

/**
 * Timing-safe check of a delivery's `X-Slack-Signature` and `X-Slack-Request-Timestamp`.
 * Enforces replay protection: rejects requests older or newer than `toleranceSec` (default 5 min).
 */
export function verifySlackSignature(
	signingSecret: string,
	rawBody: string | Buffer,
	signatureHeader: string | undefined | null,
	timestampHeader: string | undefined | null,
	nowSec: number = Math.floor(Date.now() / 1000),
	toleranceSec: number = 300,
): boolean {
	if (!signatureHeader || !timestampHeader) return false;

	const ts = Number(timestampHeader);
	if (!Number.isFinite(ts)) return false;

	// Replay attack check
	if (Math.abs(nowSec - ts) > toleranceSec) return false;

	const expected = Buffer.from(
		computeSlackSignature(signingSecret, timestampHeader, rawBody),
	);
	const received = Buffer.from(signatureHeader);
	if (expected.length !== received.length) return false;
	return timingSafeEqual(expected, received);
}
