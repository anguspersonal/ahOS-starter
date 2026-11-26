import { z } from "zod";
import { DOMAINS } from "../../domain/domains.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { BigQueryColumn, BigQueryPort } from "../../ports/bigquery.js";

export const bigqueryQuerySchema = z.object({
	domain: z.enum(DOMAINS).refine((d) => d === "angus", "bigquery_query only accepts domain 'angus'").default("angus").describe("Google account domain ('angus' only; personal GCP project)."),
	sql: z.string().min(1).describe("Standard SQL SELECT query."),
	max_rows: z.number().int().min(1).max(1000).optional().describe("Maximum rows to return (1..1000), clamped to configured max_rows."),
	params: z.record(z.string(), z.union([z.string(), z.number().finite()])).optional().describe("Named query parameters (@name in SQL)."),
});

export type BigqueryQueryInput = z.infer<typeof bigqueryQuerySchema>;

export interface BigqueryQueryOutput {
	columns: BigQueryColumn[];
	rows: Array<Record<string, unknown>>;
	total_rows: number;
	bytes_processed: number;
	truncated: boolean;
	job_id: string;
}

export interface BigqueryQueryOptions { pollIntervalMs?: number; pollTimeoutMs?: number }

export function createBigqueryQueryAction(
	port: BigQueryPort,
	options?: BigqueryQueryOptions,
): ActionDefinition<typeof bigqueryQuerySchema, BigqueryQueryOutput> {
	const pollIntervalMs = options?.pollIntervalMs ?? 1_000;
	const pollTimeoutMs = options?.pollTimeoutMs ?? 60_000;

	return defineAction({
		id: "bigquery_query",
		description:
			"Run a read-only Standard SQL SELECT query against the owner's personal BigQuery project ('angus' domain only), gated by a mandatory dry-run statementType check, dataset allowlist, and max_bytes_billed cap. Full notes: docs/guides/tools/bigquery_query.md",
		schema: bigqueryQuerySchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		run: async (input) => {
			if ((input.domain ?? "angus") !== "angus") {
				throw new Error("bigquery_query only accepts the personal Google account (domain: 'angus').");
			}
			const config = await port.loadConfig();
			if (!config) {
				throw new Error('BigQuery integration is not configured. Configure it via integration_set({ provider: "bigquery", config: { project_id: "...", datasets: ["project.dataset"] } }).');
			}
			const dry = await port.dryRun({ projectId: config.project_id, location: config.location, sql: input.sql, params: input.params });
			if (dry.statementType !== "SELECT") {
				throw new Error(`Refused BigQuery query: dry-run statementType must be SELECT (got "${dry.statementType ?? "UNKNOWN"}").`);
			}
			for (const ref of dry.referencedTables) {
				const qualified = `${ref.projectId}.${ref.datasetId}`;
				if (!config.datasets.includes(qualified)) {
					throw new Error(`Refused BigQuery query: dataset "${qualified}" is not in the allowlisted datasets (${config.datasets.join(", ") || "none"}).`);
				}
			}
			if (dry.totalBytesProcessed > config.max_bytes_billed) {
				throw new Error(`Refused BigQuery query: dry-run estimate ${dry.totalBytesProcessed} bytes exceeds max_bytes_billed cap of ${config.max_bytes_billed} bytes.`);
			}

			const maxResults = Math.min(input.max_rows ?? config.max_rows, config.max_rows);
			let res = await port.runQuery({
				projectId: config.project_id, location: config.location, sql: input.sql,
				params: input.params, maximumBytesBilled: config.max_bytes_billed, maxResults,
			});

			const deadline = Date.now() + pollTimeoutMs;
			while (!res.jobComplete) {
				if (Date.now() >= deadline) {
					throw new Error(`BigQuery job "${res.jobId}" did not complete within 60s (location: ${res.location ?? config.location ?? "default"}).`);
				}
				if (pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
				res = await port.getQueryResults({ projectId: config.project_id, jobId: res.jobId, location: res.location ?? config.location, maxResults });
			}

			const rows = res.rows.slice(0, maxResults);
			return { columns: res.columns, rows, total_rows: res.totalRows, bytes_processed: res.bytesProcessed, truncated: res.totalRows > rows.length, job_id: res.jobId };
		},
		formatMcp: (output) => JSON.stringify(output, null, 2),
	});
}
