// Internal vocabulary types and helpers mirroring packages/shared/src/types/entities.ts
// because @ahkms/core is dependency-free (check-core-import-direction.js).
interface NamespaceBinding {
	prefix: string;
	namespaceIri: string;
	isDefault: boolean;
}

interface TermNodeExternalMatch {
	relation: string;
	iri: string;
}

interface TermNodeProperties {
	type: "ahos_concept_term";
	term: string;
	local_name: string;
	namespace?: string;
	applies_to?: "entity_type" | "edge_type";
	external_match?: TermNodeExternalMatch[];
	definition?: string;
	[key: string]: unknown;
}

function resolveNamespaceBinding(
	namespacePointer: string | undefined,
	bindings: readonly NamespaceBinding[],
): NamespaceBinding {
	if (namespacePointer === undefined) {
		const def = bindings.find((b) => b.isDefault);
		if (!def) {
			throw new Error(
				"No default namespace in the supplied bindings — exactly one binding must have isDefault=true (ADR-037 §2).",
			);
		}
		return def;
	}
	const found = bindings.find((b) => b.namespaceIri === namespacePointer);
	if (!found) {
		throw new Error(
			`No namespace binding for pointer '${namespacePointer}' — every namespace referenced by a term must have a namespace row (ADR-037 §5 hard-fail gate).`,
		);
	}
	return found;
}

function deriveTermCurie(
	props: Pick<TermNodeProperties, "local_name" | "namespace">,
	bindings: readonly NamespaceBinding[],
): string {
	const ns = resolveNamespaceBinding(props.namespace, bindings);
	return `${ns.prefix}:${props.local_name}`;
}

// graph_export_rdf (#454, ADR-037 §4). Scope, deliberately: the VOCABULARY layer —
// namespace bindings (@prefix block, optional owl:Ontology Role-B lines) and
// term-node rows (ahos_concept_term) as Turtle — using registry IRIs, no
// triple store (ADR-021 Option C stays soft-blocked). This does NOT export
// general instance data (people/orgs/arrangements/entity_relationships):
// ADR-036 §1a's full "shredded triple store" mapping for arbitrary rows is a
// separate, much larger concern (property->predicate naming, literal
// datatype inference, escaping arbitrary user text) with real open design
// questions #454's own issue text never scoped in — it names only
// graph_namespaces and CURIE compaction. Exporting the vocabulary layer is
// exactly what ADR-037 §4 itself specifies (the two new mapping rows are
// both namespace-shaped) and is what makes the vocab-diff CI guard (#455)
// and the term-node schema (#453) actually round-trippable to RDF today.
//
// Known gap, left for future work rather than guessed at: the seed graph's
// TBox block (ahOS-seed.ttl) distinguishes owl:Class / owl:ObjectProperty /
// owl:DatatypeProperty / owl:SymmetricProperty, but the term-node schema
// (ADR-036 §1 / ADR-037 §1) only carries `applies_to: entity_type|edge_type`
// — two buckets, not four. This maps entity_type -> owl:Class and edge_type
// -> owl:ObjectProperty (the common cases) and asserts no RDF type at all
// otherwise, rather than inventing a finer distinction the schema doesn't
// store. A term-node row for #326's seed ingestion pass may want a richer
// field before that finer distinction round-trips.

export type RawNamespaceRow = {
	id: string;
	properties: Record<string, unknown> | null;
};

export type RawTermRow = {
	id: string;
	local_name?: string | null;
	namespace?: string | null;
	properties: Record<string, unknown> | null;
};

export type RdfExportState = {
	namespaces: RawNamespaceRow[];
	terms: RawTermRow[];
};

const NAMESPACE_ROLE_A_KEYS = new Set(["type", "prefix", "namespace_iri", "is_default"]);

function toBinding(row: RawNamespaceRow): NamespaceBinding | null {
	const p = row.properties;
	const prefix = typeof p?.prefix === "string" ? p.prefix : null;
	const namespaceIri = typeof p?.namespace_iri === "string" && p.namespace_iri ? p.namespace_iri : null;
	if (!prefix || !namespaceIri) return null;
	return { prefix, namespaceIri, isDefault: p?.is_default === true };
}

/** True when a namespace row carries anything beyond the bare Role-A binding (ADR-037 §3). */
function hasRoleBContent(row: RawNamespaceRow): boolean {
	const p = row.properties;
	if (!p) return false;
	return Object.keys(p).some((key) => !NAMESPACE_ROLE_A_KEYS.has(key));
}

/** Escape a Turtle string literal's body (RDF 1.2 / Turtle-star ECHAR rules). */
function literal(value: string): string {
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
	return `"${escaped}"`;
}

/** The prefix half of a CURIE string ("foaf:Person" -> "foaf"), or null if malformed. */
function curiePrefix(curie: string): string | null {
	const idx = curie.indexOf(":");
	if (idx <= 0) return null;
	return curie.slice(0, idx);
}

function externalMatchesOf(properties: TermNodeProperties): TermNodeExternalMatch[] {
	const raw = properties.external_match;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(entry): entry is TermNodeExternalMatch =>
			typeof entry === "object" && entry !== null && typeof (entry as { iri?: unknown }).iri === "string",
	);
}

function appliesToRdfType(appliesTo: unknown): string | null {
	if (appliesTo === "entity_type") return "owl:Class";
	if (appliesTo === "edge_type") return "owl:ObjectProperty";
	return null;
}

function renderPrefixBlock(bindings: readonly NamespaceBinding[]): string {
	const sorted = [...bindings].sort((a, b) =>
		a.isDefault === b.isDefault ? a.prefix.localeCompare(b.prefix) : a.isDefault ? -1 : 1,
	);
	return sorted.map((b) => `@prefix ${b.prefix}: <${b.namespaceIri}> .`).join("\n");
}

/**
 * Every term block unconditionally uses `rdfs:`/`owl:`/`skos:` as fixed predicate
 * vocabulary — those are NOT read from a term row, so they get none of the
 * per-term namespace-pointer validation above. Without this check a graph
 * missing (or having renamed) one of those three seeded namespaces (migration
 * 078) would silently produce Turtle referencing an undeclared prefix instead
 * of failing loudly, which is exactly the class of bug #455's vocab-diff
 * exists to catch — this is the same discipline applied to graph_export_rdf's OWN
 * fixed vocabulary, not just to what a term row happens to reference.
 */
function requireBoundPrefix(prefix: string, bindings: readonly NamespaceBinding[], usage: string): void {
	if (!bindings.some((b) => b.prefix === prefix)) {
		throw new Error(
			`graph_export_rdf: no namespace row binds prefix '${prefix}', needed to emit ${usage} — graph_export_rdf's own fixed vocabulary requires it declared, same as any term-referenced prefix (ADR-037 §5)`,
		);
	}
}

function renderTerm(row: RawTermRow, bindings: readonly NamespaceBinding[]): { curie: string; block: string } {
	const props = row.properties as TermNodeProperties | null;
	const fallbackProps = row.properties;
	const localName = (row.local_name ?? (typeof fallbackProps?.local_name === "string" ? fallbackProps.local_name : undefined)) as string | undefined;
	const namespace = (row.namespace ?? (typeof fallbackProps?.namespace === "string" ? fallbackProps.namespace : undefined)) as string | undefined;
	if (typeof localName !== "string" || !localName) {
		throw new Error(`graph_export_rdf: term row ${row.id} has no local_name — cannot derive its CURIE`);
	}

	// Throws (ADR-037 §5 hard-fail) if the pointer doesn't resolve — the vocab-diff
	// CI guard (#455) is what should have caught this before export was ever run.
	const curie = deriveTermCurie(
		{ local_name: localName, namespace: typeof namespace === "string" ? namespace : undefined },
		bindings,
	);

	requireBoundPrefix("rdfs", bindings, "rdfs:label (every term)");

	const predicateObjects: string[] = [];
	const rdfType = appliesToRdfType(props?.applies_to);
	if (rdfType) {
		requireBoundPrefix("owl", bindings, `${rdfType} (applies_to='${props?.applies_to}')`);
		predicateObjects.push(`a ${rdfType}`);
	}
	predicateObjects.push(`rdfs:label ${literal(localName)}`);
	if (typeof props?.definition === "string" && props.definition) {
		predicateObjects.push(`rdfs:comment ${literal(props.definition)}`);
	}

	for (const match of props ? externalMatchesOf(props) : []) {
		const prefix = curiePrefix(match.iri);
		if (prefix === null || !bindings.some((b) => b.prefix === prefix)) {
			throw new Error(
				`graph_export_rdf: term '${curie}' has external_match '${match.iri}' (relation '${match.relation}') whose prefix is not covered by any namespace row — run the vocab-diff check (#455) before exporting`,
			);
		}
		requireBoundPrefix("skos", bindings, `skos:${match.relation} (external_match)`);
		predicateObjects.push(`skos:${match.relation} ${match.iri}`);
	}

	return { curie, block: `${curie} ${predicateObjects.join(" ;\n    ")} .` };
}

/**
 * Pure core: build valid Turtle from already-fetched namespace + term rows.
 * No I/O — easy to unit-test with fixtures.
 */
export function renderTurtle(input: { namespaces: RawNamespaceRow[]; terms: RawTermRow[] }): string {
	const namespaceEntries = input.namespaces
		.map((row) => ({ binding: toBinding(row), hasRoleB: hasRoleBContent(row) }))
		.filter((e): e is { binding: NamespaceBinding; hasRoleB: boolean } => e.binding !== null);

	if (namespaceEntries.length === 0) {
		throw new Error("graph_export_rdf: no namespace row has both a prefix and a non-empty namespace_iri — nothing to declare");
	}

	const bindings = namespaceEntries.map((e) => e.binding);
	const sections: string[] = [renderPrefixBlock(bindings)];

	const describedNamespaces = namespaceEntries.filter((e) => e.hasRoleB);
	if (describedNamespaces.length > 0) requireBoundPrefix("owl", bindings, "<ns> a owl:Ontology (Role-B namespace description)");
	const ontologyLines = describedNamespaces
		.sort((a, b) => a.binding.prefix.localeCompare(b.binding.prefix))
		.map((e) => `<${e.binding.namespaceIri}> a owl:Ontology .`);
	if (ontologyLines.length > 0) sections.push(ontologyLines.join("\n"));

	const termBlocks = input.terms
		.map((row) => renderTerm(row, bindings))
		.sort((a, b) => a.curie.localeCompare(b.curie))
		.map((t) => t.block);
	if (termBlocks.length > 0) sections.push(termBlocks.join("\n\n"));

	return `${sections.join("\n\n")}\n`;
}
