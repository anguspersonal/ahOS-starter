# ADR-088: A day window reads valid time; coverage reads transaction time

- **Status:** Accepted
- **Created:** 2026-09-14
- **Accepted-on-dev:** 2026-09-14
- **Deciders:** Angus
- **Amended by:** [ADR-119](./ADR119_Coverage_Attributes_A_Late_Ingested_Atom_To_Its_Effective_Day_Within_Seven_Days.md) (§3: coverage attributes an atom to its `effective_at` day when that day is 0 to 7 calendar days before its `captured_at` day, and to its `captured_at` day otherwise)

## Context and problem

`artifacts.captured_at` records **when the ingest ran**, not when the content is
from. On 2026-08-05 a bulk Google Drive backfill of the personal archive landed
hundreds of artifacts stamped with that day — a 2016 flat-hunting spreadsheet,
GCSE homework, an old employment contract — and every day-scoped consumer read
them as things that happened that day (#567).

#567 shipped a read-side stage filter that removed the visible half of the
problem: those rows were unenriched pointers with no body, so they had no
business in a synthesis window. It cannot reach the other half. An **enriched**
historic document is legitimately synthesis-eligible, and lands in today's
window with nothing to mark it as 2016.

The same defect has two more instances the codebase had already written down and
deferred to #571: the Daily Log twin (#562), written up to seven days after the
day it narrates and forced to overload `captured_at` through a guarded allowlist
(`BACKDATABLE_CONTENT_SUBTYPES`); and the session summary (#565), where a
`/close` after midnight files the narrative atom for five hours of work under the
following day — leaving the day it describes with no narrative atom at all, which
under ADR-046 §3 means that day cannot be narrated, since commits and PRs sit at
role `evidence` and never narrate alone.

## Decision drivers

- ADR-018 forbids **judgement** at write time. Anything stored must be a
  field-copy of what the source served, not a reading of the content.
- ADR-046 §2's envelope rule already licenses exactly that field-copy, and the
  Drive and Notion discover cadences already make it.
- The day window is read on every EOD ritual and must stay indexable.
- Four PRs (#609, #765, #775, #783 / migration 098) have been spent narrowing
  what the artifact read path pulls over the wire; a fix that widens it again is
  swimming against a current the repo has already chosen.
- Whatever is chosen must not leave two mechanisms for one concept.

## Considered options

### Option A — Derive origination at read from `processing_metadata.discovery`

The timestamps are already stored: `discoveryMetadata()` in `tools/discover.ts`
writes `source_created_at` / `source_modified_at`, and `enrichNext.ts` spreads
the block forward, so an enriched 2016 contract still carries its 2016 date.

- **Pros:** no schema change on the write side; no re-ingest; the data is
  provably already there and survives enrichment.
- **Cons:** not actually migration-free. `knowledge_search` filters the day
  window in three places, one of them a PostgREST query builder
  (`tools/search.ts`), and `COALESCE(jsonb_path, column)` is not expressible in
  PostgREST's filter grammar — so it needs a view, a generated column or an RPC
  regardless. `idx_artifacts_processing_metadata` is GIN `jsonb_ops`:
  containment, not range comparison, so the window becomes a seq scan comparing
  jsonb **strings**, correct only while every source serves identical UTC
  formatting. It widens the hot projection to a jsonb blob to read one string out
  of it. And it reaches only rows that arrived through `ingest_discover`:
  `capture` has no `discovery` block and never will, and `drive_import` writes
  none — so the twin and the session summary stay permanently out of reach.

### Option B — An `originated_at` column, with a generated `effective_at` (chosen)

- **Pros:** one indexed `timestamptz`, 8 bytes, normalised at write; every writer
  has somewhere to put the date, including the two that have no envelope block;
  the day window keeps the access path it has today.
- **Cons:** a migration and a backfill; and a third date on the row, which is a
  real cost — see Consequences.

### Option C — An ingest-batch marker (`batch_id` / `is_backfill`)

- **Pros:** cheapest of the three.
- **Cons:** answers a narrower question — *how it arrived*, not *when it is
  from* — so it does nothing for a single historic file ingested live, and
  nothing for the twin or the session summary.

## Decision

We chose **Option B**, and name what it is: ordinary **bitemporality**.
`captured_at` is **transaction time** (when the system learned it);
`originated_at` is **valid time** (when the content is from).

### 1. Storage

```sql
ALTER TABLE public.artifacts
  ADD COLUMN originated_at timestamptz,
  ADD COLUMN effective_at timestamptz
    GENERATED ALWAYS AS (COALESCE(originated_at, captured_at)) STORED;
CREATE INDEX idx_artifacts_effective_at ON public.artifacts USING btree (effective_at);
```

`effective_at` is **generated, not a second writable column**. It is the one
definition of "the day this atom belongs to", so the SQL filter and the two JS
filters cannot drift apart — which they would, being three call sites in two
languages. `STORED` rather than `VIRTUAL` so it can carry a btree index.

`originated_at` NULL is the ordinary case and means *the source told us nothing*,
never *today*. Both search RPCs are still `returns setof public.artifacts`
(migration 069), so they pick the column up with no RPC migration.

### 2. Which envelope timestamp is origination is **per source**

Implemented as `ORIGINATION_FIELD_BY_CONNECTOR` in
`packages/mcp-server/src/vocab.ts`, a row of ADR-046 §4's per-source policy table
in the same spirit as `DISCOVER_ROLE_SEED`:

| Source | Field | Why |
|---|---|---|
| Drive (`gdrive`, `gdrive_work`, aliases) | `source_created_at` | The discover cadence is incremental on `modifiedTime`, so the arriving rows are precisely the recently-touched ones. Keying on modified time would put a 2016 contract re-saved last week back into last week's window — the bug itself. |
| Notion (`notion`) | `source_modified_at` | A page is a living document; one edited today holds content from today. `created_time` would file a heavily-revised 2024 page under 2024 forever. |

A connector **absent** from the map keeps `originated_at` NULL and falls back to
`captured_at`, i.e. pre-ADR-088 behaviour. Adding a source is additive and never
retroactive.

Deliberately **not** in `captureConfig.ts` beside `DISCOVER_ROLE_SEED`, despite
both implementing rows of the same table: everything in that module is a floor
under the owner's stored `capture_preferences`, i.e. configurable. Which
timestamp a source serves as origination is a fact about the source's API, not a
preference — an owner who could repoint it could silently refile years of atoms.

Both values are deterministic field-copies of the source's own response, so this
sits on the provenance side of ADR-046 §2's test and is not the write-time
judgement ADR-018 forbids.

### 3. The day window moves; **coverage does not**

`knowledge_search`'s `captured_after` / `captured_before` filter on
`effective_at`. `dos_synthesis_coverage` and the marker reads in `links.ts` stay
on `captured_at`.

This divergence is the decision, not an oversight. The window asks *what is this
day about* — a property of the content. Coverage asks *did I run the ritual* — a
property of the ingest. Moved to `effective_at`, a synthesized backfill would
open a coverage obligation on 2016-03-12, a day that would then read as forever
incomplete and would corrupt the adherence metrics (#493/#495) in the opposite
direction to the bug this ADR fixes. Recorded in a comment at
`getSynthesisCoverage` so nobody "repairs" it.

The parameter names keep the `captured_` spelling. Renaming them is a real API
break for skills and callers already wired to them, not justified by a naming
nit; the widened meaning is spelled out in the parameter descriptions and the
tool guide. Same call, for the same reason, as `include_discovered` (#567).

### 4. Historic atoms stay unconsumed, and will not be narrated

The backlog slice is `{captured_before: today, not_consumed: true, limit: 50}`
(`dos` SKILL.md step 5), ordered newest-first. Today the 2015–2022 backfill all
carries `captured_at = 2026-08-05`, so it sits near the **front** of that slice,
crowding out genuinely older atoms; dating it correctly sinks it to the back of a
~2,000-deep queue. That fixes a second symptom of the same incident.

The honest consequence: at that depth the slice will never reach them, so
"eligible for the next night" is true in principle and false in practice. That is
the intended outcome. ADR-046 §4 row 1.10a already puts whole-account Drive
discover at role `evidence` — searchable and consultable, never narrated bare.

## Consequences

- **Good:** the three atoms whose day is wrong (historic file, Daily Log twin,
  session summary) become one mechanism instead of one bug and two bodges; the
  day window stays indexed; the backlog slice stops being crowded by the backfill;
  `captured_at` becomes honest again rather than a field callers are tempted to
  lie in.
- **Cost / bad:** three dates on every row — `created_at` (row insert),
  `captured_at` (ingest), `originated_at` (content) — and dates you can disagree
  with are how bugs start. Mitigated by making `effective_at` generated and
  read-only: consumers ask for the day an atom belongs to and never coalesce for
  themselves. A migration and a one-shot backfill, whose per-source rule is
  necessarily restated in SQL; harmless because it runs once, and the live rule
  has exactly one home.
- **Follow-up:** the Daily Log twin (#562) and session summary (#565) declare
  `originated_at` instead of overloading `captured_at`, retiring
  `BACKDATABLE_CONTENT_SUBTYPES`. Deliberately a separate change: this one makes
  no behaviour change on `capture`, and folding a caller-facing parameter swap
  into it would.

## Links

- Issue: [#571](https://github.com/anguspersonal/ahOS/issues/571); incident #567; consumers #569, #489, #493, #495; follow-ups #562, #565
- Related: [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md) §2 (envelope rule) and §4 (per-source policy table), [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) (no judgement at write time), [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md) (provenance)
- Migration: `supabase/migrations/20260914120000_104_artifacts_originated_at.sql`
