import { z } from "zod";
import { DOMAINS } from "../../domain/domains.js";
import type { SheetsPort } from "../../ports/sheets.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import {
	explainSheetsError,
	normaliseSpreadsheetId,
	requireSheetsDomain,
} from "./shared.js";

const MAX_WRITE_CELLS = 10000;

export type SheetsWritePort = Pick<
	SheetsPort,
	"updateValues" | "appendValues" | "clearValues"
>;

const sheetCellInputSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);

export const sheetsWriteInputSchema = z.object({
	domain: z
		.enum(DOMAINS)
		.optional()
		.describe(
			"Required. Which Google account: 'work' (work) or 'angus' (personal). No default (ADR-054 §9).",
		),
	spreadsheet_id: z
		.string()
		.min(1)
		.describe("Bare spreadsheet id or a docs.google.com/spreadsheets/d/<id> URL."),
	mode: z
		.enum(["update", "append", "clear"])
		.describe(
			"Write mode: 'update' writes values at range, 'append' adds rows below the table at range, 'clear' empties values in range (keeping formatting).",
		),
	range: z
		.string()
		.min(1)
		.describe(
			"A1 range, required in every mode. For 'append' it names the table to append below, e.g. \"'Log'!A:D\".",
		),
	values: z
		.array(z.array(sheetCellInputSchema))
		.optional()
		.describe(
			"2D array of cell values (string, number, boolean, or null) for 'update' and 'append'. null leaves that cell as it is (Google skips nulls); \"\" sets it empty. Omit for 'clear'.",
		),
	value_input_option: z
		.enum(["RAW", "USER_ENTERED"])
		.optional()
		.describe(
			"RAW stores what you send, so '=SUM(A1)' stays text. USER_ENTERED parses as if typed in the UI: formulas run (IMPORTXML, IMAGE and IMPORTDATA fetch external URLs) and '1/2' may become a date. Pass it only for a formula you mean.",
		),
});

export type SheetsWriteInput = z.infer<typeof sheetsWriteInputSchema>;

export const sheetsWriteOutputSchema = z.object({
	domain: z.enum(DOMAINS),
	spreadsheet_id: z.string(),
	mode: z.enum(["update", "append", "clear"]),
	value_input_option: z.enum(["RAW", "USER_ENTERED"]).optional(),
	updated_range: z.string().optional(),
	updated_rows: z.number().int().nonnegative().optional(),
	updated_columns: z.number().int().nonnegative().optional(),
	updated_cells: z.number().int().nonnegative().optional(),
	table_range: z.string().optional(),
	cleared_range: z.string().optional(),
});

export type SheetsWriteOutput = z.infer<typeof sheetsWriteOutputSchema>;

/**
 * Formats a `SheetsWriteOutput` receipt into a single-line MCP summary with counts and ranges, never cell values.
 */
export function formatSheetsWriteMcp(result: SheetsWriteOutput): string {
	if (result.mode === "clear") {
		return `Cleared ${result.cleared_range} in ${result.spreadsheet_id} (domain '${result.domain}'). Values only; formatting stays. Restore from the spreadsheet's version history if this was wrong.`;
	}
	const verb = result.mode === "append" ? "Appended" : "Updated";
	const tableClause =
		result.mode === "append" && result.table_range ? ` (table ${result.table_range})` : "";
	return `${verb} ${result.updated_cells} cells (${result.updated_rows} rows x ${result.updated_columns} columns) at ${result.updated_range}${tableClause} in ${result.spreadsheet_id} (domain '${result.domain}', ${result.value_input_option}).`;
}

/**
 * Creates the `sheets_write` core action (`update | append | clear`) backed by a `SheetsPort`.
 */
export function createSheetsWriteAction(
	port: SheetsWritePort,
): ActionDefinition<typeof sheetsWriteInputSchema, SheetsWriteOutput> & { auditLog: true } {
	const action = defineAction({
		id: "sheets_write",
		name: "sheets_write",
		description:
			"Write cell values to a Google Sheet (`domain` required, no default). " +
			"`mode`: update writes `values` at `range` (null leaves a cell as it is); " +
			"append adds rows below the table at `range`; " +
			"clear empties `range`, keeping formatting. " +
			"Values are stored as given (RAW) unless `value_input_option: 'USER_ENTERED'`. " +
			"Returns ranges and counts, never values.",
		domain: "integrations",
		schema: sheetsWriteInputSchema,
		outputSchema: sheetsWriteOutputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp: formatSheetsWriteMcp,
		async run(input: SheetsWriteInput, _context: ActionContext): Promise<SheetsWriteOutput> {
			const domain = requireSheetsDomain(input.domain, "write to a Google Sheet");

			if (input.mode === "update" || input.mode === "append") {
				if (
					!input.values ||
					input.values.length === 0 ||
					input.values.every((row) => row.length === 0)
				) {
					throw new Error(
						`\`values\` is required and must be non-empty when mode is '${input.mode}'.`,
					);
				}
			}

			if (input.mode === "clear") {
				if (input.values !== undefined || input.value_input_option !== undefined) {
					throw new Error(
						"mode 'clear' does not accept `values` or `value_input_option` — clear only empties `range`.",
					);
				}
			}

			const cellCount = (input.values ?? []).reduce((sum, row) => sum + row.length, 0);
			if (cellCount > MAX_WRITE_CELLS) {
				throw new Error(
					`Write payload has ${cellCount} cells, which exceeds the ${MAX_WRITE_CELLS}-cell limit per call. Split the write across several calls.`,
				);
			}

			const spreadsheetId = normaliseSpreadsheetId(input.spreadsheet_id);

			if (input.mode === "clear") {
				const receipt = await port
					.clearValues({ domain, spreadsheetId, range: input.range })
					.catch((err) => explainSheetsError(err, domain));
				return {
					domain,
					spreadsheet_id: spreadsheetId,
					mode: "clear",
					cleared_range: receipt.clearedRange,
				};
			}

			const valueInput = input.value_input_option ?? "RAW";
			const values = input.values!;

			if (input.mode === "update") {
				const receipt = await port
					.updateValues({
						domain,
						spreadsheetId,
						range: input.range,
						values,
						valueInput,
					})
					.catch((err) => explainSheetsError(err, domain));
				return {
					domain,
					spreadsheet_id: spreadsheetId,
					mode: "update",
					value_input_option: valueInput,
					updated_range: receipt.updatedRange,
					updated_rows: receipt.updatedRows,
					updated_columns: receipt.updatedColumns,
					updated_cells: receipt.updatedCells,
				};
			}

			const receipt = await port
				.appendValues({
					domain,
					spreadsheetId,
					range: input.range,
					values,
					valueInput,
				})
				.catch((err) => explainSheetsError(err, domain));
			return {
				domain,
				spreadsheet_id: spreadsheetId,
				mode: "append",
				value_input_option: valueInput,
				updated_range: receipt.updatedRange,
				updated_rows: receipt.updatedRows,
				updated_columns: receipt.updatedColumns,
				updated_cells: receipt.updatedCells,
				...(receipt.tableRange !== undefined ? { table_range: receipt.tableRange } : {}),
			};
		},
	});

	return Object.assign(action, { auditLog: true as const });
}
