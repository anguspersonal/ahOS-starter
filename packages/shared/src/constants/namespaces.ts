// ---------------------------------------------------------------------------
// Namespace bindings (ADR-037 §2) — the prefix ⟷ namespace-IRI primitive.
//
// A CURIE (`ahos:People`) is `prefix : local`: a MUTABLE presentation prefix
// glued to a STABLE local name. ADR-037 stores the binding ONCE — never per
// term — so a prefix rename (`ahos` → `ah`) or a namespace re-host is a
// one-row edit, never an N-row migration. This module is the single canonical
// source of truth for that binding set:
//
//   • the `graph_namespaces` DB rows are seeded from exactly these values
//     (migration 078); and
//   • `export_rdf` (#454) builds its Turtle `@prefix` header block from them.
//
// The set mirrors the `@prefix` directives of the authoritative seed graph
// `ahOS-seed.ttl` (v2, 2026-07-12, pyoxigraph-validated). The `ahos` and
// `schema` IRIs are HTTPS, matching ADR-037's quoted canonical IRIs — NOT the
// older HTTP forms in docs/architecture/ahOntology.ttl.
// ---------------------------------------------------------------------------

/**
 * A namespace binding — ADR-037 §2, Role A (serialization plumbing, read as a
 * literal, never resolved through the graph).
 */
export interface NamespaceBinding {
  /** Presentation prefix — a MUTABLE label. `'ahos'`, `'foaf'`, `'schema'`. */
  prefix: string;
  /**
   * The full namespace IRI — the namespace's STABLE identity, ending in `#` or
   * `/`. A term's namespace is referenced by this (or the row id), never by the
   * mutable prefix.
   */
  namespaceIri: string;
  /**
   * `true` for exactly one binding (`ahos`). Lets term rows omit the pointer and
   * default to `ahos` (ADR-037 §1 derived-defaults).
   */
  isDefault: boolean;
}

/**
 * The canonical prefix ⟷ namespace-IRI bindings, in a stable, deterministic
 * order (`ahos` default first, then the external vocabularies). Frozen so no
 * consumer can mutate the shared registry.
 */
export const AHOS_NAMESPACES: readonly NamespaceBinding[] = Object.freeze([
  { prefix: "ahos", namespaceIri: "https://example.com/ahos-ontology#", isDefault: true },
  { prefix: "rdf", namespaceIri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", isDefault: false },
  { prefix: "rdfs", namespaceIri: "http://www.w3.org/2000/01/rdf-schema#", isDefault: false },
  { prefix: "owl", namespaceIri: "http://www.w3.org/2002/07/owl#", isDefault: false },
  { prefix: "skos", namespaceIri: "http://www.w3.org/2004/02/skos/core#", isDefault: false },
  { prefix: "schema", namespaceIri: "https://schema.org/", isDefault: false },
  { prefix: "foaf", namespaceIri: "http://xmlns.com/foaf/0.1/", isDefault: false },
  { prefix: "rel", namespaceIri: "http://purl.org/vocab/relationship/", isDefault: false },
  { prefix: "xsd", namespaceIri: "http://www.w3.org/2001/XMLSchema#", isDefault: false },
].map((b) => Object.freeze(b)));

/**
 * The default namespace (`ahos`) — the one a term row points at implicitly when
 * it omits an explicit `namespace`. Guaranteed present and unique by the unit
 * tests and the migration's partial-unique index.
 */
export const DEFAULT_NAMESPACE: NamespaceBinding = AHOS_NAMESPACES.find(
  (n) => n.isDefault,
)!;

const PREFIX_TO_IRI: ReadonlyMap<string, string> = new Map(
  AHOS_NAMESPACES.map((n) => [n.prefix, n.namespaceIri]),
);

/**
 * Expand a prefix to its full namespace IRI, or `undefined` if the prefix has no
 * binding. Pure literal lookup — no graph walk (ADR-037 §2 "bottom out at a
 * literal read").
 */
export function expandPrefix(prefix: string): string | undefined {
  return PREFIX_TO_IRI.get(prefix);
}

/**
 * A plain `{ prefix: namespaceIri }` map of every binding — the shape
 * `export_rdf` and ingestion consume to build/parse `@prefix` blocks.
 */
export function namespacePrefixMap(): Record<string, string> {
  return Object.fromEntries(PREFIX_TO_IRI);
}
