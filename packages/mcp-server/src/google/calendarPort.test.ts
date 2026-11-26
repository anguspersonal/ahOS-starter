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

describe("calendarPort composition (issue #1580)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("importing the module calls no fetch and resolves no credential", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const mod = await import("./calendarPort.js");
		expect(mod.calendarPort).toBeDefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("work posts the work refresh token and angus the personal one", async () => {
		const { calendarPort } = await import("./calendarPort.js");
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const postedBodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				if (String(input) === "https://oauth2.googleapis.com/token") {
					postedBodies.push(String(init?.body ?? ""));
					return new Response(JSON.stringify({ access_token: "at-ok" }), { status: 200 });
				}
				return new Response(JSON.stringify({ id: "ev-1", summary: "Sync" }), { status: 200 });
			}),
		);

		await calendarPort.getEvent({ domain: "work", eventId: "ev-1" });
		await calendarPort.getEvent({ domain: "angus", eventId: "ev-1" });

		expect(postedBodies).toHaveLength(2);
		expect(postedBodies[0]).toContain("refresh_token=rt-work-val");
		expect(postedBodies[1]).toContain("refresh_token=rt-personal-val");
	});
});
