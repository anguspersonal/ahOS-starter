# ADR036: IRI-grounded vocabulary + self-describing graph — ontology lives in the database as rows; `instance_of` derived at read

- **Status:** Accepted
- **Created:** 2026-07-12
- **Accepted-on-dev:** 2026-07-12
- **Deciders:** Angus Hally

## Context and problem

The hand-written seed exercise (`ahOS-seed.ttl`, first committed 2026-07-12) surfaced
two architectural demands that the current runtime does not meet:

1. **IRI discipline.** The runtime stores bare enum strings (`entity_type: 'people'`,
   `relationship_type: 'employed_at'`) with no link to the external vocabularies
   ([ADR-033](./ADR033_External_Vocabulary_Adoption.md)) they were adopted from. The
   instinct: even without a triple store, terms should be grounded in IRIs — it
   leverages the work of giants (FOAF, schema.org, RELATIONSHIP, SKOS) and encourages
   discipline. Today the `foaf:Person` ↔ `'people'` correspondence lives only in ADR
   prose and `vocab.ts` comments; nothing enforces it, nothing can round-trip the graph
   to RDF.
2. **Self-describing graph.** The design ontology (`docs/architecture/ahOntology.ttl` —
   metaclasses, principles, the meta/ontology/instance × TBox/ABox axes) lives in a
   file, outside the database. For the graph to be self-documenting, the TBox and all
   three levels must be **in the database**: a query should be able to walk from an
   instance to its type, from a type to its governing principle, without leaving the
   graph. [ADR-035 §8](./ADR035_Relationship_Reification.md) explicitly fenced this to
   [#312](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/312); this
   ADR is the design that lifts that fence.

The same exercise also settled a constraint on any solution: **defaults must be derived,
not stored**. Stamping `layer: instance` / `box: aBox` on every instance row is pure
redundancy — instance/ABox is what a node *is* unless something says otherwise.

## Decision drivers

- **Leverage the giants** — every term should trace to `foaf:`/`schema:`/`rel:` where a
  match exists (ADR-033), and be exportable as real RDF at any time.
- **Discipline** — no type/edge term ships without a definition and an IRI; drift
  between code (`vocab.ts`) and the graph must be caught mechanically.
- **Self-description** — `promote_edge_to_node —governed_by→ ReifyByCategory` should be
  a real, queryable edge (ADR-035 §8's "thin pointer nodes", now in the runtime DB).
- **No write amplification** — a per-row `instance_of` edge or `layer` property
  duplicates the `entity_type` column N times and *will* drift. Derived, not stored.
- **Keep the ego-centric binary graph** — this must not become ADR-021 Option C
  (a triple store) through the back door. Clarification (owner, 2026-07-12): the
  Option C rejection is a **soft block for now, not forever** — "a full triple store
  is overkill for v1," not "overkill for ever." If the system keeps pressing against
  the need, moving becomes a legitimate future ADR; this ADR deliberately keeps that
  move cheap (registry IRIs + `export_rdf` mean the data already round-trips to RDF).
- **Additive, reversible, single-user-appropriate.**

## Considered options

### For IRI grounding

**A — Store full IRIs per row** (`entity_type: 'http://xmlns.com/foaf/0.1/Person'`).
Rejected: bloats every row, constraint, and MCP payload; widens the typo surface.
Decisive argument: **dedicated triple stores don't do this either** — Jena, Virtuoso,
Oxigraph all dictionary-encode IRIs to internal ids at the storage layer. A short term
plus a registry *is* dictionary encoding; storing IRI text per row imitates the giants'
syntax while ignoring their engineering.

**B — Status quo** (no IRIs anywhere in the runtime). Rejected: no RDF round-trip, no
enforcement of ADR-033, vocabulary drifts silently.

**C — Vocabulary registry as graph rows (chosen).** Every term gets one **term-node**
in `entities` carrying its canonical `ahos:` IRI and its external mapping. IRI identity
without per-row cost.

**Why a mapping at all — why not `entity_type === foaf:Person`?** (owner question,
2026-07-12). Because the identity is false for most terms and merely
currently-true-by-assertion for the rest: (1) only a minority of terms have an
exactMatch — `arrangement` is closeMatch `schema:Role` at best, `project`/`area`/`signal`
are ahOS-native — so an IRI-valued column would silently mix three different semantics
(exact, close, local mint); (2) ADR-033 mappings are **revisable** — in the identifier,
a revision is an every-row migration; in one term row, it's a one-row update; (3) even a
true exactMatch is two names for two definitions (what FOAF's spec says vs what this
system enforces) — a claim that can be wrong belongs in editable data, not in primary
identifiers; (4) one term can match several vocabs (`foaf:Person` *and* `schema:Person`)
— a mapping row holds a list, a column value holds one string.

### For the physical row shape (owner's in-flight sketches, 2026-07-12)

Three candidate shapes were sketched against the flight pack
(`docs/sessions/2026-07-12-flight-offline-pack/adr-draft-flight-annotations.md`):

**Sketch 1 — in-row curie** (`entityType: 'foaf:Person'` on every row). Rejected: stores
the mapping N times (see "why a mapping at all" above); revisions become row migrations.
Its goal — in-row self-documentation — is met instead by the derived `instance_of` view
at read time.

**Sketch 2 — a uniform triplet table** (`subject, predicate, object` rows). **Already
half-exists**: `entity_relationships(from_entity_id, relationship_type, to_entity_id)`
*is* an SPO table for node-valued predicates. Making it uniform (types and literals as
triples too) is the full ADR-021 Option C move — soft-blocked, not needed for v1 (see
Decision drivers).

**Sketch 3 — dedicated `schema`/`box`/`level` columns, NULL on instances.** Closest
miss: NULL-as-default is exactly the derived-defaults principle. Rejected as columns
because the values exist for only ~tens of term rows (poor cohesion on a table of
thousands), and ontology-axis vocabulary is open — columns need a migration per
extension, JSONB doesn't. **Chosen shape = sketch 3 applied only to term rows, with the
columns folded into `properties`.**

### For the ontology's home

**A — Separate file only** (status quo, `ahOntology.ttl`). Rejected by this decision:
not queryable, not linkable from runtime rows, invisible to agents traversing the graph.

**B — Full materialization** — write an `instance_of` edge and `layer`/`box` properties
on every row. Rejected: N-row redundancy; two sources of truth (`entity_type` column vs
edge) that will drift; fails the derived-defaults constraint.

**C — Type-nodes as rows + derived `instance_of` (chosen).** The ontology layer is
real rows; the per-instance links to it are a projection of the `entity_type` column.

## Decision

Adopt **C + C**: the vocabulary registry and the ontology are the same feature — rows
in the database — and instance-level classification is derived at read.

### 1. Term-nodes: the vocabulary registry lives in `entities`

> **Refined by [ADR-037](./ADR037_IRI_Storage_Local_Name_And_Namespace_Binding.md):**
> the `iri` property sketched below is **not stored as a CURIE**. A term row holds
> `local_name` + a `namespace` pointer (default `ahos`, omitted); the CURIE and
> full IRI are **derived**. Namespaces are their own rows (`properties.type =
> "ahos_namespace"`) carrying the prefix⟷IRI binding, so a prefix rename or
> re-host is a one-row edit. See ADR-037 for the full shape.

Every value of `ENTITY_TYPES`, `EDGE_TYPES`, and every `arrangement` `properties.kind`
in active use gets one row, reusing the existing **`concept`** entity type¹ with the
discriminator `properties.type = "ahos_concept_term"` — no new CHECK value needed
(`concept` shipped in ADR-033/#209; the only remaining migration is ADR-035's
`arrangement`). Required properties:

- `type` — the literal `"ahos_concept_term"`, distinguishing term rows from ordinary
  idea `concept` rows;
- `iri` — canonical `ahos:` IRI (e.g. `https://example.com/ahos-ontology#Arrangement`);
- `term` — the runtime string it grounds (`'arrangement'`, `'employed_at'`);
- `applies_to` — `entity_type` | `edge_type` | `kind`;
- optional `external_match` — a **list** of `{ relation: 'exactMatch' | 'closeMatch',
  iri, source }` per ADR-033 (e.g. `people` → exactMatch `foaf:Person`; a term may
  match several vocabs — `foaf:Person` and `schema:Person`);
- optional `definition`.

The lookup chain is deliberately **two hops**: runtime term (`'people'`) → canonical
`ahos:` IRI (always exists — we own the namespace) → claimed external equivalences
(0..n, each tagged exact/close). The external hop is an assertion, revisable in one
row; the term and canonical IRI are stable identifiers.

Term rows ground runtime *strings*; they are distinct from **idea rows** (principles
and concepts like `ReifyByCategory` or "n-ary", §3): both live in `entities` at the
ontology level, but only term rows carry `term`/`applies_to` and participate in the
derived `instance_of` view.

**Bootstrap note:** `concept` is itself a term with a term-node. Self-description
bottoms out at the `entity_type` column — the column remains the primitive that makes
the rest queryable. This circularity is acknowledged and acceptable; it is the same
foundation every RDF store has (something non-RDF stores the triples).

### 1a. The mapping contract (Turtle ⟷ tables)

> **Refined by [ADR-037](./ADR037_IRI_Storage_Local_Name_And_Namespace_Binding.md):**
> the worked `t1` row stores `local_name` (not `iri`), and `@prefix` directives /
> un-prefixed `owl:Ontology` subjects map to **namespace rows**. See ADR-037 §4
> for the updated `t1` row and the two added mapping rows.

The relational schema is a **shredded triple store**: every Turtle triple `S P O`
lands in exactly one of four places, chosen by the shape of `P`/`O`. This mapping is
total, and is the normative contract for seed ingestion (#326) and `export_rdf`:

| Triple shape | Lands in | Example (`ahOS-seed.ttl` v2) |
| --- | --- | --- |
| `S a <Class>` (`rdf:type`) | `entities.entity_type` — short term via registry | `ahos:angus a foaf:Person` → `'people'` |
| `S P "literal"` | `entities.properties[P]` (JSONB) | `schema:birthDate "1990-01-01"` → `properties.birth_date` |
| `S P O`, `O` a node | `entity_relationships` row | `ahos:workCofounder ahos:employee ahos:angus` |
| `{\| qualifiers \|}` on an edge | `entity_relationships.metadata` | `{\| ahos:role "Mother" \|}` → `metadata.role` |

The shredding is the same specialization real triple stores perform internally
(dictionary-encode, index hot predicates): the one predicate every query touches
(`rdf:type`) gets a column, literal predicates get JSONB, node predicates get the SPO
table that `entity_relationships` already is. Provenance sits deliberately **outside**
the mapping: the `.ttl` file itself becomes an `artifacts` row on ingestion, with
`artifact_entity_links` to every entity it evidences — *entities are what I know,
artifacts are how we know them.*

**Worked rows** (seed v2 fragment). `entities`:

| id | entity_type | title | properties |
| --- | --- | --- | --- |
| e1 | `people` | Angus Hally | `{given_name: "Angus", birth_date: "1990-01-01"}` |
| e2 | `organization` | Work | `{legal_name: "Work AI Ltd"}` |
| e3 | `arrangement` | Work cofounder | `{kind: "employment", role: "COO", valid_from: "2025-10-02"}` |
| t1 | `concept`¹ | people | `{type: "ahos_concept_term", term: "people", applies_to: "entity_type", iri: "ahos:People", external_match: [{relation: "exactMatch", iri: "foaf:Person"}], level: "ontology", in_box: "TBox"}` |

`entity_relationships`:

| from | relationship_type | to | metadata |
| --- | --- | --- | --- |
| e3 | `employer` | e2 | `{}` |
| e3 | `employee` | e1 | `{}` |
| e-anne | `parent_of` | e1 | `{role: "Mother", parent_type: "biological"}` |

Derived view `graph_instance_of` (§2, never written): `(e1 —instance_of→ t1)`,
`(e3 —instance_of→ t-arrangement)`, … A traversal therefore *sees*
`angus —instance_of→ people —exactMatch→ foaf:Person` as real edges while the mapping
is stored exactly once.

¹ Whether term rows use a new `vocab_term` type or reuse `concept` was pinned at
acceptance; **resolved same day (owner, 2026-07-12): reuse `concept`, discriminated by
`properties.type = "ahos_concept_term"`** — each term is an instance of `concept`, and
no new entity type is minted. The row shape is identical either way.

### 2. `instance_of` is derived, never written

A SQL view (`graph_instance_of`) projects one virtual edge per entity: `entity.id →
term-node.id`, joining `entities.entity_type` to the registry. `entity_neighbourhood`
gains an opt-in flag to union these virtual edges into traversals, so "walk from this
row to its type, then to the type's governing principle" is one graph query. Nothing is
written per instance; the column stays the single source of truth.

**This flag is a data-access concern for the agent, not a rendering rule for the
human.** Only the instance→type-node *first hop* is virtual; once a traversal reaches a
term-node, everything onward (its `exactMatch` to `foaf:Person`, its `governed_by`
principle) is real rows (§3). Default is off — ordinary neighbourhood queries stay clean
and cheap; a caller doing ontology/vocabulary reasoning opts in and gets the ladder up to
the external vocabulary. How the *human* visualisation surfaces type is deliberately
**out of scope here**: this ADR guarantees only that the classification is derivable, not
that the ego graph must render a type-node. The graph view treats `entity_type` as a
node facet (colour/icon/filter), with a distinct schema-view mode for looking at the
ontology itself — a rendering decision tracked in
[#330](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/330), not
dictated by this ADR. The same applies to
layers: **`properties.level` (`meta` | `ontology`) is stored only on non-instance rows;
absence = `instance`. Same for `properties.in_box` (`TBox` stamped; absence = `ABox`).**
Names and values deliberately mirror the design ontology's existing axis vocabulary —
`ahos:level` / `ahos:inBox` with string values (`docs/architecture/ahOntology.ttl`) —
so TTL and DB share one axis vocabulary, with no parallel `box`/`tBox` variant.

### 3. Metaclasses, principles, and governance edges are real rows

The design ontology's contents — `ahos:Category`, `ahos:Principle`, `ahos:Capability`
metaclasses and their instances (e.g. `ReifyByCategory`, `p-synth-time`) — are ingested
as entities, and sparse edges like `promote_edge_to_node —governed_by→ ReifyByCategory`
are **written normally** (they are few and hand-curated; the no-write rule applies only
to the N-instance `instance_of` fan-out).

### 4. The database is canonical; `.ttl` files become projections

`ahOntology.ttl` (and seed files like `ahOS-seed.ttl`) become **seed-in / export-out
artifacts**: ingested once, then regenerable. An `export_rdf` projection emits valid
Turtle using registry IRIs — the full RDF round-trip that motivates IRI grounding,
without running a triple store (ADR-021 Option C stays rejected).

### 5. Discipline gates

- CI check: every string in `vocab.ts` `ENTITY_TYPES`/`EDGE_TYPES` has a term-node with
  an `iri` (hard fail); every `kind` observed in data has one (soft warn — capture-first
  per ADR-018/021 must not gate writes).
- `vocab.ts` and the registry are compared, not duplicated by hand: the check reads both
  and diffs.

## Consequences

- **Good:** the graph is self-describing and queryable end-to-end (instance → type →
  principle); ADR-033 mappings become data instead of prose; RDF round-trip at zero
  per-row cost; defaults derived so nothing drifts; #312's north star lands additively
  (one CHECK migration + one view + seed ingestion).
- **Cost / bad:** read-path unions for virtual edges add query complexity; the registry
  must track `vocab.ts` (mitigated by the CI diff); bootstrap circularity means
  self-description is honest only down to the `entity_type` column; term-nodes mix with
  user data in `entities` (filterable by type, but present in scans).
- **Follow-ups (separate PRs):**
  - Migration: add `arrangement` (per ADR-035) to `ENTITY_TYPES` CHECK — term rows
    reuse the existing `concept` type, so no further CHECK value is needed; create
    `graph_instance_of` view (filter: `entity_type = 'concept' AND
    properties->>'type' = 'ahos_concept_term'`).
  - Seed ingestion: registry rows for all current terms; `ahOntology.ttl` contents as
    rows; ADR-035 §8 pointer nodes.
  - `entity_neighbourhood` opt-in flag for virtual edges.
  - `export_rdf` projection; CI vocab diff check.
  - Closes the design phase of
    [#312](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/312).

## Links

- Issue: [#312](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/312)
  (runtime metaclass TBox — this ADR is its design)
- Extends: [ADR-035](./ADR035_Relationship_Reification.md) §8 (lifts the
  self-description fence), [ADR-033](./ADR033_External_Vocabulary_Adoption.md)
  (external vocabulary adoption — this makes its mappings enforceable data),
  [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md) (Option C — triple store —
  soft-blocked for v1, see Decision drivers), [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md)
  (projection-source pattern, applied here to `.ttl` files)
- Provenance of the demand: `ahOS-seed.ttl` v1→v2 (hand-written ABox practice, open
  questions 2 & 3); owner's in-flight review sketches
  (`docs/sessions/2026-07-12-flight-offline-pack/adr-draft-flight-annotations.md`)
  → the row-shape considered options and the mapping contract (§1a)
- Design ontology: `docs/architecture/ahOntology.ttl`,
  `docs/sessions/2026-06-15-ahOS-design-ontology.md`
- Runtime vocabulary: `packages/mcp-server/src/vocab.ts`
