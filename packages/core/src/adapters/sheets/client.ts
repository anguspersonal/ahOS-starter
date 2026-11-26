/**
 * @ahkms/core/adapters/sheets/client
 *
 * Lightweight, isomorphic Google Sheets v4 client using plain fetch (ADR-101 §1).
 * Takes pre-resolved accessToken and label; performs no credentials resolution,
 * env reading, or Node-specific calls.
 */

import type {
	SheetCellValue,
	SheetInputCell,
	SheetsAppendReceipt,
	SheetsClearReceipt,
	SheetsWriteReceipt,
	SheetTab,
	SheetValueInput,
	SheetValueRange,
	SheetValueRender,
	SpreadsheetMetadata,
} from "../../ports/sheets.js";

export type {
	SheetCellValue,
	SheetInputCell,
	SheetsAppendReceipt,
	SheetsClearReceipt,
	SheetsWriteReceipt,
	SheetTab,
	SheetValueInput,
	SheetValueRange,
	SheetValueRender,
	SpreadsheetMetadata,
} from "../../ports/sheets.js";

export interface SheetsClientOptions {
	accessToken: string;
	label: string;
	fetchFn?: typeof fetch;
}

export class SheetsApiError extends Error {
	readonly status: number;
	readonly googleStatus?: string;
	readonly reason?: string;

	constructor(
		message: string,
		status: number,
		googleStatus?: string,
		reason?: string,
	) {
		super(message);
		this.name = "SheetsApiError";
		this.status = status;
		this.googleStatus = googleStatus;
		this.reason = reason;
	}
}

/**
 * Encloses a sheet title in single quotes, doubling any embedded single quotes.
 * RFC-style escaping for Google Sheets range names containing spaces/punctuation.
 */
export function quoteSheetTitle(title: string): string {
	return `'${title.replace(/'/g, "''")}'`;
}

interface RawGoogleSheetProperties {
	sheetId?: number;
	title?: string;
	index?: number;
	hidden?: boolean;
	sheetType?: string;
	gridProperties?: {
		rowCount?: number;
		columnCount?: number;
	};
}

interface RawGoogleSpreadsheet {
	spreadsheetId?: string;
	spreadsheetUrl?: string;
	properties?: {
		title?: string;
	};
	sheets?: Array<{
		properties?: RawGoogleSheetProperties;
	}>;
}

interface RawGoogleBatchGetValues {
	spreadsheetId?: string;
	valueRanges?: Array<{
		range?: string;
		majorDimension?: string;
		values?: SheetCellValue[][];
	}>;
}

interface RawGoogleUpdateValuesResponse {
	updatedRange?: string;
	updatedRows?: number;
	updatedColumns?: number;
	updatedCells?: number;
}

interface RawGoogleAppendValuesResponse {
	tableRange?: string;
	updates?: RawGoogleUpdateValuesResponse;
}

interface RawGoogleClearValuesResponse {
	clearedRange?: string;
}

export function assertFiniteInputCells(values: SheetInputCell[][]): void {
	for (let r = 0; r < values.length; r++) {
		const row = values[r];
		for (let c = 0; c < row.length; c++) {
			const cell = row[c];
			if (typeof cell === "number" && !Number.isFinite(cell)) {
				throw new Error(
					`Non-finite number (${String(cell)}) at row ${r}, column ${c} cannot be sent to Google Sheets`,
				);
			}
		}
	}
}

async function sheetsRequest<T>(
	method: string,
	path: string,
	query: URLSearchParams | undefined,
	opts: SheetsClientOptions,
	spreadsheetId?: string,
	body?: unknown,
): Promise<T> {
	const fetchFn = opts.fetchFn ?? globalThis.fetch;
	const cleanPath = path.replace(/^\//, "");
	const queryString = query ? `?${query.toString()}` : "";
	const url = `https://sheets.googleapis.com/v4/${cleanPath}${queryString}`;

	const headers: Record<string, string> = {
		Authorization: `Bearer ${opts.accessToken}`,
	};
	let bodyStr: string | undefined;
	if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		bodyStr = JSON.stringify(body);
	}

	const res = await fetchFn(url, {
		method,
		headers,
		body: bodyStr,
	});

	if (!res.ok) {
		const rawText = await res.text();
		let googleStatus: string | undefined;
		let reason: string | undefined;
		let detailMsg = rawText;

		try {
			const json = JSON.parse(rawText);
			if (json && typeof json === "object" && json.error) {
				googleStatus = json.error.status;
				if (Array.isArray(json.error.details) && json.error.details.length > 0) {
					reason = json.error.details[0]?.reason;
				}
				if (json.error.message) {
					detailMsg = json.error.message;
				}
			}
		} catch {
			// keep rawText as detailMsg
		}

		const targetId = spreadsheetId ?? path.match(/spreadsheets\/([^/?]+)/)?.[1] ?? "(unknown)";
		const statusBits = [
			`account '${opts.label}'`,
			`spreadsheet '${targetId}'`,
			`HTTP ${res.status}`,
			googleStatus ? `googleStatus: ${googleStatus}` : undefined,
			reason ? `reason: ${reason}` : undefined,
		].filter(Boolean).join(", ");

		throw new SheetsApiError(
			`Google Sheets API request failed for ${statusBits}: ${detailMsg}`,
			res.status,
			googleStatus,
			reason,
		);
	}

	return (await res.json()) as T;
}

/**
 * Reads spreadsheet metadata (id, title, url, sheets properties) without cell data.
 */
export async function getSpreadsheetMetadata(
	spreadsheetId: string,
	opts: SheetsClientOptions,
): Promise<SpreadsheetMetadata> {
	const params = new URLSearchParams();
	params.set(
		"fields",
		"spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title,index,hidden,sheetType,gridProperties(rowCount,columnCount))",
	);

	const data = await sheetsRequest<RawGoogleSpreadsheet>(
		"GET",
		`spreadsheets/${encodeURIComponent(spreadsheetId)}`,
		params,
		opts,
		spreadsheetId,
	);

	const rawSheets = data.sheets ?? [];
	const sheets: SheetTab[] = rawSheets
		.map((s) => {
			const p = s.properties ?? {};
			return {
				sheetId: p.sheetId ?? 0,
				title: p.title ?? "",
				index: p.index ?? 0,
				hidden: Boolean(p.hidden),
				sheetType: p.sheetType ?? "GRID",
				rowCount: p.gridProperties?.rowCount,
				columnCount: p.gridProperties?.columnCount,
			};
		})
		.sort((a, b) => a.index - b.index);

	return {
		spreadsheetId: data.spreadsheetId ?? spreadsheetId,
		title: data.properties?.title ?? "",
		url: data.spreadsheetUrl ?? "",
		sheets,
	};
}

/**
 * Reads values for multiple ranges via values:batchGet in batches of at most 50 ranges.
 */
export async function batchGetValues(
	spreadsheetId: string,
	ranges: string[],
	valueRender: SheetValueRender,
	opts: SheetsClientOptions,
): Promise<SheetValueRange[]> {
	if (ranges.length === 0) {
		return [];
	}

	const results: SheetValueRange[] = [];
	const BATCH_SIZE = 50;

	for (let i = 0; i < ranges.length; i += BATCH_SIZE) {
		const batch = ranges.slice(i, i + BATCH_SIZE);
		const params = new URLSearchParams();
		for (const r of batch) {
			params.append("ranges", r);
		}
		params.set("valueRenderOption", valueRender);
		params.set("dateTimeRenderOption", "FORMATTED_STRING");
		params.set("majorDimension", "ROWS");
		params.set("fields", "valueRanges(range,values)");

		const data = await sheetsRequest<RawGoogleBatchGetValues>(
			"GET",
			`spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`,
			params,
			opts,
			spreadsheetId,
		);

		const valueRanges = data.valueRanges ?? [];
		if (valueRanges.length !== batch.length) {
			throw new SheetsApiError(
				`Google Sheets API batchGetValues for account '${opts.label}', spreadsheet '${spreadsheetId}' returned ${valueRanges.length} ranges, expected ${batch.length}`,
				200,
			);
		}

		for (let j = 0; j < batch.length; j++) {
			const vr = valueRanges[j];
			results.push({
				range: vr.range ?? batch[j],
				values: vr.values ?? [],
			});
		}
	}

	return results;
}

/**
 * Updates cell values in a single range, returning only range and count metadata.
 */
export async function updateValues(
	spreadsheetId: string,
	range: string,
	values: SheetInputCell[][],
	valueInput: SheetValueInput,
	opts: SheetsClientOptions,
): Promise<SheetsWriteReceipt> {
	assertFiniteInputCells(values);

	const params = new URLSearchParams();
	params.set("valueInputOption", valueInput);
	params.set("includeValuesInResponse", "false");
	params.set("fields", "updatedRange,updatedRows,updatedColumns,updatedCells");

	const data = await sheetsRequest<RawGoogleUpdateValuesResponse>(
		"PUT",
		`spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
		params,
		opts,
		spreadsheetId,
		{ majorDimension: "ROWS", values },
	);

	if (!data || typeof data.updatedRange !== "string" || data.updatedRange.length === 0) {
		throw new Error(
			`Google Sheets API updateValues response for spreadsheet '${spreadsheetId}' omitted updatedRange; the write may have landed`,
		);
	}

	return {
		updatedRange: data.updatedRange,
		updatedRows: data.updatedRows ?? 0,
		updatedColumns: data.updatedColumns ?? 0,
		updatedCells: data.updatedCells ?? 0,
	};
}

/**
 * Appends rows to a table in a range using INSERT_ROWS, returning only range and count metadata.
 */
export async function appendValues(
	spreadsheetId: string,
	range: string,
	values: SheetInputCell[][],
	valueInput: SheetValueInput,
	opts: SheetsClientOptions,
): Promise<SheetsAppendReceipt> {
	assertFiniteInputCells(values);

	const params = new URLSearchParams();
	params.set("valueInputOption", valueInput);
	params.set("insertDataOption", "INSERT_ROWS");
	params.set("includeValuesInResponse", "false");
	params.set(
		"fields",
		"tableRange,updates(updatedRange,updatedRows,updatedColumns,updatedCells)",
	);

	const data = await sheetsRequest<RawGoogleAppendValuesResponse>(
		"POST",
		`spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append`,
		params,
		opts,
		spreadsheetId,
		{ majorDimension: "ROWS", values },
	);

	const updates = data?.updates;
	if (!updates || typeof updates.updatedRange !== "string" || updates.updatedRange.length === 0) {
		throw new Error(
			`Google Sheets API appendValues response for spreadsheet '${spreadsheetId}' omitted updatedRange; the write may have landed`,
		);
	}

	const receipt: SheetsAppendReceipt = {
		updatedRange: updates.updatedRange,
		updatedRows: updates.updatedRows ?? 0,
		updatedColumns: updates.updatedColumns ?? 0,
		updatedCells: updates.updatedCells ?? 0,
	};
	if (typeof data.tableRange === "string" && data.tableRange.length > 0) {
		receipt.tableRange = data.tableRange;
	}
	return receipt;
}

/**
 * Clears values in a range, returning only the clearedRange receipt.
 */
export async function clearValues(
	spreadsheetId: string,
	range: string,
	opts: SheetsClientOptions,
): Promise<SheetsClearReceipt> {
	const params = new URLSearchParams();
	params.set("fields", "clearedRange");

	const data = await sheetsRequest<RawGoogleClearValuesResponse>(
		"POST",
		`spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:clear`,
		params,
		opts,
		spreadsheetId,
		{},
	);

	if (!data || typeof data.clearedRange !== "string" || data.clearedRange.length === 0) {
		throw new Error(
			`Google Sheets API clearValues response for spreadsheet '${spreadsheetId}' omitted clearedRange; the write may have landed`,
		);
	}

	return {
		clearedRange: data.clearedRange,
	};
}

