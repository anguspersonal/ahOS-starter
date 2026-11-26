# ADR-049: PARA containment — primary `belongs_to` edge + secondary `associated_with` edge

- **Status:** Accepted
- **Created:** 2026-08-05
- **Accepted-on-dev:** 2026-08-05
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, graph, para, relationships, provenance
- **Builds on:** ADR-021 (FOAF relationship vocabulary), ADR-035 (relationship reification / collision-at-2 posture)
- **Resolves:** #170 (PARA primary/secondary containment) — design half; the live-data
  backfill remains an open operator step tracked on #170

---

## Context and problem

PARA (Projects/Areas/Resources/Archives) filing needs every project and resource to
have a well-defined home for roll-up and counting ("show everything under
Business"), while still allowing an entity to *relate* to more than one area
conceptually (e.g. `Work AI` touches Business, Technology, and Work). A single
unqualified containment edge can't express both needs at once: counted-once and
related-to-many are in tension.

Issue #170's decision comment (2026-07-17) settled the shape:

- **One primary area** per project/resource — reserved for roll-ups and counting;
  traversal for "show everything under X" uses primary edges only, so nothing is
  double-counted.
- **Zero or more secondary (associated) areas** — for conceptual linking, never
  counted in roll-ups.

The comment explicitly left the *representation* of "secondary" open: "recommend a
new `associated_with` edge type in `EDGE_TYPES` (or a `metadata.role: "secondary"`
flag on `belongs_to`); impl detail for the ADR/agent, not a human decision." This
ADR records that implementation decision and the enforcement semantics built on top
of it, shipped in PR #548. **This ADR is written after the code merged** (per the
round-1 QA review on #548, which flagged that the decision lived only in the #170
issue thread and the PR body, not in `docs/ADRs/` per this repo's own convention)
— it records a decision already made and shipped, not new design.

## Decision drivers

- **Roll-up/count correctness by construction.** Every existing roll-up/count path
  already filters `relationship_type = 'belongs_to'`; whatever "secondary" turns
  out to be must not require those readers to change to stay correct.
- **`relate_entities` replaces `metadata` wholesale on update**
  (`metadata: args.metadata ?? {}`) — any representation that lived in `metadata`
  would be silently erased by a caller that omits it on a later write.
- **Migration-062's `UNIQUE(user_id, from_entity_id, to_entity_id, relationship_type)`
  key** allows one entity pair to carry both a primary and a secondary edge
  simultaneously — needed when a primary is re-pointed away but the old area
  should stay associated.
- **Consistency with ADR-035's collision-at-2 posture:** refuse a destructive
  ambiguity with an actionable error unless the caller explicitly opts in, rather
  than silently re-pointing.
- **No new migration:** `relationship_type` has been an open vocabulary since
  migration 049, so the representation should live in vocab + app-layer code only.

## Considered options

### Option A — `metadata.role: "secondary"` flag on `belongs_to`

- **Pros:** No new vocabulary term; stays a single edge type.
- **Cons:** Every roll-up/count reader (present and future) would have to learn to
  also check `metadata.role`, or silently over-count — exactly the class of drift
  bug the flag-free design avoids. `relate_entities`' wholesale `metadata`
  replacement on update means a role flag can be erased by any re-assert that
  omits it — a silent primary↔secondary flip with no signal. The unique key can't
  distinguish two edges on the same pair that differ only by a metadata flag, so a
  pair can't cleanly hold both a primary and a secondary relationship at once.

### Option B — `associated_with` as a distinct edge type (chosen)

- **Pros:** Type-filtered queries stay correct by construction — the existing
  `belongs_to`-only filters already exclude it, with no reader changes needed.
  Can't be flipped by a metadata omission. Migration-062's unique key permits one
  pair to carry both a primary `belongs_to` and a secondary `associated_with`
  edge, which the repoint-while-keeping-associated case needs. No schema change:
  `relationship_type` is open vocabulary since migration 049.
- **Cons:** A new ahkms-only vocabulary term to maintain — no external `@context`
  mapping is claimed for it (schema.org has no generic Thing↔Thing association
  property, and `skos:related` is scoped to `skos:Concept`).

## Decision

We chose **Option B: `associated_with` as a real `EDGE_TYPES` member**
(`packages/mcp-server/src/vocab.ts`), exposed through `relate_entities` like any
other vocabulary term, with no cardinality guard — zero or more per entity, never
counted by roll-up/count traversal.

**Single-parent enforcement (primary only):** when a second primary `belongs_to`
is asserted from a `project`/`resource` source toward a **different** target,
`relate_entities` (`packages/mcp-server/src/tools/relateEntities.ts`):

- **Rejects by default**, with an actionable error naming the current primary and
  the two sanctioned alternatives (`associated_with` for a secondary link,
  `overwrite: true` to re-point) — the same refuse-unless-opt-in posture ADR-035
  already established for collision-at-2.
- **Re-points under `overwrite: true`** — the old primary edge is **archived**
  (soft-deleted, the same treatment the merge-repoint code already uses), never
  hard-deleted, before the new edge is written.
- Re-asserting the **same** parent is a plain dedup update, never a violation;
  `archive: true` skips the guard (removing an edge can't create a second parent).

**Scope:** the guard applies only to `project`/`resource` **source** entities —
the Areas tree uses SKOS `broader`/`narrower` (#195), and other entity types'
`belongs_to` writes carry no PARA roll-up semantics. This enforces single
*parent*, not containment presence: a missing parent stays advisory-only (a
`missing_containment` recommendation), per the 2026-07-05 settled rule that PARA
containment is never hard-enforced by a DB constraint or a write-time block.

**Forward maintenance:**

- **Extraction** (`proposeContainmentEdge`, worker): before writing a resolved
  parent, checks for an existing live primary; if one exists pointing elsewhere,
  the newly resolved parent is emitted as `associated_with` (demote-to-secondary)
  instead of a second primary — including in the below-threshold
  `relationship_suggested` payload.
- **Merges** (`repointRelationshipEdges`, worker `resume.ts`): when the winner
  (a project/resource) inherits a loser's `belongs_to` out-edge and the winner
  already has a live primary pointing elsewhere, the inherited edge is demoted to
  `associated_with` — the winner's own filing choice always wins, and merges can
  no longer silently mint a second primary.

## Consequences

- **Good:** Roll-up/count queries stay correct without any reader-side changes.
  Destructive re-pointing is explicit (`overwrite: true`) and reversible (archive,
  never hard-delete). One entity pair can hold both a primary and a secondary
  relationship simultaneously without a unique-key collision.
- **Cost / bad:** `associated_with` is an ahkms-only term with no external
  vocabulary mapping. The primary-count guard is a SELECT-then-WRITE with no
  transaction/row lock — a TOCTOU window exists between the count check and the
  archive/insert. This mirrors the pre-existing ADR-035 collision-at-2 pattern in
  the same file, already accepted for this single-user, effectively-serial-request
  architecture; not a new risk class.
- **Follow-up:** the live-data backfill of existing entities (assigning primary
  areas to the 7 orphaned resources identified in #170's 2026-07-09 enumeration,
  and adding `associated_with` links for Work AI's Technology/Work
  co-occurrence) is a heuristic write to prod data, deliberately **not** done in
  this ADR or in #548 — it stays an explicit operator go/no-go tracked on #170.

## Links

- Related: [ADR-035](./ADR035_Relationship_Reification.md) (collision-at-2 refuse-
  unless-opt-in posture, reused here for the primary-parent guard)
- Related: [ADR-021](./ADR021_FOAF_Relationship_Vocabulary.md) (`EDGE_TYPES` /
  `SYSTEM_RELATIONSHIP_TYPES` pass-through the guard's edges route through)
- Issue: #170 (decision thread; decision comment 2026-07-17)
- PR: #548 (implementation this ADR documents)
