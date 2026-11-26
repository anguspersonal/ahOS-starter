import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	computeSlackSignature,
	verifySlackSignature,
} from "./slackSignature.js";

const SECRET = "test_signing_secret_123";
const NOW = 1700000000;

describe("computeSlackSignature", () => {
	it("computes expected HMAC with v0 prefix", () => {
		const sig = computeSlackSignature(SECRET, NOW, "test-body");
		expect(sig).toMatch(/^v0=[a-f0-9]{64}$/);
	});

	it("signs raw bytes faithfully, including bytes that are not valid UTF-8", () => {
		const raw = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]); // invalid UTF-8 sequence
		const expected = `v0=${createHmac("sha256", SECRET)
			.update(Buffer.concat([Buffer.from(`v0:${NOW}:`), raw]))
			.digest("hex")}`;
		expect(computeSlackSignature(SECRET, NOW, raw)).toBe(expected);
		// A utf8 round-trip would have replaced the bad bytes and produced a different digest.
		expect(computeSlackSignature(SECRET, NOW, raw.toString("utf8"))).not.toBe(expected);
	});
});

describe("verifySlackSignature", () => {
	it("verifies a valid signature and timestamp", () => {
		const body = JSON.stringify({ event: { text: "hello" } });
		const sig = computeSlackSignature(SECRET, NOW, body);
		const valid = verifySlackSignature(SECRET, body, sig, String(NOW), NOW);
		expect(valid).toBe(true);
	});

	it("rejects an invalid signature", () => {
		const body = "payload";
		const valid = verifySlackSignature(
			SECRET,
			body,
			"v0=0000000000000000000000000000000000000000000000000000000000000000",
			String(NOW),
			NOW,
		);
		expect(valid).toBe(false);
	});

	it("rejects missing headers", () => {
		expect(verifySlackSignature(SECRET, "body", null, String(NOW), NOW)).toBe(false);
		expect(verifySlackSignature(SECRET, "body", "sig", null, NOW)).toBe(false);
	});

	it("rejects timestamps outside replay tolerance window (> 5 mins old)", () => {
		const body = "payload";
		const oldTimestamp = NOW - 301;
		const sig = computeSlackSignature(SECRET, oldTimestamp, body);
		const valid = verifySlackSignature(SECRET, body, sig, String(oldTimestamp), NOW);
		expect(valid).toBe(false);
	});

	it("rejects timestamps far in the future (> 5 mins ahead)", () => {
		const body = "payload";
		const futureTimestamp = NOW + 301;
		const sig = computeSlackSignature(SECRET, futureTimestamp, body);
		const valid = verifySlackSignature(SECRET, body, sig, String(futureTimestamp), NOW);
		expect(valid).toBe(false);
	});

	it("accepts timestamps within tolerance window", () => {
		const body = "payload";
		const recentTimestamp = NOW - 100;
		const sig = computeSlackSignature(SECRET, recentTimestamp, body);
		const valid = verifySlackSignature(SECRET, body, sig, String(recentTimestamp), NOW);
		expect(valid).toBe(true);
	});
});
