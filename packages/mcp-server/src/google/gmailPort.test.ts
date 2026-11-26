import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", () => ({
	supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) },
}));

describe("gmailPort composition (issue #1497)", () => {
	afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

	it("importing the module calls no fetch and resolves no credential", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const mod = await import("./gmailPort.js");
		expect(mod.gmailPort).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("work posts the work refresh token and angus the personal one", async () => {
		const { gmailPort } = await import("./gmailPort.js");
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const postedBodies: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) === "https://oauth2.googleapis.com/token") {
				postedBodies.push(String(init?.body ?? ""));
				return new Response(JSON.stringify({ access_token: "at-ok" }), { status: 200 });
			}
			return new Response(JSON.stringify({ emailAddress: "owner@example.com", messagesTotal: 5 }), { status: 200 });
		}));

		await gmailPort.getProfile({ domain: "work" });
		await gmailPort.getProfile({ domain: "angus" });
		expect(postedBodies.map((b) => new URLSearchParams(b).get("refresh_token"))).toEqual(["rt-work-val", "rt-personal-val"]);
	});
});
