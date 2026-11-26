# ADR033: External vocabulary adoption — reuse terms directly when exact; mint + map when approximate

- **Status:** Accepted
- **Created:** 2026-07-05
- **Accepted-on-dev:** 2026-07-06
- **Deciders:** Angus Hally

> Authored unnumbered (`ADR-DRAFT-2026-07-05-external-vocabulary-adoption.md`)
> per the mint-at-merge rule; merged to `dev` in PR #201 and minted as ADR033
> on 2026-07-06.

## Context and problem

Five external vocabularies are being adopted into the knowledge graph —
Schema.org (#192), PROV-O (#193), FOAF (#194), SKOS (#195), Dublin Core /
DCTerms (#196) — on top of the FOAF + RELATIONSHIP precedent set by
[ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md).

[`ahOntology.ttl`](../architecture/ahOntology.ttl) already aligns to these
standards, but **only in prose comments**: `ahos:createdBy` is "equivalent to
dcterms:creator / schema:creator", `ahos:sourceLocation` is "semantically
equivalent to dcterms:source", `ahos:auditHistory` notes "PROV-O alternative:
prov:wasGeneratedBy chains; chose ahos: for simplicity". The stated house style
throughout the file has been **"use `ahos:` for symmetry, note the standard in
a comment"** — which leaves the cross-vocabulary alignment human-readable but
not machine-traversable, and creates a hand-maintained mapping layer that can
rot. This clashes with the file's own principle that the design should be
"encoded structurally in the graph (not just here in prose)". The drift is
already real: the TTL's `@prefix` block still lacks `foaf:` even though
ADR-021 shipped `foaf:` CURIEs in `vocab.ts` months ago — the prefix (and
vocabulary node) lands via #194.

Adopting five vocabularies at once forces two rules to be settled:

1. **Proxy or direct?** When adopting an external term, do we mint an `ahos:`
   proxy and map it (`ahos:derivedFrom skos:exactMatch prov:wasDerivedFrom`),
   or use the external IRI directly (`prov:wasDerivedFrom`)?
2. **Self-documentation.** How does the graph itself record which vocabularies
   it uses and for what, so "which standards does ahOS align to?" is a query,
   not a doc lookup?

## Decision drivers

- **Self-documenting graph** — design encoded structurally, not just prose
  (existing `ahOntology.ttl` principle; the same drive behind `ahos:partOfAxis`).
- **One canonical term per relation** — the vocabularies overlap
  (`schema:author` ≈ `dcterms:creator` ≈ `prov:wasAttributedTo`); one fact must
  not fork into several differently-named edges.
- **No reasoner** — the runtime graph is Postgres (`entity_relationships`) with
  open string edge types in
  [`vocab.ts`](../../packages/mcp-server/src/vocab.ts), not a triple store.
  ~~Vocabularies are a **naming standard, not an inference engine**: nothing
  (`foaf:knows` rollups, `prov` derivation chains) is inferred "for free".~~
  **— corrected, see Erratum below.**
- **Reuse open standards; don't hand-roll** (ADR-021's driver).
- **Low maintenance** — mappings rot; namespaces don't. Every proxy term is a
  mapping someone must keep true.

## Considered options

### Option A — mint `ahos:` proxies for everything + `skos:exactMatch` bridges

Continue the current house style, but promote the prose equivalences to
`skos:exactMatch` triples.

- **Pros:** uniform `ahos:` namespace; full local control over every term;
  machine-readable alignment.
- **Cons:** the proxy is an indirection that buys nothing without a reasoner or
  divergent semantics; every consumer must follow the mapping; "which standard
  is this term from?" needs a lookup; the mapping layer is exactly the kind of
  hand-maintained parallel structure that drifts.

### Option B — adopt external terms directly everywhere

- **Pros:** zero mapping layer; the namespace itself documents provenance of
  every term.
- **Cons:** dishonest where our meaning only *approximates* the standard's —
  e.g. `ahos:subjectOf` is "equivalent **in role** to dcterms:subject" (a
  hedge), and `ahos:lastEditedBy` has no clean external equivalent. Direct
  reuse there would assert semantics we don't hold.

### Option C — adopt-direct when exact; mint + `closeMatch` when approximate (chosen)

The mainstream linked-data rule: reuse an external term directly when it means
exactly what we mean; mint a local term only when our meaning differs, and then
bridge it with a non-propagating `skos:closeMatch`.

- **Pros:** minimal mapping surface (only the deliberate approximations carry
  bridges); self-documenting by namespace; honest semantics both ways.
- **Cons:** heterogeneous namespaces in the TTL (normal in linked data, but a
  style change); adopting a term means conforming to its published definition.

## Decision

**1. Adopt-direct rule.** Where an external term's semantics match ours
exactly, use the external IRI directly in `ahOntology.ttl` and in the JSON-LD
`@context` — no `ahos:` proxy. First applications:

- `ahos:derivedFrom` → **`prov:wasDerivedFrom`** (mechanical instance-triple
  rename; both ends are `prov:Entity`s, so we conform honestly).
- `ahos:createdBy` → **`dcterms:creator`** (exact; migrate opportunistically —
  it is widely used in the file).

**2. Mint + map when approximate.** Where our meaning is only close to or
broader than the standard's, keep the `ahos:` term and add a machine-readable
**`skos:closeMatch`** bridge (promoting today's prose comments to triples):

```turtle
ahos:subjectOf    skos:closeMatch dcterms:subject, schema:about .
ahos:lastEditedBy skos:closeMatch dcterms:contributor, prov:wasAttributedTo .
```

`skos:closeMatch`/`exactMatch` are chosen over `owl:equivalentProperty` /
`rdfs:subPropertyOf` deliberately: they record alignment as queryable data
**without** implying inference we don't run.

**3. House annotations attach to external terms.** The viewer/tagging
machinery (`ahos:level`, `ahos:inBox`, `ahos:relationType`) never required the
`ahos:` namespace — annotations are asserted on any node:

```turtle
prov:wasDerivedFrom ahos:relationType ahos:Flow ;
    ahos:level "ontology" ; ahos:inBox "TBox" .
```

**4. Vocabulary nodes, not a new class.** Each adopted vocabulary becomes a
node typed with what RDF already provides — `owl:Ontology` — carrying one new
annotation property, `ahos:usedFor`, which encodes the "which framework owns
which axis" mental model as triples:

```turtle
ahos:usedFor a owl:AnnotationProperty ;
    rdfs:label "used for" ;
    rdfs:comment "Which axis of the graph an adopted external vocabulary owns." ;
    ahos:level "meta" ; ahos:inBox "TBox" .

<http://schema.org/>                  a owl:Ontology ; rdfs:label "Schema.org" ;
    ahos:usedFor "Spine / default — general relations; reach for this first." .
<http://www.w3.org/ns/prov#>          a owl:Ontology ; rdfs:label "PROV-O" ;
    ahos:usedFor "Lineage — 'where did this come from?' (wasDerivedFrom, wasGeneratedBy, wasAttributedTo)." .
<http://xmlns.com/foaf/0.1/>          a owl:Ontology ; rdfs:label "FOAF" ;
    ahos:usedFor "People — 'who knows/belongs to whom?' (knows, member, currentProject). Per ADR-021." .
<http://www.w3.org/2004/02/skos/core#> a owl:Ontology ; rdfs:label "SKOS" ;
    ahos:usedFor "Concept hierarchy — Areas tree (broader/narrower/related); also supplies the closeMatch mapping predicate." .
<http://purl.org/dc/terms/>           a owl:Ontology ; rdfs:label "DCTerms" ;
    ahos:usedFor "Documents / citation — creator, references, subject on Resources and artifacts." .
```

`SELECT ?v ?use WHERE { ?v a owl:Ontology ; ahos:usedFor ?use }` returns the
whole table. Explicitly rejected homes: **`ahos:KnowledgeFramework`** (that
class is for content-organising systems — PARA, work-team-os; term
standards in it would pollute the "all frameworks" query) and a new
**`ahos:Vocabulary` class** (unnecessary machinery today; add as a subclass
tag only if the HTML viewer later needs the grouping).

**5. Storage split unchanged.** Postgres `entity_relationships` edge strings
stay snake_case open vocab in `vocab.ts` (per migration 049); the `@context` /
TTL carries the canonical external IRI for each string (e.g. `derived_from` →
`prov:wasDerivedFrom`). **One canonical term per relation**, disambiguated by
the specialist-wins rule: lineage → PROV, people → FOAF, hierarchy → SKOS,
document/citation → DCTerms, everything else → Schema.org.

This decision **reverses** the previous "use `ahos:` for symmetry" style
stated throughout `ahOntology.ttl`; those comments are updated as terms
migrate.

## Consequences

- **Good:** the cross-map table originally scoped in #196 largely *dissolves*
  — directly-adopted terms need no mapping (the namespace is the
  documentation); only deliberate approximations carry `closeMatch` bridges.
- **Good:** "which standards do we use, for what?" becomes a graph query;
  per-term provenance is visible in the IRI.
- **Good:** honest semantics — we never claim exact equivalence we don't hold,
  and never fork one relation into synonym edges.
- **Cost:** mechanical renames of existing TTL triples (`derivedFrom`,
  `createdBy`) and their prose comments; heterogeneous namespaces in the file.
- **Cost:** a directly-adopted term inherits the standard's published
  definition — if our meaning later diverges, we must re-mint an `ahos:` term
  at that point (the reversal is cheap but must be noticed).
- **Unchanged:** no inference is implied or run; rollups (e.g. coarse
  `foaf:knows` from specific RELATIONSHIP edges) remain explicit queries or
  materialisations if ever wanted.

## Erratum — "not an inference engine" (recorded 2026-07-21)

Recorded under [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1; no new decision is
required, so this ADR is edited in place and its Status line is not stamped. **The decision —
adopt-direct when exact, mint-and-map when approximate — is unaffected and remains in force.**

The *No reasoner* driver above stated that vocabularies are *"a naming standard, not an inference
engine: nothing is inferred 'for free'."* That was accurate when written (2026-07-05). It is not
accurate now:

- **[ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)** (accepted 2026-07-12,
  six days later) is titled *"`instance_of` derived at read"*, and its §2 is *"`instance_of` is
  derived, never written"* — a SQL view projects virtual type edges so a traversal *sees*
  `angus —instance_of→ people —exactMatch→ foaf:Person` while the mapping is stored once.
- `RELATIONSHIP_VOCABULARY` in `@ahkms/shared` ships `symmetric`, `inverseOf` and
  `subPropertyOf: KNOWS` today, with `inverseOfType()` computing an edge's inverse at render time
  rather than storing both directions.

Inference *is* happening — at read, in Postgres, without a reasoner.

**Corrected to:** nothing is inferred *by a reasoner*; structural inference is **derived at read**.
The blanket phrasing had already been mistaken for a general rule once, when it was promoted to a
load-bearing principle in a `docs/vision.md` draft on 2026-07-20 and had to be reverted.

Superseding treatment and the full per-mechanism verdicts (forward-chaining materialisation
rejected · hard consistency checking rejected · soft consistency checking in scope · OWL reasoner
deferred · SPARQL deferred as the interoperability path) are in
**[ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md) §3–§4**, which also records the
driver this ADR was missing: public vocabularies are *free inference from model weights*, since the
LLM already knows the public term and does not know ours.

## Links

- [ADR-041](./ADR041_Public_Vocabularies_As_LLM_Scaffolding.md) — why we adopt public vocabularies;
  corrects the driver above
- Issues applying this rule: #192 (Schema.org), #193 (PROV-O), #194 (FOAF),
  #195 (SKOS), #196 (DCTerms)
- [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md) — FOAF + RELATIONSHIP
  (precedent: reuse open vocabularies; soft app-layer validation)
- [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md) —
  provenance rationalisation (PROV-O's nearest neighbour in the schema)
- [`docs/architecture/ahOntology.ttl`](../architecture/ahOntology.ttl) ·
  [`packages/mcp-server/src/vocab.ts`](../../packages/mcp-server/src/vocab.ts)
