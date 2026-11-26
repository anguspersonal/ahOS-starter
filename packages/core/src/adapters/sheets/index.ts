/**
 * @ahkms/core/adapters/sheets
 *
 * Google Sheets adapter implementing SheetsPort (ADR-101 §1, ADR-045, Issue #1434).
 * Resolves the domain's refresh token per call, exchanges it for an access token,
 * and delegates to the lightweight fetch-based Sheets v4 client.
 */

import type { Domain } from "../../domain/domains.js";
import type {
	AppendValuesParams,
	BatchGetValuesParams,
	ClearValuesParams,
	GetSpreadsheetParams,
	SheetsAppendReceipt,
	SheetsClearReceipt,
	SheetsPort,
	SheetsWriteReceipt,
	SheetValueRange,
	SpreadsheetMetadata,
	UpdateValuesParams,
} from "../../ports/sheets.js";
import { createGoogleTokenSource } from "../google/tokenSource.js";
import {
	appendValues,
	assertFiniteInputCells,
	batchGetValues,
	clearValues,
	getSpreadsheetMetadata,
	updateValues,
} from "./client.js";

export interface GoogleSheetsAdapterConfig {
	clientId?: string;
	clientSecret?: string;
	refreshToken: (domain: Domain) => Promise<string | null | undefined>;
	fetchFn?: typeof fetch;
}

export function createGoogleSheetsAdapter(config: GoogleSheetsAdapterConfig): SheetsPort {
	const tokenSource = createGoogleTokenSource(config);

	return {
		async getSpreadsheet({ domain, spreadsheetId }: GetSpreadsheetParams): Promise<SpreadsheetMetadata> {
			const accessToken = await tokenSource.accessToken(domain);
			const fetchFn = config.fetchFn ?? globalThis.fetch;
			return getSpreadsheetMetadata(spreadsheetId, {
				accessToken,
				label: domain,
				fetchFn,
			});
		},

		async batchGetValues({
			domain,
			spreadsheetId,
			ranges,
			valueRender,
		}: BatchGetValuesParams): Promise<SheetValueRange[]> {
			const accessToken = await tokenSource.accessToken(domain);
			const fetchFn = config.fetchFn ?? globalThis.fetch;
			return batchGetValues(spreadsheetId, ranges, valueRender, {
				accessToken,
				label: domain,
				fetchFn,
			});
		},

		async updateValues({
			domain,
			spreadsheetId,
			range,
			values,
			valueInput,
		}: UpdateValuesParams): Promise<SheetsWriteReceipt> {
			assertFiniteInputCells(values);
			const accessToken = await tokenSource.accessToken(domain);
			const fetchFn = config.fetchFn ?? globalThis.fetch;
			return updateValues(spreadsheetId, range, values, valueInput, {
				accessToken,
				label: domain,
				fetchFn,
			});
		},

		async appendValues({
			domain,
			spreadsheetId,
			range,
			values,
			valueInput,
		}: AppendValuesParams): Promise<SheetsAppendReceipt> {
			assertFiniteInputCells(values);
			const accessToken = await tokenSource.accessToken(domain);
			const fetchFn = config.fetchFn ?? globalThis.fetch;
			return appendValues(spreadsheetId, range, values, valueInput, {
				accessToken,
				label: domain,
				fetchFn,
			});
		},

		async clearValues({
			domain,
			spreadsheetId,
			range,
		}: ClearValuesParams): Promise<SheetsClearReceipt> {
			const accessToken = await tokenSource.accessToken(domain);
			const fetchFn = config.fetchFn ?? globalThis.fetch;
			return clearValues(spreadsheetId, range, {
				accessToken,
				label: domain,
				fetchFn,
			});
		},
	};
}
