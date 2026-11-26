# ADR119: Coverage attributes a late-ingested atom to its effective day, within seven days

- **Status:** Accepted
- **Created:** 2026-11-21
- **Accepted-on-dev:** 2026-11-21
- **Deciders:** Angus Hally (owner: decided on 2026-11-21, recorded in the grill outcome on #2264); drafted by the executor under [ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md)
- **Amends:** [ADR-088](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md) (§3: coverage reads the `effective_at` day when it is 0 to 7 calendar days before the `captured_at` day, and the `captured_at` day otherwise)
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md)

## Context and problem

[ADR-088 §3](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md) says `dos_synthesis_coverage` stays on `captured_at`. [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md) §1 says an atom's marker counts on the atom's `captured_at` day, and §4 calls `captured_at` "the same day coverage, the stampable test and the closing row use".

The code has not done that since PR #2110 (merged to `dev` on 7 November 2026). `coverageDateForArtifact` in `packages/core/src/adapters/supabase/externalLinks.ts` attributes an atom to its `effective_at` day when that day is at most 7 days before its `captured_at` day. The change fixed a real fault: a meeting held on day D whose transcript synced from Drive on D+1 was counted on D+1, so D read as a day with no material and the sweep skipped it. The rule has a test and no ADR, and two accepted ADRs plus the function's own comments said the opposite.

#2264 moves the coverage read into a Postgres function. A rule that is about to exist in two languages has to be written down first.

## Decision drivers

- Coverage and the `knowledge_search` day window should name the same day for a late-synced atom, or the sweep reads a day as empty while the search for that day returns its material.
- ADR-088 §3's reason still holds for old content: a 2016 contract ingested today must not open a coverage obligation in 2016.
- Production has run this rule since 7 November. Reverting it would move days that are already closed.
- A day's answer must not depend on the window that was asked.

## Considered options

### Option A: return to ADR-088 §3, coverage on `captured_at` only

- **Pros:** matches the two accepted ADRs as written; one clock.
- **Cons:** brings back the fault PR #2110 fixed; moves markers on days closed since 7 November.

### Option B: coverage on `effective_at` with no ceiling

- **Pros:** coverage and the day window always agree.
- **Cons:** the case ADR-088 §3 exists to prevent. A synthesized backfill opens a day years in the past that then reads as forever incomplete.

### Option C: `effective_at` within a 7-day ceiling, `captured_at` beyond it (chosen)

- **Pros:** what production runs; agrees with the day window for late syncs; the ceiling keeps ADR-088 §3's protection for backfills.
- **Cons:** coverage is no longer a pure transaction-time read, and it can disagree with the evidence aggregate by a day (§3 below).

## Decision

We chose **Option C**.

### 1. The attributed day

Coverage attributes an atom, and any closing marker on it, to one UTC calendar day:

- Take the UTC dates of `captured_at` and `effective_at`.
- When the `effective_at` date is 0 to 7 calendar days before the `captured_at` date, the day is the `effective_at` date.
- Otherwise (more than 7 days before, or after) the day is the `captured_at` date.
- When one timestamp is null the other decides. When both are null the atom has no day and is not counted.

The lag is counted in calendar days, not elapsed hours. Seven matches the unattended sweep's horizon (`[today-7, today-2]`). A marker's day is never the marker row's own `created_at`.

This amends ADR-088 §3. Its sentence "coverage does not move" becomes "coverage moves with the day window for up to 7 days, and not beyond". What counts as material, the streak rules of [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) §8 and ADR-109 §2, and the UTC boundary are unchanged.

### 2. The window edge

Attribution can place an atom up to 7 days before its `captured_at`. A coverage read for `[from, to]` therefore scans atoms captured in `[from, to + 7 days]`, buckets them by attributed day, and keeps the days in `[from, to]`. An atom captured on `to + 1` and dated `to` counts on `to`.

The TypeScript read on `dev` stops its scan at `to` and misses that atom unless it carries a marker. `public.get_dos_coverage_days` (migration 158) applies the rule above. This is the one intended difference between the two, and the parity check names it `window-edge`.

### 3. What this means for ADR-109 §1 and §4

ADR-109 is not edited. Read beside this ADR:

- §1's "an atom's marker counts on the atom's `captured_at` day" holds for coverage only when the atom's `effective_at` day is the same day, later, or more than 7 days earlier. Inside the 7 days the marker counts on the `effective_at` day.
- §4 keeps the evidence aggregate's membership on `captured_at`. Coverage and the aggregate can therefore disagree for late-dated evidence: a commit dated D and captured on D+1 is material on D for coverage and is counted in D+1's aggregate (listed there as "arrived on D+1, dated earlier").
- The two reads also use different day boundaries. Coverage is UTC. The aggregate is Europe/London. Around midnight in British Summer Time they can place the same atom on different days.
- Daily Log twins are unaffected. A twin is written with `captured_at` equal to the day it narrates, so its `effective_at` and `captured_at` days are the same and the closing row counts on that day under either rule.

### 4. One runtime copy, one oracle

Once the readers switch (#2312), the SQL in migration 158 is the only runtime copy of this rule. `coverageDateForArtifact`, `isSynthesizableMaterial` and `COVERAGE_MAX_EFFECTIVE_LAG_DAYS` stay in TypeScript as the oracle. `packages/mcp-server/scripts/dos-coverage-parity.ts` rebuilds the per-day rows from raw rows with the oracle and compares them with the function on production data. The repo has no database test harness, so that run (#2310) is the proof. A change to the rule changes both copies in one PR.

## Consequences

- **Good:** the rule production runs is the rule on record. Coverage and the day window agree on late syncs. A day's coverage no longer depends on where the requested window ends.
- **Cost / bad:** coverage and the evidence aggregate use different clocks and different day boundaries, so a late-dated evidence row can be material on one day for coverage and listed on the next by the aggregate. The rule lives in two languages until a database test harness exists.
- **Follow-up:** #2310 pushes migration 158 and runs the parity check. #2312 switches `getSynthesisCoverage` and `getStreak` to the function and deletes the paging read. This ADR changes no component, boundary or flow ([ADR-039 §2](./ADR039_ADR_Immutability_Metadata_And_Guards.md)): nothing calls the function yet. `docs/architecture/architecture.md` still says coverage reads `captured_at`, which has been inexact since PR #2110; that sentence and the `artifacts.effective_at` column comment from migration 104 are outside this change's file list and are flagged on the PR.

## Links

- Resolves: the day-attribution and window-edge decisions on #2264 (grill outcome, 21 November 2026)
- Related: #2257, #2110, #2310, #2312, [ADR-088](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md), [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)
- Migration: `supabase/migrations/20261121120000_158_get_dos_coverage_days_rpc.sql`
