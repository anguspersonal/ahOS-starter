import { describe, expect, it, vi } from "vitest";
import type { Domain } from "../../domain/domains.js";
import { createGoogleBigQueryAdapter } from "./bigquery.js";

function makeAdapter(apiResponder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const refreshToken = vi.fn(async (d: Domain) => `rt-${d}`);
	const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init });
		if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "at-personal-bq" }), { status: 200 });
		return apiResponder(url, init);
	}) as unknown as typeof fetch;
	const adapter = createGoogleBigQueryAdapter({
		clientId: "cid", clientSecret: "csecret", refreshToken, fetchFn,
		loadConfig: async () => ({ project_id: "angus-personal", datasets: ["angus-personal.analytics"], max_bytes_billed: 1024, max_rows: 200 }),
	});
	return { adapter, calls, refreshToken };
}

describe("createGoogleBigQueryAdapter (#1650)", () => {
	it("always mints with the personal ('angus') refresh token and sends dryRun + named params", async () => {
		const { adapter, calls, refreshToken } = makeAdapter(() => new Response(JSON.stringify({
			statistics: { query: { statementType: "SELECT", referencedTables: [{ projectId: "angus-personal", datasetId: "analytics", tableId: "events" }], totalBytesProcessed: "512" } },
		}), { status: 200 }));
		const res = await adapter.dryRun({ projectId: "angus-personal", location: "EU", sql: "SELECT * FROM t WHERE day = @day AND n > @n", params: { day: "2026-10-01", n: 5 } });
		expect(refreshToken).toHaveBeenCalledWith("angus");
		expect(res).toEqual({ statementType: "SELECT", referencedTables: [{ projectId: "angus-personal", datasetId: "analytics", tableId: "events" }], totalBytesProcessed: 512 });
		expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
			dryRun: true, useLegacySql: false, location: "EU", parameterMode: "NAMED",
			queryParameters: [
				{ name: "day", parameterType: { type: "STRING" }, parameterValue: { value: "2026-10-01" } },
				{ name: "n", parameterType: { type: "INT64" }, parameterValue: { value: "5" } },
			],
		});
	});

	it("maps BigQuery f/v row cells and surfaces error reason + scope hint on 403 accessDenied", async () => {
		const { adapter } = makeAdapter((url) => url.includes("/queries/job-9")
			? new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "accessDenied" }] } }), { status: 403 })
			: new Response(JSON.stringify({
				jobComplete: true, jobReference: { jobId: "job-1", location: "US" },
				schema: { fields: [{ name: "event", type: "STRING" }, { name: "cnt", type: "INTEGER" }] },
				rows: [{ f: [{ v: "signup" }, { v: "42" }] }], totalRows: "10", totalBytesProcessed: "256",
			}), { status: 200 }));
		const run = await adapter.runQuery({ projectId: "angus-personal", sql: "SELECT event, cnt FROM t", maximumBytesBilled: 2048, maxResults: 1 });
		expect(run).toEqual({
			jobComplete: true, jobId: "job-1", location: "US",
			columns: [{ name: "event", type: "STRING" }, { name: "cnt", type: "INTEGER" }],
			rows: [{ event: "signup", cnt: "42" }], totalRows: 10, bytesProcessed: 256,
		});
		const err = await adapter.getQueryResults({ projectId: "angus-personal", jobId: "job-9", maxResults: 10 }).catch((e) => e);
		expect(err.status).toBe(403);
		expect(err.reason).toBe("accessDenied");
		expect(err.message).toContain("angus-personal");
		expect(err.message).toContain("https://www.googleapis.com/auth/bigquery.readonly");
		expect(err.message).not.toContain("at-personal-bq");
	});
});
