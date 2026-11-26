// ---------------------------------------------------------------------------
// Term-node row shape (ADR-037 §1) — local name + namespace pointer, CURIE
// derived.
//
// A term-node grounds a runtime vocabulary string (`'people'`, `'employed_at'`)
// in a canonical IRI (ADR-036 §1). ADR-037 §1 sharpens HOW that IRI is stored:
// the row carries only the STABLE parts —
//
//   • `local_name` — the IRI local part (`"People"`), stored explicitly (the
//     runtime `term` and the local part diverge for classes: 'people' → People;
//     casing rules are fiddly and drift-prone, so no derivation from `term`);
//   • `namespace`  — an OPTIONAL pointer to a namespace row (#452 /
//     migration 078), referenced by the namespace's STABLE identity (its
//     `namespace_iri`, or in the DB the namespace row's id) — NEVER by the
//     mutable `prefix`. Omitted ⇒ the default `ahos` namespace
//     (derived-defaults, mirroring ADR-036's instance/ABox default).
//
// The CURIE (`ahos:People`) and full IRI (`https://…#People`) are PROJECTIONS
// computed at read/export time — never persisted. ADR-036 §1a's stored-`iri`
// CURIE sketch is REMOVED by this shape (#453). Consequences:
//
//   • a prefix rename (`ahos` → `ah`) is a one-row edit on the namespace row —
//     zero term rows touched (no term row ever stores a prefix);
//   • a namespace re-host is a one-row edit too — default-namespace terms omit
//     the pointer entirely. `graph_terms` (migration 081) can RESOLVE a
//     pointer via either the namespace_iri form or the namespace row's id,
//     but a DB CHECK (migration 081 guard 1(d), QA round-1 fix #453/#545)
//     currently restricts what can be STORED to the namespace_iri form only
//     — the row-id form is reserved, not yet writable — so this builder must
//     never emit it (see {@link buildTermNodeProperties}).
//
// `term` (the runtime entity_type/edge_type join key) is UNCHANGED from
// ADR-036; the entity_type column remains the bootstrap primitive.
// ---------------------------------------------------------------------------

import { AHOS_NAMESPACES, type NamespaceBinding } from "./namespaces";

/**
 * The `properties.type` discriminator for term-node rows (ADR-036 §1 /
 * ADR-037 §1). Term-nodes reuse `entity_type = 'concept'` — no new CHECK
 * value — and are told apart by this marker, exactly like namespace rows'
 * `'ahos_namespace'` (migration 078).
 */
export const TERM_NODE_TYPE = "ahos_concept_term" as const;

/**
 * The two property keys ADR-037 §1 REMOVES from the stored shape. A term row
 * must never persist either — both are derived projections. Mirrored by
 * migration 081's `entities_term_node_no_stored_iri` CHECK and (to come) the
 * #455 CI vocab diff.
 */
export const FORBIDDEN_TERM_NODE_KEYS = Object.freeze(["iri", "curie"] as const);

/**
 * An external-vocabulary equivalence claim (ADR-036 §1, unchanged by ADR-037).
 * Kept in CURIE form deliberately — these are 0..n REVISABLE claims, not the
 * primary identity; their prefixes resolve via their own namespace rows at
 * export (ADR-037 §4a).
 */
export interface TermNodeExternalMatch {
	/** skos mapping relation, e.g. `"exactMatch"`, `"closeMatch"`. */
	relation: string;
	/** The external term in CURIE form, e.g. `"foaf:Person"`. */
	iri: string;
}

/**
 * The stored properties of a term-node row (ADR-037 §1). Note what is ABSENT:
 * no `iri`, no `curie` — see {@link FORBIDDEN_TERM_NODE_KEYS}.
 */
export interface TermNodeProperties {
	type: typeof TERM_NODE_TYPE;
	/**
	 * The runtime string this term grounds (`'people'`, `'employed_at'`) — the
	 * join key to the `entity_type` / `edge_type` primitive. UNCHANGED from
	 * ADR-036 §1.
	 */
	term: string;
	/**
	 * The local part of the IRI (`"People"`, `"employed_at"`). Stored
	 * explicitly, never derived from `term` by a casing rule.
	 */
	local_name: string;
	/**
	 * Pointer to the term's namespace, by the namespace's STABLE identity — its
	 * `namespace_iri` (never the mutable prefix). OMITTED ⇒ the default `ahos`
	 * namespace. Present only for the rare term whose canonical home is not
	 * `ahos`. (The `graph_terms` view can also RESOLVE a pointer by the
	 * namespace row's id, but a DB CHECK currently restricts what can be
	 * STORED to this `namespace_iri` form only — QA round-1 fix, #545 — so
	 * this builder must always emit the IRI form, never a row id.)
	 */
	namespace?: string;
	/** Which runtime axis the term grounds (ADR-036 §1, unchanged). */
	applies_to?: "entity_type" | "edge_type";
	/** External equivalence claims (ADR-036 §1, unchanged). */
	external_match?: TermNodeExternalMatch[];
	/** Human definition (ADR-036 §1, unchanged). */
	definition?: string;
	/** Open extension point — further ADR-036 §1 fields (level, in_box, …). */
	[key: string]: unknown;
}

/** Input for {@link buildTermNodeProperties}. */
export interface BuildTermNodeInput {
	term: string;
	localName: string;
	/**
	 * The namespace's stable identity (`namespaceIri`). Omit — or pass the
	 * default namespace's IRI — for `ahos`: the builder OMITS the pointer for
	 * the default namespace (derived-default, ADR-037 §1).
	 */
	namespaceIri?: string;
	appliesTo?: "entity_type" | "edge_type";
	externalMatch?: TermNodeExternalMatch[];
	definition?: string;
	/**
	 * Extra ADR-036 §1 fields (level, in_box, …). Must not contain `iri`,
	 * `curie`, or any of the reserved shape keys — the builder throws if it
	 * does, so no caller can smuggle a stored CURIE back in.
	 */
	extra?: Record<string, unknown>;
}

const RESERVED_KEYS = new Set([
	"type",
	"term",
	"local_name",
	"namespace",
	"applies_to",
	"external_match",
	"definition",
	...FORBIDDEN_TERM_NODE_KEYS,
]);

/**
 * Build a term-node `properties` object in the canonical ADR-037 §1 shape.
 *
 * Guarantees, by construction:
 *   • the default namespace pointer is OMITTED (derived-default) — passing the
 *     default `namespaceIri` explicitly still yields no stored pointer;
 *   • no `iri`/`curie` key can appear (reserved-key check on `extra`);
 *   • a non-default `namespaceIri` must have a binding in `bindings`
 *     (ADR-037 §5 hard-fail: an unresolvable pointer can never be written).
 */
export function buildTermNodeProperties(
	input: BuildTermNodeInput,
	bindings: readonly NamespaceBinding[] = AHOS_NAMESPACES,
): TermNodeProperties {
	if (!input.term.trim()) throw new Error("term must be non-empty");
	if (!input.localName.trim()) throw new Error("localName must be non-empty");

	for (const key of Object.keys(input.extra ?? {})) {
		if (RESERVED_KEYS.has(key)) {
			throw new Error(
				`extra property '${key}' is reserved on a term-node row` +
					((FORBIDDEN_TERM_NODE_KEYS as readonly string[]).includes(key)
						? " — iri/curie are DERIVED, never stored (ADR-037 §1)"
						: ""),
			);
		}
	}

	const defaultNs = getDefaultBinding(bindings);
	let namespace: string | undefined;
	if (input.namespaceIri !== undefined && input.namespaceIri !== defaultNs.namespaceIri) {
		// Hard-fail gate (ADR-037 §5): every referenced namespace must resolve.
		resolveNamespaceBinding(input.namespaceIri, bindings);
		namespace = input.namespaceIri;
	}

	return {
		...(input.extra ?? {}),
		type: TERM_NODE_TYPE,
		term: input.term,
		local_name: input.localName,
		...(namespace !== undefined ? { namespace } : {}),
		...(input.appliesTo !== undefined ? { applies_to: input.appliesTo } : {}),
		...(input.externalMatch !== undefined ? { external_match: input.externalMatch } : {}),
		...(input.definition !== undefined ? { definition: input.definition } : {}),
	};
}

/** Type guard: is `props` a term-node properties object? */
export function isTermNodeProperties(
	props: unknown,
): props is TermNodeProperties {
	if (typeof props !== "object" || props === null) return false;
	const p = props as Record<string, unknown>;
	return (
		p.type === TERM_NODE_TYPE &&
		typeof p.term === "string" &&
		typeof p.local_name === "string" &&
		(p.namespace === undefined || typeof p.namespace === "string")
	);
}

function getDefaultBinding(bindings: readonly NamespaceBinding[]): NamespaceBinding {
	const def = bindings.find((b) => b.isDefault);
	if (!def) {
		throw new Error(
			"No default namespace in the supplied bindings — exactly one binding must have isDefault=true (ADR-037 §2).",
		);
	}
	return def;
}

/**
 * Resolve a term's namespace pointer to its binding. `undefined` (pointer
 * omitted) resolves to the DEFAULT namespace (`ahos`). An unknown pointer is a
 * HARD FAIL (ADR-037 §5): the IRI cannot be expanded, so this throws rather
 * than returning undefined.
 *
 * `bindings` defaults to the canonical registry; callers reading live
 * `graph_namespaces` rows (e.g. export_rdf, #454) inject those instead — the
 * derivation then follows any prefix rename / re-host automatically, with zero
 * term-row changes.
 */
export function resolveNamespaceBinding(
	namespacePointer: string | undefined,
	bindings: readonly NamespaceBinding[] = AHOS_NAMESPACES,
): NamespaceBinding {
	if (namespacePointer === undefined) return getDefaultBinding(bindings);
	const found = bindings.find((b) => b.namespaceIri === namespacePointer);
	if (!found) {
		throw new Error(
			`No namespace binding for pointer '${namespacePointer}' — every namespace referenced by a term must have a namespace row (ADR-037 §5 hard-fail gate).`,
		);
	}
	return found;
}

/**
 * Derive a term's FULL IRI — `namespace_iri + local_name` (ADR-037 §1).
 * A projection, computed at read/export time; never persisted.
 */
export function deriveTermIri(
	props: Pick<TermNodeProperties, "local_name" | "namespace">,
	bindings: readonly NamespaceBinding[] = AHOS_NAMESPACES,
): string {
	const ns = resolveNamespaceBinding(props.namespace, bindings);
	return ns.namespaceIri + props.local_name;
}

/**
 * Derive a term's CURIE — `prefix + ":" + local_name` (ADR-037 §1).
 * A projection of the MUTABLE presentation prefix; never persisted. Renaming
 * the prefix on the namespace binding changes every derived CURIE with zero
 * term-row edits.
 */
export function deriveTermCurie(
	props: Pick<TermNodeProperties, "local_name" | "namespace">,
	bindings: readonly NamespaceBinding[] = AHOS_NAMESPACES,
): string {
	const ns = resolveNamespaceBinding(props.namespace, bindings);
	return `${ns.prefix}:${props.local_name}`;
}
