import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseVocabularyReadAdapter } from "./vocabulary.js";

describe("createSupabaseVocabularyReadAdapter (#1495)", () => {
	it("fetches ahos_namespace and ahos_concept_term rows from entities", async () => {
		const calls: Array<{ selectCols: string; typeVal: string }> = [];
		const client = {
			from: vi.fn((table: string) => {
				expect(table).toBe("entities");
				return {
					select: (selectCols: string) => ({
						eq: (col: string, typeVal: string) => {
							expect(col).toBe("properties->>type");
							calls.push({ selectCols, typeVal });
							if (typeVal === "ahos_namespace") {
								return Promise.resolve({
									data: [
										{
											id: "ns-1",
											properties: {
												type: "ahos_namespace",
												prefix: "ahos",
												namespace_iri: "https://vocab.ahos.dev/core#",
												is_default: true,
											},
										},
									],
									error: null,
								});
							}
							return Promise.resolve({
								data: [
									{
										id: "term-1",
										local_name: "Person",
										namespace: "ns-1",
										properties: { type: "ahos_concept_term", applies_to: "entity_type" },
									},
								],
								error: null,
							});
						},
					}),
				};
			}),
		} as unknown as SupabaseClient;

		const adapter = createSupabaseVocabularyReadAdapter(client);
		const state = await adapter.fetchRdfExportState("user-1");

		expect(calls).toEqual([
			{ selectCols: "id, properties", typeVal: "ahos_namespace" },
			{ selectCols: "id, local_name, namespace, properties", typeVal: "ahos_concept_term" },
		]);
		expect(state.namespaces).toHaveLength(1);
		expect(state.terms).toHaveLength(1);
		expect(state.terms[0]?.local_name).toBe("Person");
	});

	it("falls back to id, properties when local_name column is missing (42703)", async () => {
		const termSelects: string[] = [];
		const client = {
			from: vi.fn(() => ({
				select: (selectCols: string) => ({
					eq: (_col: string, typeVal: string) => {
						if (typeVal === "ahos_namespace") {
							return Promise.resolve({ data: [], error: null });
						}
						termSelects.push(selectCols);
						if (selectCols.includes("local_name")) {
							return Promise.resolve({
								data: null,
								error: { code: "42703", message: "column entities.local_name does not exist" },
							});
						}
						return Promise.resolve({
							data: [
								{
									id: "term-legacy",
									properties: { type: "ahos_concept_term", local_name: "LegacyTerm" },
								},
							],
							error: null,
						});
					},
				}),
			})),
		} as unknown as SupabaseClient;

		const adapter = createSupabaseVocabularyReadAdapter(client);
		const state = await adapter.fetchRdfExportState("user-1");

		expect(termSelects).toEqual([
			"id, local_name, namespace, properties",
			"id, properties",
		]);
		expect(state.terms).toEqual([
			{
				id: "term-legacy",
				properties: { type: "ahos_concept_term", local_name: "LegacyTerm" },
			},
		]);
	});

	it("surfaces namespace and term query errors with graph_export_rdf prefix", async () => {
		const nsFailClient = {
			from: vi.fn(() => ({
				select: () => ({
					eq: () => Promise.resolve({ data: null, error: { message: "connection refused" } }),
				}),
			})),
		} as unknown as SupabaseClient;

		const nsAdapter = createSupabaseVocabularyReadAdapter(nsFailClient);
		await expect(nsAdapter.fetchRdfExportState("user-1")).rejects.toThrow(
			"graph_export_rdf: namespace query failed: connection refused",
		);

		const termFailClient = {
			from: vi.fn(() => ({
				select: () => ({
					eq: (_col: string, typeVal: string) => {
						if (typeVal === "ahos_namespace") {
							return Promise.resolve({ data: [], error: null });
						}
						return Promise.resolve({ data: null, error: { code: "XX000", message: "term query exploded" } });
					},
				}),
			})),
		} as unknown as SupabaseClient;

		const termAdapter = createSupabaseVocabularyReadAdapter(termFailClient);
		await expect(termAdapter.fetchRdfExportState("user-1")).rejects.toThrow(
			"graph_export_rdf: term query failed: term query exploded",
		);
	});
});
