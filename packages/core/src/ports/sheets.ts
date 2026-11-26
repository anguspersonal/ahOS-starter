import type { Domain } from "../domain/domains.js";

export type SheetCellValue = string | number | boolean | null;
export type SheetInputCell = string | number | boolean | null;
export type SheetValueRender = "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA";
export type SheetValueInput = "RAW" | "USER_ENTERED";

export interface SheetTab {
	sheetId: number;
	title: string;
	index: number;
	hidden: boolean;
	sheetType: string;
	rowCount?: number;
	columnCount?: number;
}

export interface SpreadsheetMetadata {
	spreadsheetId: string;
	title: string;
	url: string;
	sheets: SheetTab[];
}

export interface SheetValueRange {
	range: string;
	values: SheetCellValue[][];
}

export interface SheetsWriteReceipt {
	updatedRange: string;
	updatedRows: number;
	updatedColumns: number;
	updatedCells: number;
}

export interface SheetsAppendReceipt extends SheetsWriteReceipt {
	tableRange?: string;
}

export interface SheetsClearReceipt {
	clearedRange: string;
}

export interface SheetsApiError extends Error {
	name: "SheetsApiError";
	status: number;
	googleStatus?: string;
	reason?: string;
}

export interface GetSpreadsheetParams {
	domain: Domain;
	spreadsheetId: string;
}

export interface BatchGetValuesParams {
	domain: Domain;
	spreadsheetId: string;
	ranges: string[];
	valueRender: SheetValueRender;
}

export interface UpdateValuesParams {
	domain: Domain;
	spreadsheetId: string;
	range: string;
	values: SheetInputCell[][];
	valueInput: SheetValueInput;
}

export type AppendValuesParams = UpdateValuesParams;

export interface ClearValuesParams {
	domain: Domain;
	spreadsheetId: string;
	range: string;
}

export interface SheetsPort {
	getSpreadsheet(params: GetSpreadsheetParams): Promise<SpreadsheetMetadata>;
	batchGetValues(params: BatchGetValuesParams): Promise<SheetValueRange[]>;
	updateValues(params: UpdateValuesParams): Promise<SheetsWriteReceipt>;
	appendValues(params: AppendValuesParams): Promise<SheetsAppendReceipt>;
	clearValues(params: ClearValuesParams): Promise<SheetsClearReceipt>;
}

