import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase.js", () => ({
	supabase: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({
		data: { enabled: true, config: { project_id: "angus-personal", datasets: ["angus-personal.analytics"] } }, error: null,
	}) }) }) }) }) },
}));

describe("bigqueryPort composition (#1650)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("lazily exchanges the personal refresh token on dryRun and loads bigquery integration config", async () => {
		const fetchSpy = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => String(input) === "https://oauth2.googleapis.com/token"
			? new Response(JSON.stringify({ access_token: "at-ok" }), { status: 200 })
			: new Response(JSON.stringify({ statistics: { query: { statementType: "SELECT", referencedTables: [], totalBytesProcessed: "0" } } }), { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);
		const { bigqueryPort } = await import("./bigqueryPort.js");
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-bq");
		expect((await bigqueryPort.loadConfig())?.project_id).toBe("angus-personal");
		await bigqueryPort.dryRun({ projectId: "angus-personal", sql: "SELECT 1" });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain("refresh_token=rt-personal-bq");
	});
});
