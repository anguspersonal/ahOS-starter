import type { BigqueryConfig } from "../domain/integrations.js";

export class BigQueryApiError extends Error {
	readonly status: number;
	readonly reason?: string;
	constructor(message: string, status: number, reason?: string) {
		super(message);
		this.name = "BigQueryApiError";
		this.status = status;
		this.reason = reason;
	}
}

export type BigQueryParamValue = string | number;
export interface BigQueryReferencedTable { projectId: string; datasetId: string; tableId: string }
export interface BigQueryColumn { name: string; type: string }
export interface BigQueryDryRunResult {
	statementType?: string;
	referencedTables: BigQueryReferencedTable[];
	totalBytesProcessed: number;
}
export interface BigQueryRunResult {
	jobComplete: boolean;
	jobId: string;
	location?: string;
	columns: BigQueryColumn[];
	rows: Array<Record<string, unknown>>;
	totalRows: number;
	bytesProcessed: number;
}

export interface BigQueryPort {
	loadConfig(): Promise<BigqueryConfig | null>;
	dryRun(params: { projectId: string; location?: string; sql: string; params?: Record<string, BigQueryParamValue> }): Promise<BigQueryDryRunResult>;
	runQuery(params: { projectId: string; location?: string; sql: string; params?: Record<string, BigQueryParamValue>; maximumBytesBilled: number; maxResults: number }): Promise<BigQueryRunResult>;
	getQueryResults(params: { projectId: string; jobId: string; location?: string; maxResults: number }): Promise<BigQueryRunResult>;
}
