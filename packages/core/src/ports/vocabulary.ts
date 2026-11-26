import type { RawNamespaceRow, RawTermRow } from "../domain/rdf/exportRdf.js";

/**
 * Port for reading the RDF vocabulary state (namespace bindings and concept
 * terms) scoped to a single user (ADR-101 §3, #1495).
 */
export interface VocabularyReadPort {
	fetchRdfExportState(userId: string): Promise<{
		namespaces: RawNamespaceRow[];
		terms: RawTermRow[];
	}>;
}
