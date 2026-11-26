import { describe, expect, it } from "vitest";
import { isValidDsn, sanitizeDsn } from "../instrument.js";

describe("sanitizeDsn", () => {
	it("trims whitespace from ends", () => {
		expect(sanitizeDsn("  https://key@example.com/123 \n")).toBe("https://key@example.com/123");
	});

	it("strips double quotes", () => {
		expect(sanitizeDsn('"https://key@example.com/123"')).toBe("https://key@example.com/123");
	});

	it("strips single quotes", () => {
		expect(sanitizeDsn("'https://key@example.com/123'")).toBe("https://key@example.com/123");
	});

	it("returns empty string for empty, undefined, or non-string input", () => {
		expect(sanitizeDsn("")).toBe("");
		expect(sanitizeDsn(undefined)).toBe("");
		expect(sanitizeDsn("   ")).toBe("");
	});
});

describe("isValidDsn", () => {
	it("accepts standard lowercase hex Sentry DSN", () => {
		expect(isValidDsn("https://a1b2c3d4e5f6@example.com/123456")).toBe(true);
	});

	it("accepts uppercase hex characters in Sentry public key", () => {
		expect(isValidDsn("https://A1B2C3D4E5F6@example.com/123456")).toBe(true);
	});

	it("accepts alphanumeric and dashed public keys", () => {
		expect(isValidDsn("https://my-custom-key_123@example.com/42")).toBe(true);
	});

	it("accepts legacy public:secret key format", () => {
		expect(isValidDsn("https://publicKey:secretKey@sentry.example.com/123")).toBe(true);
	});

	it("accepts ports in host", () => {
		expect(isValidDsn("https://key@example.com:9000/123")).toBe(true);
	});

	it("accepts subpaths before project id", () => {
		expect(isValidDsn("https://key@sentry.example.com/api/123")).toBe(true);
	});

	it("accepts quoted DSN strings by sanitizing them first", () => {
		expect(isValidDsn('"https://key@sentry.example.com/123"')).toBe(true);
	});

	it("rejects non-http/https protocols", () => {
		expect(isValidDsn("ftp://key@sentry.example.com/123")).toBe(false);
	});

	it("rejects URLs missing the public key (username)", () => {
		expect(isValidDsn("https://sentry.example.com/123")).toBe(false);
	});

	it("rejects URLs missing the project id path", () => {
		expect(isValidDsn("https://key@sentry.example.com/")).toBe(false);
		expect(isValidDsn("https://key@sentry.example.com")).toBe(false);
	});

	it("rejects arbitrary invalid strings", () => {
		expect(isValidDsn("invalid-dsn")).toBe(false);
		expect(isValidDsn("")).toBe(false);
	});
});
