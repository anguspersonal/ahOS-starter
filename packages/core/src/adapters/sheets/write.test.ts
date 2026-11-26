import { describe, expect, it, vi } from "vitest";
import { createGoogleSheetsAdapter } from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("write methods", () => {
	it("updateValues PUTs with includeValuesInResponse=false and a fields mask", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-angus" });
			}
			requests.push({ url, init });
			return jsonResponse({
				updatedRange: "Sheet1!A1:B2",
				updatedRows: 2,
				updatedColumns: 2,
				updatedCells: 3,
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-angus",
			fetchFn,
		});

		const receipt = await adapter.updateValues({
			domain: "angus",
			spreadsheetId: "s-1",
			range: "Sheet1!A1:B2",
			values: [
				["a", null],
				[42, true],
			],
			valueInput: "RAW",
		});

		expect(requests).toHaveLength(1);
		const parsed = new URL(requests[0].url);
		expect(requests[0].init?.method).toBe("PUT");
		expect(parsed.pathname).toBe("/v4/spreadsheets/s-1/values/Sheet1!A1%3AB2");
		expect(parsed.searchParams.get("includeValuesInResponse")).toBe("false");
		expect(parsed.searchParams.get("fields")).toBe(
			"updatedRange,updatedRows,updatedColumns,updatedCells",
		);
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({
			majorDimension: "ROWS",
			values: [
				["a", null],
				[42, true],
			],
		});
		expect(receipt).toEqual({
			updatedRange: "Sheet1!A1:B2",
			updatedRows: 2,
			updatedColumns: 2,
			updatedCells: 3,
		});
	});

	it("sends valueInputOption exactly as given", async () => {
		const seenOptions: string[] = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			const parsed = new URL(url);
			seenOptions.push(parsed.searchParams.get("valueInputOption") ?? "");
			return jsonResponse({
				updatedRange: "Sheet1!A1",
				updatedRows: 1,
				updatedColumns: 1,
				updatedCells: 1,
				updates: {
					updatedRange: "Sheet1!A1",
					updatedRows: 1,
					updatedColumns: 1,
					updatedCells: 1,
				},
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		await adapter.updateValues({
			domain: "angus",
			spreadsheetId: "s-1",
			range: "Sheet1!A1",
			values: [["=1+1"]],
			valueInput: "RAW",
		});
		await adapter.appendValues({
			domain: "work",
			spreadsheetId: "s-1",
			range: "Sheet1!A1",
			values: [["=1+1"]],
			valueInput: "USER_ENTERED",
		});

		expect(seenOptions).toEqual(["RAW", "USER_ENTERED"]);
	});

	it("appendValues posts INSERT_ROWS and returns tableRange", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-work" });
			}
			requests.push({ url, init });
			return jsonResponse({
				tableRange: "Sheet1!A1:B10",
				updates: {
					updatedRange: "Sheet1!A11:B11",
					updatedRows: 1,
					updatedColumns: 2,
					updatedCells: 2,
				},
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-work",
			fetchFn,
		});

		const receipt = await adapter.appendValues({
			domain: "work",
			spreadsheetId: "s-2",
			range: "Sheet1!A:B",
			values: [["row", "data"]],
			valueInput: "USER_ENTERED",
		});

		expect(requests).toHaveLength(1);
		const parsed = new URL(requests[0].url);
		expect(requests[0].init?.method).toBe("POST");
		expect(parsed.pathname).toBe("/v4/spreadsheets/s-2/values/Sheet1!A%3AB:append");
		expect(parsed.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
		expect(parsed.searchParams.get("includeValuesInResponse")).toBe("false");
		expect(parsed.searchParams.get("fields")).toBe(
			"tableRange,updates(updatedRange,updatedRows,updatedColumns,updatedCells)",
		);
		expect(receipt).toEqual({
			tableRange: "Sheet1!A1:B10",
			updatedRange: "Sheet1!A11:B11",
			updatedRows: 1,
			updatedColumns: 2,
			updatedCells: 2,
		});
	});

	it("clearValues posts an empty body to :clear", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			requests.push({ url, init });
			return jsonResponse({ clearedRange: "Sheet1!A2:D20" });
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		const receipt = await adapter.clearValues({
			domain: "angus",
			spreadsheetId: "s-3",
			range: "Sheet1!A2:D20",
		});

		expect(requests).toHaveLength(1);
		const parsed = new URL(requests[0].url);
		expect(requests[0].init?.method).toBe("POST");
		expect(parsed.pathname).toBe("/v4/spreadsheets/s-3/values/Sheet1!A2%3AD20:clear");
		expect(parsed.searchParams.get("fields")).toBe("clearedRange");
		expect(requests[0].init?.body).toBe("{}");
		expect(receipt).toEqual({ clearedRange: "Sheet1!A2:D20" });
	});

	it("encodes a quoted tab title with a space in the path, with the range colon as %3A", async () => {
		const paths: string[] = [];
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			paths.push(new URL(url).pathname);
			return jsonResponse({
				updatedRange: "'Q1 Budget'!A1:B2",
				clearedRange: "'Q1 Budget'!A1:B2",
				updates: { updatedRange: "'Q1 Budget'!A1:B2" },
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		const range = "'Q1 Budget'!A1:B2";
		await adapter.updateValues({
			domain: "angus",
			spreadsheetId: "s-enc",
			range,
			values: [["x"]],
			valueInput: "RAW",
		});
		await adapter.appendValues({
			domain: "angus",
			spreadsheetId: "s-enc",
			range,
			values: [["x"]],
			valueInput: "RAW",
		});
		await adapter.clearValues({
			domain: "angus",
			spreadsheetId: "s-enc",
			range,
		});

		expect(paths).toEqual([
			"/v4/spreadsheets/s-enc/values/'Q1%20Budget'!A1%3AB2",
			"/v4/spreadsheets/s-enc/values/'Q1%20Budget'!A1%3AB2:append",
			"/v4/spreadsheets/s-enc/values/'Q1%20Budget'!A1%3AB2:clear",
		]);
	});

	it("receipts carry ranges and counts and no cell value", async () => {
		const sentinel = "SENTINEL-CELL-VALUE-DO-NOT-RETURN";
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			return jsonResponse({
				tableRange: "Sheet1!A1:A5",
				updatedRange: "Sheet1!A6",
				updatedRows: 1,
				updatedColumns: 1,
				updatedCells: 1,
				updatedData: { values: [[sentinel]] },
				clearedRange: "Sheet1!A6",
				updates: {
					updatedRange: "Sheet1!A6",
					updatedRows: 1,
					updatedColumns: 1,
					updatedCells: 1,
					updatedData: { values: [[sentinel]] },
				},
			});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		const updateReceipt = await adapter.updateValues({
			domain: "angus",
			spreadsheetId: "s-1",
			range: "Sheet1!A6",
			values: [[sentinel]],
			valueInput: "RAW",
		});
		const appendReceipt = await adapter.appendValues({
			domain: "angus",
			spreadsheetId: "s-1",
			range: "Sheet1!A6",
			values: [[sentinel]],
			valueInput: "RAW",
		});
		const clearReceipt = await adapter.clearValues({
			domain: "angus",
			spreadsheetId: "s-1",
			range: "Sheet1!A6",
		});

		expect(Object.keys(updateReceipt).sort()).toEqual([
			"updatedCells",
			"updatedColumns",
			"updatedRange",
			"updatedRows",
		]);
		expect(Object.keys(appendReceipt).sort()).toEqual([
			"tableRange",
			"updatedCells",
			"updatedColumns",
			"updatedRange",
			"updatedRows",
		]);
		expect(Object.keys(clearReceipt)).toEqual(["clearedRange"]);

		expect(JSON.stringify(updateReceipt)).not.toContain(sentinel);
		expect(JSON.stringify(appendReceipt)).not.toContain(sentinel);
		expect(JSON.stringify(clearReceipt)).not.toContain(sentinel);
	});

	it("rejects NaN and Infinity before any request", async () => {
		const fetchFn = vi.fn() as unknown as typeof fetch;
		const refreshToken = vi.fn(async () => "rt-1");

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken,
			fetchFn,
		});

		await expect(
			adapter.updateValues({
				domain: "angus",
				spreadsheetId: "s-1",
				range: "Sheet1!A1",
				values: [[Number.NaN]],
				valueInput: "RAW",
			}),
		).rejects.toThrow(/NaN/);

		await expect(
			adapter.appendValues({
				domain: "angus",
				spreadsheetId: "s-1",
				range: "Sheet1!A1",
				values: [[Number.POSITIVE_INFINITY]],
				valueInput: "RAW",
			}),
		).rejects.toThrow(/Infinity/);

		await expect(
			adapter.updateValues({
				domain: "angus",
				spreadsheetId: "s-1",
				range: "Sheet1!A1",
				values: [[Number.NEGATIVE_INFINITY]],
				valueInput: "RAW",
			}),
		).rejects.toThrow(/Infinity/);

		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("reads an omitted count as 0 and rejects a response with no clearedRange", async () => {
		let mode: "omitted-counts" | "missing-cleared" | "missing-updated" = "omitted-counts";
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			if (mode === "omitted-counts") {
				return jsonResponse({
					updatedRange: "Sheet1!A1",
					updates: { updatedRange: "Sheet1!A1" },
				});
			}
			return jsonResponse({});
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		const updateReceipt = await adapter.updateValues({
			domain: "angus",
			spreadsheetId: "s-zero",
			range: "Sheet1!A1",
			values: [[null]],
			valueInput: "RAW",
		});
		expect(updateReceipt).toEqual({
			updatedRange: "Sheet1!A1",
			updatedRows: 0,
			updatedColumns: 0,
			updatedCells: 0,
		});

		const appendReceipt = await adapter.appendValues({
			domain: "angus",
			spreadsheetId: "s-zero",
			range: "Sheet1!A1",
			values: [[null]],
			valueInput: "RAW",
		});
		expect(appendReceipt).toEqual({
			updatedRange: "Sheet1!A1",
			updatedRows: 0,
			updatedColumns: 0,
			updatedCells: 0,
		});

		mode = "missing-cleared";
		await expect(
			adapter.clearValues({
				domain: "angus",
				spreadsheetId: "s-zero",
				range: "Sheet1!A1:B2",
			}),
		).rejects.toThrow(/may have landed/);

		mode = "missing-updated";
		await expect(
			adapter.updateValues({
				domain: "angus",
				spreadsheetId: "s-zero",
				range: "Sheet1!A1:B2",
				values: [["x"]],
				valueInput: "RAW",
			}),
		).rejects.toThrow(/may have landed/);
	});

	it("a 400 rejects with status and reason as properties", async () => {
		const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				return jsonResponse({ access_token: "at-1" });
			}
			return jsonResponse(
				{
					error: {
						code: 400,
						message: "Unable to parse range: Bad!Range",
						status: "INVALID_ARGUMENT",
						details: [{ reason: "BAD_REQUEST" }],
					},
				},
				400,
			);
		}) as unknown as typeof fetch;

		const adapter = createGoogleSheetsAdapter({
			clientId: "cid",
			clientSecret: "csecret",
			refreshToken: async () => "rt-1",
			fetchFn,
		});

		await expect(
			adapter.updateValues({
				domain: "angus",
				spreadsheetId: "s-400",
				range: "Bad!Range",
				values: [["v"]],
				valueInput: "RAW",
			}),
		).rejects.toMatchObject({
			name: "SheetsApiError",
			status: 400,
			googleStatus: "INVALID_ARGUMENT",
			reason: "BAD_REQUEST",
		});
	});
});
