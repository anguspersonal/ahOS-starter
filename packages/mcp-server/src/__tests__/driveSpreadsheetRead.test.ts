import { beforeEach, describe, expect, it, vi } from "vitest";

const exportSpy = vi.fn();
const getDriveSpy = vi.fn();

vi.mock("../credentials.js", () => ({
	getCredential: vi.fn(async () => "fake_refresh_token"),
}));

vi.mock("../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../google/oauth.js")>();
	return {
		...actual,
		getOAuth2Client: () => ({ setCredentials: vi.fn() }),
		getGoogleAccessToken: vi.fn(async (_account = "personal") => "fake_sheets_access_token"),
	};
});

vi.mock("googleapis", () => ({
	google: {
		drive: () => ({
			files: {
				export: exportSpy,
				get: vi.fn(),
			},
		}),
	},
}));

import { downloadFileBytes, GOOGLE_EXPORT } from "../google/drive.js";
import { quoteSheetTitle } from "@ahkms/core/adapters";

type FetchCall = { url: string; init?: RequestInit };

function setupFetchStub(responses: Array<{ ok?: boolean; status?: number; data: unknown }>) {
	const calls: FetchCall[] = [];
	let index = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			const current = responses[index++];
			if (!current) {
				throw new Error(`Unexpected fetch call #${index} to ${url}`);
			}
			const ok = current.ok ?? (current.status ? current.status >= 200 && current.status < 300 : true);
			const status = current.status ?? (ok ? 200 : 400);
			return {
				ok,
				status,
				statusText: ok ? "OK" : "Error",
				json: async () => current.data,
				text: async () => (typeof current.data === "string" ? current.data : JSON.stringify(current.data)),
			} as Response;
		}),
	);
	return calls;
}

beforeEach(() => {
	vi.clearAllMocks();
	exportSpy.mockReset();
	exportSpy.mockResolvedValue({ data: Buffer.from("csv,data\n") });
});

describe("driveSpreadsheetRead", () => {
	it("reads every sheet of a two-sheet spreadsheet and never calls files.export", async () => {
		setupFetchStub([
			{
				ok: true,
				status: 200,
				data: {
					spreadsheetId: "sheet-two-tabs",
					spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-two-tabs/edit",
					properties: { title: "Quarterly Report" },
					sheets: [
						{
							properties: {
								sheetId: 0,
								title: "Summary",
								index: 0,
								sheetType: "GRID",
								gridProperties: { rowCount: 2, columnCount: 2 },
							},
						},
						{
							properties: {
								sheetId: 101,
								title: "Details",
								index: 1,
								sheetType: "GRID",
								gridProperties: { rowCount: 2, columnCount: 2 },
							},
						},
					],
				},
			},
			{
				ok: true,
				status: 200,
				data: {
					valueRanges: [
						{
							range: "'Summary'",
							values: [
								["Month", "Revenue"],
								["Jan", "$100"],
							],
						},
						{
							range: "'Details'",
							values: [
								["ID", "Item"],
								["1", "Widget"],
							],
						},
					],
				},
			},
		]);

		const res = await downloadFileBytes(
			"sheet-two-tabs",
			"application/vnd.google-apps.spreadsheet",
			"personal",
		);

		expect(exportSpy).not.toHaveBeenCalled();
		expect(res.mimeType).toBe("text/markdown");
		expect(res.extension).toBe("md");

		const text = res.buffer.toString("utf-8");
		expect(text).toContain("## Summary");
		expect(text).toContain("Month,Revenue");
		expect(text).toContain("Jan,$100");
		expect(text).toContain("## Details");
		expect(text).toContain("ID,Item");
		expect(text).toContain("1,Widget");
	});

	it("renders hidden sheets, empty grid sheets, and non-GRID chart sheets", async () => {
		setupFetchStub([
			{
				ok: true,
				status: 200,
				data: {
					spreadsheetId: "sheet-mixed",
					properties: { title: "Mixed Types" },
					sheets: [
						{
							properties: {
								sheetId: 1,
								title: "HiddenTab",
								index: 0,
								hidden: true,
								sheetType: "GRID",
							},
						},
						{
							properties: {
								sheetId: 2,
								title: "EmptyGrid",
								index: 1,
								hidden: false,
								sheetType: "GRID",
							},
						},
						{
							properties: {
								sheetId: 3,
								title: "Chart1",
								index: 2,
								hidden: false,
								sheetType: "OBJECT",
							},
						},
					],
				},
			},
			{
				ok: true,
				status: 200,
				data: {
					valueRanges: [
						{
							range: "'HiddenTab'",
							values: [["Hidden", "Data"]],
						},
						{
							range: "'EmptyGrid'",
							values: [],
						},
					],
				},
			},
		]);

		const res = await downloadFileBytes(
			"sheet-mixed",
			"application/vnd.google-apps.spreadsheet",
			"personal",
		);

		const text = res.buffer.toString("utf-8");
		expect(text).toContain("## HiddenTab (hidden)");
		expect(text).toContain("Hidden,Data");
		expect(text).toContain("## EmptyGrid\n\n(empty)");
		expect(text).toContain("## Chart1\n\n(chart sheet: no cell data)");
	});

	it("sends a fields mask on both requests and never includeGridData", async () => {
		const calls = setupFetchStub([
			{
				ok: true,
				status: 200,
				data: {
					spreadsheetId: "sheet-fields-mask",
					properties: { title: "Fields Mask Test" },
					sheets: [
						{
							properties: {
								sheetId: 0,
								title: "Tab1",
								index: 0,
								sheetType: "GRID",
							},
						},
					],
				},
			},
			{
				ok: true,
				status: 200,
				data: {
					valueRanges: [
						{
							range: "'Tab1'",
							values: [["A", "B"]],
						},
					],
				},
			},
		]);

		await downloadFileBytes(
			"sheet-fields-mask",
			"application/vnd.google-apps.spreadsheet",
			"personal",
		);

		expect(calls.length).toBe(2);

		const [metaCall, valuesCall] = calls;
		expect(metaCall.url).toContain("fields=");
		expect(metaCall.url).toContain("spreadsheetId");
		expect(metaCall.url).toContain("sheets.properties");
		expect(metaCall.url).not.toContain("includeGridData");

		expect(valuesCall.url).toContain("values:batchGet");
		expect(valuesCall.url).toContain("fields=valueRanges%28range%2Cvalues%29");
		expect(valuesCall.url).toContain("valueRenderOption=FORMATTED_VALUE");
		expect(valuesCall.url).not.toContain("includeGridData");
	});

	it("quotes a sheet title containing a space and an apostrophe", async () => {
		const calls = setupFetchStub([
			{
				ok: true,
				status: 200,
				data: {
					spreadsheetId: "sheet-quote-title",
					properties: { title: "Title Quote Test" },
					sheets: [
						{
							properties: {
								sheetId: 1,
								title: "Don't Panic Costs",
								index: 0,
								sheetType: "GRID",
							},
						},
					],
				},
			},
			{
				ok: true,
				status: 200,
				data: {
					valueRanges: [
						{
							range: "'Don''t Panic Costs'",
							values: [["Cost", "Value"]],
						},
					],
				},
			},
		]);

		await downloadFileBytes(
			"sheet-quote-title",
			"application/vnd.google-apps.spreadsheet",
			"personal",
		);

		expect(calls.length).toBe(2);
		const valuesCall = calls[1];
		const parsedUrl = new URL(valuesCall.url);
		expect(parsedUrl.searchParams.get("ranges")).toBe("'Don''t Panic Costs'");
		expect(quoteSheetTitle("Don't Panic Costs")).toBe("'Don''t Panic Costs'");
	});

	it("escapes a cell containing a comma, a double quote and a newline", async () => {
		setupFetchStub([
			{
				ok: true,
				status: 200,
				data: {
					spreadsheetId: "sheet-escape-cell",
					properties: { title: "Cell Escape Test" },
					sheets: [
						{
							properties: {
								sheetId: 0,
								title: "Escapes",
								index: 0,
								sheetType: "GRID",
							},
						},
					],
				},
			},
			{
				ok: true,
				status: 200,
				data: {
					valueRanges: [
						{
							range: "'Escapes'",
							values: [
								["Header"],
								['Line 1, with "quotes"\nLine 2'],
							],
						},
					],
				},
			},
		]);

		const res = await downloadFileBytes(
			"sheet-escape-cell",
			"application/vnd.google-apps.spreadsheet",
			"personal",
		);

		const text = res.buffer.toString("utf-8");
		expect(text).toContain('"Line 1, with ""quotes""\nLine 2"');
	});

	it("names the account, status and SERVICE_DISABLED reason on a 403", async () => {
		setupFetchStub([
			{
				ok: false,
				status: 403,
				data: {
					error: {
						code: 403,
						message: "Google Sheets API has not been used in project 123456 before or it is disabled.",
						status: "PERMISSION_DENIED",
						details: [
							{
								"@type": "type.googleapis.com/google.rpc.ErrorInfo",
								reason: "SERVICE_DISABLED",
								domain: "googleapis.com",
							},
						],
					},
				},
			},
		]);

		await expect(
			downloadFileBytes(
				"sheet-disabled",
				"application/vnd.google-apps.spreadsheet",
				"personal",
			),
		).rejects.toThrowError(/personal.*403.*SERVICE_DISABLED/s);
	});

	it("propagates a Sheets API failure instead of falling back to export", async () => {
		setupFetchStub([
			{
				ok: false,
				status: 500,
				data: {
					error: {
						code: 500,
						message: "Internal Server Error",
						status: "INTERNAL",
					},
				},
			},
		]);

		await expect(
			downloadFileBytes(
				"sheet-failed",
				"application/vnd.google-apps.spreadsheet",
				"personal",
			),
		).rejects.toThrow();

		expect(exportSpy).not.toHaveBeenCalled();
	});

	it("keeps the spreadsheet type in GOOGLE_EXPORT as text/markdown", () => {
		expect(GOOGLE_EXPORT["application/vnd.google-apps.spreadsheet"]).toEqual({
			mimeType: "text/markdown",
			extension: "md",
		});
	});
});
