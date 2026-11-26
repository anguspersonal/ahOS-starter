import { afterEach, describe, expect, it, vi } from "vitest";

import { relationshipsMatch } from "@ahkms/core";
import { supabase } from "../supabase.js";
import { collectAliases, isMissingColumnError, normalizeAliases } from "../aliases.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const entitiesCreateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_create")!).handler(args);
const entitiesQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_query")!).handler(args);
const entitiesUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_update")!).handler(args);
const peopleCreateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_create")!).handler(args);
const peopleMatchHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_match")!).handler(args);
const peopleQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_query")!).handler(args);
const peopleUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_update")!).handler(args);

// #1023 (ADR-092): aliases are a first-class text[] column on entities (and
// therefore on the people view). Nicknames are how people are actually referred
// to, so the matchers must read them — and must keep working in the window
// before migration 110 is pushed, when the column does not exist yet.

vi.mock("../embeddings.js", () => ({ embedAndStore: vi.fn(async () => {}) }));

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const MISSING = (col: string) => ({ code: "42703", message: `column people.${col} does not exist` });

/**
 * Query-builder stub. `rows` is the table; when `columnMissing` is set, any
 * select naming `aliases` fails the way PostgREST does before the migration.
 */
function stubTable(rows: unknown[], opts: { columnMissing?: boolean } = {}) {
	const seen = { selects: [] as string[], inserts: [] as any[], updates: [] as any[] };
	(supabase as any).from = vi.fn(() => {
		let cols = "";
		const b: any = {
			select: (c?: string) => {
				if (c !== undefined) {
					cols = c;
					seen.selects.push(c);
				}
				return b;
			},
			eq: () => b,
			in: () => b,
			order: () => b,
			insert: (r: any[]) => {
				seen.inserts.push(...r);
				return {
					select: () => Promise.resolve({ data: r.map((x: any) => ({ ...x })), error: null }),
				};
			},
			update: (u: any) => {
				seen.updates.push(u);
				const w: any = {
					eq: () => w,
					in: () => w,
					select: () => w,
					then: (resolve: (v: unknown) => unknown) => resolve({ data: [{ id: "p1", title: "x" }], error: null }),
				};
				return w;
			},
			limit: (n: number) =>
				Promise.resolve(
					opts.columnMissing && cols.includes("aliases")
						? { data: null, error: MISSING("aliases") }
						: { data: rows.slice(0, n), error: null },
				),
			maybeSingle: () => Promise.resolve({ data: null, error: null }),
		};
		return b;
	});
	return seen;
}

const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
	id,
	name,
	bio: null,
	role: null,
	organization: null,
	email: null,
	phone: null,
	relationship: null,
	last_contact: null,
	tags: [],
	archived: false,
	archived_at: null,
	properties: {},
	source_url: null,
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
	...extra,
});

describe("alias helpers", () => {
	it("normalises: trims, drops blanks, dedupes case-insensitively, keeps first spelling", () => {
		expect(normalizeAliases(["  Todd ", "todd", "", "TM", "  "])).toEqual(["Todd", "TM"]);
	});

	it("collects the column and the legacy properties.aliases jsonb together", () => {
		expect(
			collectAliases({ aliases: ["Todd"], properties: { aliases: ["todd", "T-Bone", 7] } }),
		).toEqual(["Todd", "T-Bone"]);
		expect(collectAliases({ properties: null })).toEqual([]);
	});

	it("recognises PostgREST's missing-column error for the named column only", () => {
		expect(isMissingColumnError(MISSING("aliases"), "aliases")).toBe(true);
		expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'aliases' column" }, "aliases")).toBe(true);
		expect(isMissingColumnError(MISSING("hot"), "aliases")).toBe(false);
		expect(isMissingColumnError(MISSING("photo"), "hot")).toBe(false);
		expect(isMissingColumnError(MISSING("hot"), "hot")).toBe(true);
		expect(isMissingColumnError({ code: "57014", message: "timeout" }, "aliases")).toBe(false);
		expect(isMissingColumnError(null, "aliases")).toBe(false);
	});
});

describe("people_match reads aliases", () => {
	it("resolves a nickname to the canonical person", async () => {
		stubTable([person("todd-1", "Todd Martinez", { aliases: ["todd"] }), person("t-2", "Toddler Group")]);
		const res = await peopleMatchHandler({ name: "Todd" });
		const text = res.content[0].text;
		expect(text).toContain("Best candidate: [todd-1] Todd Martinez");
		expect(text).toContain("exact alias match");
	});

	it("finds a person known only by an alias the name does not contain", async () => {
		stubTable([person("r-1", "Robert Smith", { aliases: ["Bob"] })]);
		const res = await peopleMatchHandler({ name: "bob" });
		expect(res.content[0].text).toContain("[r-1] Robert Smith");
	});

	it("still reads legacy properties.aliases, and still works before the column exists", async () => {
		const seen = stubTable(
			[person("r-1", "Robert Smith", { properties: { aliases: ["Bob"] } })],
			{ columnMissing: true },
		);
		const res = await peopleMatchHandler({ name: "Bob" });
		expect(res.content[0].text).toContain("[r-1] Robert Smith");
		// First attempt asked for the column, the retry did not.
		expect(seen.selects[0]).toContain("aliases");
		expect(seen.selects[1]).not.toContain("aliases");
	});

	it("people_query shows aliases and the hot flag", async () => {
		stubTable([person("todd-1", "Todd Martinez", { aliases: ["todd"], hot: true })]);
		const res = await peopleQueryHandler({ query: "todd" });
		expect(res.content[0].text).toContain("aka: todd");
		expect(res.content[0].text).toContain("hot");
	});

	it("matches relationship synonyms and diacritics (e.g. 'fiancée' matches stored 'Partner')", async () => {
		stubTable([person("laura-1", "Laura Sharp", { relationship: "Partner" })]);
		const res = await peopleMatchHandler({ name: "Laura", relationship: "fiancée" });
		const text = res.content[0].text;
		expect(text).toContain("Match result: probable match");
		expect(text).toContain("Best candidate: [laura-1] Laura Sharp");
		expect(text).toContain("relationship match");
	});

	it("enforces word boundaries in relationshipsMatch so 'Gopal'/'Palantir' do not match 'Friend' ('pal') and 'midwife' does not match 'Partner' ('wife')", async () => {
		expect(relationshipsMatch("Friend", "Gopal")).toBe(false);
		expect(relationshipsMatch("Friend", "Palantir")).toBe(false);
		expect(relationshipsMatch("Partner", "midwife")).toBe(false);
		expect(relationshipsMatch("Close friend", "pal")).toBe(true);

		stubTable([
			person("friend-1", "Alice Example", { relationship: "Friend" }),
			person("partner-1", "Laura Sharp", { relationship: "Partner" }),
		]);
		const gopalRes = await peopleQueryHandler({ query: "Gopal" });
		expect(gopalRes.content[0].text).not.toContain("Alice Example");
		const midwifeRes = await peopleQueryHandler({ query: "midwife" });
		expect(midwifeRes.content[0].text).not.toContain("Laura Sharp");
	});
});

describe("people writes carry aliases and hot as columns", () => {
	it("create writes normalised aliases and hot onto the entities row", async () => {
		const seen = stubTable([]);
		await peopleCreateHandler({ people: [{ name: "Todd Martinez", aliases: ["todd", " Todd "], hot: true }] });
		expect(seen.inserts[0]).toMatchObject({ aliases: ["todd"], hot: true });
		expect(seen.inserts[0].properties.aliases).toBeUndefined();
	});

	it("create leaves both columns out when not given, so it works pre-migration", async () => {
		const seen = stubTable([]);
		await peopleCreateHandler({ people: [{ name: "Plain Person" }] });
		expect(seen.inserts[0]).not.toHaveProperty("aliases");
		expect(seen.inserts[0]).not.toHaveProperty("hot");
	});

	it("update patches aliases and hot", async () => {
		const seen = stubTable([]);
		await peopleUpdateHandler({ ids: ["00000000-0000-4000-8000-000000000001"], patch: { aliases: ["T"], hot: false } });
		expect(seen.updates[0]).toEqual({ aliases: ["T"], hot: false });
	});
});

const entity = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
	id,
	entity_type: "organization",
	title,
	description: null,
	archived: false,
	archived_at: null,
	properties: {},
	tags: [],
	source_url: null,
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
	...extra,
});

describe("entities read and write aliases", () => {
	it("entities_query matches on an alias", async () => {
		stubTable([entity("lr-1", "LogicRays Technologies", { aliases: ["LR"] }), entity("x", "Other")]);
		const res = await entitiesQueryHandler({ query: "lr" });
		expect(res.content[0].text).toContain("[lr-1]");
		expect(res.content[0].text).toContain("aka: LR");
	});

	it("entities_query retries without the column before the migration lands", async () => {
		const seen = stubTable([entity("lr-1", "LogicRays Technologies")], { columnMissing: true });
		const res = await entitiesQueryHandler({ query: "logicrays" });
		expect(res.content[0].text).toContain("[lr-1]");
		expect(seen.selects[1]).not.toContain("aliases");
	});

	it("create accepts a term with its expansion and context, plus aliases and hot", async () => {
		const seen = stubTable([]);
		await entitiesCreateHandler({
			entities: [
				{
					entity_type: "term",
					title: "PSR",
					properties: { expansion: "Pipeline Status Report", context: "Work finance" },
					aliases: ["psr"],
					hot: true,
				},
			],
		});
		expect(seen.inserts[0]).toMatchObject({ entity_type: "term", aliases: ["psr"], hot: true });
	});

	it("update patches aliases and hot", async () => {
		const seen = stubTable([]);
		await entitiesUpdateHandler({ ids: ["00000000-0000-4000-8000-000000000002"], patch: { aliases: ["LR"], hot: true } });
		expect(seen.updates[0]).toEqual({ aliases: ["LR"], hot: true });
	});
});
