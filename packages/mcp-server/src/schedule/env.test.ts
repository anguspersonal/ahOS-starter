import { afterEach, describe, expect, it, vi } from "vitest";
import { positiveInt } from "./env.js";

/**
 * positiveInt guards a per-run bound. The failure it exists for is silent: the
 * .env.example template leaves KMS_GMAIL_ATTACHMENT_DISCOVER_MAX_MESSAGES empty, and
 * `Number("")` is 0, so a bare Number() would give the Gmail attachment sweep a bound
 * of 0. Every run would then list its window, fetch nothing and record success.
 */
describe("positiveInt", () => {
	it.each([
		["unset", undefined, 1000],
		["empty", "", 1000],
		["blank", "   ", 1000],
		["zero", "0", 1000],
		["negative", "-5", 1000],
		["not a number", "abc", 1000],
		["infinite", "Infinity", 1000],
		["a fraction below 1", "0.5", 1000],
	])("falls back when the value is %s", (_label, raw, expected) => {
		expect(positiveInt(raw, 1000)).toBe(expected);
	});

	it.each([
		["250", 250],
		["1", 1],
		["2.7", 2],
		[" 40 ", 40],
	])("reads %j as %i", (raw, expected) => {
		expect(positiveInt(raw, 1000)).toBe(expected);
	});
});

describe("env.gmailAttachmentDiscoverMaxMessages", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("defaults to 1000 when the template's empty value is deployed", async () => {
		vi.stubEnv("KMS_GMAIL_ATTACHMENT_DISCOVER_MAX_MESSAGES", "");
		vi.resetModules();
		const { env } = await import("./env.js");
		expect(env.gmailAttachmentDiscoverMaxMessages).toBe(1000);
	});

	it("takes a set value", async () => {
		vi.stubEnv("KMS_GMAIL_ATTACHMENT_DISCOVER_MAX_MESSAGES", "250");
		vi.resetModules();
		const { env } = await import("./env.js");
		expect(env.gmailAttachmentDiscoverMaxMessages).toBe(250);
	});
});

describe("env driveHygiene settings", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("defaults driveHygieneEnabled=true, interval=360m, maxActions=500", async () => {
		vi.resetModules();
		const { env } = await import("./env.js");
		expect(env.driveHygieneEnabled).toBe(true);
		expect(env.driveHygieneIntervalMinutes).toBe(360);
		expect(env.driveHygieneMaxActions).toBe(500);
	});

	it("allows disabling via KMS_DRIVE_HYGIENE_ENABLED=false and clamps maxActions to 500", async () => {
		vi.stubEnv("KMS_DRIVE_HYGIENE_ENABLED", "false");
		vi.stubEnv("KMS_DRIVE_HYGIENE_INTERVAL_MINUTES", "180");
		vi.stubEnv("KMS_DRIVE_HYGIENE_MAX_ACTIONS", "750");
		vi.resetModules();
		const { env } = await import("./env.js");
		expect(env.driveHygieneEnabled).toBe(false);
		expect(env.driveHygieneIntervalMinutes).toBe(180);
		expect(env.driveHygieneMaxActions).toBe(500);
	});
});

describe("env jobHuntGmail settings", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("defaults jobHuntGmailEnabled=false, mode='shadow', maxMessages=50", async () => {
		vi.resetModules();
		const { env } = await import("./env.js");
		expect(env.jobHuntGmailEnabled).toBe(false);
		expect(env.jobHuntGmailMode).toBe("shadow");
		expect(env.jobHuntGmailMaxMessages).toBe(50);
	});

	it("accepts KMS_JOB_HUNT_GMAIL_ENABLED=true and mode='label' / 'act'", async () => {
		vi.stubEnv("KMS_JOB_HUNT_GMAIL_ENABLED", "true");
		vi.stubEnv("KMS_JOB_HUNT_GMAIL_MODE", "label");
		vi.stubEnv("KMS_JOB_HUNT_GMAIL_MAX_MESSAGES", "120");
		vi.resetModules();
		const { env } = await import("./env.js");
		expect(env.jobHuntGmailEnabled).toBe(true);
		expect(env.jobHuntGmailMode).toBe("label");
		expect(env.jobHuntGmailMaxMessages).toBe(120);
	});
});
