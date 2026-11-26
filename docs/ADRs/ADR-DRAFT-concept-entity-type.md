# ADR[NNN]: Promote `concept` to a first-class entity type, anchored to `skos:Concept`

<!-- Authored as ADR-DRAFT per the mint-at-merge numbering rule (docs/ADRs/README.md).
     The integer is assigned at merge to dev. -->

- **Status:** Proposed
- **Created:** 2026-07-07
- **Accepted-on-dev:** (pending merge)
- **Deciders:** Angus

## Context and problem

During the #188 (place) release, a different Claude session found the graph
had no home for topics/subjects: it wanted to promote 7 tags (Design,
Graphics, Motion, Video, Content, Mobile, Events) into real nodes so people/
resources could point `about` them, the same way `event`/`organization`/
`place` already give first-class nodes to other ontology gaps (ADR-025,
#188). It reached for the Supabase MCP `apply_migration` tool to add
`'concept'` to the `entities.entity_type` CHECK directly against prod — a
banned write path (`docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md`: "prod
DDL goes through the repo flow ONLY"), because it leaves a remote history
version no repo file has and breaks the next `supabase db push`. It also
opened PR #200 carrying a `003_add_concept_entity_type.sql` migration —
mis-numbered against the repo's real sequence (the repo was already past
migration 060+ at the time) and authored against a pre-remediation state.

The ad-hoc write was caught and remediated (issue #209): the 7 stray
`concept` rows were retyped to `resource` with
`properties.original_entity_type = 'concept'` preserved (zero data loss,
revivable in one UPDATE), and the live CHECK constraint was re-asserted to
exactly what migration 063 (`place`) defines — no `concept`. #209 asked
Angus to make the actual product call: finish the pipeline properly, or
close it out and let PARA's Resources continue to absorb topics. Decision:
**yes — take the full pipeline** (#209 option 1), executed here through the
sanctioned repo flow, superseding PR #200's raw material.

## Decision drivers

- **Additive** (vision §load-bearing): extend the ontology, don't reshape it —
  same driver ADR-025 (event/organization/signal) and #188 (place) followed.
- **Uniform graph:** a topic/subject should be a node so existing edges work
  unmodified — `artifact -[about]-> concept`, `concept -[broader]-> concept`.
- **Reuse an external vocabulary exactly, don't hand-roll** (ADR-021's
  driver, formalised as the adopt-direct rule in ADR-033): SKOS already
  defines `skos:Concept` as the canonical "unit of thought" class, and the
  graph already adopted SKOS's `broader`/`narrower`/`related` hierarchy edges
  for the Areas tree (#195/#232) — a topic/subject entity is an exact match
  for that same class, not an approximation needing a proxy.
- **No premature structure:** a concept doesn't need its own columns — a
  title, optional provenance in `properties`, and edges are enough (mirrors
  event's "date/location in properties, not columns" decision).
- **Prod DDL only through the repo flow** (the runbook's golden rule) — this
  ADR and its migration are precisely the repair PR #200 and the ad-hoc
  `apply_migration` call should have been from the start.

## Considered options

### Option A — `concept` as a twelfth `entity_type` (chosen)

Add `concept` to the CHECK, anchored to `skos:Concept`. Concept-specific data
(if any — e.g. an `origin_tag` provenance key) lives in `properties`;
hierarchy and "about" links are edges, reusing what's already adopted.

- **Pros:** Minimal, additive (one CHECK change + a partial GIN index,
  mirroring the place/event/people/project pattern). Concepts become
  first-class graph nodes immediately — every entity tool works on them
  unchanged, no new edge type, no new columns. `skos:Concept` is a
  widely-understood, exact-match external class — anchoring to it costs
  nothing and buys interoperability for free.
- **Cons:** Grows the controlled entity-type set again (now "PARAMPS +
  event + organization + signal + place + concept", 12 types); the
  vocab/CHECK must stay in sync (already true for all types added since
  migration 049).

### Option B — keep topics as `resource` with a tag/subtype marker (status quo, close #209 as "no")

- **Pros:** No schema change; PARA already treats topics as a kind of
  Resource; avoids growing the entity-type set further.
- **Cons:** This is exactly the pre-incident status quo the #171 audit
  flagged as a gap — topics stay second-class, can't be filtered as their
  own type, and overload `resource`'s meaning (an area/reading-list
  resource and a topic/subject are conceptually different things). Would
  also mean discarding the 7 already-identified concept candidates back
  into undifferentiated resources rather than reviving them.

### Option C — model concepts purely as freeform `tags` (no entity nodes at all)

- **Pros:** Zero schema change; tags already exist and are cheap to write.
- **Cons:** Tags aren't graph nodes — they can't hold their own properties,
  can't be the target of a `broader`/`narrower` hierarchy edge, and can't be
  queried as "all things about topic X" without a full-text scan. This is
  the exact limitation #200's author hit that motivated the ad-hoc write in
  the first place. (Freeform tags are **retained** alongside concepts as a
  coexisting fast-capture layer — promotion to a concept entity is lazy, not
  forced, matching #200's own original design note.)

## Decision

We chose **Option A**. `concept` is added to the `entities.entity_type` CHECK
(migration 065) and to `ENTITY_TYPES` in `packages/mcp-server/src/vocab.ts`.

**SKOS anchoring (adopt-direct per ADR-033):** `concept` maps directly to
`skos:Concept` — no `ahos:` proxy, no `skos:closeMatch` hedge. Per the
adopt-direct rule, an external term is reused as-is only when its published
semantics exactly match ours; `skos:Concept`'s definition ("a unit of
thought — an idea, meaning, or object/event") is an exact match for "a
topic/subject node in the graph," so it clears that bar the same way
`event` → conceptually maps to a dated-happening node and `place` → a
location node did (though neither of those was anchored to a named external
class in code before now — `concept` is the first entity type to get an
explicit machine-readable class mapping, `ENTITY_TYPE_CLASS_CONTEXT`, in
`vocab.ts`).

**No new edge types.** Concepts reuse:

- the existing SKOS `broader`/`narrower` hierarchy predicates (adopted for
  the Areas tree in #195/#232) for concept-to-concept hierarchy (a topic
  under a broader topic);
- the existing `about` edge (`schema:about`, adopted in #192) for
  artifact/entity → concept links (a captured note is `about` a concept, the
  same shape people/orgs are `about` other entities today).

**Property convention** for concept entities (in `properties`, open-vocab,
no enforced schema — mirrors event's `date`/`location` convention): an
optional `origin_tag` (or similar) preserving where a promoted freeform tag
came from, for traceability. Nothing is required.

## Consequences

- **Schema:** migration 065 swaps the CHECK to include `concept` and adds a
  partial GIN index `idx_entities_concept_properties`, exact pattern of
  migrations 054/063.
- **Vocab:** `ENTITY_TYPES` (mcp-server) and `GraphEntityType` (shared) both
  include `concept`; `ENTITY_TYPE_CLASS_CONTEXT` (mcp-server) records the
  `concept -> skos:Concept` mapping as queryable data, not just a comment.
- **Web:** the generic entity detail page and relationship-graph node
  palette render `concept` (icon, label, badge colour), same as every other
  graph-only type.
- **Supersedes PR #200:** #200's migration (`003_add_concept_entity_type.sql`)
  is not used — it was mis-numbered against the repo's real sequence and
  authored pre-remediation. This ADR and migration 065 are the properly
  reviewed, repo-flow replacement.
- **Post-merge data revive (out of scope for this migration):** the 7 rows
  remediated to `resource` with `properties.original_entity_type = 'concept'`
  are revived by the orchestrator via MCP `execute_sql` (DML, not DDL) after
  this PR merges and `supabase db push` runs:

  ```sql
  UPDATE entities SET entity_type = 'concept'
  WHERE entity_type = 'resource'
    AND properties->>'original_entity_type' = 'concept';
  ```

- **Out of scope (future):** a dedicated `/concepts` listing page or CRUD
  view — `concept` stays a graph-only type (no dedicated Postgres view),
  same as event/organization/signal/place. Lazy tag→concept promotion
  tooling (deciding *when* a freeform tag graduates to a concept entity) is
  also not built here; #200's "promotion is lazy, not forced" note still
  holds as a design intent, not an implemented mechanism.

## Links

- Issue: [#209](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/209)
  (the product decision this ADR executes) — supersedes
  [#200](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/200)
- Runbook: [`docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md`](../guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md)
  — documents the 2026-07-05 concept incident this ADR resolves properly
- [ADR-025](./ADR025_Event_Entity_Type.md) — same-shaped precedent: `event`
  (+ `organization`, `signal`) added to the entity-type CHECK, additive,
  properties-not-columns convention
- [ADR-033](./ADR033_External_Vocabulary_Adoption.md) — the adopt-direct vs.
  mint-and-`closeMatch` rule this ADR applies to `concept -> skos:Concept`
- Migration: `supabase/migrations/20260707120000_065_add_concept_entity_type.sql`
- Vocab: `packages/mcp-server/src/vocab.ts` (`ENTITY_TYPES`,
  `ENTITY_TYPE_CLASS_CONTEXT`)
