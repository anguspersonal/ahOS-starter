import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

function parseStatusCheckValues(sql: string, file: string): string[] {
	const checkMatch = sql.match(
		/ADD\s+CONSTRAINT\s+"?system_decisions_status_check"?\s+CHECK\s*\([\s\S]*?ARRAY\[([\s\S]*?)\]/i,
	);
	if (!checkMatch) {
		throw new Error(`could not parse system_decisions_status_check in ${file}`);
	}
	return Array.from(checkMatch[1]!.matchAll(/'([^']+)'/g), (m) => m[1]!);
}

describe("system_decisions action_approval migration lockstep (#1417)", () => {
	const allFiles = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const migrationFiles = allFiles.filter((f) =>
		f.endsWith("_system_decisions_action_approval.sql"),
	);

	it("has exactly one migration ending _system_decisions_action_approval.sql", () => {
		expect(migrationFiles).toHaveLength(1);
	});

	const sql =
		migrationFiles.length > 0
			? readFileSync(join(migrationsDir, migrationFiles[0]!), "utf8")
			: "";

	it("newest migration adding system_decisions_status_check lists migration 038's eight values plus executed and failed", () => {
		const mig038File = allFiles.find((f) => f.includes("_038_"));
		expect(mig038File).toBeTruthy();
		const mig038Statuses = parseStatusCheckValues(
			readFileSync(join(migrationsDir, mig038File!), "utf8"),
			mig038File!,
		);
		expect(mig038Statuses).toHaveLength(8);

		const defining = allFiles
			.map((file) => ({
				file,
				sql: readFileSync(join(migrationsDir, file), "utf8"),
			}))
			.filter(({ sql: s }) =>
				/ADD\s+CONSTRAINT\s+"?system_decisions_status_check"?/i.test(s),
			);
		const newest = defining.at(-1);
		expect(newest).toBeTruthy();
		expect(newest!.sql).toMatch(
			/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+system_decisions_status_check/i,
		);
		const listedStatuses = parseStatusCheckValues(
			newest!.sql,
			newest!.file,
		).sort();
		expect(listedStatuses).toEqual(
			[...mig038Statuses, "executed", "failed"].sort(),
		);
	});

	it("adds input_sha256 text column and enforces 64-hex hash check on action_approval rows", () => {
		expect(sql).toMatch(
			/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+input_sha256\s+text/i,
		);
		expect(sql).toMatch(
			/ADD\s+CONSTRAINT\s+system_decisions_action_approval_hash_check\s+CHECK\s*\(\s*decision_type\s*<>\s*'action_approval'\s+OR\s+input_sha256\s*~\s*'\^\[0-9a-f\]\{64\}\$'\s*\)/i,
		);
	});

	it("creates the partial index on (status, expires_at) where decision_type = 'action_approval'", () => {
		expect(sql).toMatch(
			/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_system_decisions_action_approval\s+ON\s+(public\.)?system_decisions\s*\(\s*status\s*,\s*expires_at\s*\)\s*WHERE\s+decision_type\s*=\s*'action_approval'/i,
		);
	});

	it("cites ADR-100 §1, ADR-104, and #1417 in the migration header", () => {
		expect(sql).toMatch(/ADR-100\s+§1/i);
		expect(sql).toMatch(/ADR-104/i);
		expect(sql).toMatch(/#1417/);
	});
});
