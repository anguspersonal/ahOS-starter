# ADR035: Relationship reification — reify n-ary/repeated facts into `arrangement` nodes, promote-on-demand

- **Status:** Accepted
- **Created:** 2026-07-12
- **Accepted-on-dev:** 2026-07-12
- **Deciders:** Angus Hally

## Context and problem

A binary `A —relationship_type→ B` edge — one entity, one parent, one label — is
too thin to model how real entities relate. Two cases from the #170 resource
backfill (2026-07-09) forced the question ([#311](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/311)):

- **N-ary + temporal (the Octopus case):** *"Octopus supplied **gas** at **Address B**
  from **2025–2027**"* is a 4-way fact — supplier × utility × place × interval. A
  two-ended edge holds none of it; home and supplier both change independently, and
  coverage can split (gas vs. electricity across suppliers).
- **Multiplicity (the employment case):** *"PM at Acme 2018–2019, then Senior PM
  2019–2023"* is two employment facts between the same pair. The `entity_relationships`
  `UNIQUE (user_id, from_entity_id, to_entity_id, relationship_type)` constraint
  (migration 062) forbids two matching `employed_at` edges — the second write collides
  and `relateEntities.ts` dedup **overwrites the first's dates**.

Reused, not rebuilt: temporal validity (`valid_from`/`valid_to` + `archived`, migration
068 / #175), `place` as a first-class entity type (migration 063 / #188), and multiple
typed edges per node (the role/perspective "ChatGPT" case). The gap is n-ary and
repeated facts. This ADR **reframes #170**: single-parent containment is right for
projects (one PARA home), wrong as the sole model for cross-cutting resources.

The framing question — *"should relationships be first-class entities?"* — is the wrong
altitude. The answer is to reify *specific facts*, not the edge table.

## Decision drivers

- **Keep the ego-centric binary graph as the default.** Do not promote the edge table
  to nodes / a triple store — that is [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md)
  Option C, already rejected (a second graph semantics to run).
- **Capture-first, refine-later** — soft validation, no hard gate (ADR-021 / ADR-018).
- **No data loss** — a modelling choice must never silently drop a fact.
- **Traversable & queryable** — the whole point of reifying is that participants become
  real, walkable edges, not opaque JSONB.
- **Additive, reversible, single-user-appropriate** — reuse shipped columns; one CHECK
  migration; no big-bang backfill.

## Considered options

### Option A — Edge attributes only (fat `metadata` JSONB)

Store the extra participants as values on one binary edge, e.g. `Octopus —supplied→ Angus`
with `metadata: { utility, address_id, valid_from, valid_to }`.

- **Pros:** zero new types; works today.
- **Cons:** **semi-lossy** — extra participants sit in JSONB as opaque values, not
  traversable/joinable edges ("who supplied gas at Address B?" can't be a graph query).
  Cannot represent multiplicity at all (UNIQUE collision → data loss).

### Option B — Reify everything (relationships as first-class entities / triple store)

Every edge becomes a node; edges-on-edges.

- **Cons:** taxes every trivial 2-entity fact with a junction node forever; re-opens
  ADR-021 Option C (RDF/triple-store complexity). Rejected.

### Option C — Selective reification into a generic `arrangement` node (chosen)

Binary edges stay the default; a fact is promoted to its own node only when a trigger
forces it; the node is a generic `arrangement` type; participants attach as per-role
edges.

- **Pros:** default stays simple and cheap; n-ary/temporal/repeated facts become
  first-class and queryable; no data loss; additive.
- **Cons:** promotion is a real operation to build (esp. the 1→N split); a mix of
  edge-facts and node-facts within the graph (mitigated by reify-by-category).

## Decision

We adopt **Option C — selective, promote-on-demand reification**, with the following
contract.

### 1. Default: binary edges

A fact stays a binary `entity_relationships` edge (with `valid_from`/`valid_to` +
`metadata`) until a trigger fires. A plain two-entity fact with a time window is **not**
odd-shaped and never reifies.

### 2. The `arrangement` entity type (one generic type)

Add `arrangement` to `ENTITY_TYPES` (one CHECK migration). Kind lives in
`properties.kind` (`employment` | `supply` | `tenancy` | …), **open-vocab** in properties
per ADR-021 soft validation — new kinds need no migration. Consequence: **"category"
(for reify-by-category and the accumulation threshold) keys on `properties.kind`, not
`entity_type`.** Accepted cost: type-level queries filter a JSONB `kind` rather than a
crisp `entity_type`.

### 3. Reification triggers (when a fact is promoted)

| Trigger | Timing | Rationale |
| --- | --- | --- |
| **Query-driven** | immediate | A value must be queried *across* the label → promote now. |
| **Collision-driven** | immediate, at instance **2** | A 2nd same-`type` edge between the same pair is **data-loss, not mess** — the 2nd write overwrites the 1st (UNIQUE dedup). Promote before the collision. |
| **Accumulation-driven** | soft, per-`kind`, threshold **3** | 3 odd-shaped facts of a kind accumulate → the system **suggests** promotion (human/agent confirms; never automatic). |
| **A lone odd fact** | tolerated | Stays an edge + `metadata`. No promotion. |

"Odd-shaped fact" = an n-ary fact (≥3 real entities) **or** a same-type repeat within a
kind. The lone-fact toleration is a deliberate, capture-first trade: a single n-ary fact
limps along as an edge + fat metadata, **semi-lossy** (extra participants not traversable)
until a trigger fires.

### 4. Reify by category, not by instance

The moment *any* instance of a `kind` needs a node, migrate *all* instances of that kind
to nodes. The graph is mixed *across* kinds but uniform *within* each — so per-kind
queries ("list all my jobs") always have one shape. The accumulation counter is per-kind.

### 5. Participant edges: per-role, arrangement as hub

When a fact reifies, the single edge becomes a hub node + one edge per participant, named
**per-role** (not a generic `has_participant`): a generic edge would push the role back
into a qualifier, recreating the JSONB lossiness reification exists to escape. Edges point
**out** from the arrangement to each participant. Seed vocabulary (net-new `EDGE_TYPES`,
open-vocab):

- employment → `employer`, `employee`
- supply → `supplier`, `customer`, `at_place`, `of_utility`

### 6. The `promote_edge_to_node` operation

A provenance-preserving operation (MCP tool). Steps: (1) create the `arrangement` node;
(2) move the edge's labels/dates onto it; (3) attach per-role edges to each participant;
(4) archive the original edge (soft-delete, migration 068 — history retained).

**1→N split** (the ugly case, employment): one edge → two job-nodes. The originating
capture's provenance links to **both** new nodes (`artifact_entity_links` to each), and
the original edge's date range is **superseded** — the capture that triggers the split
carries the corrected per-node dates (PM 2018–2019, Senior PM 2019–2023). Reifying is
**local and non-cascading**: nothing references an edge (only nodes are addressable), so
promotion touches exactly one edge + its endpoints, no graph-wide ripple.

### 7. Provenance principle

*Entities are what I know; artifacts are how we know them.* Provenance attaches to **nodes**,
not edges (`artifact_entity_links` = artifact↔entity). A fact living as an edge therefore
has only lossy, inferred provenance; **reifying a fact into a node is what gives it
first-class provenance** — an artifact link can finally point at the fact itself.

### 8. Meta-knowledge placement (classification lens only)

Mapped onto ahOS's two-axis model (`docs/architecture/ahOntology.ttl`: `ahos:inBox`
TBox/ABox ⟂ `ahos:level` meta/ontology/instance). All net-new items are **instances of
already-coined metaclasses**, hence **ABox**: the `arrangement` type (`a ahos:Category`)
and the reification rules (`a ahos:Principle`) are `ontology`/**ABox**; `promote_edge_to_node`
(`a ahos:Capability`) is `instance`/**ABox**. Only the coined classes themselves are TBox,
and they pre-exist. Rules live in **this ADR (canonical why) + the design-ontology graph
as thin pointer nodes** (label + ADR ref, matching `p-synth-time → ADR-018 §4`), enabling
`promote_edge_to_node —governed-by→ ReifyByCategory` edges. Making the **runtime** graph
literally self-describing is **out of scope**, fenced to
[#312](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/312).

## Consequences

- **Good:** n-ary, temporal, and repeated facts become representable, traversable, and
  first-class-provenanced; no data loss (collision-at-2); the default graph stays simple;
  reuses shipped columns (068/063); additive (one CHECK migration, no data backfill).
- **Cost / bad:** type-level queries filter JSONB `kind` (mushier than `entity_type`); a
  lone odd fact is semi-lossy until promoted; per-role participant vocabulary grows per
  kind; the `promote_edge_to_node` 1→N split must be built carefully.
- **Follow-up (separate PRs / issues):**
  - Implement: add `arrangement` to `ENTITY_TYPES` + CHECK migration; participant +
    `arrangement_promotion_suggested` vocabulary; build `promote_edge_to_node`.
  - [#312](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/312) —
    runtime metaclass TBox (self-describing entity graph).
  - [#313](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/313) —
    agent graph-maintenance contract (confidence thresholds for the suggestion path).
  - Temporal **as-of read-path**: `valid_from`/`valid_to` are written but never read
    (`entity_neighbourhood` ignores them) — "who was my supplier in 2026?" needs wiring;
    filed as [#315](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/315).
  - [#170](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/170) unblock
    (no schema change): add `substitute_for` / `supplies_inference_to` / `used_by` +
    document a `metadata.lens` convention for the role/perspective case.

## Amendment (2026-08-22, #501): re-asserting an edge merges `metadata`, never replaces it

[#464](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/464) fixed
`relate_entities`' update branch silently clearing `valid_from`/`valid_to` when a
re-assertion omitted them. [#501](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/501)
found the same "omit = clear" shape on the three columns next to them —
`confidence_score: args.confidence ?? null`, `metadata: args.metadata ?? {}`,
`notes: edgeNotes` — so bumping an edge's `confidence` alone was silently
discarding any `metadata` a prior call had recorded, including the
`{ context: 'Matheson Lang Gardens' }` case Option A above uses as the
canonical example of a fact that lives in edge metadata rather than a
reified node.

`confidence_score` preserves on omit the same way `valid_from`/`valid_to` do
(#464's direct analogue: `args.confidence ?? existing.confidence_score ?? null`)
— unambiguous, because a scalar column has exactly one previous value to fall
back to. `metadata` is not a scalar: a re-supplied object raises a real
question preserve-on-omit alone doesn't answer. **Replace** silently drops
sibling keys the caller never mentioned (the same data-loss-by-omission #464
fixed, one level down); a naive **merge** with no way to remove a key makes a
fact permanent the moment it's recorded, when reification is meant to be
additive-with-an-escape-hatch, not append-only.

**Decision:** on the update branch, `entity_relationships.metadata` is written
using **RFC 7386 JSON Merge Patch semantics, one level deep**:

1. Omitting `metadata` entirely leaves the stored object unchanged.
2. Supplying `metadata` merges it into the stored object: keys present in the
   patch overwrite the same key in storage; keys the patch doesn't mention are
   left alone.
3. A key present in the patch with value `null` **deletes** that key from
   storage — the one explicit way to retract something previously recorded in
   metadata, since every other write to this field is additive.
4. One level deep is a deliberate scope, not a partial implementation:
   `entity_relationships.metadata` is documented (see `relate_entities`'s
   `metadata` input schema) as a flat key/value bag, so RFC 7386's recursive
   case for nested object values never applies to it.

`notes` gets its own, narrower rule: the caller's free-text prose is
preserve-on-omit, and the ADR-021 vocabulary note appended to it is re-derived
from the resolved relationship type and re-appended on **every** write — it
documents what the system did with the caller's term, not something the
caller authored, so it was never meant to be caller-erasable. Holding that
for a *recognised* synonym (the romantic subtypes — girlfriend, boyfriend,
situationship, … — are currently the only note-carrying vocabulary) means the
note must survive even a call that itself produces no fresh note of its own —
the caller switched to the canonical term, or to a different synonym for the
same type — which the first cut of this fix (single-suffix string strip)
missed: round-1 QA reproduced a canonical-term re-assertion silently
destroying a previously-recorded note when combined with fresh `notes`. Fixed
by recognising a stored vocab-note segment against the type's bounded synonym
set rather than assuming a fixed string position (`vocabNoteSynonymsForType`
in `@ahkms/shared`). The open-ended `'other'` fallback has **no** bounded set
— its note is the caller's own unrecognised phrase, verbatim — so this
guarantee only extends as far as the vocabulary is closed: re-using the SAME
`'other'`-bucket phrase never duplicates its note, but a call that both
switches to a genuinely different unrecognised phrase and supplies fresh
`notes` can still lose the earlier phrase, the same residual any single
free-text column has without a schema change.

This amendment is about *how* a write lands on the metadata bag once a fact is
there, not about *whether* metadata is the right place for it — Option A's
framing (edge metadata as a semi-lossy home for attributes until a fact earns
reification) stands unchanged.

## Links

- Issue: [#311](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/311)
  (reframes [#170](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/170);
  spawns [#312](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/312),
  [#313](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/313); relates
  [#178](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/178))
- Builds on: [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md) (relationship vocabulary;
  rejects its Option C for the whole graph), [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md)
  (provenance/trust), [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
  (capture-first), [ADR-033](./ADR033_External_Vocabulary_Adoption.md) (vocabulary adoption),
  [ADR-034](./ADR034_Lifecycle_Semantics.md) (soft-delete/archive)
- Design ontology: `docs/architecture/ahOntology.ttl`,
  `docs/sessions/2026-06-15-ahOS-design-ontology.md`
- Runtime vocabulary: `packages/mcp-server/src/vocab.ts` (`ENTITY_TYPES`, `EDGE_TYPES`)
