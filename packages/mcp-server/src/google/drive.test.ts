import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getDrive`'s module-level cache (#977 round-1 QA): every other call site
 * mocks this module away entirely (see driveDiscoverCadence.test.ts), so the
 * real function — and in particular how its cache interacts with the optional
 * pre-resolved `refreshToken` — had no direct coverage. That is exactly the
 * seam a token-crossing bug would live in: two accounts sharing a cached
 * client, or a freshly-resolved token silently being ignored.
 *
 * Three properties matter:
 *   1. With no `refreshToken`, the credential is resolved via `getCredential`
 *      as before.
 *   2. With a `refreshToken`, `getCredential` is skipped entirely and the
 *      passed token is what gets set on the client.
 *   3. The cache is keyed per account and records the token it was built with
 *      (#1048). If a caller passes a fresher refreshToken, or if getCredential
 *      resolves a rotated token, the cache invalidates and returns a fresh client
 *      built with that token. Per-account isolation remains strictly enforced.
 */

const getCredential = vi.fn();
const getOAuth2Client = vi.fn();
const driveFactory = vi.fn();

vi.mock("../credentials.js", () => ({ getCredential: (...a: unknown[]) => getCredential(...a) }));
vi.mock("./oauth.js", () => ({ getOAuth2Client: (...a: unknown[]) => getOAuth2Client(...a) }));
vi.mock("googleapis", () => ({
	google: { drive: (...a: unknown[]) => driveFactory(...a) },
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	getCredential.mockImplementation(async (provider: string) => `token-for-${provider}`);
	let n = 0;
	driveFactory.mockImplementation(() => ({ __clientId: `client-${n++}` }));
	getOAuth2Client.mockImplementation(() => ({ setCredentials: vi.fn() }));
});

describe("getDrive", () => {
	it("resolves the credential via getCredential when no refreshToken is passed", async () => {
		const { getDrive } = await import("./drive.js");

		await getDrive("personal");

		expect(getCredential).toHaveBeenCalledWith("google_personal");
	});

	it("uses a passed-in refreshToken and skips getCredential entirely", async () => {
		const { getDrive } = await import("./drive.js");

		await getDrive("personal", "already-resolved-token");

		expect(getCredential).not.toHaveBeenCalled();
		const auth = getOAuth2Client.mock.results[0]?.value as { setCredentials: ReturnType<typeof vi.fn> };
		expect(auth.setCredentials).toHaveBeenCalledWith({ refresh_token: "already-resolved-token" });
	});

	it("caches per account and never returns one account's client for another", async () => {
		const { getDrive } = await import("./drive.js");

		const personal = await getDrive("personal");
		const work = await getDrive("work");

		expect(personal).not.toBe(work);
		expect(getCredential).toHaveBeenCalledWith("google_personal");
		expect(getCredential).toHaveBeenCalledWith("google_work");

		getCredential.mockClear();
		const personalAgain = await getDrive("personal");
		expect(personalAgain).toBe(personal);
		expect(getCredential).not.toHaveBeenCalled();
	});

	it("passing a fresh refreshToken invalidates a warm cache entry and builds a new client", async () => {
		const { getDrive } = await import("./drive.js");

		const first = await getDrive("personal"); // warms the cache via getCredential
		getCredential.mockClear();

		const second = await getDrive("personal", "brand-new-token");

		// Fresh token invalidates the warm cache entry (#1048)
		expect(second).not.toBe(first);
		expect(getCredential).not.toHaveBeenCalled();
		const auth = getOAuth2Client.mock.results[1]?.value as { setCredentials: ReturnType<typeof vi.fn> };
		expect(auth.setCredentials).toHaveBeenCalledWith({ refresh_token: "brand-new-token" });

		// Calling again with the same token hits the cache
		const third = await getDrive("personal", "brand-new-token");
		expect(third).toBe(second);
	});

	it("rotates client when credentials rotate and cache is cleared", async () => {
		const { getDrive, clearDriveCache } = await import("./drive.js");

		const first = await getDrive("personal");
		getCredential.mockResolvedValue("rotated-token-for-google_personal");

		// Clear cache for personal account upon rotation
		clearDriveCache("personal");

		const second = await getDrive("personal");
		expect(second).not.toBe(first);

		// Subsequent call without token hits the cache with the new client
		getCredential.mockClear();
		const third = await getDrive("personal");
		expect(third).toBe(second);
		expect(getCredential).not.toHaveBeenCalled();
	});

	it("clearDriveCache clears all cached clients", async () => {
		const { getDrive, clearDriveCache } = await import("./drive.js");

		const first = await getDrive("personal");
		clearDriveCache();

		const second = await getDrive("personal");
		expect(second).not.toBe(first);
	});
});
