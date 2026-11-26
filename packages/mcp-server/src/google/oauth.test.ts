import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getGoogleAccessToken`'s optional pre-resolved refresh token (#1210), the same seam
 * getDrive() has (#977, see drive.test.ts). Every other test mocks this function away,
 * so the pass-through itself had no direct coverage, and a token-crossing bug would
 * live exactly here: a passed token silently ignored in favour of a fresh resolution,
 * or the resolution skipped when nothing was passed.
 */

const getCredential = vi.fn();
const setCredentials = vi.fn();
const getAccessToken = vi.fn();

vi.mock("../credentials.js", () => ({ getCredential: (...a: unknown[]) => getCredential(...a) }));
vi.mock("../env.js", () => ({
	env: { googleClientId: "client-id", googleClientSecret: "client-secret", googleOAuthRedirect: "http://x" },
}));
vi.mock("googleapis", () => ({
	google: {
		auth: {
			OAuth2: vi.fn(function OAuth2() {
				return { setCredentials, getAccessToken };
			}),
		},
	},
}));

const { getGoogleAccessToken } = await import("./oauth.js");

beforeEach(() => {
	vi.clearAllMocks();
	getCredential.mockImplementation(async (provider: string) => `resolved-${provider}`);
	getAccessToken.mockResolvedValue({ token: "access-token" });
});

describe("getGoogleAccessToken", () => {
	it("resolves the account's credential when no refresh token is passed", async () => {
		expect(await getGoogleAccessToken("work", "Gmail")).toBe("access-token");

		expect(getCredential).toHaveBeenCalledWith("google_work");
		expect(setCredentials).toHaveBeenCalledWith({ refresh_token: "resolved-google_work" });
	});

	it("uses a passed refresh token and skips the credential seam entirely", async () => {
		await getGoogleAccessToken("personal", "Gmail", "already-resolved");

		expect(getCredential).not.toHaveBeenCalled();
		expect(setCredentials).toHaveBeenCalledWith({ refresh_token: "already-resolved" });
	});

	it("still fails loudly, naming the account, when Google returns no token", async () => {
		getAccessToken.mockResolvedValue({ token: null });

		await expect(getGoogleAccessToken("personal", "Gmail", "already-resolved")).rejects.toThrow(
			/Gmail access token for the 'personal' account/,
		);
	});
});
