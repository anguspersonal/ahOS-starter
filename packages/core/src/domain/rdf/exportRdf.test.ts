import { describe, expect, it } from "vitest";
import { renderTurtle, type RawNamespaceRow, type RawTermRow } from "./exportRdf.js";

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
/** The full seeded set (migration 078) minus rdf/rel/xsd, which no test below needs. */
const FULL_NAMESPACES = [AHOS_NS, FOAF_NS, SCHEMA_NS, RDFS_NS, OWL_NS, SKOS_NS];

function term(id: string, properties: Record<string, unknown>): RawTermRow {
	return { id, properties: { type: "ahos_concept_term", ...properties } };
}

describe("renderTurtle (pure domain renderer, #1495)", () => {
	it("declares one @prefix per namespace row", () => {
		const turtle = renderTurtle({ namespaces: [AHOS_NS, FOAF_NS], terms: [] });

		expect(turtle).toContain("@prefix ahos: <https://example.com/ahos-ontology#> .");
		expect(turtle).toContain("@prefix foaf: <http://xmlns.com/foaf/0.1/> .");
	});

	it("puts the default namespace's @prefix line first, then alphabetically", () => {
		const turtle = renderTurtle({ namespaces: [FOAF_NS, SCHEMA_NS, AHOS_NS], terms: [] });
		const prefixLines = turtle.split("\n").filter((l) => l.startsWith("@prefix"));
		expect(prefixLines[0]).toContain("ahos:");
		expect(prefixLines[1]).toContain("foaf:");
		expect(prefixLines[2]).toContain("schema:");
	});

	it("compacts a term to its CURIE and emits label/comment/external_match triples", () => {
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

		expect(turtle).toContain(
			'ahos:People a owl:Class ;\n    rdfs:label "People" ;\n    rdfs:comment "A human being." ;\n    skos:exactMatch foaf:Person .',
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
		expect(turtle).toContain('ahos:employed_at a owl:ObjectProperty ;\n    rdfs:label "employed_at" .');
		expect(turtle).toContain('ahos:Misc rdfs:label "Misc" .');
		expect(turtle).not.toContain("ahos:Misc a ");
	});

	it("resolves a term's non-default namespace pointer and emits its CURIE under that prefix", () => {
		const turtle = renderTurtle({
			namespaces: [AHOS_NS, SCHEMA_NS, RDFS_NS],
			terms: [term("t4", { term: "role", local_name: "Role", namespace: SCHEMA_NS.properties!.namespace_iri as string })],
		});
		expect(turtle).toContain('schema:Role rdfs:label "Role" .');
	});

	it("hard-fails (ADR-037 §5) on a term whose namespace pointer resolves to no namespace row", () => {
		expect(() =>
			renderTurtle({
				namespaces: [AHOS_NS],
				terms: [term("t5", { term: "broken", local_name: "Broken", namespace: "http://no-such-namespace.example/#" })],
			}),
		).toThrow(/No namespace binding/);
	});

	it("hard-fails on an external_match whose prefix has no covered namespace row", () => {
		expect(() =>
			renderTurtle({
				namespaces: [AHOS_NS, RDFS_NS],
				terms: [term("t6", { term: "people", local_name: "People", external_match: [{ relation: "exactMatch", iri: "foaf:Person" }] })],
			}),
		).toThrow(/foaf.*not covered|not covered.*foaf/);
	});

	it("hard-fails when a term needs rdfs/owl/skos but the graph has no namespace row binding that prefix (graph_export_rdf's own fixed vocabulary is validated too)", () => {
		expect(() =>
			renderTurtle({
				namespaces: [AHOS_NS],
				terms: [term("t7", { term: "people", local_name: "People" })],
			}),
		).toThrow(/no namespace row binds prefix 'rdfs'/);
	});

	it("emits an un-prefixed owl:Ontology declaration only for a namespace row with Role-B content beyond the bare binding", () => {
		const described: RawNamespaceRow = {
			id: "ns-foaf-described",
			properties: { ...FOAF_NS.properties, version: "0.1" },
		};
		const turtle = renderTurtle({ namespaces: [AHOS_NS, described, OWL_NS], terms: [] });
		expect(turtle).toContain("<http://xmlns.com/foaf/0.1/> a owl:Ontology .");
		// The bare ahos row (Role A only, no extra properties) gets no such line.
		expect(turtle).not.toContain("<https://example.com/ahos-ontology#> a owl:Ontology .");
	});

	it("throws when no namespace row has both a prefix and a non-empty namespace_iri", () => {
		expect(() => renderTurtle({ namespaces: [{ id: "bad", properties: { type: "ahos_namespace", prefix: "x", namespace_iri: "" } }], terms: [] })).toThrow(
			/no namespace row/,
		);
	});

	it("renders byte-identical Turtle for one logical term whether local_name/namespace live in properties (pre-migration) or in the columns (post-migration)", () => {
		const preMigrationShape = term("t8", {
			term: "role",
			local_name: "Role",
			namespace: SCHEMA_NS.properties!.namespace_iri as string,
			applies_to: "entity_type",
			definition: "A role.",
			external_match: [{ relation: "exactMatch", iri: "schema:Role" }],
		});
		const postMigrationShape: RawTermRow = {
			id: "t8",
			local_name: "Role",
			namespace: SCHEMA_NS.properties!.namespace_iri as string,
			properties: {
				type: "ahos_concept_term",
				term: "role",
				applies_to: "entity_type",
				definition: "A role.",
				external_match: [{ relation: "exactMatch", iri: "schema:Role" }],
			},
		};
		const namespaces = [AHOS_NS, SCHEMA_NS, RDFS_NS, OWL_NS, SKOS_NS];

		const beforeTurtle = renderTurtle({ namespaces, terms: [preMigrationShape] });
		const afterTurtle = renderTurtle({ namespaces, terms: [postMigrationShape] });

		expect(afterTurtle).toBe(beforeTurtle);
	});
});
