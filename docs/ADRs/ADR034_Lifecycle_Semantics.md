# ADR034: Soft-Delete / Lifecycle Contract Across the Knowledge Substrate

- **Status:** Accepted
- **Created:** 2026-07-07
- **Accepted-on-dev:** 2026-07-08
- **Deciders:** Angus

## Context and problem

Delete/lifecycle affordances grew **inconsistently** across the knowledge
substrate. Issue #125 named the symptom: `entities_delete` and `people_delete`
existed, but artifacts had no delete path at all — only `artifact_update`
(relabel) and `drive_trash` (a Drive file, not the captured note). Relationships
(`entity_relationships`) had neither a delete path nor the columns to support
one. There was no shared contract for what "delete" meant — hard row removal,
reversible soft-delete, or a lifecycle stage — so each type risked drifting to
its own answer.

Three PRs closed the gap piecemeal:

- **#248** — `artifact_delete` tool (soft-archive default, hard opt-in).
- **#269** — closed the remaining `search_knowledge` / `entity_neighbourhood`
  / `enrich_next` read-path gaps that let archived artifacts leak into results
  or keep consuming enrichment budget.
- **#268** — brought `entity_relationships` to lifecycle parity (`archived`,
  `valid_from`/`valid_to`, `updated_at`), refs #175 (the ontology-gaps audit
  that first named the missing columns).

This ADR is **descriptive**: it records the contract those PRs converged on,
so it survives as a documented convention rather than an implicit pattern
future work has to reverse-engineer from `git blame`.

## Decision drivers

- **One vocabulary for "delete"** across artifacts, entities/people, and
  relationships — new lifecycle-affecting code should extend this contract,
  not invent a fourth shape.
- **Reversible by default.** A mistaken capture or a wrong edge should be
  retractable without being destroyed.
- **Uniform read-side honoring.** Search and traversal must not surface
  something the user just retracted, regardless of which table it lives in.
- **Destructive-by-exception.** Hard, irreversible deletes require an explicit
  opt-in and are not the default anywhere.

## Considered options

### Option A — Hard delete only

- **Pros:** Simple; no `archived` filtering needed anywhere.
- **Cons:** No undo for a mistaken capture or a bad edge; breaks referential
  history (an artifact cited in a synthesis note vanishing outright). Rejected
  implicitly — every `*_delete` tool in this codebase defaults to soft.

### Option B — Soft-delete flag, but reads see everything by default

- **Pros:** Nothing to filter; simplest read path.
- **Cons:** Defeats the point of "retract this thing I created" — a
  soft-deleted artifact would still show up in `search_knowledge` results.
  This was the exact bug #269 closed (three read paths were missing the
  filter). Rejected.

### Option C — `archived`(+`archived_at`) soft-delete, default-excluded on
reads, explicit `include_archived` opt-in, hard-delete as a separate opt-in
flag on the same tool (chosen)

- **Pros:** Reversible by default; matches the "trash, not delete" mental
  model already used for `drive_trash`; one tool per resource handles both
  paths instead of splitting soft/hard into separate tools; a single
  `include_archived` convention reads consistently across every query-shaped
  tool.
- **Cons:** Requires every new read path touching these tables to remember
  the `archived = false` filter — a convention enforced by review, not by the
  type system. (#269 exists precisely because this was missed in three
  places.)

## Decision

We use one contract, instantiated per table where its physical shape allows:

**Soft-delete is the default and reversible.** `*_delete` tools take an
`archive_only` flag defaulting to `true` — the safe path sets `archived` (and
a timestamp) rather than removing the row. Restore is symmetric: setting
`archived: false` on the corresponding `*_update` tool un-archives the row
(`artifact_update`, `entities_update`/`people_update`). There is no separate
`restore=true` flag — restoring is just another update.

**Reads default-exclude archived rows, with an explicit opt-in.**
`search_knowledge`, `entities_query`, `people_query`, and `entity_neighbourhood`
all filter `archived = false` unless the caller passes `include_archived: true`
(or, for `entity_neighbourhood`'s edge traversal, `include_archived_edges`).
Point lookups by id — `get_artifact`, `entities_get`, `people_get` — are the
one deliberate asymmetry: they do **not** filter `archived`, so a caller can
still inspect something they just soft-deleted. This is existing, established
precedent (not a gap) and applies uniformly to all three point-lookup tools.

**The per-table shape is not identical** — `people` is not an independent
table, and `entity_relationships` is missing one column other tables have:

| Table | Physical shape | `archived` | `archived_at` | `archived_reason` | Delete tool | Hard delete | Restore |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `artifacts` | own table | column | column | column | `artifact_delete` | opt-in (`archive_only: false`) — cascades to `artifact_entity_links`/`artifact_external_links` via `ON DELETE CASCADE` | `artifact_update({archived: false})` |
| `entities` | own table | column | column | **none** (no column, no tool field) | `entities_delete` | opt-in (`archive_only: false`) | `entities_update({archived: false})` |
| `people` | **view** — `entities WHERE entity_type = 'people'`; `people_delete`/`people_update` write through to `entities` | column (inherited) | column (inherited) | **none** | `people_delete` | opt-in (`archive_only: false`) | `people_update({archived: false})` |
| `entity_relationships` | own table | column (added migration 068 / #268) | **none** — has `updated_at` instead | **none** | **no dedicated delete tool** — `relate_entities({archive: true})` archives the matched edge; re-relating an archived `(from, to, type)` triple resurrects it (`archived: false`) rather than erroring or duplicating | **not possible** — no code path issues `.delete()` on this table | `relate_entities` on the same triple (implicit — no separate restore call) |

Column-origin note: `artifacts.archived`/`archived_at`/`archived_reason` and
`entities.archived`/`archived_at` are baked into the `remote_schema.sql`
baseline (predates the tracked migration sequence); `entities`/`people` never
had an `archived_reason` column added, and no MCP tool field writes one for
them. `entity_relationships` gained `archived`/`updated_at`/`valid_from`/
`valid_to` via migration `20260707150000_068_relationship_temporal_lifecycle.sql`
(PR #268, refs #175) — additive, no `archived_reason`.

**Cascade.** `artifact_entity_links` has `ON DELETE CASCADE` on both
`artifact_id → artifacts(id)` and `entity_id → entities(id)` (defined in the
`remote_schema.sql` baseline). This only fires on a **hard** delete — a soft
delete leaves link rows in place, which is the point: the link survives so a
restored artifact/entity comes back fully connected.

**Hard-delete policy.** Hard (physical row) delete is possible only for
`artifacts`, `entities`, and `people` (the `people` view's hard-delete is
really a hard-delete on `entities` scoped to `entity_type = 'people'`), each
gated behind an explicit `archive_only: false` on the resource's `*_delete`
tool — never the default. `entity_relationships` has no hard-delete path at
all in the MCP tool layer; the only lifecycle-affecting operation on an edge
is archive/resurrect via `relate_entities`.

## Consequences

- **Good:** one mental model — soft-delete reversible by default, reads
  exclude archived unless asked, hard delete is an explicit, documented
  opt-in — applies across every knowledge type. A caller who knows
  `entities_delete` already knows the shape of `artifact_delete` and
  `people_delete`.
- **Good:** the FK cascade on `artifact_entity_links` means a hard delete
  never orphans link rows; a soft delete never touches them, so restore is
  always a full restore.
- **Cost / known asymmetry:** `entity_relationships` is soft-only by
  construction (no `.delete()` code path exists), and lacks `archived_reason`
  — an edge's archive reason cannot be recorded, unlike an artifact's. This is
  accurate to the current implementation, not an oversight to silently
  "fix" by adding a column nobody has asked for.
- **Cost / known asymmetry:** `entities`/`people` also lack `archived_reason`
  entirely (no column, no tool field) — only `artifacts` records *why* something
  was archived. A future ADR or issue should decide whether to extend
  `archived_reason` to entities/people/relationships or leave it
  artifact-specific.
- **Cost / dead code:** `packages/mcp-server/src/tools/entityRelationships.ts`
  (a full CRUD file with its own `archive_only`/`include_archived` logic) is
  not registered in `server.ts` — only `relate_entities` and
  `entity_neighbourhood` are live. It was kept in sync with the migration-068
  columns for correctness but is unreachable via any MCP tool call. Flagged in
  #268 for a follow-up register-or-delete decision, not resolved by this ADR.
  Similarly, `linkArtifactEntity.ts` is unregistered dead code (the live
  equivalents are `artifact_entity_link_create`/`_upsert`).
- **Follow-up / residual gap (#280):** `enrich_next`'s textual-connector path
  stores `plain_text` directly and skips `embedAndStore`, so enriched textual
  pointers are FTS-searchable but not semantically retrievable until
  re-embedded. This is independent of archive status — it affects fresh,
  non-archived artifacts too — but it means the "excluded when archived,
  included otherwise" read-side contract this ADR documents is not yet backed
  by complete embedding coverage on every artifact it applies to.
- **Follow-up / open judgment calls, not yet decided:** `discover.ts`'s
  re-discovery idempotency lookup does not filter `archived`, so
  re-discovering an externally-sourced id that was previously soft-deleted
  refreshes its metadata in place without touching `archived` — not obviously
  wrong, but not an explicit choice either (flagged in #269, undecided).
  `packages/worker`'s synthesis consumers that read `artifacts` directly
  (bypassing `search_knowledge`) have not been audited for the same
  `archived = false` treatment (blocked on #207).

## Links

- Closes the contract requested by #125.
- Implements: #248 (`artifact_delete`), #269 (search/neighbourhood/enrich_next
  read-path gaps), #268 (`entity_relationships` lifecycle columns, refs #175).
- Residual gaps cited above: #280 (embedding coverage), #269's open
  `discover.ts` and worker-consumer follow-ups.
