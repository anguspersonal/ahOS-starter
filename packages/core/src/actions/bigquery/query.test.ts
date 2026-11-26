import { describe, expect, it, vi } from "vitest";
import type { BigqueryConfig } from "../../domain/integrations.js";
import type { BigQueryPort } from "../../ports/bigquery.js";
import { bigqueryQuerySchema, createBigqueryQueryAction } from "./query.js";

const DEFAULT_CONFIG: BigqueryConfig = {
	project_id: "p", location: "US", datasets: ["p.public"], max_bytes_billed: 1_073_741_824, max_rows: 200,
};

function makePort(overrides?: Partial<BigQueryPort>): BigQueryPort {
	const baseResult = { jobComplete: true, jobId: "job-123", columns: [{ name: "id", type: "INTEGER" }], rows: [{ id: 1 }], totalRows: 1, bytesProcessed: 1024 };
	return {
		loadConfig: vi.fn(async () => DEFAULT_CONFIG),
		dryRun: vi.fn(async () => ({ statementType: "SELECT", referencedTables: [{ projectId: "p", datasetId: "public", tableId: "events" }], totalBytesProcessed: 1024 })),
		runQuery: vi.fn(async () => baseResult),
		getQueryResults: vi.fn(async () => baseResult),
		...overrides,
	};
}

describe("bigquery_query action (#1650)", () => {
	it.each(["INSERT", "SCRIPT", "CREATE_TABLE"])("1. Statement type: refuses dry-run statementType=%s and never runs query", async (statementType) => {
		const port = makePort({ dryRun: vi.fn(async () => ({ statementType, referencedTables: [], totalBytesProcessed: 100 })) });
		await expect(createBigqueryQueryAction(port).run({ domain: "angus", sql: "SELECT 1" }, {} as never)).rejects.toThrow(statementType);
		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("2. Dataset allowlist: refuses off-allowlist dataset naming 'p.secret', and empty datasets refuses every table", async () => {
		const port = makePort({ dryRun: vi.fn(async () => ({ statementType: "SELECT", referencedTables: [{ projectId: "p", datasetId: "secret", tableId: "users" }], totalBytesProcessed: 100 })) });
		await expect(createBigqueryQueryAction(port).run({ domain: "angus", sql: "SELECT * FROM p.secret.users" }, {} as never)).rejects.toThrow("p.secret");
		expect(port.runQuery).not.toHaveBeenCalled();

		const emptyPort = makePort({ loadConfig: vi.fn(async () => ({ ...DEFAULT_CONFIG, datasets: [] })) });
		await expect(createBigqueryQueryAction(emptyPort).run({ domain: "angus", sql: "SELECT * FROM p.public.events" }, {} as never)).rejects.toThrow("p.public");
		expect(emptyPort.runQuery).not.toHaveBeenCalled();
	});

	it("3. Byte cap: refuses when totalBytesProcessed exceeds max_bytes_billed, naming both numbers", async () => {
		const port = makePort({ dryRun: vi.fn(async () => ({ statementType: "SELECT", referencedTables: [{ projectId: "p", datasetId: "public", tableId: "events" }], totalBytesProcessed: 5_000_000_000 })) });
		const err = await createBigqueryQueryAction(port).run({ domain: "angus", sql: "SELECT * FROM p.public.events" }, {} as never).catch((e) => e);
		expect(err.message).toContain("5000000000");
		expect(err.message).toContain("1073741824");
		expect(port.runQuery).not.toHaveBeenCalled();
	});

	it("4. Slow job: a job still jobComplete: false after 60 s fails naming job_id", async () => {
		const incomplete = { jobComplete: false, jobId: "job-slow-99", columns: [], rows: [], totalRows: 0, bytesProcessed: 0 };
		const port = makePort({ runQuery: vi.fn(async () => incomplete), getQueryResults: vi.fn(async () => incomplete) });
		await expect(createBigqueryQueryAction(port, { pollIntervalMs: 1, pollTimeoutMs: 5 }).run({ domain: "angus", sql: "SELECT 1" }, {} as never)).rejects.toThrow("job-slow-99");
	});

	it("5. Truncation: totalRows 500 with max_rows 200 returns 200 rows and truncated: true", async () => {
		const rows200 = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }));
		const port = makePort({ runQuery: vi.fn(async () => ({ jobComplete: true, jobId: "job-trunc", columns: [{ name: "id", type: "INTEGER" }], rows: rows200, totalRows: 500, bytesProcessed: 4096 })) });
		const out = await createBigqueryQueryAction(port).run({ domain: "angus", sql: "SELECT id FROM p.public.events", max_rows: 200 }, {} as never);
		expect(out.rows).toHaveLength(200);
		expect(out.total_rows).toBe(500);
		expect(out.truncated).toBe(true);
		expect(out.job_id).toBe("job-trunc");
	});

	it("6. Unconfigured: missing bigquery integration row fails naming integration_set", async () => {
		const port = makePort({ loadConfig: vi.fn(async () => null) });
		await expect(createBigqueryQueryAction(port).run({ domain: "angus", sql: "SELECT 1" }, {} as never)).rejects.toThrow("integration_set");
		expect(port.dryRun).not.toHaveBeenCalled();
	});

	it("7. Domain: only the personal Google account ('angus') is accepted; 'work' is rejected", async () => {
		expect(() => bigqueryQuerySchema.parse({ domain: "work", sql: "SELECT 1" })).toThrow();
		const port = makePort();
		await expect(createBigqueryQueryAction(port).run({ domain: "work" as "angus", sql: "SELECT 1" }, {} as never)).rejects.toThrow(/angus/);
		expect(port.loadConfig).not.toHaveBeenCalled();
	});
});
