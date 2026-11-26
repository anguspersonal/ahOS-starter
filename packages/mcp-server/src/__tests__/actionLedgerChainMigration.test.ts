import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

interface SimulatedLedgerRow {
	id: string;
	action: string;
	created_at: string;
	prev_hash: string | null;
	row_hash: string | null;
}

function canonicalizeRow(row: SimulatedLedgerRow): string {
	const entries = Object.entries(row)
		.filter(([k, v]) => k !== "prev_hash" && k !== "row_hash" && v !== null && v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify(Object.fromEntries(entries));
}

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function createLedgerHarness(initialRows: SimulatedLedgerRow[] = []) {
	const rows: SimulatedLedgerRow[] = [...initialRows];
	const toMs = (iso: string) => new Date(iso).getTime();
	const sortDesc = (a: SimulatedLedgerRow, b: SimulatedLedgerRow) =>
		toMs(b.created_at) - toMs(a.created_at) || b.id.localeCompare(a.id);
	const sortAsc = (a: SimulatedLedgerRow, b: SimulatedLedgerRow) =>
		toMs(a.created_at) - toMs(b.created_at) || a.id.localeCompare(b.id);

	function insert(draft: { id: string; action: string; created_at: string }): SimulatedLedgerRow {
		const tail = rows.filter((r) => r.row_hash !== null).sort(sortDesc)[0];
		const prevHash = tail?.row_hash ?? null;
		const prevCreatedAt = tail?.created_at ?? [...rows].sort(sortDesc)[0]?.created_at ?? null;
		let createdAtMs = toMs(draft.created_at);
		if (prevCreatedAt !== null && createdAtMs <= toMs(prevCreatedAt)) {
			createdAtMs = toMs(prevCreatedAt) + 1;
		}
		const newRow: SimulatedLedgerRow = {
			id: draft.id,
			action: draft.action,
			created_at: new Date(createdAtMs).toISOString(),
			prev_hash: prevHash,
			row_hash: null,
		};
		newRow.row_hash = sha256Hex((prevHash ?? "") + canonicalizeRow(newRow));
		rows.push(newRow);
		return newRow;
	}

	function verify(sinceIso: string | null = null) {
		const chained = rows.filter((r) => r.row_hash !== null || r.prev_hash !== null);
		if (chained.length === 0) return { checked_count: 0, first_broken: null };
		const chainStartMs = Math.min(...chained.map((r) => toMs(r.created_at)));
		const sinceMs = sinceIso !== null ? toMs(sinceIso) : null;
		let expectedPrev =
			sinceMs !== null
				? (rows.filter((r) => toMs(r.created_at) >= chainStartMs && toMs(r.created_at) < sinceMs).sort(sortDesc)[0]?.row_hash ?? null)
				: null;
		const windowRows = rows
			.filter((r) => toMs(r.created_at) >= chainStartMs && (sinceMs === null || toMs(r.created_at) >= sinceMs))
			.sort(sortAsc);
		let broken: string | null = null;
		for (const row of windowRows) {
			const expectedHash = row.row_hash === null ? null : sha256Hex((row.prev_hash ?? "") + canonicalizeRow(row));
			if (row.row_hash === null || row.prev_hash !== expectedPrev || row.row_hash !== expectedHash) {
				if (broken === null) broken = row.id;
			}
			expectedPrev = row.row_hash;
		}
		return { checked_count: windowRows.length, first_broken: broken };
	}

	return { rows, insert, verify };
}

describe("action_ledger chain migration lockstep (#1493)", () => {
	const allFiles = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const migrationFiles = allFiles.filter((f) =>
		f.endsWith("_action_ledger_chain.sql"),
	);

	it("has exactly one migration ending _action_ledger_chain.sql", () => {
		expect(migrationFiles).toHaveLength(1);
	});

	const sql =
		migrationFiles.length > 0
			? readFileSync(join(migrationsDir, migrationFiles[0]!), "utf8")
			: "";

	it("1. adds prev_hash and row_hash columns, and BEFORE INSERT FOR EACH ROW trigger taking advisory lock and using sha256(bytea) over jsonb_strip_nulls(to_jsonb(new) - 'prev_hash' - 'row_hash')::text", () => {
		expect(sql).toMatch(
			/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+prev_hash\s+text/i,
		);
		expect(sql).toMatch(
			/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+row_hash\s+text/i,
		);
		expect(sql).toMatch(
			/BEFORE\s+INSERT\s+ON\s+(public\.)?action_ledger\s+FOR\s+EACH\s+ROW/i,
		);
		expect(sql).toMatch(/pg_advisory_xact_lock\s*\(/i);
		expect(sql).toMatch(/sha256\s*\(/i);
		expect(sql).not.toMatch(/CREATE\s+EXTENSION/i);
		expect(sql).toMatch(
			/jsonb_strip_nulls\s*\(\s*(pg_catalog\.)?to_jsonb\s*\(\s*new\s*\)\s*-\s*'prev_hash'\s*-\s*'row_hash'\s*\)::text/i,
		);
	});

	it("2. defines action_ledger_verify as STABLE with SET timezone = 'UTC' and grants EXECUTE only to service_role", () => {
		expect(sql).toMatch(/FUNCTION\s+(public\.)?action_ledger_verify\s*\(/i);
		expect(sql).toMatch(/\bSTABLE\b/i);
		const tzMatches = sql.match(/SET\s+timezone\s*=\s*'UTC'/gi);
		expect(tzMatches?.length ?? 0).toBeGreaterThanOrEqual(2);
		expect(sql).toMatch(
			/REVOKE\s+ALL\s+ON\s+FUNCTION\s+(public\.)?action_ledger_verify\s*\([^)]*\)\s+FROM\s+[^;]*public/i,
		);
		expect(sql).toMatch(
			/REVOKE\s+ALL\s+ON\s+FUNCTION\s+(public\.)?action_ledger_verify\s*\([^)]*\)\s+FROM\s+[^;]*anon/i,
		);
		expect(sql).toMatch(
			/REVOKE\s+ALL\s+ON\s+FUNCTION\s+(public\.)?action_ledger_verify\s*\([^)]*\)\s+FROM\s+[^;]*authenticated/i,
		);
		expect(sql).toMatch(
			/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(public\.)?action_ledger_verify\s*\([^)]*\)\s+TO\s+service_role\s*;/i,
		);
	});

	it("includes a comment warning that later columns must be nullable with no default or the chain needs a version", () => {
		expect(sql).toMatch(/nullable\s+with\s+no\s+default/i);
		expect(sql).toMatch(/version/i);
	});

	it("3. enforces monotonic created_at in action_ledger_compute_hash when concurrent or same-transaction inserts share now()", () => {
		expect(sql).toMatch(
			/SELECT\s+row_hash\s*,\s*created_at\s+INTO\s+v_prev_hash\s*,\s*v_prev_created_at/i,
		);
		expect(sql).toMatch(
			/IF\s+v_prev_created_at\s+IS\s+NOT\s+NULL\s+AND\s+NEW\.created_at\s*<=\s*v_prev_created_at\s+THEN\s+NEW\.created_at\s*:=\s*v_prev_created_at\s*\+\s*interval\s+'1 microsecond'/i,
		);

		const harness = createLedgerHarness();
		const sharedNow = "2026-10-19T13:00:00.000Z";
		const first = harness.insert({
			id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
			action: "task_create",
			created_at: sharedNow,
		});
		const second = harness.insert({
			id: "00000000-0000-4000-8000-000000000001",
			action: "entity_upsert",
			created_at: "2026-10-19T12:59:59.999Z",
		});

		expect(new Date(second.created_at).getTime()).toBeGreaterThan(
			new Date(first.created_at).getTime(),
		);
		expect(second.prev_hash).toBe(first.row_hash);
		expect(harness.verify(null)).toEqual({
			checked_count: 2,
			first_broken: null,
		});
	});

	it("4. detects genesis prefix deletion or non-null genesis prev_hash in action_ledger_verify(NULL)", () => {
		expect(sql).not.toMatch(/v_expected_prev\s*:=\s*v_row\.prev_hash/i);
		expect(sql).not.toMatch(/\bv_has_prev\b/i);

		const harness = createLedgerHarness();
		const row1 = harness.insert({
			id: "11111111-1111-4111-8111-111111111111",
			action: "capture",
			created_at: "2026-10-19T13:00:00.000Z",
		});
		const row2 = harness.insert({
			id: "22222222-2222-4222-8222-222222222222",
			action: "entity_create",
			created_at: "2026-10-19T13:00:01.000Z",
		});

		expect(row1.prev_hash).toBeNull();
		expect(harness.verify(null)).toEqual({
			checked_count: 2,
			first_broken: null,
		});

		// Deleting the genesis row leaves row2 with a non-null prev_hash at the head of the chain
		harness.rows.shift();
		expect(harness.verify(null)).toEqual({
			checked_count: 1,
			first_broken: row2.id,
		});
	});

	it("5. skips pre-migration null-hash rows but flags post-genesis rows whose row_hash was nulled out", () => {
		expect(sql).toMatch(/SELECT\s+MIN\s*\(\s*created_at\s*\)\s+INTO\s+v_chain_start/i);
		expect(sql).toMatch(/IF\s+v_row\.row_hash\s+IS\s+NULL\s+THEN/i);

		const preMigrationRow: SimulatedLedgerRow = {
			id: "00000000-0000-4000-8000-000000000000",
			action: "legacy_pre_migration",
			created_at: "2026-10-18T00:00:00.000Z",
			prev_hash: null,
			row_hash: null,
		};
		const harness = createLedgerHarness([preMigrationRow]);
		harness.insert({
			id: "11111111-1111-4111-8111-111111111111",
			action: "capture",
			created_at: "2026-10-19T13:00:00.000Z",
		});
		const row2 = harness.insert({
			id: "22222222-2222-4222-8222-222222222222",
			action: "entity_create",
			created_at: "2026-10-19T13:00:01.000Z",
		});
		harness.insert({
			id: "33333333-3333-4333-8333-333333333333",
			action: "task_create",
			created_at: "2026-10-19T13:00:02.000Z",
		});

		// Pre-migration row is skipped; 3 chained rows pass
		expect(harness.verify(null)).toEqual({
			checked_count: 3,
			first_broken: null,
		});

		// Nulling row_hash on a post-genesis row is flagged as broken
		row2.row_hash = null;
		expect(harness.verify(null)).toEqual({
			checked_count: 3,
			first_broken: row2.id,
		});
	});
});
