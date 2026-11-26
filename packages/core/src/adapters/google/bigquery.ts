import type { BigqueryConfig } from "../../domain/integrations.js";
import {
	BigQueryApiError, type BigQueryColumn, type BigQueryParamValue,
	type BigQueryPort, type BigQueryReferencedTable, type BigQueryRunResult,
} from "../../ports/bigquery.js";
import { createGoogleTokenSource, type GoogleTokenSourceConfig } from "./tokenSource.js";

const BQ_API_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const BQ_READONLY_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

export interface GoogleBigQueryAdapterConfig extends GoogleTokenSourceConfig {
	loadConfig: () => Promise<BigqueryConfig | null>;
}

interface RawQueryResponse {
	jobComplete?: boolean;
	jobReference?: { projectId?: string; jobId?: string; location?: string };
	schema?: { fields?: Array<{ name?: string; type?: string }> };
	rows?: Array<{ f?: Array<{ v?: unknown }> } | Record<string, unknown>>;
	totalRows?: string | number;
	totalBytesProcessed?: string | number;
	statementType?: string;
	referencedTables?: BigQueryReferencedTable[];
	statistics?: {
		totalBytesProcessed?: string | number;
		query?: { statementType?: string; referencedTables?: BigQueryReferencedTable[]; totalBytesProcessed?: string | number };
	};
}

function buildNamedParams(params?: Record<string, BigQueryParamValue>) {
	if (!params || Object.keys(params).length === 0) return {};
	return {
		parameterMode: "NAMED",
		queryParameters: Object.entries(params).map(([name, val]) => ({
			name,
			parameterType: { type: typeof val === "number" ? (Number.isInteger(val) ? "INT64" : "FLOAT64") : "STRING" },
			parameterValue: { value: String(val) },
		})),
	};
}

function parseRunResult(data: RawQueryResponse): BigQueryRunResult {
	const columns: BigQueryColumn[] = (data.schema?.fields ?? []).map((f) => ({ name: String(f.name ?? ""), type: String(f.type ?? "STRING") }));
	const rows = (data.rows ?? []).map((r) => {
		if (Array.isArray((r as { f?: unknown }).f)) {
			const cells = (r as { f: Array<{ v?: unknown }> }).f;
			return Object.fromEntries(columns.map((col, idx) => [col.name, cells[idx]?.v ?? null]));
		}
		return r as Record<string, unknown>;
	});
	return {
		jobComplete: data.jobComplete ?? true,
		jobId: data.jobReference?.jobId ?? "",
		location: data.jobReference?.location,
		columns,
		rows,
		totalRows: Number(data.totalRows ?? rows.length),
		bytesProcessed: Number(data.totalBytesProcessed ?? data.statistics?.query?.totalBytesProcessed ?? data.statistics?.totalBytesProcessed ?? 0),
	};
}

export function createGoogleBigQueryAdapter(config: GoogleBigQueryAdapterConfig): BigQueryPort {
	const tokenSource = createGoogleTokenSource(config);

	async function request(projectId: string, method: string, url: string, body?: unknown): Promise<RawQueryResponse> {
		const token = await tokenSource.accessToken("angus");
		const fetchImpl = config.fetchFn ?? globalThis.fetch;
		const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const res = await fetchImpl(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
		if (!res.ok) {
			let reason: string | undefined;
			try {
				const errJson = (await res.json()) as { error?: { errors?: Array<{ reason?: string }> } };
				reason = errJson.error?.errors?.[0]?.reason;
			} catch { /* ignore */ }
			const scopeHint = res.status === 403 || reason === "accessDenied"
				? ` on project "${projectId}" (ensure scope ${BQ_READONLY_SCOPE} is consented and IAM roles/bigquery.jobUser + roles/bigquery.dataViewer are granted)`
				: ` on project "${projectId}"`;
			throw new BigQueryApiError(`BigQuery API ${method} failed (HTTP ${res.status})${reason ? ` [${reason}]` : ""}${scopeHint}`, res.status, reason);
		}
		return (await res.json()) as RawQueryResponse;
	}

	return {
		loadConfig: () => config.loadConfig(),
		async dryRun({ projectId, location, sql, params }) {
			const data = await request(projectId, "POST", `${BQ_API_BASE}/projects/${encodeURIComponent(projectId)}/queries`, {
				query: sql, useLegacySql: false, dryRun: true, ...(location ? { location } : {}), ...buildNamedParams(params),
			});
			const qStats = data.statistics?.query;
			return {
				statementType: qStats?.statementType ?? data.statementType,
				referencedTables: qStats?.referencedTables ?? data.referencedTables ?? [],
				totalBytesProcessed: Number(data.totalBytesProcessed ?? qStats?.totalBytesProcessed ?? data.statistics?.totalBytesProcessed ?? 0),
			};
		},
		async runQuery({ projectId, location, sql, params, maximumBytesBilled, maxResults }) {
			const data = await request(projectId, "POST", `${BQ_API_BASE}/projects/${encodeURIComponent(projectId)}/queries`, {
				query: sql, useLegacySql: false, dryRun: false, maximumBytesBilled: String(maximumBytesBilled),
				maxResults, timeoutMs: 30_000, ...(location ? { location } : {}), ...buildNamedParams(params),
			});
			return parseRunResult(data);
		},
		async getQueryResults({ projectId, jobId, location, maxResults }) {
			const qs = new URLSearchParams({ maxResults: String(maxResults), ...(location ? { location } : {}) });
			const data = await request(projectId, "GET", `${BQ_API_BASE}/projects/${encodeURIComponent(projectId)}/queries/${encodeURIComponent(jobId)}?${qs.toString()}`);
			return parseRunResult({ ...data, jobReference: { projectId, jobId, location, ...data.jobReference } });
		},
	};
}
