import { FORBIDDEN_TERM_NODE_KEYS, TERM_NODE_TYPE, type TermNodeExternalMatch } from "@ahkms/shared";
import { isMissingColumnError } from "../aliases.js";
import { supabase } from "../supabase.js";

// The vocab-diff CI guard (#455, ADR-037 §5 "extends ADR-036 §5 vocab diff" —
// there was no prior vocab-diff check to extend; this IS the first one).
//
// Two of the three rules already have a DB-level backstop:
//   - migration 081's `entities_term_node_no_stored_iri` CHECK already makes a
//     stored iri/curie impossible to INSERT/UPDATE through any writer.
//   - migration 078's `graph_namespaces_one_default` unique index already
//     guarantees AT MOST one `is_default=true` row (not "exactly one" — zero
//     is a distinct, unguarded failure mode).
// Neither guards a term's `external_match` prefixes at all (buildTermNodeProperties,
// @ahkms/shared, never validates them), and a dangling `namespace` pointer is only
// checked at the TS write layer (resolveNamespaceBinding), never at the DB level —
// a raw insert bypasses it, and `graph_terms`'s LEFT JOIN deliberately surfaces
// the failure as a NULL iri/curie rather than rejecting the row (migration 081's
// own comment: "a queryable violation of the §5 gate, rather than silently
// vanishing"). This script is that query, run independently of any writer.

export type NamespaceRow = {
	prefix: string | null;
	namespace_iri: string | null;
	is_default: boolean | null;
};

export type TermRow = {
	id: string;
	/**
	 * Real column on `entities` from migration 115 on (#1104). Absent (undefined)
	 * pre-migration, in which case the pointer lives at `properties.namespace`
	 * (see `namespacePointerOf`) — never trust `properties.namespace` alone once
	 * migration 115 has run, since its backfill empties that JSONB key.
	 */
	namespace?: string | null;
	properties: Record<string, unknown> | null;
};

/** The term's namespace pointer: the real column when present, else the legacy JSONB key (#1104). */
function namespacePointerOf(row: TermRow): unknown {
	return row.namespace ?? row.properties?.namespace;
}

export type VocabViolation = {
	termId: string;
	term: string | null;
	detail: string;
};

export type VocabDiffResult = {
	ok: boolean;
	storedCurie: { ok: boolean; violations: VocabViolation[] };
	namespaceCoverage: { ok: boolean; violations: VocabViolation[] };
	exactlyOneDefault: { ok: boolean; count: number; defaults: string[] };
};

function termLabel(row: TermRow): string | null {
	const term = row.properties?.term;
	return typeof term === "string" ? term : null;
}

function hasForbiddenKey(properties: Record<string, unknown> | null): boolean {
	if (!properties) return false;
	return FORBIDDEN_TERM_NODE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(properties, key));
}

/** The prefix half of a CURIE string ("foaf:Person" -> "foaf"), or null if malformed. */
function curiePrefix(curie: string): string | null {
	const idx = curie.indexOf(":");
	if (idx <= 0) return null;
	return curie.slice(0, idx);
}

function externalMatchesOf(properties: Record<string, unknown> | null): TermNodeExternalMatch[] {
	const raw = properties?.external_match;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(entry): entry is TermNodeExternalMatch =>
			typeof entry === "object" && entry !== null && typeof (entry as { iri?: unknown }).iri === "string",
	);
}

/**
 * Pure core: run the three ADR-037 §5 assertions against already-fetched rows.
 * No I/O — easy to unit-test with fixtures, mirrors check-migration-drift.js's
 * buildResult()/fetchRemoteState() split.
 */
export function buildVocabDiffResult(inputs: { namespaces: NamespaceRow[]; terms: TermRow[] }): VocabDiffResult {
	const { namespaces, terms } = inputs;

	// (a) No term row may store a literal iri/curie.
	const storedCurieViolations: VocabViolation[] = [];
	for (const row of terms) {
		if (hasForbiddenKey(row.properties)) {
			storedCurieViolations.push({
				termId: row.id,
				term: termLabel(row),
				detail: `stores a literal ${FORBIDDEN_TERM_NODE_KEYS.filter((k) => row.properties && k in row.properties).join("/")} property — both must be derived, never stored (ADR-037 §1/§5)`,
			});
		}
	}

	// A namespace only "covers" a prefix/IRI when it has a non-empty namespace_iri —
	// a row that exists but carries no IRI does not satisfy the gate either.
	const validIris = new Set(namespaces.filter((n) => n.namespace_iri).map((n) => n.namespace_iri as string));
	const validPrefixes = new Set(
		namespaces.filter((n) => n.prefix && n.namespace_iri).map((n) => n.prefix as string),
	);

	// (b) Every namespace referenced by a term's `namespace` pointer or an
	// `external_match[].iri` CURIE prefix must resolve to a covered namespace.
	const namespaceCoverageViolations: VocabViolation[] = [];
	for (const row of terms) {
		const pointer = namespacePointerOf(row);
		if (typeof pointer === "string" && pointer.length > 0 && !validIris.has(pointer)) {
			namespaceCoverageViolations.push({
				termId: row.id,
				term: termLabel(row),
				detail: `namespace pointer '${pointer}' does not resolve to any namespace row with a non-empty namespace_iri`,
			});
		}

		for (const match of externalMatchesOf(row.properties)) {
			const prefix = curiePrefix(match.iri);
			if (prefix === null || !validPrefixes.has(prefix)) {
				namespaceCoverageViolations.push({
					termId: row.id,
					term: termLabel(row),
					detail: `external_match '${match.iri}' (relation '${match.relation}') has ${prefix === null ? "no parseable prefix" : `prefix '${prefix}' with no covered namespace row`}`,
				});
			}
		}
	}

	// (c) Exactly one namespace row has is_default=true. The DB unique index only
	// guarantees AT MOST one — zero is a distinct failure this must also catch.
	const defaults = namespaces.filter((n) => n.is_default === true).map((n) => n.prefix ?? "(no prefix)");

	const result: VocabDiffResult = {
		ok: storedCurieViolations.length === 0 && namespaceCoverageViolations.length === 0 && defaults.length === 1,
		storedCurie: { ok: storedCurieViolations.length === 0, violations: storedCurieViolations },
		namespaceCoverage: { ok: namespaceCoverageViolations.length === 0, violations: namespaceCoverageViolations },
		exactlyOneDefault: { ok: defaults.length === 1, count: defaults.length, defaults },
	};
	return result;
}

/** Human-readable report lines for a buildVocabDiffResult() result. Pure. */
export function formatVocabDiffReport(result: VocabDiffResult): string[] {
	const lines: string[] = [];

	lines.push(`Check A — no term row stores a literal iri/curie (${TERM_NODE_TYPE})`);
	if (result.storedCurie.ok) {
		lines.push("  OK: no term row stores iri or curie.");
	} else {
		for (const v of result.storedCurie.violations) {
			lines.push(`  FAIL: term ${v.term ?? "(untitled)"} [${v.termId}] ${v.detail}`);
		}
	}

	lines.push("");
	lines.push("Check B — every referenced namespace prefix/IRI has a covered namespace row");
	if (result.namespaceCoverage.ok) {
		lines.push("  OK: every namespace pointer and external_match prefix resolves.");
	} else {
		for (const v of result.namespaceCoverage.violations) {
			lines.push(`  FAIL: term ${v.term ?? "(untitled)"} [${v.termId}] ${v.detail}`);
		}
	}

	lines.push("");
	lines.push("Check C — exactly one namespace row has is_default=true");
	if (result.exactlyOneDefault.ok) {
		lines.push(`  OK: default namespace is '${result.exactlyOneDefault.defaults[0]}'.`);
	} else if (result.exactlyOneDefault.count === 0) {
		lines.push("  FAIL: no namespace row has is_default=true — term rows with an omitted pointer cannot resolve.");
	} else {
		lines.push(
			`  FAIL: ${result.exactlyOneDefault.count} namespace rows have is_default=true (${result.exactlyOneDefault.defaults.join(", ")}) — expected exactly 1.`,
		);
	}

	lines.push("");
	lines.push(result.ok ? "vocab-diff: clean." : "vocab-diff: violations found — see FAIL lines above.");
	return lines;
}

/** Fetch namespace + term rows from the live graph. The only I/O in this module. */
export async function fetchVocabState(): Promise<{ namespaces: NamespaceRow[]; terms: TermRow[] }> {
	const { data: namespaces, error: nsError } = await supabase
		.from("graph_namespaces")
		.select("prefix, namespace_iri, is_default");
	if (nsError) throw new Error(`vocab-diff: graph_namespaces query failed: ${nsError.message}`);

	let terms: TermRow[] = [];
	const { data, error } = await supabase
		.from("entities")
		.select("id, namespace, properties")
		.eq("properties->>type", TERM_NODE_TYPE);
	let termError = error;
	// Pre-migration-115 tables lack the `namespace` column; degrade to the
	// properties-only shape (mirrors exportRdf.ts's fetchRdfExportState, #1104).
	if (termError && isMissingColumnError(termError, "namespace")) {
		const fallback = await supabase
			.from("entities")
			.select("id, properties")
			.eq("properties->>type", TERM_NODE_TYPE);
		terms = (fallback.data ?? []) as TermRow[];
		termError = fallback.error;
	} else if (data) {
		terms = data as TermRow[];
	}
	if (termError) throw new Error(`vocab-diff: term query failed: ${termError.message}`);

	return {
		namespaces: (namespaces ?? []) as NamespaceRow[],
		terms,
	};
}

/** Fetch the live graph and run all three assertions. What the CLI wrapper calls. */
export async function runVocabDiff(): Promise<VocabDiffResult> {
	const { namespaces, terms } = await fetchVocabState();
	return buildVocabDiffResult({ namespaces, terms });
}
