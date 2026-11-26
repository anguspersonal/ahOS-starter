import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { createGraphExportRdfAction } from "./graphExportRdf.js";
import type { VocabularyReadPort } from "../../ports/vocabulary.js";
import { renderTurtle, type RawNamespaceRow, type RawTermRow } from "../../domain/rdf/exportRdf.js";

const LEGACY_DESCRIPTION =
	"Export the knowledge graph's VOCABULARY layer as valid Turtle: the namespace prefixes plus each " +
	"vocabulary term as a CURIE-compacted triple block. Registry IRIs only \u2014 there is no triple " +
	"store, and it does NOT export instance data such as people, organisations or relationships. Full " +
	"notes: docs/guides/tools/graph_export_rdf.md";

const SEED_NAMESPACES: RawNamespaceRow[] = [
	{
		id: "ns-ahos",
		properties: {
			type: "ahos_namespace",
			prefix: "ahos",
			namespace_iri: "https://vocab.ahos.dev/core#",
			is_default: true,
		},
	},
	{
		id: "ns-owl",
		properties: {
			type: "ahos_namespace",
			prefix: "owl",
			namespace_iri: "http://www.w3.org/2002/07/owl#",
			is_default: false,
		},
	},
	{
		id: "ns-rdfs",
		properties: {
			type: "ahos_namespace",
			prefix: "rdfs",
			namespace_iri: "http://www.w3.org/2000/01/rdf-schema#",
			is_default: false,
		},
	},
	{
		id: "ns-skos",
		properties: {
			type: "ahos_namespace",
			prefix: "skos",
			namespace_iri: "http://www.w3.org/2004/02/skos/core#",
			is_default: false,
		},
	},
];

describe("graph_export_rdf core action (#1495)", () => {
	it("AC 1 (Contract, R11): preserves legacy id, JSON schema snapshot, description, annotations, and default exposure", () => {
		const port: VocabularyReadPort = { fetchRdfExportState: vi.fn() };
		const action = createGraphExportRdfAction(port);

		expect(action.id).toBe("graph_export_rdf");
		expect(z.toJSONSchema(action.schema)).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {},
			additionalProperties: false,
		});
		expect(action.description).toBe(LEGACY_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("AC 2: with two namespace rows and three term rows, formatMcp(await run({}, ctx)) equals renderTurtle(...) byte for byte", async () => {
		const namespaces: RawNamespaceRow[] = [
			{
				id: "ns-ahos",
				properties: {
					type: "ahos_namespace",
					prefix: "ahos",
					namespace_iri: "https://vocab.ahos.dev/core#",
					is_default: true,
				},
			},
			{
				id: "ns-rdfs",
				properties: {
					type: "ahos_namespace",
					prefix: "rdfs",
					namespace_iri: "http://www.w3.org/2000/01/rdf-schema#",
					is_default: false,
				},
			},
		];
		const terms: RawTermRow[] = [
			{
				id: "term-1",
				local_name: "Person",
				namespace: "https://vocab.ahos.dev/core#",
				properties: {
					type: "ahos_concept_term",
					definition: "A human agent.",
				},
			},
			{
				id: "term-2",
				local_name: "Organization",
				namespace: null,
				properties: {
					type: "ahos_concept_term",
					definition: "A structured group.",
				},
			},
			{
				id: "term-3",
				local_name: "memberOf",
				namespace: null,
				properties: {
					type: "ahos_concept_term",
				},
			},
		];

		const fetchRdfExportState = vi.fn().mockResolvedValue({ namespaces, terms });
		const port: VocabularyReadPort = { fetchRdfExportState };
		const action = createGraphExportRdfAction(port);
		const ctx = { caller: "mcp" as const, requestId: "req-ac2", userId: "user-rdf-ac2" };

		const out = await action.run({}, ctx);
		expect(fetchRdfExportState).toHaveBeenCalledWith("user-rdf-ac2");
		expect(action.formatMcp?.(out)).toBe(renderTurtle({ namespaces, terms }));
	});

	it("happy path: exports namespaces and terms with owl classes/properties as Turtle and passes ctx.userId to port", async () => {
		const terms: RawTermRow[] = [
			{
				id: "term-person",
				local_name: "Person",
				namespace: "https://vocab.ahos.dev/core#",
				properties: {
					type: "ahos_concept_term",
					applies_to: "entity_type",
					definition: "A human agent.",
				},
			},
			{
				id: "term-knows",
				local_name: "knows",
				namespace: null,
				properties: {
					type: "ahos_concept_term",
					applies_to: "edge_type",
				},
			},
		];

		const fetchRdfExportState = vi.fn().mockResolvedValue({
			namespaces: SEED_NAMESPACES,
			terms,
		});
		const port: VocabularyReadPort = { fetchRdfExportState };
		const action = createGraphExportRdfAction(port);

		const res = await executeAction(
			action,
			{},
			{ context: { caller: "mcp", userId: "user-rdf-1" } },
		);

		expect(fetchRdfExportState).toHaveBeenCalledWith("user-rdf-1");
		expect(res.turtle).toContain("@prefix ahos: <https://vocab.ahos.dev/core#> .");
		expect(res.turtle).toContain('ahos:Person a owl:Class ;\n    rdfs:label "Person" ;\n    rdfs:comment "A human agent." .');
		expect(res.turtle).toContain('ahos:knows a owl:ObjectProperty ;\n    rdfs:label "knows" .');
		expect(action.formatMcp?.(res)).toBe(renderTurtle({ namespaces: SEED_NAMESPACES, terms }));
	});

	it("AC 3: rejects when ctx.userId is missing without calling the port", async () => {
		const fetchRdfExportState = vi.fn();
		const port: VocabularyReadPort = { fetchRdfExportState };
		const action = createGraphExportRdfAction(port);

		await expect(
			executeAction(action, {}, { context: { caller: "mcp" } }),
		).rejects.toThrow("graph_export_rdf requires an authenticated userId");
		expect(fetchRdfExportState).not.toHaveBeenCalled();
	});

	it("AC 4: propagates a port error with its message unchanged", async () => {
		const port: VocabularyReadPort = {
			fetchRdfExportState: vi
				.fn()
				.mockRejectedValue(new Error("graph_export_rdf: namespace query failed: database connection lost")),
		};
		const action = createGraphExportRdfAction(port);

		await expect(
			action.run({}, { caller: "mcp", requestId: "req-ac4", userId: "user-rdf-1" }),
		).rejects.toThrow("graph_export_rdf: namespace query failed: database connection lost");
	});

	it("rejects when no namespace row has a valid prefix + namespace_iri", async () => {
		const port: VocabularyReadPort = {
			fetchRdfExportState: vi.fn().mockResolvedValue({
				namespaces: [],
				terms: [],
			}),
		};
		const action = createGraphExportRdfAction(port);

		await expect(
			executeAction(action, {}, { context: { caller: "mcp", userId: "user-rdf-1" } }),
		).rejects.toThrow("no namespace row has both a prefix and a non-empty namespace_iri");
	});

	it("rejects when a term references an unbound external_match prefix", async () => {
		const port: VocabularyReadPort = {
			fetchRdfExportState: vi.fn().mockResolvedValue({
				namespaces: SEED_NAMESPACES,
				terms: [
					{
						id: "term-broken",
						local_name: "Person",
						namespace: "https://vocab.ahos.dev/core#",
						properties: {
							type: "ahos_concept_term",
							applies_to: "entity_type",
							external_match: [{ iri: "foaf:Person", relation: "exactMatch" }],
						},
					},
				],
			}),
		};
		const action = createGraphExportRdfAction(port);

		await expect(
			executeAction(action, {}, { context: { caller: "mcp", userId: "user-rdf-1" } }),
		).rejects.toThrow("foaf:Person");
	});
});

