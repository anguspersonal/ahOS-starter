import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", () => ({
	supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) },
}));

describe("docsPort composition (issue #1514)", () => {
	afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

	it("importing the module calls no fetch and resolves no credential", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const mod = await import("./docsPort.js");
		expect(mod.docsPort).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	}, 15_000);

	it("work posts the work refresh token and angus the personal one", async () => {
		const { docsPort } = await import("./docsPort.js");
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
			return new Response(JSON.stringify({ documentId: "doc-1", title: "Spec", revisionId: "rev-1" }), { status: 200 });
		}));

		await docsPort.getDocument({ domain: "work", documentId: "doc-1" });
		await docsPort.getDocument({ domain: "angus", documentId: "doc-1" });
		expect(postedBodies.map((b) => new URLSearchParams(b).get("refresh_token"))).toEqual(["rt-work-val", "rt-personal-val"]);
	});
});
