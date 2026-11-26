import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import type { ActionAuditRecord, ActionContext } from "../types.js";
import {
	createSheetsWriteAction,
	formatSheetsWriteMcp,
	type SheetsWritePort,
} from "./write.js";

const ctx: ActionContext = { caller: "mcp", userId: "owner-1", requestId: "req-1" };

function makeFakePort(overrides?: Partial<SheetsWritePort>): SheetsWritePort {
	return {
		updateValues: vi.fn(async ({ range, values }) => ({
			updatedRange: range,
			updatedRows: values.length,
			updatedColumns: values[0]?.length ?? 0,
			updatedCells: values.reduce((sum, r) => sum + r.length, 0),
		})),
		appendValues: vi.fn(async ({ range, values }) => ({
			tableRange: range,
			updatedRange: "'Log'!A11:D11",
			updatedRows: values.length,
			updatedColumns: values[0]?.length ?? 0,
			updatedCells: values.reduce((sum, r) => sum + r.length, 0),
		})),
		clearValues: vi.fn(async ({ range }) => ({
			clearedRange: range,
		})),
		...overrides,
	};
}

describe("sheets_write action (#1437)", () => {
	it("refuses a call with no domain before calling the port", async () => {
		const port = makeFakePort();
		const action = createSheetsWriteAction(port);

		await expect(
			action.run(
				{
					spreadsheet_id: "sheet_123",
					mode: "update",
					range: "'Log'!A1:B1",
					values: [["a", "b"]],
				},
				ctx,
			),
		).rejects.toThrow(/`domain` is required/);

		expect(port.updateValues).not.toHaveBeenCalled();
		expect(port.appendValues).not.toHaveBeenCalled();
		expect(port.clearValues).not.toHaveBeenCalled();
	});

	it("sends RAW when value_input_option is omitted and USER_ENTERED only when passed", async () => {
		const port = makeFakePort();
		const action = createSheetsWriteAction(port);

		const rawRes = await action.run(
			{
				domain: "angus",
				spreadsheet_id: "https://docs.google.com/spreadsheets/d/sheet_123/edit#gid=0",
				mode: "update",
				range: "'Log'!A2:B2",
				values: [["=SUM(A1)", 42]],
			},
			ctx,
		);

		expect(port.updateValues).toHaveBeenCalledWith({
			domain: "angus",
			spreadsheetId: "sheet_123",
			range: "'Log'!A2:B2",
			values: [["=SUM(A1)", 42]],
			valueInput: "RAW",
		});
		expect(rawRes.value_input_option).toBe("RAW");

		const enteredRes = await action.run(
			{
				domain: "work",
				spreadsheet_id: "sheet_123",
				mode: "append",
				range: "'Log'!A:B",
				values: [["=SUM(A1)", 42]],
				value_input_option: "USER_ENTERED",
			},
			ctx,
		);

		expect(port.appendValues).toHaveBeenCalledWith({
			domain: "work",
			spreadsheetId: "sheet_123",
			range: "'Log'!A:B",
			values: [["=SUM(A1)", 42]],
			valueInput: "USER_ENTERED",
		});
		expect(enteredRes.value_input_option).toBe("USER_ENTERED");
		expect(enteredRes.table_range).toBe("'Log'!A:B");
	});

	it("requires values for update and append and refuses values and value_input_option for clear", async () => {
		const port = makeFakePort();
		const action = createSheetsWriteAction(port);

		await expect(
			action.run(
				{ domain: "angus", spreadsheet_id: "sheet_123", mode: "update", range: "'Log'!A1" },
				ctx,
			),
		).rejects.toThrow(/`values` is required/);

		await expect(
			action.run(
				{
					domain: "angus",
					spreadsheet_id: "sheet_123",
					mode: "append",
					range: "'Log'!A:B",
					values: [],
				},
				ctx,
			),
		).rejects.toThrow(/`values` is required/);

		await expect(
			action.run(
				{
					domain: "angus",
					spreadsheet_id: "sheet_123",
					mode: "clear",
					range: "'Log'!A1:B2",
					values: [["x"]],
				},
				ctx,
			),
		).rejects.toThrow(/values/);

		await expect(
			action.run(
				{
					domain: "angus",
					spreadsheet_id: "sheet_123",
					mode: "clear",
					range: "'Log'!A1:B2",
					value_input_option: "RAW",
				},
				ctx,
			),
		).rejects.toThrow(/value_input_option/);

		expect(port.updateValues).not.toHaveBeenCalled();
		expect(port.appendValues).not.toHaveBeenCalled();
		expect(port.clearValues).not.toHaveBeenCalled();
	});

	it("refuses more than 10000 cells before calling the port", async () => {
		const port = makeFakePort();
		const action = createSheetsWriteAction(port);
		const bigRow = Array.from({ length: 100 }, () => "x");
		const values = Array.from({ length: 101 }, () => bigRow);

		await expect(
			action.run(
				{
					domain: "angus",
					spreadsheet_id: "sheet_123",
					mode: "update",
					range: "'Log'!A1",
					values,
				},
				ctx,
			),
		).rejects.toThrow(/10100.*several calls/i);

		expect(port.updateValues).not.toHaveBeenCalled();
	});

	it("passes null cells through to the port unchanged", async () => {
		const port = makeFakePort();
		const action = createSheetsWriteAction(port);

		await action.run(
			{
				domain: "angus",
				spreadsheet_id: "sheet_123",
				mode: "update",
				range: "'Log'!A2:D2",
				values: [[null, "keep-adjacent", "", false]],
			},
			ctx,
		);

		expect(port.updateValues).toHaveBeenCalledWith({
			domain: "angus",
			spreadsheetId: "sheet_123",
			range: "'Log'!A2:D2",
			values: [[null, "keep-adjacent", "", false]],
			valueInput: "RAW",
		});
	});

	it("keeps cell values out of the output and the MCP text", async () => {
		const sentinel = "SENTINEL_CELL_SECRET_9941";
		const port = makeFakePort();
		const action = createSheetsWriteAction(port);

		const updateOut = await action.run(
			{
				domain: "angus",
				spreadsheet_id: "sheet_123",
				mode: "update",
				range: "'Log'!A2:D4",
				values: [
					[sentinel, "b", "c", "d"],
					["e", "f", "g", "h"],
					["i", "j", "k", "l"],
				],
			},
			ctx,
		);

		const updateText = formatSheetsWriteMcp(updateOut);
		expect(JSON.stringify(updateOut)).not.toContain(sentinel);
		expect(updateText).not.toContain(sentinel);
		expect(updateText).toBe(
			"Updated 12 cells (3 rows x 4 columns) at 'Log'!A2:D4 in sheet_123 (domain 'angus', RAW).",
		);

		const clearOut = await action.run(
			{
				domain: "angus",
				spreadsheet_id: "sheet_123",
				mode: "clear",
				range: "'Log'!A2:D4",
			},
			ctx,
		);
		const clearText = formatSheetsWriteMcp(clearOut);
		expect(clearText).toContain("Values only; formatting stays.");
		expect(clearText).toContain("version history");
	});

	it("names the other domain on a 404 carried only as a status property", async () => {
		const rawErr = Object.assign(new Error("not found"), { status: 404 });
		const port = makeFakePort({
			updateValues: vi.fn(async () => {
				throw rawErr;
			}),
		});
		const action = createSheetsWriteAction(port);

		let caught: (Error & { status?: number; cause?: unknown }) | undefined;
		try {
			await action.run(
				{
					domain: "angus",
					spreadsheet_id: "sheet_123",
					mode: "update",
					range: "'Log'!A1",
					values: [["v"]],
				},
				ctx,
			);
		} catch (err) {
			caught = err as Error & { status?: number; cause?: unknown };
		}

		expect(caught).toBeDefined();
		expect(caught!.status).toBe(404);
		expect(caught!.cause).toBe(rawErr);
		expect(caught!.message).toMatch(/work/);
	});

	it("is destructive, not read-only, not idempotent, and audit-logged", async () => {
		const sentinel = "SENTINEL_AUDIT_SECRET_7782";
		const port = makeFakePort();
		const action = createSheetsWriteAction(port);

		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(action.auditLog).toBe(true);

		const records: ActionAuditRecord[] = [];
		await executeAction(
			action,
			{
				domain: "angus",
				spreadsheet_id: "sheet_123",
				mode: "update",
				range: "'Log'!A1",
				values: [[sentinel]],
			},
			{
				context: ctx,
				auditSink: (rec) => {
					records.push(rec);
				},
			},
		);

		expect(records).toHaveLength(1);
		expect(records[0].actionId).toBe("sheets_write");
		expect(records[0].outcome).toBe("success");
		expect(JSON.stringify(records[0])).not.toContain(sentinel);
	});
});
