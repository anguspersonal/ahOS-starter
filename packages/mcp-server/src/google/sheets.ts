import {
	batchGetValues,
	getSpreadsheetMetadata,
	quoteSheetTitle,
	type SheetTab,
} from "@ahkms/core/adapters";
import { getGoogleAccessToken } from "./oauth.js";
import { DEFAULT_GOOGLE_ACCOUNT, type GoogleAccount } from "./accounts.js";

export interface ReadSpreadsheetSheet {
	sheetId: number;
	title: string;
	index: number;
	hidden: boolean;
	sheetType: string;
	values: string[][];
}

export interface ReadSpreadsheetResult {
	title: string;
	sheets: ReadSpreadsheetSheet[];
	text: string;
}

/**
 * Escapes a single cell value per RFC 4180:
 * A field containing a comma, a double quote, CR or LF is double-quoted,
 * with embedded quotes doubled.
 */
function escapeCsvField(val: string): string {
	if (
		val.includes(",") ||
		val.includes('"') ||
		val.includes("\n") ||
		val.includes("\r")
	) {
		return `"${val.replace(/"/g, '""')}"`;
	}
	return val;
}

/**
 * Renders an array of sheets into markdown format.
 * Each sheet gets a `## <sheet title>` heading (with ` (hidden)` appended when hidden),
 * followed by a fenced `csv` block of RFC 4180 lines, `(empty)`, or
 * `(chart sheet: no cell data)`.
 */
export function renderSpreadsheetMarkdown(sheets: ReadSpreadsheetSheet[]): string {
	if (sheets.length === 0) {
		return "(empty)";
	}

	const sections = sheets.map((sheet) => {
		const heading = sheet.hidden
			? `## ${sheet.title} (hidden)`
			: `## ${sheet.title}`;

		if (sheet.sheetType !== "GRID") {
			return `${heading}\n\n(chart sheet: no cell data)`;
		}

		if (
			sheet.values.length === 0 ||
			sheet.values.every((row) => row.length === 0)
		) {
			return `${heading}\n\n(empty)`;
		}

		const csvLines = sheet.values.map((row) =>
			row.map(escapeCsvField).join(","),
		);
		return `${heading}\n\n\`\`\`csv\n${csvLines.join("\n")}\n\`\`\``;
	});

	return sections.join("\n\n");
}

/**
 * Reads every sheet of a Google Spreadsheet using the Sheets API v4.
 * Reads all GRID sheets at FORMATTED_VALUE by their quoted titles.
 * Returns metadata and cell values in index order, along with rendered markdown text.
 */
export async function readSpreadsheet(
	spreadsheetId: string,
	account: GoogleAccount = DEFAULT_GOOGLE_ACCOUNT,
): Promise<ReadSpreadsheetResult> {
	const token = await getGoogleAccessToken(account, "Google Sheets");
	const clientOpts = { accessToken: token, label: account };

	const meta = await getSpreadsheetMetadata(spreadsheetId, clientOpts);
	const gridSheets = meta.sheets.filter((s: SheetTab) => s.sheetType === "GRID");

	let valueRangesMap = new Map<string, string[][]>();
	if (gridSheets.length > 0) {
		const ranges = gridSheets.map((s: SheetTab) => quoteSheetTitle(s.title));
		const valueRanges = await batchGetValues(
			spreadsheetId,
			ranges,
			"FORMATTED_VALUE",
			clientOpts,
		);

		for (let i = 0; i < gridSheets.length; i++) {
			const sheet = gridSheets[i];
			const vr = valueRanges[i];
			const rawRows = vr?.values ?? [];
			const rows: string[][] = rawRows.map((row) =>
				row.map((cell) => (cell == null ? "" : String(cell))),
			);
			valueRangesMap.set(sheet.title, rows);
		}
	}

	const sheets: ReadSpreadsheetSheet[] = meta.sheets.map((s: SheetTab) => ({
		sheetId: s.sheetId,
		title: s.title,
		index: s.index,
		hidden: s.hidden,
		sheetType: s.sheetType,
		values: valueRangesMap.get(s.title) ?? [],
	}));

	const text = renderSpreadsheetMarkdown(sheets);

	return {
		title: meta.title || "(untitled)",
		sheets,
		text,
	};
}
