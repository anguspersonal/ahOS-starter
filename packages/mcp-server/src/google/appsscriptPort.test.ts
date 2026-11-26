import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", () => ({
	supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) },
}));

describe("appsscriptPort composition (issue #1633)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("importing the module calls no fetch and resolves no credential", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const mod = await import("./appsscriptPort.js");
		expect(mod.appsscriptPort).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	}, 15_000);

	it("work posts the work refresh token and angus the personal one", async () => {
		const { appsscriptPort } = await import("./appsscriptPort.js");
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
			return new Response(JSON.stringify({ scriptId: "s-1", title: "Script" }), { status: 200 });
		}));
		await appsscriptPort.getProject({ domain: "work", scriptId: "s-1" });
		await appsscriptPort.getProject({ domain: "angus", scriptId: "s-1" });
		expect(postedBodies).toHaveLength(2);
		expect(postedBodies[0]).toContain("refresh_token=rt-work-val");
		expect(postedBodies[1]).toContain("refresh_token=rt-personal-val");
	});
});
