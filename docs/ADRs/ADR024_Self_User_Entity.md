# ADR024: Self/User Entity

- **Status:** Accepted
- **Created:** 2026-06-27
- **Accepted-on-dev:** 2026-06-28
- **Deciders:** Angus

## Context and problem

The knowledge graph (`entities` + `entity_relationships`) had no first-class
representation of the owner. Two capture examples that drove the
`process_artifact` skill —
[`docs/sessions/2026-06-27-capture-entity-extraction-walkthrough.md`](../sessions/2026-06-27-capture-entity-extraction-walkthrough.md)
— both depend on one:

- "Laura Sharp **Fiancée**" is a relationship *to the user*. Without a self
  entity there is no node for the `engaged_to` edge to point from.
- An inbound email greets "Laura and **Angus**". Recognising that this "Angus" is
  the owner (and not creating a duplicate person) requires identity matching
  against the owner.

The interim workaround in `process_artifact` stored owner-relationships on the
`people.relationship` scalar and resolved the owner ad-hoc by name/email. That
works for one-hop "to me" facts but can't express the owner as a graph node, and
re-derives the owner on every run. We want to lock the model in.

## Decision drivers

- **Additive, not re-architecture** (vision §load-bearing): extend the substrate,
  don't reshape it.
- **Uniform model:** the owner should behave like any other graph node so existing
  tools (`relate_entities`, `entity_neighbourhood`, `artifact_entity_link_*`) work
  on it unchanged.
- **Cheap, unambiguous resolution:** exactly one self entity per user, found in
  O(1), surviving renames.
- **Dedupe references to the owner** by a strong signal (email), with a name
  fallback.
- **No personal data in migrations / shared skills.**

## Considered options

### Option A — `people` entity + pointer (chosen)

The owner is an ordinary `entity_type='people'` entity, marked
`properties.is_self=true`, and pointed to by a typed `self_entity_id` FK on
`user_preferences`. Owner identity (emails + display name) lives in a
`user_preferences.identity` jsonb. A `get_self_entity` tool resolves-or-creates it
and caches the pointer.

- **Pros:** Most additive (no change to the `entities` shape beyond a jsonb flag
  it already supports). Uniform — self is just a person, so every graph tool works
  on it. O(1) via the pointer; self-identifying via `is_self` if queried directly.
  Referential integrity via the FK (`ON DELETE SET NULL`).
- **Cons:** Two sources of "is this self" (pointer + flag) must be kept
  consistent; the tool owns that.

### Option B — dedicated `is_self` column on `entities`

Add an `is_self boolean` column with a partial unique index (one true per user).

- **Pros:** Explicit; DB-enforced single self.
- **Cons:** Schema change on the hot `entities` table; less uniform; the column is
  dead weight for the 99.99% of entities that aren't the owner.

### Option C — pointer only (no entity marker)

Only `user_preferences.self_entity_id`; nothing on the entity.

- **Pros:** Simplest.
- **Cons:** The entity isn't self-identifying when traversing the graph directly
  (e.g. `entity_neighbourhood` output), so consumers must always join back to
  preferences.

## Decision

We chose **Option A**. The owner is a `people` entity (`properties.is_self=true`),
pointed to by `user_preferences.self_entity_id`, with owner identity in
`user_preferences.identity` (`{ emails, display_name }`). Resolution order in
`get_self_entity`: cached pointer → `is_self` flag → identity email → display name
→ create. Owner-relationships become real edges from the self entity (e.g.
`self -[engaged_to]-> Laura`); the `people.relationship` scalar is retained as a
denormalised convenience, not the source of truth.

Identity is **not** seeded in the migration (no personal data in migrations); it
is supplied at runtime via `get_self_entity` args or `update_user_preferences`.

## Consequences

- **Schema:** migration 053 adds `user_preferences.self_entity_id` (FK →
  `entities`, `ON DELETE SET NULL`) and `user_preferences.identity` (jsonb).
- **Tooling:** new `get_self_entity` MCP tool (resolve-or-create, idempotent).
- **Skill:** `process_artifact` Setup calls `get_self_entity`; owner-relationships
  are edges from the self id. The self/user-entity item is removed from that
  skill's stub list.
- **Dedupe:** references to the owner match by email first (covers multiple
  addresses), then name — so "Angus" + `owner@example.com` resolves to self,
  not a new person.
- **Follow-ups (separate decisions):** the remaining `process_artifact` stubs —
  `event` entity type, the overloaded `consumed_by_state` marker, and
  `surface`/trust fields — are still open.

## References

- Session note: [`2026-06-27-capture-entity-extraction-walkthrough.md`](../sessions/2026-06-27-capture-entity-extraction-walkthrough.md)
- Skill: `.claude/skills/process_artifact/SKILL.md`
- Migration: `supabase/migrations/20260627120000_053_add_self_entity_to_user_preferences.sql`
- Builds on ADR-018 (synthesis-time interpretation) and the open vocab in
  `packages/mcp-server/src/vocab.ts`.
