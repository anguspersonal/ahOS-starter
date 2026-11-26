import { describe, expect, it } from "vitest";
import {
	AHOS_NAMESPACES,
	DEFAULT_NAMESPACE,
	FORBIDDEN_TERM_NODE_KEYS,
	TERM_NODE_TYPE,
	buildTermNodeProperties,
	deriveTermCurie,
	deriveTermIri,
	isTermNodeProperties,
	resolveNamespaceBinding,
	type NamespaceBinding,
	type TermNodeProperties,
} from "@ahkms/shared";

// ADR-037 §1 (#453): the term-node row shape. Rows store local_name + an
// optional namespace pointer; CURIE and full IRI are derived projections.
// These tests pin the three acceptance criteria of #453:
//   1. rows carry local_name + optional namespace, with NO stored iri/curie;
//   2. a prefix rename / re-host is a one-row namespace edit — zero term rows;
//   3. CURIE + full IRI derive correctly for default (ahos) and non-default
//      namespaces.

const AHOS_IRI = "https://example.com/ahos-ontology#";
const FOAF_IRI = "http://xmlns.com/foaf/0.1/";

describe("buildTermNodeProperties — the stored shape (acceptance 1)", () => {
	it("builds the ADR-037 §4a worked t1 row: local_name, omitted default namespace", () => {
		const props = buildTermNodeProperties({
			term: "people",
			localName: "People",
			appliesTo: "entity_type",
			externalMatch: [{ relation: "exactMatch", iri: "foaf:Person" }],
			extra: { level: "ontology", in_box: "TBox" },
		});
		expect(props).toEqual({
			type: "ahos_concept_term",
			term: "people",
			local_name: "People",
			applies_to: "entity_type",
			external_match: [{ relation: "exactMatch", iri: "foaf:Person" }],
			level: "ontology",
			in_box: "TBox",
		});
		// The default (ahos) namespace pointer is OMITTED — derived-default.
		expect("namespace" in props).toBe(false);
	});

	it("omits the pointer even when the default namespaceIri is passed explicitly", () => {
		const props = buildTermNodeProperties({
			term: "people",
			localName: "People",
			namespaceIri: DEFAULT_NAMESPACE.namespaceIri,
		});
		expect("namespace" in props).toBe(false);
	});

	it("stores the pointer (by namespace_iri, never prefix) for a non-default namespace", () => {
		const props = buildTermNodeProperties({
			term: "person_foaf",
			localName: "Person",
			namespaceIri: FOAF_IRI,
		});
		expect(props.namespace).toBe(FOAF_IRI);
		expect(JSON.stringify(props)).not.toContain('"foaf"');
	});

	it("only ever emits the namespace_iri pointer form, never a row-id form (QA round 1, #545)", () => {
		// migration 081 guard 1(d) restricts what the DB will STORE to pointers
		// containing the URI scheme separator '://' — the row-id form (a bare
		// uuid) is reserved, not yet writable. This locks the writer side of
		// that contract: every non-default pointer this builder emits must be
		// IRI-shaped, for every namespace in the registry, not just foaf.
		for (const binding of AHOS_NAMESPACES) {
			if (binding.isDefault) continue;
			const props = buildTermNodeProperties({
				term: `t_${binding.prefix}`,
				localName: "X",
				namespaceIri: binding.namespaceIri,
			});
			expect(props.namespace).toContain("://");
			// A bare uuid row-id pointer would never contain '://'.
			expect(props.namespace).not.toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
			);
		}
	});

	it("never stores iri or curie — and refuses attempts to smuggle them in", () => {
		const props = buildTermNodeProperties({ term: "people", localName: "People" });
		for (const key of FORBIDDEN_TERM_NODE_KEYS) {
			expect(key in props).toBe(false);
			expect(() =>
				buildTermNodeProperties({
					term: "people",
					localName: "People",
					extra: { [key]: "ahos:People" },
				}),
			).toThrow(/derived, never stored/i);
		}
	});

	it("hard-fails on a namespace pointer with no binding (ADR-037 §5)", () => {
		expect(() =>
			buildTermNodeProperties({
				term: "x",
				localName: "X",
				namespaceIri: "https://unregistered.example/ns#",
			}),
		).toThrow(/namespace row/i);
	});

	it("rejects empty term / localName", () => {
		expect(() => buildTermNodeProperties({ term: " ", localName: "X" })).toThrow();
		expect(() => buildTermNodeProperties({ term: "x", localName: "" })).toThrow();
	});
});

describe("derivation — default and non-default namespaces (acceptance 3)", () => {
	it("derives the ahos worked example: ahos:People / …#People", () => {
		const t1 = buildTermNodeProperties({ term: "people", localName: "People" });
		expect(deriveTermIri(t1)).toBe(`${AHOS_IRI}People`);
		expect(deriveTermCurie(t1)).toBe("ahos:People");
	});

	it("derives an edge-type term in the default namespace", () => {
		const t = buildTermNodeProperties({
			term: "employed_at",
			localName: "employed_at",
			appliesTo: "edge_type",
		});
		expect(deriveTermIri(t)).toBe(`${AHOS_IRI}employed_at`);
		expect(deriveTermCurie(t)).toBe("ahos:employed_at");
	});

	it("derives a non-default (foaf) term via its stored pointer", () => {
		const t = buildTermNodeProperties({
			term: "person_foaf",
			localName: "Person",
			namespaceIri: FOAF_IRI,
		});
		expect(deriveTermIri(t)).toBe(`${FOAF_IRI}Person`);
		expect(deriveTermCurie(t)).toBe("foaf:Person");
	});

	it("hard-fails derivation for an unresolvable pointer (ADR-037 §5)", () => {
		const dangling: Pick<TermNodeProperties, "local_name" | "namespace"> = {
			local_name: "X",
			namespace: "https://unregistered.example/ns#",
		};
		expect(() => deriveTermIri(dangling)).toThrow(/hard-fail/i);
		expect(() => deriveTermCurie(dangling)).toThrow(/hard-fail/i);
	});
});

describe("one-row namespace edits touch zero term rows (acceptance 2)", () => {
	/** Clone the canonical bindings with one binding edited — the "one-row edit". */
	function withEdit(
		prefix: string,
		edit: Partial<NamespaceBinding>,
	): NamespaceBinding[] {
		return AHOS_NAMESPACES.map((b) =>
			b.prefix === prefix ? { ...b, ...edit } : { ...b },
		);
	}

	it("prefix rename (ahos → ah): derived CURIE follows; the term row is byte-identical", () => {
		const t1 = buildTermNodeProperties({ term: "people", localName: "People" });
		const before = JSON.stringify(t1);

		const renamed = withEdit("ahos", { prefix: "ah" });
		expect(deriveTermCurie(t1, renamed)).toBe("ah:People");
		expect(deriveTermIri(t1, renamed)).toBe(`${AHOS_IRI}People`); // identity unchanged

		expect(JSON.stringify(t1)).toBe(before); // zero term-row changes
	});

	it("prefix rename on a NON-default namespace (foaf → foafx): pointer stores the IRI, so CURIE follows too", () => {
		const t = buildTermNodeProperties({
			term: "person_foaf",
			localName: "Person",
			namespaceIri: FOAF_IRI,
		});
		const before = JSON.stringify(t);

		const renamed = withEdit("foaf", { prefix: "foafx" });
		expect(deriveTermCurie(t, renamed)).toBe("foafx:Person");
		expect(deriveTermIri(t, renamed)).toBe(`${FOAF_IRI}Person`);

		expect(JSON.stringify(t)).toBe(before);
	});

	it("re-host of the default namespace: derived IRI follows; term rows (pointer omitted) untouched", () => {
		const t1 = buildTermNodeProperties({ term: "people", localName: "People" });
		const before = JSON.stringify(t1);

		const rehosted = withEdit("ahos", {
			namespaceIri: "https://ontology.example.com/ahos#",
		});
		expect(deriveTermIri(t1, rehosted)).toBe(
			"https://ontology.example.com/ahos#People",
		);
		expect(deriveTermCurie(t1, rehosted)).toBe("ahos:People");

		expect(JSON.stringify(t1)).toBe(before);
	});
});

describe("resolveNamespaceBinding", () => {
	it("resolves an omitted pointer to the default (ahos) binding", () => {
		expect(resolveNamespaceBinding(undefined)).toEqual(DEFAULT_NAMESPACE);
	});

	it("resolves a pointer by namespace_iri", () => {
		expect(resolveNamespaceBinding(FOAF_IRI).prefix).toBe("foaf");
	});

	it("throws when the supplied bindings have no default", () => {
		const noDefault = AHOS_NAMESPACES.map((b) => ({ ...b, isDefault: false }));
		expect(() => resolveNamespaceBinding(undefined, noDefault)).toThrow(
			/isDefault/i,
		);
	});
});

describe("isTermNodeProperties", () => {
	it("accepts a built term-node and rejects other shapes", () => {
		const t = buildTermNodeProperties({ term: "people", localName: "People" });
		expect(isTermNodeProperties(t)).toBe(true);
		expect(isTermNodeProperties(null)).toBe(false);
		expect(isTermNodeProperties({ type: "ahos_namespace", prefix: "ahos" })).toBe(false);
		expect(isTermNodeProperties({ type: TERM_NODE_TYPE, term: "x" })).toBe(false); // no local_name
	});
});
