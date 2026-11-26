# ADR-065: ADR acceptance is stamped automatically on merge to `dev` — the value is derivable, so it is not the author's to remember

- **Status:** Accepted
- **Created:** 2026-08-26
- **Accepted-on-dev:** 2026-08-26
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, process, ci, governance
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1 (metadata is mutable) and §3 (`Accepted-on-dev` is the canonical ordering key),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (a document-level question needs a document-level instrument),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (the watermark this defect silently corrupts)

## Context and problem

`docs/ADRs/README.md` states the rule plainly: **Status** starts `Proposed` and
becomes `Accepted` **only when merged to `dev`** — "not on dev = not accepted
officially". Nothing enforced it, and it has now been missed **six times in
seventeen days**:

| Occurrence | ADRs | Corrected by |
|---|---|---|
| 2026-08-10 | 050, 051, 052 | #619, which filed #620 |
| 2026-08-24 | seventeen, found by #847 | #853, which shipped a guard |
| 2026-08-24 | 056–060 | #861, which filed #862 |
| 2026-08-25 | 061, 062 | #903 |
| 2026-08-26 | 063 | #905 |
| 2026-08-26 | 064 | this change |

Three of those came **after** #853 shipped a guard, and #862 was filed hours
before the failure it describes recurred. This is not a discipline problem that
more discipline fixes.

### Why the existing guards are blind to it

- `check-adr-index-status.js` compares an index row to the status line of the
  file it links to. When an ADR merges unstamped **both say `Proposed`** — they
  agree perfectly, so the guard passes on a state the README forbids.
- `check-apex-watermark.js` is worse than blind. It filters non-live ADRs out
  *before* measuring the gap, so an unstamped ADR **silently shrinks the number
  the freshness mechanism reports**. Measured directly: before #903 stamped 061
  and 062, `vision.md` reported "ok, 1 ADR behind" when the true figure was 3.
  ADR-064 reproduced it — `architecture.md` read *level* partly because the one
  ADR that would put it behind was filtered out.

### Why it cannot be a PR check

The PR that *adds* an ADR correctly says `Proposed`: it is not on `dev` yet, and
failing that PR would be wrong. The violation comes into being **on merge**, and
nobody goes back. Structurally identical to ADR-059's watermark, which is why
neither can be a `pull_request` gate.

## Decision drivers

- **The value is derivable, not a judgement.** The merge happened; its date is on
  the commit. Nothing here needs a human to decide anything, which is what
  separates this from every other apex-doc freshness question.
- **A guard taxes without removing the step.** #862's proposal converts a silent
  wrong state into a red build that still needs a human commit to clear. At the
  observed rate that is a chore every third day, and the author still has to
  remember the thing they already forgot.
- **The corruption is quiet and compounding.** A wrong stamp is bad; a wrong
  stamp that makes the freshness mechanism *under-report* is worse, because it
  looks like health.

## Decision

**Stamp it automatically.** `#620`'s alternative over `#862`'s guard.

### 1. A post-merge workflow on `dev`

`.github/workflows/adr-stamp.yml` runs on push to `dev` under
`paths: docs/ADRs/**`, calls `.github/scripts/stamp-accepted-adrs.js --write`,
and pushes a commit if anything changed. `workflow_dispatch` exposes the same
thing with a **dry run defaulted on**, so the corpus can be inspected by hand
without writing.

### 2. The date is the merge date, taken from the commit

ADR-039 §3 makes `Accepted-on-dev` the canonical ordering key — "the integer is a
stable label, not a timeline" — so a wrong date reorders the record. It is read
from `github.event.head_commit.timestamp`, never from the runner's clock, so a
re-run or a delayed job cannot drift it.

### 3. Three exemptions, each for a stated reason

- **`ADR-DRAFT-*` files are never touched.** They are correctly `Proposed` on
  `dev`: the README's mint-at-merge rule means a draft lives there without an
  integer until minted. Three exist today, and a guard without this exemption
  would have been red from its first run.
- **An ADR with no `Accepted-on-dev` line gets a status stamp but no invented
  date.** The 24 pre-ADR-039 ADRs predate the field. Back-filling a date onto one
  in isolation would make the watermark's exclusion list look decided when it is
  not (ADR-064 §4). This is the **"undated *and not* `Proposed`"** split that
  #862's own proposed exemption needs: ADR-019 sat undated *and* `Proposed` for
  six weeks while `architecture.md` described it as a served component, so
  exempting the undated set wholesale would have hidden a real defect.
- **An unparseable status line is left alone, not guessed at.** The earliest ADRs
  use a `## Status` heading rather than a header field. Rewriting them to satisfy
  a stamper would be a large diff to immutable documents for no gain — the same
  reasoning `check-adr-index-status.js` already applies.

### 4. The file and its index row move together

`check-adr-index-status.js` fails when they disagree, so stamping the file alone
would trade a silent wrong state for a red build: the exact outcome this exists
to avoid. The workflow runs that guard **before** committing, so a half-applied
stamp never reaches `dev`.

### 5. What is deliberately not automated

**Anything requiring judgement.** This stamps a status whose correct value is
already determined by where the file sits. It does not touch `Superseded` or
`Deprecated`, does not decide whether an ADR should have been accepted, and does
not bump either apex-doc watermark — ADR-059 requires *evidence* for a bump, and
a bot has none. ADR-056 rejected a per-ADR declaration block as an ADR-level
instrument for a document-level question; that reasoning is respected here by
keeping the scope to the one field that is mechanically derivable.

## Consequences

**The class closes.** No future ADR reaches `dev` reading `Proposed` for longer
than one workflow run, and the watermark stops under-reporting.

**A bot commit lands on `dev`.** Accepted cost, and the repo already tolerates
automated commits. It is authored as the owner so the `pr-guards` authorship gate
stays satisfied downstream, with the bot credited in a `Co-Authored-By` trailer.
It does not retrigger itself: GitHub suppresses workflow runs from pushes made
with the default `GITHUB_TOKEN`, and the script is idempotent regardless.

**It does not take effect while runners are starved.** The Actions quota outage
(#867) means this will not fire until the billing reset. ADR-064 was therefore
stamped by hand in the same change, using this script — the seventh manual stamp
and, if this works, the last. **This ADR is the mechanism's first real customer:**
it merges `Proposed`, and the first run after runners return should stamp it.

**#862 is answered, and #620 with it.** Both described this defect; #620 proposed
the shape adopted here. The guard #862 asked for is deliberately not built.

**What still is not enforced:** nothing prevents a *new apex doc* being created at
`Reviewed-against: never`, which is #902's third "done when" and remains open. It
is the same shape — a state that comes into being on merge — but the value is not
derivable, so it does not yield to this treatment.

## Refs

#862 · #620 · #619 · #861 · #903 · #905 · #867 · #902 · ADR-039 §1/§3 · ADR-056 ·
ADR-059 · ADR-063 · ADR-064
