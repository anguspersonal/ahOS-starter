import { describe, expect, it, vi } from "vitest";
import { createGoogleSheetsAdapter } from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("createGoogleSheetsAdapter (issue #1434)", () => {
	it("mints with the angus refresh token for domain angus and the work one for work", async () => {
		const tokenBodies: string[] = [];
		const authHeaders: string[] = [];

		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				const body = String(init?.body ?? "");
				tokenBodies.push(body);
				const token = body.includes("rt-angus") ? "at-angus" : "at-work";
				return jsonResponse({ access_token: token });
			}
			const headers = (init?.headers ?? {}) as Record<string, string>;
			authHeaders.push(headers.Authorization);
			return jsonResponse({
				spreadsheetId: "sheet-1",
				spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
				properties: { title: "Budget" },
				sheets: [],
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async (d) => (d === "angus" ? "rt-angus" : "rt-work"),
			fetchFn,
		});

		await adapter.getSpreadsheet({ domain: "angus", spreadsheetId: "sheet-1" });
		await adapter.getSpreadsheet({ domain: "work", spreadsheetId: "sheet-1" });

		expect(tokenBodies[0]).toContain("refresh_token=rt-angus");
		expect(tokenBodies[1]).toContain("refresh_token=rt-work");
		expect(authHeaders).toEqual(["Bearer at-angus", "Bearer at-work"]);
	});

	it("refuses before any request for an unknown domain or a domain with no refresh token", async () => {
		const fetchFn = vi.fn() as unknown as typeof fetch;
		const refreshToken = vi.fn(async () => "");

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken,
			fetchFn,
		});

		await expect(
			adapter.getSpreadsheet({ domain: "bogus" as any, spreadsheetId: "s1" }),
		).rejects.toThrow(/bogus/);
		expect(refreshToken).not.toHaveBeenCalled();
		expect(fetchFn).not.toHaveBeenCalled();

		await expect(
			adapter.getSpreadsheet({ domain: "work", spreadsheetId: "s1" }),
		).rejects.toThrow(/work/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("names a missing client id or secret before any request", async () => {
		const fetchFn = vi.fn() as unknown as typeof fetch;
		const adapter = createGoogleSheetsAdapter({
			clientId: "",
			clientSecret: "csecret",
			refreshToken: async () => "rt-angus",
			fetchFn,
		});

		await expect(
			adapter.getSpreadsheet({ domain: "angus", spreadsheetId: "s1" }),
		).rejects.toThrow(/angus/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("maps sheets in index order with row and column counts", async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			return jsonResponse({
				spreadsheetId: "s-order",
				spreadsheetUrl: "https://docs.google.com/spreadsheets/d/s-order",
				properties: { title: "Ordered" },
				sheets: [
					{
						properties: {
							sheetId: 20,
							title: "Second",
							index: 1,
							hidden: true,
							sheetType: "GRID",
							gridProperties: { rowCount: 50, columnCount: 8 },
						},
					},
					{
						properties: {
							sheetId: 10,
							title: "First",
							index: 0,
							hidden: false,
							sheetType: "GRID",
							gridProperties: { rowCount: 100, columnCount: 12 },
						},
					},
				],
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		const meta = await adapter.getSpreadsheet({ domain: "angus", spreadsheetId: "s-order" });
		expect(meta.sheets.map((s) => ({ title: s.title, rowCount: s.rowCount, columnCount: s.columnCount }))).toEqual([
			{ title: "First", rowCount: 100, columnCount: 12 },
			{ title: "Second", rowCount: 50, columnCount: 8 },
		]);
	});

	it("rejects a 403 SERVICE_DISABLED with name, status and reason as properties", async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			return jsonResponse(
				{
					error: {
						code: 403,
						message: "Google Sheets API has not been used in project",
						status: "PERMISSION_DENIED",
						details: [{ reason: "SERVICE_DISABLED" }],
					},
				},
				403,
			);
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		await expect(
			adapter.getSpreadsheet({ domain: "work", spreadsheetId: "s-403" }),
		).rejects.toMatchObject({
			name: "SheetsApiError",
			status: 403,
			googleStatus: "PERMISSION_DENIED",
			reason: "SERVICE_DISABLED",
		});
	});

	it("never puts a refresh or access token in an error message", async () => {
		const secretRefresh = "1//03-SUPER-SECRET-REFRESH-TOKEN";
		const secretAccess = "ya29.SUPER-SECRET-ACCESS-TOKEN";

		const failingExchangeFetch = vi.fn(async () =>
			jsonResponse(
				{
					error: "invalid_grant",
					error_description: `Bad token ${secretRefresh} and ${secretAccess}`,
				},
				400,
			),
		) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => secretRefresh,
			fetchFn: failingExchangeFetch,
		});

		let caught: Error | undefined;
		try {
			await adapter.getSpreadsheet({ domain: "angus", spreadsheetId: "s1" });
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.name).toBe("Error");
		expect(caught!.message).toContain("angus");
		expect(caught!.message).toContain("400");
		expect(caught!.message).toContain("invalid_grant");
		expect(caught!.message).not.toContain(secretRefresh);
		expect(caught!.message).not.toContain(secretAccess);
	});
});
