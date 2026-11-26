import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same posture as calendar.test.ts: stub the token mint, but keep the REAL credential
// resolution inside it so the account-boundary assertions stay honest. A mint that
// short-circuits getCredential would make "GOOGLE_REFRESH_TOKEN_WORK is not set"
// unobservable, and the no-silent-fallback test would pass against a broken build.
vi.mock("../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../google/oauth.js")>();
	const { getCredential } = await import("../credentials.js");
	const { GOOGLE_ACCOUNT_PROVIDER, DEFAULT_GOOGLE_ACCOUNT } = await import(
		"../google/accounts.js"
	);
	return {
		...actual,
		getGoogleAccessToken: vi.fn(
			async (account: "personal" | "work" = DEFAULT_GOOGLE_ACCOUNT) => {
				await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
				return "fake_access_token";
			},
		),
	};
});

import { getGmailAccessToken } from "../google/gmail.js";

const origRefresh = process.env.GOOGLE_REFRESH_TOKEN;
const origWork = process.env.GOOGLE_REFRESH_TOKEN_WORK;

beforeEach(() => {
	process.env.GOOGLE_REFRESH_TOKEN = "fake_refresh_token";
	process.env.GOOGLE_REFRESH_TOKEN_WORK = "fake_work_refresh_token";
});

afterEach(() => {
	if (origRefresh === undefined) delete process.env.GOOGLE_REFRESH_TOKEN;
	else process.env.GOOGLE_REFRESH_TOKEN = origRefresh;
	if (origWork === undefined) delete process.env.GOOGLE_REFRESH_TOKEN_WORK;
	else process.env.GOOGLE_REFRESH_TOKEN_WORK = origWork;
});

describe("getGmailAccessToken", () => {
	it("mints for the Work account when asked for it", async () => {
		expect(await getGmailAccessToken("work")).toBe("fake_access_token");
	});

	it("does not silently fall back to the personal account when Work is unwired", async () => {
		// The personal token IS present, so a fallback would succeed against the wrong
		// mailbox rather than fail. Reading the wrong mailbox returns an empty search,
		// which reads downstream as "no meeting notes today" — a silent wrong answer.
		delete process.env.GOOGLE_REFRESH_TOKEN_WORK;

		await expect(getGmailAccessToken("work")).rejects.toThrow(
			/GOOGLE_REFRESH_TOKEN_WORK is not set/,
		);
	});
});
