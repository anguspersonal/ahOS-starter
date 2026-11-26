import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { dosConfigSchema, domainConfig, pillarNotionOption } from "../dosConfig.js";

// Migration 088 hand-writes the `angus` domain block as a JSONB literal, and migration
// 087 hand-writes the `Synthesis Status` property as another. Neither can import the
// reader, so nothing but this test stops the two drifting apart — and the drift would
// be invisible until a nightly ritual read the blob in production, because the SQL is
// pushed by hand long after the code deploys.
//
// So: parse the literal the migration actually ships and run it through the real
// schema. What is asserted here is what the owner's Notion workspace contains, read
// live 2026-08-21 and ratified on #679 (see ADR-054 Errata 1 and 2). If Notion
// changes, this test and the migration change together.

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../supabase/migrations",
);

function readMigration(marker: RegExp): string {
	const file = readdirSync(migrationsDir).find((f) => marker.test(f));
	if (!file) throw new Error(`migration ${marker} not found in ${migrationsDir}`);
	return readFileSync(join(migrationsDir, file), "utf8");
}

/**
 * Pull a single-quoted SQL JSONB literal out of the migration. Safe as a plain
 * delimiter scan because these literals contain no apostrophes — which is itself
 * asserted below, since an apostrophe would need SQL escaping and would break the
 * migration, not just this parser.
 */
function extractJsonLiteral(sql: string, afterMarker: string): unknown {
	const start = sql.indexOf(afterMarker);
	if (start < 0) throw new Error(`marker not found: ${afterMarker}`);
	const open = sql.indexOf("'", start + afterMarker.length);
	const close = sql.indexOf("'", open + 1);
	return JSON.parse(sql.slice(open + 1, close));
}

/** The same scan, anchored on text INSIDE the literal rather than before it. */
function extractJsonLiteralContaining(sql: string, needle: string): unknown {
	const at = sql.indexOf(needle);
	if (at < 0) throw new Error(`needle not found: ${needle}`);
	const open = sql.lastIndexOf("'", at);
	const close = sql.indexOf("'", at);
	return JSON.parse(sql.slice(open + 1, close));
}

const migration088 = readMigration(/_088_/);
const angusLiteral = extractJsonLiteral(migration088, "'angus',");

describe("migration 088 ships an `angus` block the reader understands", () => {
	const parsed = dosConfigSchema.parse({ by_domain: { angus: angusLiteral } });
	const angus = domainConfig(parsed, "angus");

	it("parses under the real schema, losing nothing but the pre-089 pillar key", () => {
		// A literal the reader has to fill defaults into is a literal that lost data.
		// The one permitted difference is #692's rename: 088 was authored before the
		// `Pillars` multi-select existed, so it stores the projection under
		// `notion_property`, and the read boundary normalises that onto `notion_option`
		// until migration 089 moves the stored blob itself.
		expect(angus).toEqual({
			...(angusLiteral as Record<string, unknown>),
			pillars: (angusLiteral as { pillars: Record<string, string>[] }).pillars.map((p) => ({
				key: p.key,
				label: p.label,
				description: p.description,
				notion_option: p.notion_property,
			})),
		});
	});

	it("carries the five pillars the owner confirmed on 2026-08-21", () => {
		expect(angus?.pillars.map((p) => p.label)).toEqual([
			"Laura",
			"Friends and Family",
			"Health and Fitness",
			"Home and Admin",
			"Finances",
		]);
	});

	it("still yields the five projection strings through the pre-089 read (#692)", () => {
		// These strings reach the owner's real workspace verbatim, and did not change
		// when #692 replaced the checkbox properties with a `Pillars` multi-select: the
		// backfill carried the names over as options, so the SAME strings now name
		// options rather than properties. `key` is internal vocabulary (`Pillar N`, per
		// migration 086) and deliberately differs.
		expect(angus?.pillars.map(pillarNotionOption)).toEqual([
			"P1 Laura",
			"P2 Friends and Family",
			"P3 Health and Fitness",
			"P4 Home and Admin",
			"P5 Finances",
		]);
		expect(angus?.pillars.every((p) => p.key.startsWith("Pillar "))).toBe(true);
	});

	it("leaves artefact_registers empty — nothing in Notion to ratify", () => {
		// The personal `Artefacts generated` multi_select has zero options, so ADR-054
		// §5's "an empty list is a legitimate answer" applies here (unlike pillars).
		expect(angus?.artefact_registers).toEqual([]);
	});

	it("keeps `KMS/repo` as a topic — ADR-051 §1 puts repo work in this domain", () => {
		expect(angus?.topics).toContain("KMS/repo");
	});

	it("carries the personal routing signals across verbatim from `workspace.personal_signals`", () => {
		expect(angus?.domain_signals).toEqual([
			"private health",
			"family",
			"friends",
			"side projects",
		]);
	});

	it("mirrors the live Notion property list, in order", () => {
		expect(angus?.daily_log_schema.properties.map((p) => p.name)).toEqual([
			"Name",
			"Date",
			"Type",
			"Summary",
			"Synthesis Status",
			"Other domains",
			"Artefacts generated",
			"Reflection included",
		]);
	});

	it("declares `Synthesis Status` as a required select, so the #561 sweep is enabled", () => {
		expect(
			angus?.daily_log_schema.properties.find((p) => p.name === "Synthesis Status"),
		).toMatchObject({ notion_type: "select", required: true });
	});

	it("does not declare the pillar projections as schema properties", () => {
		// Pillar projection strings come from the pillar list, exactly as on the work
		// side. Declaring them twice would let the two lists disagree — and after #692
		// they are option VALUES, which are never property names at all.
		const names = angus?.daily_log_schema.properties.map((p) => p.name) ?? [];
		expect(names.some((n) => n.startsWith("P1 "))).toBe(false);
	});
});

describe("migrations 087 and 088 agree on the `Synthesis Status` declaration", () => {
	// 087 appends the property to the flat blob; 088 declares it in the angus block and
	// back-fills it into work. Three copies of one string is a drift risk, so pin
	// them together here — the sweep matches on this text being right.
	const from087 = extractJsonLiteralContaining(
		readMigration(/_087_/),
		'"name": "Synthesis Status"',
	) as { name: string; notion_type: string; required: boolean; notes: string }[];

	const angusProperty = (
		angusLiteral as { daily_log_schema: { properties: { name: string; notes: string }[] } }
	).daily_log_schema.properties.find((p) => p.name === "Synthesis Status");

	it("declares the same property, byte for byte, in 087 and in 088's angus block", () => {
		expect(from087).toHaveLength(1);
		expect(from087[0]).toEqual(angusProperty);
	});

	it("back-fills that same declaration into the work block", () => {
		// The belt-and-braces append inside 088, for the case where 088 somehow runs
		// before 087 and 087 then no-ops on the now-absent flat key.
		expect(migration088).toContain(from087[0].notes);
	});
});

describe("migration 088 preserves what it must and drops only what ADR-054 says to", () => {
	it("removes the flat per-domain keys and no others", () => {
		const removed = migration088.match(/^\s+- '(\w+)'$/gm)?.map((l) => l.trim().slice(3, -1));

		expect(removed?.sort()).toEqual([
			"artefact_registers",
			"daily_log_schema",
			"domains",
			"pillars",
			"state_doc_rules",
			"workspace",
		]);
	});

	it("never removes the global keys", () => {
		// `types` and `tone` stay at the top level (ADR-054 §5's global column).
		expect(migration088).not.toMatch(/- 'types'/);
		expect(migration088).not.toMatch(/- 'tone'/);
	});

	it("filters ADR-054 §2's `Personal` topic out of the work topic list", () => {
		expect(migration088).toContain(`'"Personal"'::jsonb`);
	});

	it("is guarded so an already-migrated or malformed blob is skipped", () => {
		expect(migration088).toContain("jsonb_typeof(dos_hl_config) = 'object'");
		expect(migration088).toContain(`coalesce(dos_hl_config -> 'by_domain', '{}'::jsonb) = '{}'::jsonb`);
		// Migration 086 is a precondition: a row still on the pre-#618 key is skipped
		// rather than having `priorities` silently dropped by the key removal.
		expect(migration088).toContain(`not (dos_hl_config ? 'priorities')`);
	});

	it("uses no apostrophes inside its JSON literals, which would need SQL escaping", () => {
		expect(JSON.stringify(angusLiteral)).not.toContain("'");
	});
});

// Migration 089 (#692). The pillar checkbox properties were deleted from both Notion
// Daily Logs before this migration was authored, so the config it produces is the only
// description of where a pillar now writes. Same drift risk as 088, same treatment:
// parse the literals the migration actually ships and run them through the real schema.
const migration089 = readMigration(/_089_/);

// The file is two independent UPDATE statements, one per domain, each introduced by a
// `-- N. <domain>:` line. The header comment's own numbered list is indented further,
// so it does not match.
const [, workStatement, angusStatement] = migration089.split(/^-- \d\. /m);

/** Every JSON literal 089 hand-writes, for the assertions that treat them as a set. */
const migration089Literals = [
	extractJsonLiteral(workStatement, "'pillars',"),
	extractJsonLiteralContaining(workStatement, '"name": "Pillars"'),
	extractJsonLiteralContaining(angusStatement, '"name": "Pillars"'),
];

describe("migration 089 repoints work onto the current objectives (#692)", () => {
	const workPillarsLiteral = extractJsonLiteral(workStatement, "'pillars',");
	const parsed = dosConfigSchema.parse({
		by_domain: { work: { pillars: workPillarsLiteral } },
	});
	const pillars = domainConfig(parsed, "work")?.pillars ?? [];

	it("carries the four objectives the owner confirmed on 2026-08-21", () => {
		expect(pillars.map((p) => [p.label, p.description])).toEqual([
			["Product", "Deliver exceptional product"],
			["Operations", "Maintain the business"],
			["Investment", "Raise investment"],
			["Marketing", "Grow the business through marketing"],
		]);
	});

	it("writes the immutable option names, not the objective sentences", () => {
		// The sentences live in `description` and may be reworded freely. The option is
		// the identity every historical entry is filed against and may never change.
		expect(pillars.map(pillarNotionOption)).toEqual([
			"Product",
			"Operations",
			"Investment",
			"Marketing",
		]);
	});

	it("keeps migration 086's `Pillar N` key convention", () => {
		expect(pillars.map((p) => p.key)).toEqual(["Pillar 1", "Pillar 2", "Pillar 3", "Pillar 4"]);
	});

	it("stores the projection under the post-089 key and never the pre-089 one", () => {
		expect(JSON.stringify(workPillarsLiteral)).toContain("notion_option");
		expect(JSON.stringify(workPillarsLiteral)).not.toContain("notion_property");
	});

	it("omits the four retired options, which stay in Notion for history alone", () => {
		// Config describes what is currently SELECTABLE. `P1 Launch` and friends remain
		// as Notion options so a May entry still reads correctly, but offering them to
		// tonight's ritual would invite a new entry to claim a retired objective.
		for (const retired of ["P1 Launch", "P2 Round", "P3 EHS", "P4 Retention/WTP"]) {
			expect(JSON.stringify(workPillarsLiteral)).not.toContain(retired);
		}
	});
});

describe("migration 089 renames the angus projection field without touching its values", () => {
	// angus is TRANSFORMED, not replaced with a literal, so a pillar the owner added by
	// hand since 088 survives. That leaves nothing to parse, so the assertions are about
	// the transform itself — and about what it must NOT contain.
	it("moves each value from the pre-089 key onto the post-089 one", () => {
		expect(angusStatement).toContain("'notion_option',");
		expect(angusStatement).toContain(
			"coalesce(p ->> 'notion_option', p ->> 'notion_property')",
		);
	});

	it("drops the pre-089 key, so the two can never disagree", () => {
		expect(angusStatement).toContain("p - 'notion_property'");
	});

	it("re-authors none of the five option strings — this is a rename, not a rewrite", () => {
		// If any of these appeared here the migration would be replacing the list, and a
		// sixth pillar the owner added since 088 would be silently deleted.
		for (const option of [
			"P1 Laura",
			"P2 Friends and Family",
			"P3 Health and Fitness",
			"P4 Home and Admin",
			"P5 Finances",
		]) {
			expect(angusStatement).not.toContain(option);
		}
	});
});

describe("migration 089 declares the `Pillars` multi-select on both domains", () => {
	const declaration = (statement: string) =>
		extractJsonLiteralContaining(statement, '"name": "Pillars"') as {
			name: string;
			notion_type: string;
			required: boolean;
			notes: string;
		}[];

	const workDeclaration = declaration(workStatement);
	const angusDeclaration = declaration(angusStatement);

	it("declares it identically in both domains, byte for byte", () => {
		// Two copies of one rule is a drift risk; pin them together, exactly as 087 and
		// 088 are pinned on `Synthesis Status` above.
		expect(workDeclaration).toHaveLength(1);
		expect(angusDeclaration).toEqual(workDeclaration);
	});

	it("declares a multi_select that a zero-progress day can leave empty", () => {
		expect(workDeclaration[0]).toMatchObject({
			name: "Pillars",
			notion_type: "multi_select",
			required: false,
		});
	});

	it("parses under the real daily-log schema", () => {
		const block = domainConfig(
			dosConfigSchema.parse({
				by_domain: { work: { daily_log_schema: { properties: workDeclaration } } },
			}),
			"work",
		);

		expect(block?.daily_log_schema.properties).toEqual(workDeclaration);
	});

	it("carries the never-rename rule where a future pillar change will hit it", () => {
		// The rule is the load-bearing part of #692. A migration header nobody reads at
		// write time is not where it belongs; the rendered config is.
		expect(workDeclaration[0].notes).toContain("NEVER RENAME AN OPTION, ONLY ADD");
		expect(workDeclaration[0].notes).toContain("A changed objective is a NEW option");
	});

	it("warns that Notion creates an unknown option rather than rejecting it", () => {
		// The failure mode that makes "never invent one" more than style: an invented
		// value does not error, it adds a pillar identity to the owner's workspace.
		expect(workDeclaration[0].notes).toContain("Notion CREATES an unknown multi-select option");
	});
});

describe("migration 089 is guarded, idempotent, and pushable by hand", () => {
	it("operates on the post-088 shape only, skipping a flat blob rather than half-editing it", () => {
		expect(migration089).toContain("jsonb_typeof(dos_hl_config -> 'by_domain') = 'object'");
		expect(migration089).toContain(`dos_hl_config -> 'by_domain' <> '{}'::jsonb`);
	});

	it("type-guards every domain key it reads", () => {
		for (const domain of ["work", "angus"]) {
			expect(migration089).toContain(
				`jsonb_typeof(dos_hl_config -> 'by_domain' -> '${domain}') = 'object'`,
			);
		}
	});

	it("converges on a re-run instead of appending a second `Pillars` declaration", () => {
		// Every write in the file is a fixpoint. The property rebuild filters any
		// existing declaration out before re-appending the canonical one.
		expect(migration089.match(/where coalesce\(p ->> 'name', ''\) <> 'Pillars'/g)).toHaveLength(2);
	});

	it("uses no apostrophes inside its JSON literals, which would need SQL escaping", () => {
		expect(JSON.stringify(migration089Literals)).not.toContain("'");
	});
});
