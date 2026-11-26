# ADR025: New entity types — event (+ organization, signal)

- **Status:** Accepted
- **Created:** 2026-06-27
- **Accepted-on-dev:** 2026-06-28
- **Deciders:** Angus

## Context and problem

`entities.entity_type` was guarded by a DB CHECK to the PARAMPS set
(`project`, `area`, `resource`, `memory`, `people`, `secure`, `archive`). Dated
happenings — a wedding, a meeting — had no native type, so the
`process_artifact` skill stubbed them as `resource`
([session note](../sessions/2026-06-27-capture-entity-extraction-walkthrough.md),
Example 2: "wedding — 16 Nov"). That loses the thing that makes an event an
event: it has a date, attendees, and a place, and people relate to it
(`attended`, `met_at`).

## Decision drivers

- **Additive** (vision §load-bearing): extend the ontology, don't reshape it.
- **Uniform graph:** events should be nodes so existing edges work
  (`person -[attended]-> event`, `event -[located_at]-> place`).
- **No premature structure:** event date/location shouldn't force new columns.
- The two capture examples are the acceptance test — Example 2 needs a real
  event node.

## Considered options

### Option A — `event` as an eighth `entity_type` (chosen)

Add `event` to the CHECK. Event-specific data lives in the existing `properties`
jsonb; attendance/place are edges.

- **Pros:** Minimal, additive (one CHECK change + a partial GIN index mirroring
  the people/project/resource pattern). Events become first-class graph nodes;
  every entity tool works on them unchanged. No new columns.
- **Cons:** Grows the controlled PARAMPS set (now "PARAMPS + event"); the
  vocab/CHECK must stay in sync (already true for all types).

### Option B — events live only in the calendar (Google Calendar), not the graph

- **Pros:** No ontology change; calendar is the natural home for scheduling.
- **Cons:** Breaks the "one graph" model — an event mentioned in a capture
  couldn't be a node, so `attended`/`met_at` edges and artifact provenance to the
  event would be impossible. Retrieval ("who was at the wedding?") would have to
  span two systems. Calendar sync is still desirable, but as an *integration on
  top of* the entity, not a replacement for it (mirrors task → Notion).

### Option C — model events as `resource` with a subtype tag

- **Pros:** No schema change.
- **Cons:** This is the status-quo stub; events stay second-class, can't be
  filtered as a type, and overload `resource`'s meaning.

## Decision

We chose **Option A**. `event` is added to the `entities.entity_type` CHECK
(migration 054) and to `ENTITY_TYPES` in `packages/mcp-server/src/vocab.ts`.

**Property convention** for event entities (in `properties`):

- Single day: `{ "date": "YYYY-MM-DD" }`.
- Range / timed: `{ "start": "<ISO>", "end": "<ISO>" }`.
- Optional: `{ "location": "<text>" }` (or an `event -[located_at]-> place`
  edge when the place is itself an entity worth tracking).

**Relationships:** attendance is `person -[attended]-> event`; a chance meeting
is `person -[met_at]-> event` (both already in the edge vocab).

## Also admitted in migration 054: `organization` and `signal`

Applying the CHECK against the live store surfaced two `entity_type` values that
already existed (the column was unguarded for a window, so rows accreted):

- **`organization`** — real org nodes (a venue, the owner's company). Not stray
  data: the edge vocab (`employed_by`, `member_of`, `vendor_for`, `client_of`)
  presupposes organization nodes, so this was a genuine ontology gap. Spelling
  matches the stored rows (`organization`, not `organisation`).
- **`signal`** — a derived, uncertain inference projected from an artifact (e.g. a
  tentative scheduling read), with confidence carried in `properties`.

Both are folded into the same CHECK rather than deferred, because the constraint
can't be enforced while non-conforming rows exist. The set is now **PARAMPS +
`event` + `organization` + `signal`** (10 types), kept in sync in `vocab.ts`.

## Consequences

- **Schema:** migration 054 swaps the CHECK to include `event`, `organization`,
  and `signal`, and adds a partial GIN index `idx_entities_event_properties`.
- **Vocab:** `ENTITY_TYPES` now includes `event`, so `entity_neighbourhood` can
  filter by it and `entities_upsert`/`get_self_entity` validate it.
- **Skill:** `process_artifact` creates events as `entity_type='event'` with the
  property convention above; `event` is removed from its stub list.
- **Delivered:** syncing to Google Calendar — the same shape as `create_task` →
  Notion, built as a native `create_event` MCP tool. See
  [#126](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/126) and
  [ADR-038 §6](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md).

## References

- Session note: [`2026-06-27-capture-entity-extraction-walkthrough.md`](../sessions/2026-06-27-capture-entity-extraction-walkthrough.md)
- Migration: `supabase/migrations/20260627130000_054_add_event_entity_type.sql`
- Vocab: `packages/mcp-server/src/vocab.ts`
- Skill: `.claude/skills/process_artifact/SKILL.md`
- Follows ADR-024 (self/user entity) in the same capture→entity-extraction line.
