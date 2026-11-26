import { createHmac, timingSafeEqual } from "node:crypto";

// X-Notion-Signature verification (#546 / ADR-048). Every webhook delivery after
// the subscription handshake carries `X-Notion-Signature: sha256=<hex>`, an
// HMAC-SHA256 of the raw request body keyed by the subscription's
// verification_token. See https://developers.notion.com/reference/webhooks.

/** Compute the expected `sha256=<hex>` signature for a raw request body. */
export function computeNotionSignature(
	verificationToken: string,
	rawBody: string | Buffer,
): string {
	return `sha256=${createHmac("sha256", verificationToken).update(rawBody).digest("hex")}`;
}

/**
 * Timing-safe check of a delivery's `X-Notion-Signature` header against the
 * signature recomputed from the raw body. A missing header or a length mismatch
 * fails fast — length is not secret (the valid format is fixed-width), so the
 * early return leaks nothing; the byte comparison itself is constant-time
 * (`crypto.timingSafeEqual`), never `===` on attacker-controlled input.
 */
export function verifyNotionSignature(
	verificationToken: string,
	rawBody: string | Buffer,
	signatureHeader: string | undefined | null,
): boolean {
	if (!signatureHeader) return false;
	const expected = Buffer.from(computeNotionSignature(verificationToken, rawBody));
	const received = Buffer.from(signatureHeader);
	if (expected.length !== received.length) return false;
	return timingSafeEqual(expected, received);
}
