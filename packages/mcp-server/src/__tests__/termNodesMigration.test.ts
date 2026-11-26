import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Migration 081 (#453) encodes ADR-037 §1 in the DB: term-row integrity
// guards, the no-stored-iri/curie CHECK, and the graph_terms view that derives
// iri/curie by joining graph_namespaces (migration 078). Mirrors
// namespacesMigration.test.ts: a static lockstep guard over the SQL text — no
// live database is ever touched.

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

function readMigration081(): string {
	const file = readdirSync(migrationsDir).find((f) => /_081_/.test(f));
	if (!file) throw new Error("migration 081 not found in " + migrationsDir);
	return readFileSync(join(migrationsDir, file), "utf8");
}

describe("migration 081 term-node row shape", () => {
	const sql = readMigration081();

	it("claims number 081 exactly once (no duplicate-number collision)", () => {
		const files = readdirSync(migrationsDir).filter((f) => /_081_/.test(f));
		expect(files).toHaveLength(1);
	});

	it("creates the graph_terms view", () => {
		expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.graph_terms/);
	});

	it("derives iri and curie as projections — namespace_iri||local_name and prefix||':'||local_name", () => {
		expect(sql).toMatch(
			/ns\.namespace_iri \|\| \(t\.properties ->> 'local_name'\)\)\s+AS iri/,
		);
		expect(sql).toMatch(
			/ns\.prefix \|\| ':' \|\| \(t\.properties ->> 'local_name'\)\)\s+AS curie/,
		);
	});

	it("joins graph_namespaces with the derived-default (is_default) fast path", () => {
		expect(sql).toMatch(/JOIN public\.graph_namespaces/);
		expect(sql).toMatch(/ELSE ns\.is_default/);
	});

	it("resolves the pointer by BOTH stable identities (namespace_iri or row id), never prefix", () => {
		expect(sql).toMatch(/ns\.namespace_iri = t\.properties ->> 'namespace'/);
		expect(sql).toMatch(/ns\.id::text = t\.properties ->> 'namespace'/);
		// The join must never match on the mutable prefix.
		expect(sql).not.toMatch(/ns\.prefix\s*=/);
	});

	it("adds both term-row integrity indexes, scoped by the discriminator", () => {
		expect(sql).toMatch(/graph_terms_namespace_local_name_uniq/);
		expect(sql).toMatch(/graph_terms_term_uniq/);
		const scoped = sql.match(
			/WHERE (t\.)?properties ->> 'type' = 'ahos_concept_term'/g,
		);
		// Both partial indexes + the view's WHERE clause.
		expect(scoped?.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	it("adds the no-stored-iri/curie CHECK (ADR-037 §5: iri/curie are derived, never stored)", () => {
		expect(sql).toMatch(/entities_term_node_no_stored_iri/);
		expect(sql).toMatch(/properties \?\| ARRAY\['iri', 'curie'\]/);
	});

	it("restricts a stored namespace pointer to the namespace_iri form (QA round 1, #545)", () => {
		// The unique index (guard 1(a)) dedupes on the raw pointer string, but
		// graph_terms resolves a pointer via EITHER namespace_iri OR the
		// namespace row's id — two literal strings that can name the same
		// namespace. Until a writer needs the row-id form, the DB should only
		// accept the namespace_iri form so the unique index stays sound.
		expect(sql).toMatch(/entities_term_node_namespace_pointer_iri_form/);
		expect(sql).toMatch(
			/properties ->> 'namespace' LIKE '%:\/\/%'/,
		);
	});

	it("reuses entity_type 'concept' — no new CHECK value, no entity_type constraint change", () => {
		expect(sql).not.toMatch(/entities_entity_type_check/);
		expect(sql).not.toMatch(/DROP CONSTRAINT/i);
	});

	it("seeds nothing and touches no function signatures", () => {
		expect(sql).not.toMatch(/INSERT INTO/i);
		expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
		expect(sql).not.toMatch(/DROP FUNCTION/i);
	});
});
