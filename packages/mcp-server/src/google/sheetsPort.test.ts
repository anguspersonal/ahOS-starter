import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", () => ({
	supabase: {
		from: () => ({
			select: () => ({
				eq: () => ({
					eq: () => ({
						maybeSingle: async () => ({ data: null, error: null }),
					}),
				}),
			}),
		}),
	},
}));

describe("sheetsPort composition (issue #1434)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("importing the module calls no fetch and resolves no credential", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "");

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./sheetsPort.js");
		expect(mod.sheetsPort).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("work posts the work refresh token and angus the personal one", async () => {
		const { sheetsPort } = await import("./sheetsPort.js");

		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const postedBodies: string[] = [];
		const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				postedBodies.push(String(init?.body ?? ""));
				return new Response(JSON.stringify({ access_token: "at-ok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(
				JSON.stringify({
					spreadsheetId: "sp-1",
					spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sp-1",
					properties: { title: "Sheet" },
					sheets: [],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		vi.stubGlobal("fetch", fetchStub);

		await sheetsPort.getSpreadsheet({ domain: "work", spreadsheetId: "sp-1" });
		await sheetsPort.getSpreadsheet({ domain: "angus", spreadsheetId: "sp-1" });

		expect(postedBodies).toHaveLength(2);
		expect(postedBodies[0]).toContain("refresh_token=rt-work-val");
		expect(postedBodies[1]).toContain("refresh_token=rt-personal-val");
	});
});
