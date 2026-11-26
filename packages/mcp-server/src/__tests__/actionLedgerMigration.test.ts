import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTION_AUDIT_OUTCOMES } from "@ahkms/core";

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

describe("action_ledger migration lockstep", () => {
	const allFiles = readdirSync(migrationsDir);
	const actionLedgerFiles = allFiles.filter((f) => f.endsWith("_action_ledger.sql"));

	it("has exactly one file ending _action_ledger.sql", () => {
		expect(actionLedgerFiles).toHaveLength(1);
	});

	const sql = actionLedgerFiles.length > 0
		? readFileSync(join(migrationsDir, actionLedgerFiles[0]), "utf8")
		: "";

	it("defines action_ledger_outcome_check listing exactly ACTION_AUDIT_OUTCOMES from @ahkms/core", () => {
		// Finds the newest migration defining action_ledger_outcome_check
		const sortedFiles = [...allFiles].filter((f) => f.endsWith(".sql")).sort().reverse();
		let newestOutcomeCheckSql = "";
		for (const file of sortedFiles) {
			const content = readFileSync(join(migrationsDir, file), "utf8");
			if (/action_ledger_outcome_check/i.test(content)) {
				newestOutcomeCheckSql = content;
				break;
			}
		}

		expect(newestOutcomeCheckSql).toBeTruthy();
		const outcomeCheckMatch = newestOutcomeCheckSql.match(
			/CONSTRAINT\s+action_ledger_outcome_check\s+CHECK\s*\(\s*outcome\s+IN\s*\(([^)]+)\)\)/i,
		);
		expect(outcomeCheckMatch).toBeTruthy();
		const listedOutcomes = outcomeCheckMatch![1]
			.split(",")
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
			.sort();
		expect(listedOutcomes).toEqual([...ACTION_AUDIT_OUTCOMES].sort());
	});

	it("defines action_ledger_seam_check listing exactly action, legacy_tool, client_local", () => {
		const sortedFiles = [...allFiles].filter((f) => f.endsWith(".sql")).sort().reverse();
		let newestSeamCheckSql = "";
		for (const file of sortedFiles) {
			const content = readFileSync(join(migrationsDir, file), "utf8");
			if (/action_ledger_seam_check/i.test(content)) {
				newestSeamCheckSql = content;
				break;
			}
		}

		expect(newestSeamCheckSql).toBeTruthy();
		const seamCheckMatch = newestSeamCheckSql.match(
			/CONSTRAINT\s+action_ledger_seam_check\s+CHECK\s*\(\s*seam\s+IN\s*\(([^)]+)\)\)/i,
		);
		expect(seamCheckMatch).toBeTruthy();
		const listedSeams = seamCheckMatch![1]
			.split(",")
			.map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
			.sort();
		expect(listedSeams).toEqual(["action", "legacy_tool", "client_local"].sort());
	});

	it("has caller text not null with no check constraint", () => {
		expect(sql).toMatch(/caller\s+text\s+NOT\s+NULL/i);
		expect(sql).not.toMatch(/action_ledger_caller_check/i);
	});

	it("enables Row Level Security (RLS)", () => {
		expect(sql).toMatch(
			/ALTER\s+TABLE\s+(public\.)?action_ledger\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i,
		);
	});

	it("revokes all permissions from anon and authenticated", () => {
		expect(sql).toMatch(
			/REVOKE\s+ALL\s+ON\s+(TABLE\s+)?(public\.)?action_ledger\s+FROM\s+[^;]*anon/i,
		);
		expect(sql).toMatch(
			/REVOKE\s+ALL\s+ON\s+(TABLE\s+)?(public\.)?action_ledger\s+FROM\s+[^;]*authenticated/i,
		);
	});

	it("no migration creates a policy on action_ledger", () => {
		for (const file of allFiles) {
			if (!file.endsWith(".sql")) continue;
			const fileSql = readFileSync(join(migrationsDir, file), "utf8");
			expect(fileSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+(public\.)?action_ledger/i);
		}
	});

	it("grants select and insert to service_role and nothing else", () => {
		expect(sql).toMatch(
			/GRANT\s+SELECT,\s*INSERT\s+ON\s+(TABLE\s+)?(public\.)?action_ledger\s+TO\s+service_role\s*;/i,
		);
		expect(sql).not.toMatch(
			/GRANT\s+(ALL|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\s+ON\s+(TABLE\s+)?(public\.)?action_ledger\s+TO\s+service_role/i,
		);
	});

	it("creates action_ledger_refuse_change() trigger function raising 'action_ledger is append-only'", () => {
		expect(sql).toMatch(/FUNCTION\s+(public\.)?action_ledger_refuse_change/i);
		expect(sql).toMatch(/RAISE\s+EXCEPTION\s+'action_ledger is append-only'/i);
		expect(sql).toMatch(/SET\s+search_path\s*=\s*''/i);
	});

	it("attaches action_ledger_refuse_change() to BEFORE UPDATE OR DELETE for each row", () => {
		expect(sql).toMatch(
			/BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+(public\.)?action_ledger\s+FOR\s+EACH\s+ROW/i,
		);
	});

	it("attaches action_ledger_refuse_change() to BEFORE TRUNCATE for each statement", () => {
		expect(sql).toMatch(
			/BEFORE\s+TRUNCATE\s+ON\s+(public\.)?action_ledger\s+FOR\s+EACH\s+STATEMENT/i,
		);
	});

	it("cites ADR-100 §1 and issue #1411 in migration header", () => {
		expect(sql).toMatch(/ADR-100\s+§1/i);
		expect(sql).toMatch(/#1411/i);
		expect(sql).toMatch(/append-only/i);
	});

	it("adds parent_request_id and trace_id columns and trace_id index in _action_ledger_trace.sql (#1561)", () => {
		const traceFiles = allFiles.filter((f) => f.endsWith("_action_ledger_trace.sql"));
		expect(traceFiles).toHaveLength(1);
		const traceSql = readFileSync(join(migrationsDir, traceFiles[0]!), "utf8");
		expect(traceSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+parent_request_id\s+text/i);
		expect(traceSql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+trace_id\s+text/i);
		expect(traceSql).toMatch(
			/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+(public\.)?action_ledger\s*\(\s*trace_id\s*,\s*created_at\s*\)\s*WHERE\s+trace_id\s+IS\s+NOT\s+NULL/i,
		);
	});
});
