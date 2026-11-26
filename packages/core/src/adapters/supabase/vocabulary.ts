import type { SupabaseClient } from "@supabase/supabase-js";
import type { RawNamespaceRow, RawTermRow } from "../../domain/rdf/exportRdf.js";
import type { VocabularyReadPort } from "../../ports/vocabulary.js";

/**
 * True when a PostgREST / Postgres error reports that `columnName` does not
 * exist yet on the live schema (pre-migration fallback).
 */
export function isMissingVocabularyColumnError(
	err: { code?: string | null; message?: string | null } | null | undefined,
	columnName: string,
): boolean {
	if (!err) return false;
	const code = err.code ?? "";
	const msg = err.message ?? "";
	if (!msg.includes(columnName)) return false;
	return code === "42703" || code === "PGRST204" || /column .* does not exist/i.test(msg);
}

/**
 * Create a Supabase-backed `VocabularyReadPort` adapter (#1495).
 */
export function createSupabaseVocabularyReadAdapter(
	client: SupabaseClient,
): VocabularyReadPort {
	return {
		async fetchRdfExportState(_userId: string) {
			const { data: namespaces, error: nsError } = await client
				.from("entities")
				.select("id, properties")
				.eq("properties->>type", "ahos_namespace");
			if (nsError) {
				throw new Error(`graph_export_rdf: namespace query failed: ${nsError.message}`);
			}

			let terms: RawTermRow[] = [];
			const { data, error } = await client
				.from("entities")
				.select("id, local_name, namespace, properties")
				.eq("properties->>type", "ahos_concept_term");
			let termError = error;
			if (termError && isMissingVocabularyColumnError(termError, "local_name")) {
				const fallback = await client
					.from("entities")
					.select("id, properties")
					.eq("properties->>type", "ahos_concept_term");
				terms = (fallback.data ?? []) as RawTermRow[];
				termError = fallback.error;
			} else if (data) {
				terms = data as RawTermRow[];
			}
			if (termError) {
				throw new Error(`graph_export_rdf: term query failed: ${termError.message}`);
			}

			return {
				namespaces: (namespaces ?? []) as RawNamespaceRow[],
				terms,
			};
		},
	};
}
