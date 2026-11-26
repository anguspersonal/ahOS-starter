import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../supabase/migrations");

function findLedgerQueryMigration(): string {
	const files = fs.readdirSync(MIGRATIONS_DIR);
	const match = files.find((f) => f.endsWith("_action_ledger_query.sql"));
	if (!match) {
		throw new Error("Expected migration *_action_ledger_query.sql in supabase/migrations");
	}
	return fs.readFileSync(path.join(MIGRATIONS_DIR, match), "utf8");
}

describe("action_ledger_query migration (#1476)", () => {
	it("1. creates filter indexes on public.action_ledger", () => {
		const sql = findLedgerQueryMigration();
		expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+action_ledger_caller_created_at_idx/i);
		expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+action_ledger_client_id_created_at_idx/i);
		expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+action_ledger_session_id_created_at_idx/i);
		expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+action_ledger_request_id_idx/i);
		expect(sql).toMatch(
			/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+action_ledger_parent_request_id_created_at_idx/i,
		);
		expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+action_ledger_outcome_created_at_idx/i);
	});

	it("2. defines public.action_ledger_stats() and grants EXECUTE only to service_role", () => {
		const sql = findLedgerQueryMigration();
		expect(sql).toMatch(/DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.action_ledger_stats\(\)/i);
		expect(sql).toMatch(/CREATE\s+FUNCTION\s+public\.action_ledger_stats\(\)/i);
		expect(sql).toMatch(/row_estimate\s+bigint/i);
		expect(sql).toMatch(/total_bytes\s+bigint/i);
		expect(sql).toMatch(
			/REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.action_ledger_stats\(\)\s+FROM\s+PUBLIC,\s*anon,\s*authenticated,\s*service_role/i,
		);
		expect(sql).toMatch(
			/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.action_ledger_stats\(\)\s+TO\s+service_role/i,
		);
	});

	it("3. creates no RLS policy on public.action_ledger", () => {
		const sql = findLedgerQueryMigration();
		expect(sql).not.toMatch(/CREATE\s+POLICY/i);
	});
});
