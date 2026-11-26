import { z } from "zod";
import { DOMAINS, type Domain } from "../../domain/domains.js";
import type { SheetCellValue, SheetsPort } from "../../ports/sheets.js";
import { defineAction } from "../defineAction.js";
import type { ActionContext, ActionDefinition } from "../types.js";
import {
	explainSheetsError,
	normaliseSpreadsheetId,
	quoteSheetTitle,
	requireSheetsDomain,
} from "./shared.js";

const DEFAULT_MAX_CELLS = 5000;
const MAX_CELLS_CAP = 50000;

export type SheetsReadPort = Pick<SheetsPort, "getSpreadsheet" | "batchGetValues">;

export const sheetsReadInputSchema = z.object({
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
	ranges: z
		.array(z.string().min(1))
		.min(1)
		.max(20)
		.optional()
		.describe("Optional 1 to 20 A1 ranges to read. Omit to list tabs and their grid sizes."),
	value_render_option: z
		.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])
		.optional()
		.describe("How cell values should be rendered (default FORMATTED_VALUE)."),
	max_cells: z
		.number()
		.int()
		.min(1)
		.max(MAX_CELLS_CAP)
		.optional()
		.describe(`Cell budget across all ranges (default ${DEFAULT_MAX_CELLS}, max ${MAX_CELLS_CAP}).`),
});

export type SheetsReadInput = z.infer<typeof sheetsReadInputSchema>;

export interface SheetsReadTabOutput {
	sheet_id: number;
	title: string;
	index: number;
	hidden: boolean;
	type: string;
	rows?: number;
	columns?: number;
}

export interface SheetsReadRangeOutput {
	requested: string;
	range: string;
	values: SheetCellValue[][];
	rows_returned: number;
	truncated: boolean;
	next_range?: string;
}

export interface SheetsReadOutput {
	domain: Domain;
	spreadsheet_id: string;
	title: string;
	url: string;
	tabs: SheetsReadTabOutput[];
	ranges?: SheetsReadRangeOutput[];
}

function buildNextRange(echoedRange: string, firstUnreadOffset: number): string | undefined {
	const bangIdx = echoedRange.lastIndexOf("!");
	const prefix = bangIdx >= 0 ? echoedRange.slice(0, bangIdx + 1) : "";
	const a1 = bangIdx >= 0 ? echoedRange.slice(bangIdx + 1) : echoedRange;
	const match = a1.match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]*)(\d+)?)?$/);
	if (!match) return undefined;
	const startCol = match[1];
	const startRow = Number.parseInt(match[2], 10);
	const nextRow = startRow + firstUnreadOffset;
	if (match[3] !== undefined || match[4] !== undefined) {
		const endPart = `${match[3] ?? ""}${match[4] ?? ""}`;
		return `${prefix}${startCol}${nextRow}:${endPart}`;
	}
	return `${prefix}${startCol}${nextRow}`;
}

/**
 * Format a `SheetsReadOutput` result as human- and agent-readable MCP markdown
 * with tab grid sizes, per-range truncation hints, and the structured JSON payload.
 */
export function formatSheetsReadMcp(result: SheetsReadOutput): string {
	const lines: string[] = [`Spreadsheet "${result.title}" (${result.spreadsheet_id}, domain '${result.domain}'):`];
	for (const tab of result.tabs) {
		const size =
			tab.type === "GRID" && tab.rows !== undefined && tab.columns !== undefined
				? ` (${tab.rows} rows x ${tab.columns} columns)`
				: ` (${tab.type})`;
		const flag = tab.hidden ? " [hidden]" : "";
		lines.push(`- ${tab.title}${size}${flag}`);
	}

	if (result.ranges) {
		for (const r of result.ranges) {
			if (r.truncated) {
				const cont = r.next_range
					? `continue with ranges: ["${r.next_range}"].`
					: "narrow the requested range with explicit row numbers.";
				lines.push(
					`Range ${r.range}: ${r.rows_returned} row(s) returned. Truncated at max_cells: ${cont} Do not treat this read as complete.`,
				);
			} else {
				lines.push(`Range ${r.range}: ${r.rows_returned} row(s) returned.`);
			}
		}
	} else {
		const firstVisible = result.tabs.find((t) => !t.hidden) ?? result.tabs[0];
		if (firstVisible) {
			lines.push(`Hint: pass ranges: ["${quoteSheetTitle(firstVisible.title)}!A1:Z100"] to read cell values.`);
		}
	}

	lines.push("```json", JSON.stringify(result), "```");
	return lines.join("\n");
}

/**
 * Create the `sheets_read` core action backed by the given `SheetsReadPort`.
 * Lists tabs and grid sizes when `ranges` is omitted, or reads up to 20 A1 ranges
 * with explicit `max_cells` truncation and `next_range` continuation hints.
 */
export function createSheetsReadAction(
	port: SheetsReadPort,
): ActionDefinition<typeof sheetsReadInputSchema, SheetsReadOutput> {
	return defineAction({
		id: "sheets_read",
		name: "sheets_read",
		description:
			"Read a Google Sheet in either Google account (`domain` required, no default). " +
			"Without `ranges` it lists every tab with its grid size, hidden tabs flagged. " +
			"With up to 20 A1 `ranges` it returns their values. " +
			"Output past `max_cells` is cut and marked `truncated` with a `next_range` to continue; never treat a truncated read as complete.",
		domain: "integrations",
		schema: sheetsReadInputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp: formatSheetsReadMcp,
		async run(input: SheetsReadInput, _context: ActionContext): Promise<SheetsReadOutput> {
			const domain = requireSheetsDomain(input.domain, "read a Google Sheet");
			const spreadsheetId = normaliseSpreadsheetId(input.spreadsheet_id);
			const valueRender = input.value_render_option ?? "FORMATTED_VALUE";
			const maxCells = input.max_cells ?? DEFAULT_MAX_CELLS;

			const meta = await port
				.getSpreadsheet({ domain, spreadsheetId })
				.catch((err) => explainSheetsError(err, domain));

			const tabs: SheetsReadTabOutput[] = meta.sheets.map((s) => ({
				sheet_id: s.sheetId,
				title: s.title,
				index: s.index,
				hidden: Boolean(s.hidden),
				type: s.sheetType,
				...(s.sheetType === "GRID" ? { rows: s.rowCount ?? 0, columns: s.columnCount ?? 0 } : {}),
			}));

			if (!input.ranges || input.ranges.length === 0) {
				return { domain, spreadsheet_id: meta.spreadsheetId, title: meta.title, url: meta.url, tabs };
			}

			const valueRanges = await port
				.batchGetValues({ domain, spreadsheetId, ranges: input.ranges, valueRender })
				.catch((err) => explainSheetsError(err, domain, meta.sheets.map((s) => s.title)));

			let cellsUsed = 0;
			let budgetExceeded = false;
			const ranges: SheetsReadRangeOutput[] = input.ranges.map((requested, idx) => {
				const echoed = valueRanges[idx]?.range ?? requested;
				const allRows = valueRanges[idx]?.values ?? [];
				const keptRows: SheetCellValue[][] = [];

				if (!budgetExceeded) {
					for (let r = 0; r < allRows.length; r++) {
						const row = allRows[r];
						const rowCells = Math.max(row.length, 1);
						const isVeryFirstRow = idx === 0 && r === 0;
						if (!isVeryFirstRow && cellsUsed + rowCells > maxCells) {
							budgetExceeded = true;
							break;
						}
						keptRows.push(row);
						cellsUsed += rowCells;
					}
				}

				const truncated = budgetExceeded;
				const nextRange = truncated ? buildNextRange(echoed, keptRows.length) : undefined;
				return {
					requested,
					range: echoed,
					values: keptRows,
					rows_returned: keptRows.length,
					truncated,
					...(nextRange ? { next_range: nextRange } : {}),
				};
			});

			return {
				domain,
				spreadsheet_id: meta.spreadsheetId,
				title: meta.title,
				url: meta.url,
				tabs,
				ranges,
			};
		},
	});
}
