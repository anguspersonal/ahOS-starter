import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Migration 102 (#359) encodes ADR-036 §2 in the DB: the graph_instance_of
// derived view that projects one virtual entity -> term-node edge per
// entity, joining entities.entity_type to the vocabulary registry (migration
// 081's term-node rows). Mirrors termNodesMigration.test.ts /
// namespacesMigration.test.ts: a static lockstep guard over the SQL text —
// no live database is ever touched.

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

function readMigration102(): string {
	const file = readdirSync(migrationsDir).find((f) => /_102_/.test(f));
	if (!file) throw new Error("migration 102 not found in " + migrationsDir);
	return readFileSync(join(migrationsDir, file), "utf8");
}

describe("migration 102 graph_instance_of view", () => {
	const sql = readMigration102();

	it("claims number 102 exactly once (no duplicate-number collision)", () => {
		const files = readdirSync(migrationsDir).filter((f) => /_102_/.test(f));
		expect(files).toHaveLength(1);
	});

	it("creates the graph_instance_of view", () => {
		expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.graph_instance_of/);
	});

	it("joins entities.entity_type to term-node rows via properties.term (ADR-036 §2)", () => {
		expect(sql).toMatch(/t\.properties ->> 'type' = 'ahos_concept_term'/);
		expect(sql).toMatch(/t\.properties ->> 'applies_to' = 'entity_type'/);
		expect(sql).toMatch(/t\.properties ->> 'term' = e\.entity_type/);
	});

	it("shapes the projection like entity_relationships — literal 'instance_of' type, NULL confidence/metadata/validity", () => {
		expect(sql).toMatch(/'instance_of'::text\s+AS relationship_type/);
		expect(sql).toMatch(/AS from_entity_id/);
		expect(sql).toMatch(/AS to_entity_id/);
		expect(sql).toMatch(/NULL::numeric\(5,2\)\s+AS confidence_score/);
		expect(sql).toMatch(/NULL::jsonb\s+AS metadata/);
		expect(sql).toMatch(/NULL::timestamptz\s+AS valid_from/);
		expect(sql).toMatch(/NULL::timestamptz\s+AS valid_to/);
	});

	it("scopes the join to the same owner on both sides", () => {
		expect(sql).toMatch(/t\.user_id = e\.user_id/);
	});

	it("writes no rows, adds no CHECK/constraint, touches no function signatures", () => {
		expect(sql).not.toMatch(/INSERT INTO/i);
		expect(sql).not.toMatch(/ADD CONSTRAINT/i);
		expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
		expect(sql).not.toMatch(/DROP FUNCTION/i);
		expect(sql).not.toMatch(/ALTER TABLE/i);
	});
});
