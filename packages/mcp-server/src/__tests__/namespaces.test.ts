import { describe, expect, it } from "vitest";
import {
	AHOS_NAMESPACES,
	DEFAULT_NAMESPACE,
	expandPrefix,
	namespacePrefixMap,
	type NamespaceBinding,
} from "@ahkms/shared";

// ADR-037 §2: the namespace binding primitive. These invariants are the same
// ones the migration-078 seed and its partial-unique indexes enforce in the DB;
// pinning them here catches drift in the canonical registry before it reaches a
// `graph_namespaces` seed.

// The prefixes the issue (#452) names as required, plus xsd (referenced by
// datatype IRIs in ahOS-seed.ttl, so it needs a binding too — ADR-037 §5).
const REQUIRED_PREFIXES = [
	"ahos",
	"foaf",
	"schema",
	"rel",
	"skos",
	"rdf",
	"rdfs",
	"owl",
	"xsd",
];

describe("AHOS_NAMESPACES canonical registry", () => {
	it("contains exactly the required prefixes", () => {
		const prefixes = AHOS_NAMESPACES.map((n) => n.prefix).sort();
		expect(prefixes).toEqual([...REQUIRED_PREFIXES].sort());
	});

	it("has unique prefixes", () => {
		const prefixes = AHOS_NAMESPACES.map((n) => n.prefix);
		expect(new Set(prefixes).size).toBe(prefixes.length);
	});

	it("has unique namespace IRIs", () => {
		const iris = AHOS_NAMESPACES.map((n) => n.namespaceIri);
		expect(new Set(iris).size).toBe(iris.length);
	});

	it("declares exactly one default namespace", () => {
		expect(AHOS_NAMESPACES.filter((n) => n.isDefault)).toHaveLength(1);
	});

	it("makes ahos the default, on its HTTPS canonical IRI", () => {
		expect(DEFAULT_NAMESPACE.prefix).toBe("ahos");
		expect(DEFAULT_NAMESPACE.namespaceIri).toBe(
			"https://example.com/ahos-ontology#",
		);
	});

	it("every IRI is absolute http(s) and ends in a separator (# or /)", () => {
		for (const n of AHOS_NAMESPACES) {
			expect(n.namespaceIri).toMatch(/^https?:\/\//);
			expect(/[#/]$/.test(n.namespaceIri)).toBe(true);
		}
	});

	it("pins the external vocabulary IRIs (ahOS-seed.ttl @prefix block)", () => {
		const map = namespacePrefixMap();
		expect(map).toMatchObject({
			foaf: "http://xmlns.com/foaf/0.1/",
			schema: "https://schema.org/",
			rel: "http://purl.org/vocab/relationship/",
			skos: "http://www.w3.org/2004/02/skos/core#",
			rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
			rdfs: "http://www.w3.org/2000/01/rdf-schema#",
			owl: "http://www.w3.org/2002/07/owl#",
			xsd: "http://www.w3.org/2001/XMLSchema#",
		});
	});

	it("is frozen — no consumer can mutate the shared registry", () => {
		expect(Object.isFrozen(AHOS_NAMESPACES)).toBe(true);
		expect(() => {
			(AHOS_NAMESPACES as NamespaceBinding[]).push({
				prefix: "evil",
				namespaceIri: "http://evil/",
				isDefault: false,
			});
		}).toThrow();
	});
});

describe("expandPrefix", () => {
	it("expands a known prefix to its full IRI", () => {
		expect(expandPrefix("foaf")).toBe("http://xmlns.com/foaf/0.1/");
		expect(expandPrefix("ahos")).toBe(
			"https://example.com/ahos-ontology#",
		);
	});

	it("returns undefined for an unbound prefix", () => {
		expect(expandPrefix("nope")).toBeUndefined();
		expect(expandPrefix("")).toBeUndefined();
	});
});

describe("namespacePrefixMap", () => {
	it("returns one entry per binding", () => {
		expect(Object.keys(namespacePrefixMap())).toHaveLength(
			AHOS_NAMESPACES.length,
		);
	});
});
