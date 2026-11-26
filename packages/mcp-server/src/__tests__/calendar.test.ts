import { afterEach, describe, expect, it, vi } from "vitest";

// Stub the token mint BEFORE importing getCalendarAccessToken, so its internal call never
// touches a real OAuth2Client.
//
// The stub still performs the REAL credential resolution before returning its fake
// token. That is what keeps the account-boundary tests below honest: mocking the mint
// outright would make "GOOGLE_REFRESH_TOKEN_WORK is not set" unobservable, and those
// assertions would pass against a build that had silently reintroduced the fallback.
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

import { getCalendarAccessToken } from "../google/calendar.js";

// env properties are lazy getters over process.env (#508), so tests steer the
// refresh token by stubbing the process.env var itself rather than assigning to
// the (now read-only) env object.
const origRefreshToken = process.env.GOOGLE_REFRESH_TOKEN;
const origWorkRefreshToken = process.env.GOOGLE_REFRESH_TOKEN_WORK;
const origPersonalRefreshToken = process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;

afterEach(() => {
	vi.unstubAllGlobals();
	if (origRefreshToken === undefined) delete process.env.GOOGLE_REFRESH_TOKEN;
	else process.env.GOOGLE_REFRESH_TOKEN = origRefreshToken;
	if (origPersonalRefreshToken === undefined)
		delete process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
	else process.env.GOOGLE_REFRESH_TOKEN_PERSONAL = origPersonalRefreshToken;
	if (origWorkRefreshToken === undefined)
		delete process.env.GOOGLE_REFRESH_TOKEN_WORK;
	else process.env.GOOGLE_REFRESH_TOKEN_WORK = origWorkRefreshToken;
});

describe("getCalendarAccessToken", () => {
	it("throws naming BOTH personal var names when neither is set", async () => {
		// The personal token's var was renamed to GOOGLE_REFRESH_TOKEN_PERSONAL on
		// 2026-09-05 (#1002) with the old name kept as a fallback, so both have to be
		// absent for this to fail, and the error has to name both: the failure it
		// guards is "it is set under the other name".
		delete process.env.GOOGLE_REFRESH_TOKEN_PERSONAL;
		delete process.env.GOOGLE_REFRESH_TOKEN;

		await expect(getCalendarAccessToken()).rejects.toThrow(
			/GOOGLE_REFRESH_TOKEN_PERSONAL \(or legacy GOOGLE_REFRESH_TOKEN\) is not set.*google-auth/s,
		);
	});

	it("mints an access token via the shared OAuth2Client when the refresh token is set", async () => {
		process.env.GOOGLE_REFRESH_TOKEN = "fake_refresh_token";

		const token = await getCalendarAccessToken();

		expect(token).toBe("fake_access_token");
	});

	it("mints for the Work account when asked for it (#338)", async () => {
		process.env.GOOGLE_REFRESH_TOKEN_WORK = "fake_work_refresh_token";

		const token = await getCalendarAccessToken("work");

		expect(token).toBe("fake_access_token");
	});

	it("does not silently fall back to the personal account when Work is unwired", async () => {
		// The personal token IS present, so a fallback would succeed against the wrong
		// account instead of failing. Assert the account boundary holds at this layer,
		// not only inside getCredential.
		process.env.GOOGLE_REFRESH_TOKEN = "fake_refresh_token";
		delete process.env.GOOGLE_REFRESH_TOKEN_WORK;

		await expect(getCalendarAccessToken("work")).rejects.toThrow(
			/GOOGLE_REFRESH_TOKEN_WORK is not set/,
		);
	});
});
