# ADR037: IRI storage — terms hold a local name + a namespace pointer; the CURIE is derived; namespaces are rows

- **Status:** Accepted
- **Created:** 2026-07-13
- **Accepted-on-dev:** 2026-07-13
- **Deciders:** Angus Hally
- **Refines:** [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)
  §1 (the term-node `iri` property) and §1a (the mapping contract + worked `t1`
  row). ADR-036's C+C decision (registry rows, `instance_of` derived) stands;
  this ADR only sharpens **how the IRI itself is physically stored**.

## Context and problem

ADR-036 §1 grounds every runtime term in a canonical `ahos:` IRI and makes
external mappings revisable data. But it left the *physical representation of the
IRI itself* as a stored CURIE — §1a's worked `t1` row carries
`properties.iri: "ahos:People"`. Working the seed-ingestion (#326) and
`export_rdf` (§4) shapes on 2026-07-13 surfaced three gaps, which are one problem
wearing three hats — **where does an IRI's namespace live, and how does
resolution bottom out?**

1. **A CURIE fuses two things of very different stability.** `ahos:People` is
   `prefix : local` — a **mutable presentation prefix** (`ahos`) glued to a
   **stable local name** (`People`). Persisting that per term-row makes a prefix
   rename (`ahos` → `ah`) or a namespace re-host
   (`https://example.com/ahos-ontology#` → a new host) an **N-row migration**.
   That is the exact failure mode ADR-036 rejected for external mappings — *"in
   the identifier, a revision is an every-row migration; in one term row, it's a
   one-row update"* — reintroduced by the back door for the **canonical** IRI.
2. **`export_rdf` has nowhere to get its `@prefix` headers.** Valid Turtle
   requires `@prefix p: <ns> .` declarations. The prefix⟷namespace bindings
   those need have **no home** in §1a; they would have to be reconstructed by
   string-splitting every stored CURIE at export time.
3. **Are namespaces themselves things — entities?** (owner, 2026-07-13). ADR-036
   has no answer. Answering it naïvely — *"a namespace is just another entity,
   resolved like any term"* — creates an **infinite resolution regress**: to
   render a term's IRI you need its namespace binding; if that binding is itself
   a graph row whose rendering needs a binding, nothing bootstraps.

## Decision drivers

- **Derived, not stored** — ADR-036's spine. A CURIE is `prefix + ":" + local`;
  once the parts exist, the CURIE is redundant and must be *derived*, not
  persisted.
- **Prefix is presentation; the namespace IRI is identity.** `ahos:People` and
  `ah:People` are the **same term** if both prefixes bind the same namespace.
  Persisting the prefix persists a label, not an identity.
- **One-row revision, never N-row migration** — for both a prefix rename *and* a
  namespace re-host.
- **Leverage the giants** — Turtle `@prefix`, JSON-LD `@context`, and every
  triple store's serialization-layer `PrefixMapping` all separate the *binding*
  from the *term*. None store the CURIE as identity; storing it "imitates the
  giants' syntax while ignoring their engineering" (ADR-036's own phrasing).
- **`export_rdf` round-trip** needs the `@prefix` bindings held structurally, not
  re-parsed from strings.
- **Bootstrap honesty** — self-description must bottom out at a primitive that is
  *read*, not *resolved*. ADR-036 already bottoms out at the `entity_type`
  column ("the same foundation every RDF store has — something non-RDF stores the
  triples"). This ADR must name its own floor, not pretend there isn't one.
- **Keep it cheap / ego-centric graph** — no triple store (ADR-021 Option C stays
  soft-blocked). There are ~10 namespaces ever.

## Considered options

### For the term's IRI

**A — Store the CURIE string per row** (`iri: "ahos:People"`; ADR-036 §1a's
implicit sketch). Rejected: fuses the mutable prefix with the stable local; a
prefix rename or re-host is an N-row migration; `export_rdf` must re-split
strings to recover `@prefix` bindings.

**B — Store prefix + local as two columns per row** (`prefix: "ahos"`,
`local: "People"`). Rejected: the *split* is right but the *home* is wrong — it
still writes the mutable `ahos` into every term row, so a rename is **still** an
N-row migration. It denormalizes a shared, low-cardinality, mutable dimension —
the textbook signal to lift it into a lookup, not repeat it.

**C — Local name on the term + a namespace *pointer*; CURIE and full IRI derived
(chosen).** The term row stores `local_name` and a reference to a namespace
(defaulting to `ahos`, omitted when default). The prefix⟷namespace binding lives
**once**, on the namespace. The CURIE (`ahos:People`) and full IRI
(`https://…#People`) are **projections** computed at read/export.

### For the namespace itself

**N1 — Namespace as a flat primitive only** (a `prefix ⟷ namespace_iri` lookup,
nothing more). Resolves fine and bottoms out fine — but you cannot say anything
*about* FOAF (its publisher, version, `owl:Ontology` typing). Fails
self-description for the vocabularies that most deserve it.

**N2 — Namespace as an ordinary entity only** (a row in `entities`, resolved like
any term). Rejected *alone*: **infinite regress** — the namespace row's own IRI
needs a namespace, which needs a namespace…

**N3 — Both, split by role (chosen).** A namespace plays two roles, and they map
exactly onto ADR-036's own `(primitive ⊕ entity)` split:

- **Role A — the binding** (`prefix ⟷ namespace_iri`): serialization plumbing,
  read mechanically at ingest and `export_rdf`. The **ground** — read as a
  *literal*, never resolved through the graph.
- **Role B — the namespace as knowledge** (`<ns> a owl:Ontology`, with
  publisher/version/spec edges): a describable, traversable node. **Sparse,
  opt-in.**

The regress is broken by a fact of RDF: **a namespace names itself with a *full*
IRI, written un-prefixed** — `<http://xmlns.com/foaf/0.1/> a owl:Ontology`, never
a CURIE. A namespace needs no prefix to be identified, so Role B adds **no new
resolution dependency**. (This is precisely why N2-alone regressed but N3 does
not.)

## Decision

Adopt **C + N3**, realized as **one row per namespace** so the two roles do not
become two tables.

### 1. Term rows store a local name + a namespace pointer — never a CURIE

*Refines ADR-036 §1.* A term-node's identity properties become:

- `term` — the runtime string it grounds (`'people'`, `'employed_at'`),
  **unchanged** from ADR-036; still the join key to the `entity_type` /
  `edge_type` primitive.
- `local_name` — the **local part of the IRI** (`"People"`, `"Arrangement"`,
  `"employed_at"`). Stored explicitly rather than derived from `term` by a casing
  rule: the runtime string and the IRI local part diverge for classes
  (`'people'` → `People`) and casing rules are fiddly and drift-prone.
- `namespace` — a **pointer** to a namespace row (§2). **Omitted ⇒ the default
  `ahos` namespace** (derived-defaults, mirroring ADR-036's instance/ABox
  default). Present only for the rare term whose canonical home is not `ahos`.

`applies_to`, `external_match`, `definition` are **unchanged** from ADR-036 §1.
The stored `iri` property is **removed**; `iri` (full) and `curie` are
**derived** — `namespace.namespace_iri + local_name` and
`namespace.prefix + ":" + local_name` — never persisted.

The term still references its **type** via the `entity_type` column primitive
(ADR-036's bootstrap floor is untouched); this ADR governs only the term's
*external-facing IRI*, which is off the hot traversal path.

### 2. The namespace binding is a row, read as a literal — this ADR's bootstrap floor

Namespaces are `entities` rows, reusing **`concept`** with the discriminator
`properties.type = "ahos_namespace"` (mirroring ADR-036's `ahos_concept_term`;
**no new CHECK value** — `concept` shipped in ADR-033/#209). Each namespace row
carries, as **literal** properties (plain strings, read directly, never
IRI-resolved):

- `prefix` — `"ahos"`, `"foaf"`, `"schema"`, … the presentation label.
  **Mutable, one row.**
- `namespace_iri` — the full namespace IRI
  (`"https://example.com/ahos-ontology#"`, `"http://xmlns.com/foaf/0.1/"`).
  The namespace's **stable identity**.
- `is_default` — `true` for exactly one row (`ahos`); lets term rows omit the
  pointer.

The prefix⟷namespace **map** consumed by ingestion and `export_rdf` is a
**derived view**, `graph_namespaces`:

```sql
SELECT properties->>'prefix'        AS prefix,
       properties->>'namespace_iri' AS namespace_iri,
       (properties->>'is_default')::boolean AS is_default
FROM entities
WHERE properties->>'type' = 'ahos_namespace';
```

**This view is the ground primitive** — resolved by reading literals, exactly as
ADR-036 bottoms out at the `entity_type` column. This is where self-description
stops, and it is honest and unavoidable: *something non-RDF stores the triples.*

A term references its namespace by the namespace row's **stable identity** — its
`namespace_iri` (or row id) — **never by `prefix`** (the mutable label). The
default (`ahos`) is omitted entirely. Consequences — the motivating fixes:

- **Prefix rename** (`ahos` → `ah`): update `prefix` on **one** namespace row.
  Zero term rows touched.
- **Namespace re-host**: update `namespace_iri` on **one** row; every derived IRI
  follows. Zero term rows touched.
- **"Every element has a prefix, and it may change"** (owner, 2026-07-13) is
  answered end to end: the prefix lives in one place, most rows don't store it at
  all (default `ahos`), and either kind of change is a one-row edit.

### 3. Description (Role B) is additive on the same row

When a namespace is worth describing — FOAF's publisher, schema.org's version,
ahOS's own governance — that knowledge is **more properties and edges on the same
namespace row**: typed `a owl:Ontology` (via a term-node), `properties.version`,
`published_by` / `sourced_from` edges written normally (ADR-036 §3's "few and
hand-curated" rule; the no-write rule applies only to the N-instance
`instance_of` fan-out). **No second table, no duplicate.** Role B is **deferred
until a query wants it**: v1 ships Role A (~10 rows, mostly `ahos`) and adds
descriptive properties lazily.

### 4. §1a mapping contract — two updates

*Refines ADR-036 §1a.*

**(a) The worked `t1` row** no longer stores `iri`; it stores `local_name` and
(implicit default) namespace:

| id | entity_type | title | properties |
| --- | --- | --- | --- |
| t1 | `concept` | people | `{type: "ahos_concept_term", term: "people", local_name: "People", applies_to: "entity_type", external_match: [{relation: "exactMatch", iri: "foaf:Person"}], level: "ontology", in_box: "TBox"}` |

`namespace` is omitted ⇒ `ahos`. `iri` / `curie` are **derived**, shown here only
for reading: `ahos:People` / `https://example.com/ahos-ontology#People`.
(`external_match` entries keep CURIE form — they are 0..n **revisable claims**,
not the primary identity, and their prefixes resolve via their own namespace rows
at export. The asymmetry is deliberate: the primary identity is a stable pointer;
external equivalences are editable annotations.)

**(b) Two rows added** to §1a's Turtle⟷tables mapping, for the namespace
dimension:

| Triple / directive shape | Lands in |
| --- | --- |
| `@prefix p: <ns> .` (Turtle directive) | a namespace row (Role A): `prefix = "p"`, `namespace_iri = "<ns>"` |
| `<full-iri> a owl:Ontology` (un-prefixed subject) | the **same** namespace row, gaining Role B description |

### 5. Discipline gates (extends ADR-036 §5)

- Every namespace referenced by a term's `namespace` pointer **or** by an
  `external_match.iri` prefix **has a namespace row** with a non-empty
  `namespace_iri` — **hard fail** otherwise (IRIs can't be expanded; Turtle can't
  declare `@prefix`).
- **Exactly one** namespace row has `is_default = true`.
- `export_rdf` builds its `@prefix` header block from `graph_namespaces`; the CI
  vocab diff additionally asserts **no term stores a literal `iri`/`curie`** — it
  must be derived.

## Consequences

- **Good:** a prefix rename or namespace re-host is a **one-row edit** (the
  motivating fix); `export_rdf` gets its `@prefix` headers **structurally, for
  free**; namespaces are **describable** (`owl:Ontology`, publisher, version)
  without a parallel table; derived-not-stored preserved (CURIE/IRI are
  projections); the ego-centric graph gains ~10 rows, **not a triple store**.
- **Cost / bad:** namespace rows mix into `entities` scans (the same
  already-accepted cost as term-nodes; filterable by discriminator); the hot-path
  prefix map should be a **cached/materialized** view, not a live scan per
  export; building a full IRI is a **two-hop** read (term → namespace), mitigated
  by the default-`ahos` fast path and the cached map; self-description **still
  bottoms out** — now at the namespace rows' literal `namespace_iri` rather than
  nowhere — which is honest, not eliminable.
- **Follow-ups (separate PRs)** — refining ADR-036's follow-up list:
  - Seed ingestion (#326): resolve `@prefix` directives into namespace rows;
    store term `local_name` + namespace pointer (not a CURIE).
  - `graph_namespaces` view; `export_rdf` consumes it for the `@prefix` block.
  - Term-row shape: `local_name` + `namespace` supersede the sketched `iri`
    property. **No CHECK migration** — namespaces reuse `concept`.
  - CI: extend the vocab diff to forbid stored CURIEs and to require a namespace
    row per referenced prefix.

## Links

- **Refines:** [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)
  §1 (term-node `iri` property) and §1a (mapping contract + worked `t1` row).
- **Relates:** [ADR-033](./ADR033_External_Vocabulary_Adoption.md) (external
  mappings as revisable data — this applies the same one-row-revision logic to
  the **canonical** IRI's namespace); [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md)
  (Option C, triple store — still soft-blocked; namespaces-as-rows is *dictionary
  encoding*, not a triple store); [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md)
  (projection-source pattern — CURIE, full IRI, and the `@prefix` block are all
  projections of these rows).
- **Issues:** [#312](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/312)
  (self-describing graph — this sharpens its IRI storage);
  [#326](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/326)
  (seed ingestion — the normative consumer of this mapping).

---

**Bootstrap note (echoing ADR-036).** Self-description always bottoms out
somewhere; the skill is choosing where. RDF stores bottom out at "something
non-RDF stores the triples." ADR-036 bottoms out at the `entity_type` column.
This ADR bottoms out at the namespace rows' literal `namespace_iri`. The graph
can **describe** its own ground; it cannot **resolve through** it without a floor.
