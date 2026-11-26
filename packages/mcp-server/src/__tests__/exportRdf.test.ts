import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Parser } from "n3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import { supabase } from "../supabase.js";
import { buildRegistry, renderTurtle, type RawNamespaceRow, type RawTermRow } from "@ahkms/core/actions";
import { createSupabaseVocabularyReadAdapter } from "@ahkms/core/adapters";

// graph_export_rdf (#454, #1495, ADR-037 §4). Pure renderer cases live in
// packages/core/src/domain/rdf/exportRdf.test.ts; this suite verifies that the
// rendered Turtle parses with an independent RDF parser (n3) and that the
// registry action executes end-to-end over the Supabase vocabulary adapter.

const AHOS_NS: RawNamespaceRow = {
	id: "ns-ahos",
	properties: { type: "ahos_namespace", prefix: "ahos", namespace_iri: "https://example.com/ahos-ontology#", is_default: true },
};
const FOAF_NS: RawNamespaceRow = {
	id: "ns-foaf",
	properties: { type: "ahos_namespace", prefix: "foaf", namespace_iri: "http://xmlns.com/foaf/0.1/", is_default: false },
};
const SCHEMA_NS: RawNamespaceRow = {
	id: "ns-schema",
	properties: { type: "ahos_namespace", prefix: "schema", namespace_iri: "https://schema.org/", is_default: false },
};
const RDFS_NS: RawNamespaceRow = {
	id: "ns-rdfs",
	properties: { type: "ahos_namespace", prefix: "rdfs", namespace_iri: "http://www.w3.org/2000/01/rdf-schema#", is_default: false },
};
const OWL_NS: RawNamespaceRow = {
	id: "ns-owl",
	properties: { type: "ahos_namespace", prefix: "owl", namespace_iri: "http://www.w3.org/2002/07/owl#", is_default: false },
};
const SKOS_NS: RawNamespaceRow = {
	id: "ns-skos",
	properties: { type: "ahos_namespace", prefix: "skos", namespace_iri: "http://www.w3.org/2004/02/skos/core#", is_default: false },
};
const FULL_NAMESPACES = [AHOS_NS, FOAF_NS, SCHEMA_NS, RDFS_NS, OWL_NS, SKOS_NS];

function term(id: string, properties: Record<string, unknown>): RawTermRow {
	return { id, properties: { type: "ahos_concept_term", ...properties } };
}

function parse(turtle: string) {
	return new Parser().parse(turtle);
}

describe("renderTurtle n3 parser round-trip", () => {
	it("parses @prefix declarations as valid Turtle", () => {
		const turtle = renderTurtle({ namespaces: [AHOS_NS, FOAF_NS], terms: [] });
		expect(() => parse(turtle)).not.toThrow();
	});

	it("compacts a term to its CURIE and round-trips label/comment/external_match as real triples", () => {
		const turtle = renderTurtle({
			namespaces: FULL_NAMESPACES,
			terms: [
				term("t1", {
					term: "people",
					local_name: "People",
					applies_to: "entity_type",
					definition: "A human being.",
					external_match: [{ relation: "exactMatch", iri: "foaf:Person" }],
				}),
			],
		});

		const quads = parse(turtle);
		const subject = "https://example.com/ahos-ontology#People";
		expect(quads).toContainEqual(
			expect.objectContaining({
				subject: expect.objectContaining({ value: subject }),
				predicate: expect.objectContaining({ value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" }),
				object: expect.objectContaining({ value: "http://www.w3.org/2002/07/owl#Class" }),
			}),
		);
		expect(quads).toContainEqual(
			expect.objectContaining({
				predicate: expect.objectContaining({ value: "http://www.w3.org/2000/01/rdf-schema#label" }),
				object: expect.objectContaining({ value: "People" }),
			}),
		);
		expect(quads).toContainEqual(
			expect.objectContaining({
				predicate: expect.objectContaining({ value: "http://www.w3.org/2000/01/rdf-schema#comment" }),
				object: expect.objectContaining({ value: "A human being." }),
			}),
		);
		expect(quads).toContainEqual(
			expect.objectContaining({
				predicate: expect.objectContaining({ value: "http://www.w3.org/2004/02/skos/core#exactMatch" }),
				object: expect.objectContaining({ value: "http://xmlns.com/foaf/0.1/Person" }),
			}),
		);
	});

	it("maps applies_to='edge_type' to owl:ObjectProperty and omits a type triple when applies_to is absent", () => {
		const turtle = renderTurtle({
			namespaces: [AHOS_NS, RDFS_NS, OWL_NS],
			terms: [
				term("t2", { term: "employed_at", local_name: "employed_at", applies_to: "edge_type" }),
				term("t3", { term: "misc", local_name: "Misc" }),
			],
		});
		const quads = parse(turtle);
		expect(quads).toContainEqual(
			expect.objectContaining({
				subject: expect.objectContaining({ value: "https://example.com/ahos-ontology#employed_at" }),
				object: expect.objectContaining({ value: "http://www.w3.org/2002/07/owl#ObjectProperty" }),
			}),
		);
		const miscTypeTriples = quads.filter(
			(q) =>
				q.subject.value === "https://example.com/ahos-ontology#Misc" &&
				q.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
		);
		expect(miscTypeTriples).toHaveLength(0);
	});
});

describe("graph_export_rdf registry action handler", () => {
	const origFrom = supabase.from;
	afterEach(() => {
		(supabase as any).from = origFrom;
		vi.restoreAllMocks();
	});

	function chainBuilder(result: unknown) {
		const calls: Array<[string, unknown]> = [];
		const b: any = {
			select: () => b,
			eq: (col: string, val: unknown) => {
				calls.push([col, val]);
				return b;
			},
			then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
			_calls: calls,
		};
		return b;
	}

	it("queries entities for both namespace and term rows and formats Turtle through the registry action", async () => {
		const nsBuilder = chainBuilder({ data: [AHOS_NS, RDFS_NS], error: null });
		const termBuilder = chainBuilder({ data: [term("t1", { local_name: "People" })], error: null });
		// Both queries hit "entities" (discriminated by the properties->>type filter),
		// so the fake distinguishes calls by order: namespace query first, term query second.
		let calls = 0;
		const from = vi.fn((table: string) => {
			expect(table).toBe("entities");
			return calls++ === 0 ? nsBuilder : termBuilder;
		});
		(supabase as any).from = from;

		const action = buildRegistry({
			vocabulary: createSupabaseVocabularyReadAdapter(supabase as any),
		}).get("graph_export_rdf")!;

		const out = await action.run({}, { caller: "mcp", requestId: "req-1", userId: "user-1" });
		const turtle = action.formatMcp!(out);

		expect(nsBuilder._calls).toContainEqual(["properties->>type", "ahos_namespace"]);
		expect(termBuilder._calls).toContainEqual(["properties->>type", "ahos_concept_term"]);
		expect(turtle).toContain("@prefix ahos: <https://example.com/ahos-ontology#> .");
		expect(turtle).toContain('ahos:People rdfs:label "People" .');
	});
});

describe("registration", () => {
	it("serves graph_export_rdf over a real client connection", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test-client", version: "0.0.0" });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const tools = (await client.listTools()).tools.map((t) => t.name);
		expect(tools).toContain("graph_export_rdf");

		await client.close();
		await server.close();
	});
});

