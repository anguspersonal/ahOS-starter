# ADR026: Rationalised Provenance & Derived Trust

- **Status:** Accepted
- **Created:** 2026-06-27
- **Accepted-on-dev:** 2026-06-28
- **Deciders:** Angus

## Context and problem

The capture examples
([session note](../sessions/2026-06-27-capture-entity-extraction-walkthrough.md))
wanted two provenance facts the schema didn't have: a **surface** ("Claude Code",
"automated email ingest") finer than `source_channel`, and a **source
trustworthiness** ("perfect — straight from user" … "unverified"). Example 2 even
left trust as `??`.

But artifacts already carried overlapping provenance: `source` (locus/url),
`source_channel` (broad class, CHECK enum), and an unused `captured_by`. Bolting
on `surface` + `trust` naively risked a five-field provenance soup with unclear
boundaries. So this is a *rationalisation*, not just two new fields.

## Decision drivers

- **Capture is dumb; interpret at read** (ADR-018): store objective facts at
  capture, defer judgements to read time.
- **Controlled-value placement pattern** (already in the repo): rigid DB CHECK
  only where the set is small + stable (`entity_type`); open app-layer vocab where
  it proliferates (`relationship_type` in `vocab.ts`).
- **No overlap / clear field boundaries.**
- **User-tunable, not hardcoded policy.**
- **Additive, single-user-appropriate** (vision): no new machinery beyond need.

## Considered options

Representation of the new fields:

- **Typed columns** — robust/indexable, but a CHECK that evolves needs migrations
  (the drift `vocab.ts` exists to avoid) for sets that grow.
- **`provenance` jsonb blob** — flexible/no-migration, but no DB constraints;
  validation must live in the app.
- **Hybrid (chosen)** — `surface` as **open vocab** (proliferates → free text +
  a suggested `SURFACES` list in code); `trust` as a **small ordered enum**
  (stable → enforced).

Trust assignment:

- **Explicit per-capture** — pushes a judgement to capture time; violates dumb
  capture.
- **Fully derived at read** — recomputes a stable fact every read; scatters policy.
- **Per-surface map + override, derived at read (chosen)** — capture stores the
  objective `surface`; trust is read off a user-tunable `surface → trust` map at
  read time, with an optional stored override for exceptions.

## Decision

**Rationalised provenance model:**

| Field | Meaning | Storage | Set |
| --- | --- | --- | --- |
| `source` | external locus (url / id) | column (existing) | free |
| `source_channel` | broad class (chat/email/web/file) | column (existing) | small CHECK enum |
| `surface` | specific app/agent/ingest path | column (**new**) | **open** app-vocab (`SURFACES`) |
| `captured_by` | the actor (user vs automation) | column (existing, now wired) | free |
| trust | how much to believe the content | **derived**, not stored | ordered enum `TRUST_TIERS` |
| `trust_override` | per-artifact exception to derived trust | column (**new**, CHECK) | `TRUST_TIERS` |

**Trust is derived at read** by `resolveTrust(prefs, artifact)` with precedence:
`trust_override` → `surface_trust_map[surface]` → `surface_trust_map[source_channel]`
→ `default_trust`. The map + defaults live in
`user_preferences.capture_preferences` (where capture routing already lives), so
the policy is user-tunable without schema changes. `get_artifact` surfaces the
derived tier.

`TRUST_TIERS = [perfect, high, medium, low, unverified]` (ordered, index 0 =
highest) — enforced as a zod enum and a DB CHECK on `trust_override`.
`SURFACES` is a suggested, open list; `surface` is stored as free text so new
integrations need no migration.

## Consequences

- **Schema:** migration 055 adds `artifacts.surface` (text) and
  `artifacts.trust_override` (text, CHECK to the tiers).
- **Vocab:** `TRUST_TIERS`/`trustTier` and `SURFACES` added to `vocab.ts`.
- **Config:** `capture_preferences` gains `default_surface`, `surface_trust_map`,
  `default_trust` (example JSON + `get_capture_config` updated).
- **Capture:** `capture` accepts `surface`, `trust_override`, `captured_by` and
  stores them; `surface` falls back to `default_surface`, and since #584 to a
  shipped `api` floor below that — see the amendment below.
- **Read:** `get_artifact` shows `channel / surface / trust (override?)`. Trust is
  never stored except as an override.
- **Skill:** `process_artifact`'s surface/trust stub is removed.
- **Migration discipline:** 055 must be applied before `surface`/`trust_override`
  writes succeed (the columns don't exist until then).

## Amendment (2026-08-22, #584): `surface` is written, never left null

This ADR made `surface` an optional free-text column and left every writer free
to omit it. Three years of writers duly did: a read-only production scan on
2026-08-22 found 219 of 153,112 artifacts rows with `surface IS NULL`, spread
across five distinct write paths plus one external n8n workflow.

**The cost is not mis-classification, it is unaddressability.** `resolveTrust`
above, and ADR-046 §3's `resolveSynthesisRole` added later, both fall through
`surface` → `source_channel` → default, so a null-surface row still resolves —
to whatever the default happens to be. What it can never do is *be configured*:
ADR-046 §3 stores one role **per surface**, so with no value there is no key an
owner's `surface_role_map` / `surface_trust_map` entry can match, and a path
flooding synthesis cannot be demoted. That is the #567 flood shape, and #570
fixed only the one path it came in on.

**Decisions taken:**

1. **Every write path stamps a non-null surface.** The value is always an
   *envelope* fact — which tool or client the row came in through, nameable
   from the call site without reading the body, per ADR-046 §2 and ADR-018.
2. **The values a writer stamps are single-sourced** in `@ahkms/shared`'s
   `ARTIFACT_SURFACES`, because the worker and the mcp-server both stamp some of
   them and the column has no CHECK to catch drift. `vocab.ts`'s `SURFACES`
   remains the wider human-facing suggestion list; a test pins the two together.
3. **`capture` gets a third rung, in code**: caller → owner `default_surface` →
   `api`. `default_surface` stays optional and is deliberately *not* given a
   schema default — a configurable default that itself defaults to nothing is
   the same hole one layer down, and a schema default would also misreport
   itself through `get_capture_config` as a choice the owner had made.
4. **The column should become `NOT NULL`, but has not yet.** A static guard
   cannot prove an arbitrary payload is non-null and cannot see a writer that is
   not TypeScript under `packages/`, so the database is the only real
   enforcement. It is blocked on two things, both evidenced rather than
   theoretical: `createTask.ts` still omits the field (concurrent work under
   #653), and an external n8n workflow has written rows directly and cannot be
   fixed from this repo. Migration 091 backfills all 219 rows so only the
   constraint itself remains; `npm run check:artifact-surface-writes` prints the
   number of write paths still able to write NULL, and says so explicitly when
   that number reaches zero.

## References

- Session note: [`2026-06-27-capture-entity-extraction-walkthrough.md`](../sessions/2026-06-27-capture-entity-extraction-walkthrough.md)
- Migrations: `supabase/migrations/20260627140000_055_add_artifact_provenance.sql`;
  `…083_backfill_discover_surface.sql` (#570);
  `…091_backfill_artifact_surface.sql` (#584, the amendment above)
- Code: `packages/shared/src/constants/artifactSurfaces.ts` (`ARTIFACT_SURFACES`),
  `packages/mcp-server/src/vocab.ts`, `captureConfig.ts` (`resolveTrust`),
  `tools/capture.ts`, `tools/getArtifact.ts`
- Guard: `scripts/check-artifact-surface-writes.js` — the inventory of every
  artifacts write path and what each does about `surface`
- Builds on ADR-018 (capture dumb / interpret at read). Follows ADR-024, ADR-025
  in the capture→entity-extraction line. The remaining "consumed_by" overload is
  deferred to a later ADR.
