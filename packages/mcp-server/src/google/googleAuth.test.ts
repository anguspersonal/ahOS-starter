import { afterEach, describe, expect, it, vi } from "vitest";

const getCredentialSpy = vi.fn(async (provider: string) => {
	if (provider === "google_work") {
		return process.env.GOOGLE_REFRESH_TOKEN_WORK ?? null;
	}
	if (provider === "google_personal") {
		return process.env.GOOGLE_REFRESH_TOKEN_PERSONAL ?? null;
	}
	return null;
});

vi.mock("../credentials.js", () => ({
	getCredential: (provider: string) => getCredentialSpy(provider),
}));

describe("googleAuth composition (issue #1480)", () => {
	afterEach(() => {
		getCredentialSpy.mockClear();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("importing googleAuth.ts calls no fetch and resolves no credential", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "");

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./googleAuth.js");
		expect(mod.googleAuthConfig).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(getCredentialSpy).not.toHaveBeenCalled();
	});

	it("work resolves GOOGLE_REFRESH_TOKEN_WORK and angus the personal one", async () => {
		const { googleAuthConfig } = await import("./googleAuth.js");

		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		expect(googleAuthConfig.clientId).toBe("cid-test");
		expect(googleAuthConfig.clientSecret).toBe("csecret-test");

		const workToken = await googleAuthConfig.refreshToken("work");
		const angusToken = await googleAuthConfig.refreshToken("angus");

		expect(workToken).toBe("rt-work-val");
		expect(angusToken).toBe("rt-personal-val");
		expect(getCredentialSpy).toHaveBeenNthCalledWith(1, "google_work");
		expect(getCredentialSpy).toHaveBeenNthCalledWith(2, "google_personal");
	});
});
