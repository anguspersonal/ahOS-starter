import { afterEach, describe, expect, it, vi } from "vitest";

import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { buildRegistry } from "@ahkms/core/actions";
import { createSupabaseVocabularyReadAdapter } from "@ahkms/core/adapters";

const entitiesCreateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_create")!).handler(args);
const entitiesQueryHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_query")!).handler(args);
const entitiesUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_update")!).handler(args);
const entitiesUpsertHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_upsert")!).handler(args);

const origFrom = supabase.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

function stubTable(rows: unknown[]) {
	const calls: any[] = [];
	const b: any = {
		_calls: calls,
		select: () => b,
		eq: (col: string, val: any) => {
			calls.push(["eq", col, val]);
			return b;
		},
		is: (col: string, val: any) => {
			calls.push(["is", col, val]);
			return b;
		},
		in: (col: string, val: any) => {
			calls.push(["in", col, val]);
			return b;
		},
		order: () => b,
		limit: (n: number) => {
			let result = rows;
			const localNameCall = calls.find(([op, col]) => op === "eq" && col === "local_name");
			if (localNameCall) {
				result = result.filter((r: any) => r.local_name === localNameCall[2]);
			}
			const namespaceCall = calls.find(([op, col]) => (op === "is" || op === "eq") && col === "namespace");
			if (namespaceCall) {
				const expected = namespaceCall[0] === "is" ? null : namespaceCall[2];
				result = result.filter((r: any) => r.namespace === expected);
			}
			return Promise.resolve({ data: result.slice(0, n), error: null });
		},
		maybeSingle: () => Promise.resolve({ data: null, error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
	return b;
}

const entity = (
	id: string,
	title: string,
	local_name: string | null = null,
	namespace: string | null = null,
) => ({
	id,
	entity_type: "people",
	title,
	description: null,
	archived: false,
	archived_at: null,
	properties: {},
	tags: [],
	source_url: null,
	local_name,
	namespace,
	user_id: "u1",
	team_id: null,
	created_at: null,
	updated_at: null,
});

/**
 * A `supabase.from("entities")` stub whose `.limit()` resolves with a
 * pre-scripted sequence of `{data, error}` results, one per successive call —
 * for exercising `withAliasColumns`'s multi-attempt degrade chain, where each
 * attempt selects different columns and must be driven independently of what
 * those columns actually are.
 */
function stubTableSequential(rows: unknown[], results: Array<{ code?: string; message?: string } | null>) {
	const selects: string[] = [];
	let call = 0;
	const b: any = {
		_selects: selects,
		select: (columns: string) => {
			selects.push(columns);
			return b;
		},
		eq: () => b,
		is: () => b,
		in: () => b,
		order: () => b,
		limit: (n: number) => {
			const error = results[call] ?? null;
			call += 1;
			if (error) return Promise.resolve({ data: null, error });
			return Promise.resolve({ data: rows.slice(0, n), error: null });
		},
		maybeSingle: () => Promise.resolve({ data: null, error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
	return b;
}

describe("withAliasColumns degrade path (#1104 QA round 1 Medium finding)", () => {
	it("degrades to migration-110 columns (aliases/hot) when only local_name/namespace are missing", async () => {
		const stub = stubTableSequential(
			[entity("e1", "Angus Hally", "ExampleOwner", null)],
			[{ code: "42703", message: "column entities.local_name does not exist" }, null],
		);

		const res = await entitiesQueryHandler({});

		// entitiesQueryHandler also queries user_preferences (dos_config) and
		// entity_relationships (PARA containment) via the same mocked `.from()` —
		// isolate the `entities` list-query attempts by their distinctive column set.
		const entitySelects = stub._selects.filter((s: string) => s.includes("entity_type"));
		expect(res.content[0].text).toContain("Angus Hally");
		expect(entitySelects).toHaveLength(2);
		expect(entitySelects[0]).toContain("local_name");
		expect(entitySelects[1]).not.toContain("local_name");
		expect(entitySelects[1]).toContain("aliases");
	});

	it("falls all the way to base columns when the migration-110 retry also reports a missing column", async () => {
		const stub = stubTableSequential(
			[entity("e1", "Angus Hally", "ExampleOwner", null)],
			[
				{ code: "42703", message: "column entities.local_name does not exist" },
				{ code: "42703", message: "column entities.aliases does not exist" },
				null,
			],
		);

		const res = await entitiesQueryHandler({});

		const entitySelects = stub._selects.filter((s: string) => s.includes("entity_type"));
		expect(res.content[0].text).toContain("Angus Hally");
		expect(entitySelects).toHaveLength(3);
		expect(entitySelects[2]).not.toContain("aliases");
		expect(entitySelects[2]).not.toContain("local_name");
	});
});

describe("entities_query with local_name and namespace (#1104)", () => {
	it("formats local_name and namespace when set", async () => {
		stubTable([
			entity("e1", "Angus Hally", "ExampleOwner", null),
			entity("e2", "Todd", "todd", "foaf"),
		]);
		const res = await entitiesQueryHandler({});
		expect(res.content[0].text).toContain("local_name: ExampleOwner");
		expect(res.content[0].text).toContain("local_name: todd (foaf)");
	});

	it("omits local_name when null", async () => {
		stubTable([entity("e3", "Anonymous Person", null, null)]);
		const res = await entitiesQueryHandler({});
		expect(res.content[0].text).not.toContain("local_name:");
	});

	it("filters by exact local_name in DB query", async () => {
		const stub = stubTable([
			entity("e1", "Angus Hally", "ExampleOwner", null),
			entity("e2", "Todd", "todd", null),
		]);
		const res = await entitiesQueryHandler({ local_name: "ExampleOwner" });
		expect(stub._calls).toContainEqual(["eq", "local_name", "ExampleOwner"]);
		expect(res.content[0].text).toContain("Angus Hally");
		expect(res.content[0].text).not.toContain("Todd");
	});

	it("filters by namespace pointer in DB query, treating 'ahos' as null", async () => {
		const stub = stubTable([
			entity("e1", "Angus Hally", "ExampleOwner", null),
			entity("e2", "Todd", "todd", "foaf"),
		]);
		const res = await entitiesQueryHandler({ namespace: "ahos" });
		expect(stub._calls).toContainEqual(["is", "namespace", null]);
		expect(res.content[0].text).toContain("Angus Hally");
		expect(res.content[0].text).not.toContain("Todd");
	});

	it("matches query needle on local_name and namespace in JS scan", async () => {
		stubTable([
			entity("e1", "Sam", "samwise", null),
			entity("e2", "Frodo", "frodo", "lotr"),
		]);
		const res1 = await entitiesQueryHandler({ query: "samwise" });
		expect(res1.content[0].text).toContain("Sam");

		const res2 = await entitiesQueryHandler({ query: "lotr" });
		expect(res2.content[0].text).toContain("Frodo");
	});
});

function stubMutate() {
	const calls: { insert?: unknown; update?: unknown } = {};
	const b: any = {
		insert: (rows: unknown) => {
			calls.insert = rows;
			return b;
		},
		update: (values: unknown) => {
			calls.update = values;
			return b;
		},
		delete: () => b,
		eq: () => b,
		in: () => b,
		select: () => Promise.resolve({ data: [{ id: "res1", title: "Test" }], error: null }),
	};
	(supabase as any).from = vi.fn(() => b);
	return calls;
}

describe("entity mutations handle local_name and namespace (#1104)", () => {
	it("entity_create populates local_name and namespace and normalizes empty strings / ahos", async () => {
		const calls = stubMutate();
		await entitiesCreateHandler({
			entities: [
				{
					title: "Angus",
					local_name: "ExampleOwner",
					namespace: "ahos",
				},
				{
					title: "Todd",
					local_name: "todd",
					namespace: "foaf",
				},
				{
					title: "Empty Strings",
					local_name: "",
					namespace: "",
				},
			],
		});

		const rows = calls.insert as any[];
		expect(rows).toHaveLength(3);

		// 'ahos' is normalized to null (derived default)
		expect(rows[0].local_name).toBe("ExampleOwner");
		expect(rows[0].namespace).toBeNull();

		// Custom namespace preserved
		expect(rows[1].local_name).toBe("todd");
		expect(rows[1].namespace).toBe("foaf");

		// Empty strings normalized to null
		expect(rows[2].local_name).toBeNull();
		expect(rows[2].namespace).toBeNull();
	});

	it("entity_update updates local_name and namespace", async () => {
		const calls = stubMutate();
		await entitiesUpdateHandler({
			ids: ["e1"],
			patch: {
				local_name: "NewLocalName",
				namespace: "schema",
			},
		});

		const updates = calls.update as Record<string, unknown>;
		expect(updates.local_name).toBe("NewLocalName");
		expect(updates.namespace).toBe("schema");
	});

	it("entity_update normalizes empty strings to null", async () => {
		const calls = stubMutate();
		await entitiesUpdateHandler({
			ids: ["e1"],
			patch: {
				local_name: "",
				namespace: "ahos",
			},
		});

		const updates = calls.update as Record<string, unknown>;
		expect(updates.local_name).toBeNull();
		expect(updates.namespace).toBeNull();
	});

	it("entity_upsert writes local_name and namespace on insert and update", async () => {
		const calls = stubMutate();
		await entitiesUpsertHandler({
			entities: [
				{
					id: "e1",
					title: "Existing",
					local_name: "UpdatedLocal",
					namespace: "custom",
				},
				{
					title: "New",
					local_name: "NewLocal",
					namespace: null,
				},
			],
		});

		const updatePayload = calls.update as Record<string, unknown>;
		expect(updatePayload.local_name).toBe("UpdatedLocal");
		expect(updatePayload.namespace).toBe("custom");

		const insertPayload = calls.insert as any[];
		expect(insertPayload[0].local_name).toBe("NewLocal");
		expect(insertPayload[0].namespace).toBeNull();
	});
});

describe("exportRdf with column-based local_name (#1104)", () => {
	it("renders terms with column-based local_name and namespace", async () => {
		const FULL_NAMESPACES = [
			{
				id: "ns-ahos",
				properties: { type: "ahos_namespace", prefix: "ahos", namespace_iri: "https://schema.ahos.dev/", is_default: true },
			},
			{
				id: "ns-foaf",
				properties: { type: "ahos_namespace", prefix: "foaf", namespace_iri: "http://xmlns.com/foaf/0.1/", is_default: false },
			},
			{
				id: "ns-rdfs",
				properties: { type: "ahos_namespace", prefix: "rdfs", namespace_iri: "http://www.w3.org/2000/01/rdf-schema#", is_default: false },
			},
			{
				id: "ns-owl",
				properties: { type: "ahos_namespace", prefix: "owl", namespace_iri: "http://www.w3.org/2002/07/owl#", is_default: false },
			},
		];

		// Term row with local_name as column and NO local_name in properties
		const termRow = {
			id: "t1",
			local_name: "person_concept",
			namespace: null, // default ahos
			properties: {
				type: "ahos_concept_term",
				term: "person_concept",
				applies_to: "entity_type",
				definition: "A human being",
			},
		};

		const termRowFoaf = {
			id: "t2",
			local_name: "Person",
			namespace: "http://xmlns.com/foaf/0.1/",
			properties: {
				type: "ahos_concept_term",
				term: "Person",
				applies_to: "entity_type",
			},
		};

		const b1: any = {
			select: () => b1,
			eq: () => Promise.resolve({ data: FULL_NAMESPACES, error: null }),
		};
		const b2: any = {
			select: () => b2,
			eq: () => Promise.resolve({ data: [termRow, termRowFoaf], error: null }),
		};

		let call = 0;
		(supabase as any).from = vi.fn(() => (call++ === 0 ? b1 : b2));

		const action = buildRegistry({
			vocabulary: createSupabaseVocabularyReadAdapter(supabase as any),
		}).get("graph_export_rdf")!;
		const ttl = action.formatMcp!(
			await action.run({}, { caller: "mcp", requestId: "req-1", userId: "user-1" }),
		);

		// Checks CURIE derivation using the column-based local_name
		expect(ttl).toContain("ahos:person_concept");
		expect(ttl).toContain('rdfs:label "person_concept"');
		expect(ttl).toContain('rdfs:comment "A human being"');
		expect(ttl).toContain("foaf:Person");
	});
});
