import { describe, expect, it, vi } from "vitest";
import type { ActionContext } from "../types.js";
import { createSheetsReadAction, formatSheetsReadMcp, type SheetsReadPort } from "./read.js";

const ctx: ActionContext = { caller: "mcp", userId: "owner-1", requestId: "req-1" };

function makeFakePort(overrides?: Partial<SheetsReadPort>): SheetsReadPort {
	return {
		getSpreadsheet: vi.fn(async ({ spreadsheetId }) => ({
			spreadsheetId,
			title: "Ops Sheet",
			url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
			sheets: [
				{ sheetId: 0, title: "Log", index: 0, hidden: false, sheetType: "GRID", rowCount: 100, columnCount: 5 },
				{ sheetId: 1, title: "Archive '26", index: 1, hidden: true, sheetType: "GRID", rowCount: 50, columnCount: 3 },
				{ sheetId: 2, title: "Overview Chart", index: 2, hidden: false, sheetType: "OBJECT" },
			],
		})),
		batchGetValues: vi.fn(async () => []),
		...overrides,
	};
}

describe("sheets_read action (#1435)", () => {
	it("refuses a call with no domain before calling the port", async () => {
		const port = makeFakePort();
		const action = createSheetsReadAction(port);

		await expect(
			action.run({ spreadsheet_id: "sheet_123" }, ctx),
		).rejects.toThrow(/`domain` is required/);
		expect(port.getSpreadsheet).not.toHaveBeenCalled();
	});

	it("accepts a docs.google.com spreadsheet URL", async () => {
		const port = makeFakePort();
		const action = createSheetsReadAction(port);

		const res = await action.run(
			{
				domain: "angus",
				spreadsheet_id: "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0",
			},
			ctx,
		);

		expect(port.getSpreadsheet).toHaveBeenCalledWith({
			domain: "angus",
			spreadsheetId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
		});
		expect(res.spreadsheet_id).toBe("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
	});

	it("lists every tab with rows and columns, hidden ones flagged, when no ranges are given", async () => {
		const port = makeFakePort();
		const action = createSheetsReadAction(port);

		const res = await action.run({ domain: "work", spreadsheet_id: "sheet_123" }, ctx);

		expect(port.batchGetValues).not.toHaveBeenCalled();
		expect(res.tabs).toEqual([
			{ sheet_id: 0, title: "Log", index: 0, hidden: false, type: "GRID", rows: 100, columns: 5 },
			{ sheet_id: 1, title: "Archive '26", index: 1, hidden: true, type: "GRID", rows: 50, columns: 3 },
			{ sheet_id: 2, title: "Overview Chart", index: 2, hidden: false, type: "OBJECT" },
		]);
		const mcpText = formatSheetsReadMcp(res);
		expect(mcpText).toContain("Log (100 rows x 5 columns)");
		expect(mcpText).toContain("Archive '26 (50 rows x 3 columns) [hidden]");
		expect(mcpText).toContain("'Log'!A1:Z100");
	});

	it("marks truncation with next_range when max_cells is exceeded", async () => {
		const tenRows = Array.from({ length: 10 }, (_, i) => [`r${i + 1}a`, `r${i + 1}b`, `r${i + 1}c`]);
		const port = makeFakePort({
			batchGetValues: vi.fn(async () => [{ range: "'Log'!A1:C10", values: tenRows }]),
		});
		const action = createSheetsReadAction(port);

		const res = await action.run(
			{ domain: "angus", spreadsheet_id: "sheet_123", ranges: ["'Log'!A1:C10"], max_cells: 12 },
			ctx,
		);

		expect(res.ranges).toHaveLength(1);
		expect(res.ranges![0].rows_returned).toBe(4);
		expect(res.ranges![0].values).toHaveLength(4);
		expect(res.ranges![0].truncated).toBe(true);
		expect(res.ranges![0].next_range).toBe("'Log'!A5:C10");
		const mcpText = formatSheetsReadMcp(res);
		expect(mcpText).toContain("Truncated at max_cells: continue with ranges: [\"'Log'!A5:C10\"]. Do not treat this read as complete.");
	});

	it("returns the first row even when it alone exceeds max_cells", async () => {
		const port = makeFakePort({
			batchGetValues: vi.fn(async () => [
				{
					range: "'Log'!A1:E2",
					values: [
						["a", "b", "c", "d", "e"],
						["f", "g", "h", "i", "j"],
					],
				},
			]),
		});
		const action = createSheetsReadAction(port);

		const res = await action.run(
			{ domain: "angus", spreadsheet_id: "sheet_123", ranges: ["'Log'!A1:E2"], max_cells: 2 },
			ctx,
		);

		expect(res.ranges![0].rows_returned).toBe(1);
		expect(res.ranges![0].values).toEqual([["a", "b", "c", "d", "e"]]);
		expect(res.ranges![0].truncated).toBe(true);
		expect(res.ranges![0].next_range).toBe("'Log'!A2:E2");
	});

	it("passes FORMULA through to the port", async () => {
		const port = makeFakePort({
			batchGetValues: vi.fn(async () => [{ range: "'Log'!A1:B1", values: [["=SUM(C1:C5)", 10]] }]),
		});
		const action = createSheetsReadAction(port);

		const res = await action.run(
			{
				domain: "angus",
				spreadsheet_id: "sheet_123",
				ranges: ["'Log'!A1:B1"],
				value_render_option: "FORMULA",
			},
			ctx,
		);

		expect(port.batchGetValues).toHaveBeenCalledWith({
			domain: "angus",
			spreadsheetId: "sheet_123",
			ranges: ["'Log'!A1:B1"],
			valueRender: "FORMULA",
		});
		expect(res.ranges![0].truncated).toBe(false);
	});

	it.each([
		{
			label: "404 names the other domain",
			stage: "meta" as const,
			status: 404,
			reason: undefined,
			expectedMatch: /work/,
		},
		{
			label: "403 SERVICE_DISABLED names the console step",
			stage: "meta" as const,
			status: 403,
			reason: "SERVICE_DISABLED",
			expectedMatch: /GOOGLE_CLIENT_ID/,
		},
		{
			label: "400 from values read lists the tab titles",
			stage: "values" as const,
			status: 400,
			reason: " badRequest ",
			expectedMatch: /'Log', 'Archive ''26', 'Overview Chart'/,
		},
	])("explains errors by status and reason, never by message: $label", async ({ stage, status, reason, expectedMatch }) => {
		const rawErr = Object.assign(new Error("boom"), { status, ...(reason ? { reason } : {}) });
		const port = makeFakePort(
			stage === "meta"
				? { getSpreadsheet: vi.fn(async () => { throw rawErr; }) }
				: { batchGetValues: vi.fn(async () => { throw rawErr; }) },
		);
		const action = createSheetsReadAction(port);

		let caught: (Error & { status?: number; cause?: unknown }) | undefined;
		try {
			await action.run({ domain: "angus", spreadsheet_id: "sheet_123", ranges: ["Bad!A1"] }, ctx);
		} catch (err) {
			caught = err as Error & { status?: number; cause?: unknown };
		}

		expect(caught).toBeDefined();
		expect(caught!.status).toBe(status);
		expect(caught!.cause).toBe(rawErr);
		expect(caught!.message).toMatch(expectedMatch);
	});
});
