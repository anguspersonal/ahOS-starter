import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import {
	buildVocabDiffResult,
	fetchVocabState,
	formatVocabDiffReport,
	type NamespaceRow,
	type TermRow,
} from "../vocab/vocabDiff.js";

// The pure core of the vocab-diff CI guard (#455, ADR-037 §5). No DB, no
// mocking — buildVocabDiffResult takes rows and returns a verdict, mirroring
// check-migration-drift.js's buildResult()/fetchRemoteState() split.

const AHOS: NamespaceRow = { prefix: "ahos", namespace_iri: "https://example.com/ahos-ontology#", is_default: true };
const FOAF: NamespaceRow = { prefix: "foaf", namespace_iri: "http://xmlns.com/foaf/0.1/", is_default: false };

function term(id: string, properties: Record<string, unknown>): TermRow {
	return { id, properties: { type: "ahos_concept_term", term: id, local_name: id, ...properties } };
}

describe("buildVocabDiffResult", () => {
	it("passes on a clean graph: default namespace, resolvable pointers and external_match prefixes", () => {
		const result = buildVocabDiffResult({
			namespaces: [AHOS, FOAF],
			terms: [
				term("People", {}), // omitted pointer -> default namespace, no check needed
				term("employed_at", { namespace: FOAF.namespace_iri, external_match: [{ relation: "exactMatch", iri: "foaf:knows" }] }),
			],
		});

		expect(result.ok).toBe(true);
		expect(result.storedCurie.ok).toBe(true);
		expect(result.namespaceCoverage.ok).toBe(true);
		expect(result.exactlyOneDefault).toEqual({ ok: true, count: 1, defaults: ["ahos"] });
	});

	it("hard-fails when a term row stores a literal iri or curie", () => {
		const result = buildVocabDiffResult({
			namespaces: [AHOS],
			terms: [term("People", { iri: "https://example.com/ahos-ontology#People" }), term("Org", { curie: "ahos:Org" })],
		});

		expect(result.ok).toBe(false);
		expect(result.storedCurie.ok).toBe(false);
		expect(result.storedCurie.violations).toHaveLength(2);
		expect(result.storedCurie.violations[0].detail).toContain("iri");
		expect(result.storedCurie.violations[1].detail).toContain("curie");
	});

	it("hard-fails on a dangling namespace pointer (no namespace row covers it)", () => {
		const result = buildVocabDiffResult({
			namespaces: [AHOS],
			terms: [term("Thing", { namespace: "http://example.com/no-such-namespace#" })],
		});

		expect(result.ok).toBe(false);
		expect(result.namespaceCoverage.violations).toEqual([
			expect.objectContaining({ termId: "Thing", detail: expect.stringContaining("does not resolve") }),
		]);
	});

	it("hard-fails when a namespace row exists for the prefix but namespace_iri is empty", () => {
		const emptyIri: NamespaceRow = { prefix: "bad", namespace_iri: "", is_default: false };
		const result = buildVocabDiffResult({
			namespaces: [AHOS, emptyIri],
			terms: [term("Thing", { external_match: [{ relation: "exactMatch", iri: "bad:Thing" }] })],
		});

		expect(result.ok).toBe(false);
		expect(result.namespaceCoverage.violations[0].detail).toContain("bad");
	});

	it("hard-fails on an external_match CURIE whose prefix has no covered namespace row", () => {
		const result = buildVocabDiffResult({
			namespaces: [AHOS],
			terms: [term("People", { external_match: [{ relation: "exactMatch", iri: "schema:Person" }] })],
		});

		expect(result.ok).toBe(false);
		expect(result.namespaceCoverage.violations[0].detail).toContain("schema");
	});

	it("hard-fails on a malformed external_match CURIE with no prefix separator", () => {
		const result = buildVocabDiffResult({
			namespaces: [AHOS],
			terms: [term("People", { external_match: [{ relation: "exactMatch", iri: "not-a-curie" }] })],
		});

		expect(result.ok).toBe(false);
		expect(result.namespaceCoverage.violations[0].detail).toContain("no parseable prefix");
	});

	it("hard-fails when zero namespace rows have is_default=true — not just 'at most one'", () => {
		const result = buildVocabDiffResult({
			namespaces: [{ ...AHOS, is_default: false }, FOAF],
			terms: [],
		});

		expect(result.ok).toBe(false);
		expect(result.exactlyOneDefault).toEqual({ ok: false, count: 0, defaults: [] });
	});

	it("hard-fails when more than one namespace row has is_default=true", () => {
		const result = buildVocabDiffResult({
			namespaces: [AHOS, { ...FOAF, is_default: true }],
			terms: [],
		});

		expect(result.ok).toBe(false);
		expect(result.exactlyOneDefault.count).toBe(2);
	});

	it("passes on an empty graph with no terms, as long as exactly one default namespace exists", () => {
		const result = buildVocabDiffResult({ namespaces: [AHOS], terms: [] });
		expect(result.ok).toBe(true);
	});

	// Migration 115 (#1104) moves `namespace` out of `properties` into a real
	// column and empties the old JSONB key on backfill — Check B must read the
	// column, or it silently stops seeing any real term's namespace pointer.
	it("resolves the namespace pointer from the real `namespace` column, not just properties.namespace (#1104)", () => {
		const columnTerm: TermRow = {
			id: "ColumnTerm",
			namespace: "http://example.com/no-such-namespace#",
			properties: { type: "ahos_concept_term", term: "ColumnTerm", local_name: "ColumnTerm" },
		};

		const result = buildVocabDiffResult({ namespaces: [AHOS], terms: [columnTerm] });

		expect(result.ok).toBe(false);
		expect(result.namespaceCoverage.violations).toEqual([
			expect.objectContaining({ termId: "ColumnTerm", detail: expect.stringContaining("does not resolve") }),
		]);
	});

	it("passes when the column-based namespace resolves, even though properties.namespace is absent (post-migration-115 shape)", () => {
		const columnTerm: TermRow = {
			id: "ColumnTerm",
			namespace: FOAF.namespace_iri,
			properties: { type: "ahos_concept_term", term: "ColumnTerm", local_name: "ColumnTerm" },
		};

		const result = buildVocabDiffResult({ namespaces: [AHOS, FOAF], terms: [columnTerm] });

		expect(result.ok).toBe(true);
	});
});

/** A chainable query-builder stub, mirroring artifactEntitySyncPlace.test.ts's helper. */
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

describe("fetchVocabState", () => {
	const origFrom = supabase.from;
	afterEach(() => {
		(supabase as any).from = origFrom;
		vi.restoreAllMocks();
	});

	it("queries graph_namespaces plainly and entities filtered to ahos_concept_term rows", async () => {
		const namespacesBuilder = chainBuilder({ data: [AHOS], error: null });
		const termsBuilder = chainBuilder({ data: [term("People", {})], error: null });
		const from = vi.fn((table: string) => (table === "graph_namespaces" ? namespacesBuilder : termsBuilder));
		(supabase as any).from = from;

		const state = await fetchVocabState();

		expect(from).toHaveBeenCalledWith("graph_namespaces");
		expect(from).toHaveBeenCalledWith("entities");
		expect(termsBuilder._calls).toContainEqual(["properties->>type", "ahos_concept_term"]);
		expect(state.namespaces).toEqual([AHOS]);
		expect(state.terms).toHaveLength(1);
	});

	it("throws a clear error when the namespaces query fails", async () => {
		const namespacesBuilder = chainBuilder({ data: null, error: { message: "boom" } });
		(supabase as any).from = vi.fn(() => namespacesBuilder);

		await expect(fetchVocabState()).rejects.toThrow(/graph_namespaces query failed: boom/);
	});

	it("selects the `namespace` column and carries it onto TermRow (#1104 regression guard)", async () => {
		const namespacesBuilder = chainBuilder({ data: [AHOS], error: null });
		const termsBuilder = chainBuilder({
			data: [{ id: "t1", namespace: FOAF.namespace_iri, properties: { type: "ahos_concept_term" } }],
			error: null,
		});
		(supabase as any).from = vi.fn((table: string) => (table === "graph_namespaces" ? namespacesBuilder : termsBuilder));

		const state = await fetchVocabState();

		expect(state.terms).toEqual([{ id: "t1", namespace: FOAF.namespace_iri, properties: { type: "ahos_concept_term" } }]);
	});

	it("degrades to the properties-only select when `namespace` is missing pre-migration-115", async () => {
		const namespacesBuilder = chainBuilder({ data: [AHOS], error: null });
		const responses = [
			{ data: null, error: { code: "42703", message: "column entities.namespace does not exist" } },
			{ data: [term("People", {})], error: null },
		];
		let call = 0;
		const termsBuilder: any = {
			select: () => termsBuilder,
			eq: () => termsBuilder,
			then: (res: any, rej: any) => Promise.resolve(responses[call++]).then(res, rej),
		};
		(supabase as any).from = vi.fn((table: string) => (table === "graph_namespaces" ? namespacesBuilder : termsBuilder));

		const state = await fetchVocabState();

		expect(call).toBe(2);
		expect(state.terms).toHaveLength(1);
	});
});

describe("formatVocabDiffReport", () => {
	it("names the failing term and reason for each violation kind", () => {
		const result = buildVocabDiffResult({
			namespaces: [{ ...AHOS, is_default: false }],
			terms: [term("Broken", { iri: "x", namespace: "http://missing#" })],
		});
		const lines = formatVocabDiffReport(result).join("\n");

		expect(lines).toContain("Broken");
		expect(lines).toContain("FAIL");
		expect(lines).toContain("vocab-diff: violations found");
	});

	it("reports a clean summary when everything passes", () => {
		const result = buildVocabDiffResult({ namespaces: [AHOS], terms: [] });
		const lines = formatVocabDiffReport(result).join("\n");
		expect(lines).toContain("vocab-diff: clean.");
	});
});
