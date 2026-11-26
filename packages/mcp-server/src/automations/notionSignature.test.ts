import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
	computeNotionSignature,
	verifyNotionSignature,
} from "./notionSignature.js";

const TOKEN = "secret_verification_token";
const BODY = JSON.stringify({ type: "page.properties_updated", entity: { id: "p1" } });

function sign(token: string, body: string): string {
	return `sha256=${createHmac("sha256", token).update(body).digest("hex")}`;
}

describe("computeNotionSignature", () => {
	it("produces the sha256=<hex> HMAC of the raw body keyed by the token", () => {
		expect(computeNotionSignature(TOKEN, BODY)).toBe(sign(TOKEN, BODY));
		expect(computeNotionSignature(TOKEN, BODY)).toMatch(/^sha256=[0-9a-f]{64}$/);
	});
});

describe("verifyNotionSignature", () => {
	it("accepts a correctly signed body (string and Buffer alike)", () => {
		const signature = sign(TOKEN, BODY);
		expect(verifyNotionSignature(TOKEN, BODY, signature)).toBe(true);
		expect(verifyNotionSignature(TOKEN, Buffer.from(BODY), signature)).toBe(true);
	});

	it("rejects a signature computed with a different token", () => {
		expect(verifyNotionSignature(TOKEN, BODY, sign("wrong_token", BODY))).toBe(false);
	});

	it("rejects when the body was tampered with after signing", () => {
		const signature = sign(TOKEN, BODY);
		expect(verifyNotionSignature(TOKEN, BODY + " ", signature)).toBe(false);
	});

	it("rejects a missing or empty header without throwing", () => {
		expect(verifyNotionSignature(TOKEN, BODY, undefined)).toBe(false);
		expect(verifyNotionSignature(TOKEN, BODY, null)).toBe(false);
		expect(verifyNotionSignature(TOKEN, BODY, "")).toBe(false);
	});

	it("rejects a wrong-length header without throwing (timingSafeEqual requires equal length)", () => {
		expect(verifyNotionSignature(TOKEN, BODY, "sha256=abc")).toBe(false);
		expect(
			verifyNotionSignature(TOKEN, BODY, `${sign(TOKEN, BODY)}00`),
		).toBe(false);
	});

	it("rejects an equal-length but wrong-value signature (exercises the constant-time compare path)", () => {
		const valid = sign(TOKEN, BODY);
		// Same length, last hex digit flipped.
		const flipped =
			valid.slice(0, -1) + (valid.endsWith("0") ? "1" : "0");
		expect(flipped).toHaveLength(valid.length);
		expect(verifyNotionSignature(TOKEN, BODY, flipped)).toBe(false);
	});
});
