# ADR021: FOAF + RELATIONSHIP vocabulary for the interpersonal knowledge graph

- **Status:** Accepted
- **Date:** 2026-07-04
- **Accepted-on-dev:** 2026-07-05
- **Deciders:** Angus Hally

## Context and problem

The system stores entities (PARAMPS types) and an `entity_relationships` edge
table, but the only edge the pipeline ever writes is `co_occurs_with` — a
statistical "these two appeared together" signal produced by
[`organizeEntities.ts`](../../packages/worker/src/workflows/steps/organizeEntities.ts).
There are no *defined*, semantically-typed relationships: no way to ask "who are
my colleagues?", "who is family?", or "who did I meet through whom?". The only
hint of interpersonal structure is a free-text `properties.relation` string on
People entities (values like "colleague", "friend", "family"), which is an
attribute on one node, not a queryable edge.

We want a defined relationship layer, and we want to reuse an open-source
vocabulary rather than invent our own taxonomy.

## Decision drivers

- Reuse an open, well-understood vocabulary; don't hand-roll relationship strings.
- Fit the existing stack: Postgres/Supabase, `entity_relationships`, TypeScript
  types in `@ahkms/shared`, single-user-with-multi-user-ready data.
- Honour "capture first, refine later" — validation should be forgiving, not a
  hard gate that rejects edges the AI or a user proposes.
- Model *my* relationships: the graph is ego-centric, centred on the user.
- Keep the first slice additive and reversible.

## Considered options

### Option A — FOAF core only (`foaf:knows`, `member`, `currentProject`)

- **Pros:** Tiny, web-native, already referenced in `docs/architecture/ahOntology.ttl`.
- **Cons:** FOAF deliberately models only `foaf:knows` for interpersonal ties — no
  granularity (friend vs. colleague vs. spouse). Too shallow on its own.

### Option B — FOAF + the RELATIONSHIP vocabulary (chosen)

- **Pros:** RELATIONSHIP (`http://purl.org/vocab/relationship/`) is FOAF's standard
  companion and supplies ~30 granular typed edges (`friendOf`, `colleagueOf`,
  `mentorOf`, `spouseOf`, …), each `rdfs:subPropertyOf foaf:knows` so the coarse
  "knows" graph still rolls up for free. Open, stable, no runtime dependency —
  we adopt the term set, not a library.
- **Cons:** People-centric; other PARAMPS edges (Project↔Area, artifact lineage)
  need schema.org / PROV-O later.

### Option C — Full RDF triple store (RDFLib / Oxigraph) or a graph DB (Neo4j)

- **Pros:** Native graph semantics, reasoning, SPARQL/Cypher.
- **Cons:** A second data store to run, secure, and sync alongside Postgres/RLS.
  Massive over-reach for a personal KMS with a working edge table already.

### Option D — Hand-rolled enum enforced by a hard DB `CHECK`

- **Pros:** Strong DB-level guarantee.
- **Cons:** Reinvents a taxonomy; rejects edges the AI proposes; brittle to evolve
  (every new term is a migration). Conflicts with "capture first, refine later".

## Decision

We adopt **FOAF + the RELATIONSHIP vocabulary** as the relationship term set, with
**soft, application-layer validation** (Option B, explicitly rejecting the hard
`CHECK` of Option D):

- `RelationshipType` / `RELATIONSHIP_VOCABULARY` live in `@ahkms/shared`
  ([`types/entities.ts`](../../packages/shared/src/types/entities.ts),
  [`constants/index.ts`](../../packages/shared/src/constants/index.ts)) with
  category, label, symmetry, and inverse metadata.
- `relationship_type` stays free text in the DB; unknown values are allowed and
  normalised to `other` with the raw value preserved in `notes`
  (`normalizeRelationshipType`).
- The graph is **ego-centric**: a "self" People node (`properties.is_self = true`)
  anchors the user's own relationships.
- The existing `co_occurs_with` edge is retained as a distinct `system` category,
  rendered separately from defined relationships.

## Consequences

- **Good:** A real, typed relationship graph reusing an open standard; the coarse
  `foaf:knows` view rolls up from specific edges via `subPropertyOf`; soft
  validation keeps capture unblocked; no new infrastructure.
- **Good:** Migration 062 also reconciles `entity_relationships` drift (adds the
  `metadata`/`user_id` columns and user-scoped RLS the migration history lacked).
- **Cost / bad:** People-only for now; non-interpersonal edges await a follow-up
  (schema.org / PROV-O). Soft validation means the vocabulary can accrete `other`
  values that need periodic curation.
- **Follow-up:** Wire LLM relationship extraction into the capture pipeline via the
  already-stubbed `relationship_suggested` decision type + review backlog (tracked
  as a GitHub Issue), and extend the vocabulary to non-People edges.

## Links

- Vocabularies: FOAF `http://xmlns.com/foaf/0.1/`, RELATIONSHIP `http://purl.org/vocab/relationship/`
- Related: [ADR-008](./ADR008_Type_Organization_Standardization.md) (single-source shared types),
  [ADR-006](./ADR006_UUID_Primary_Key_Standardization.md)
