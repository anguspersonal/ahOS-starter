import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

describe("approval_expiry scheduler lock and cadence migration (#1429)", () => {
	it("Case 1: exactly one file matches *_scheduler_add_approval_expiry_cadence.sql", () => {
		const files = readdirSync(migrationsDir).filter((f) =>
			/_scheduler_add_approval_expiry_cadence\.sql$/.test(f),
		);
		expect(files).toHaveLength(1);
	});

	it("Case 2: contains insert into public.scheduler_locks for 'approval_expiry' (whitespace-tolerant)", () => {
		const files = readdirSync(migrationsDir).filter((f) =>
			/_scheduler_add_approval_expiry_cadence\.sql$/.test(f),
		);
		expect(files).toHaveLength(1);
		const sql = readFileSync(join(migrationsDir, files[0]!), "utf8");

		const normalizedSql = sql.replace(/\s+/g, " ").toLowerCase();
		const expectedClause =
			"insert into public.scheduler_locks (cadence, locked_at) values ('approval_expiry', null) on conflict (cadence) do nothing;";
		expect(normalizedSql).toContain(expectedClause.toLowerCase());
	});

	it("Case 3: newest migration adding scheduler_runs_cadence_check lists all migration 127 values plus approval_expiry", () => {
		const files = readdirSync(migrationsDir).sort();
		const checkFiles = files.filter((f) => {
			if (!f.endsWith(".sql")) return false;
			const content = readFileSync(join(migrationsDir, f), "utf8");
			return (
				content.includes("scheduler_runs_cadence_check") &&
				/add\s+constraint\s+scheduler_runs_cadence_check/i.test(content)
			);
		});

		expect(checkFiles.length).toBeGreaterThan(0);
		const newestCheckFile = checkFiles[checkFiles.length - 1]!;
		const newestContent = readFileSync(join(migrationsDir, newestCheckFile), "utf8");

		const checkMatch = newestContent.match(
			/add\s+constraint\s+scheduler_runs_cadence_check\s+check\s*\(\s*cadence\s+in\s*\(([^)]+)\)\s*\)/i,
		);
		expect(checkMatch, `Could not parse check constraint in ${newestCheckFile}`).not.toBeNull();

		const constraintBody = checkMatch![1]!;
		const values = constraintBody
			.split(",")
			.map((v) => v.trim().replace(/^'|'$/g, ""));

		const requiredValues = [
			"discover",
			"enrich",
			"dedup",
			"notion_automations",
			"alerts",
			"learning",
			"gmail_automations",
			"derive",
			"jobs",
			"approval_expiry",
		];

		for (const required of requiredValues) {
			expect(values).toContain(required);
		}
	});
});
