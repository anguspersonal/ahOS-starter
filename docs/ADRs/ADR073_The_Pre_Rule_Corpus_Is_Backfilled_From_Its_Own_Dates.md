# ADR-073: The pre-rule corpus is backfilled from its own dates

- **Status:** Accepted
- **Created:** 2026-08-27
- **Accepted-on-dev:** 2026-08-27
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, process
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) (`Accepted-on-dev` is the canonical ordering key; metadata is mutable),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (understating self-corrects, overstating does not),
  [ADR-072](./ADR072_The_Post_Merge_Hook_Stamps_And_Commits.md) (new ADRs are stamped automatically, so this is a closed set)

## Context and problem

Twenty-eight accepted ADRs predate ADR-039's ordering rule and carry no
`Accepted-on-dev`. `check-apex-watermark.js` reported them on every run as a blind
spot — correctly, since an ADR with no date cannot be placed in the canonical order
and so sits outside every gap the watermark measures.

**Backfilling changes no number today**, which is worth stating before doing it: 26 of
the 28 sort before the earliest already-stamped ADR (ADR-024, 2026-06-28), and the
other two (ADR-032, ADR-038) still sort well before either watermark. So this is not a
measurement fix. It is the thing the discrepancy register said it was: they were
excluded **by accident of parsing, not by decision**.

The forward risk — a *new* ADR landing undated and being invisible for the same reason
— is already closed by ADR-072, whose stamper writes status and date together. This is
therefore a closed set that will not grow.

## Decision

### 1. Each ADR is dated from its own record, not from git

Every one of the 28 carries its own `**Date:**` (or, for the three pre-convention
files, `**Accepted** - …`). That date is used.

The alternative was the commit that added the file, and it is worse: **21 of the 28
were added by `8be8d96`**, an 809-file vendored snapshot, so git would date a third of
the corpus to one afternoon that has nothing to do with when anything was decided.
Uniform, derivable, and meaningless.

Two resolution rules, because several dates are compound:

- Where one part is marked accepted, that part wins. ADR-018 (*"2026-06-15 (proposed)
  · 2026-06-16 (accepted)"*) → `2026-06-16`. ADR-038 (*"… 2026-07-20 (number minted,
  accepted on `dev`)"*) → `2026-07-20`.
- Where neither is, the later wins, because the earlier is the draft step throughout
  this corpus. ADR-020 (*"2026-06-15 (register) · 2026-06-16 (resolution log
  closed)"*) → `2026-06-16`. This is the one judgement call in the set.

### 2. For the pre-repo ADRs the field holds a decision date, not a merge date

**This is the cost of the choice and it is not hidden.** `Accepted-on-dev` is named for
a merge to `dev`. ADR-001 now reads `Accepted-on-dev: 2025-12-24`, and this repository's
`dev` did not exist then — the file entered history six months later.

The field is used for exactly one thing: ordering the corpus (ADR-039 §3). For that
purpose the decision date is the more truthful key, and the merge date would be a
fiction dressed as precision. A reader must not read the early corpus's values as
merge dates, which is what this section exists to prevent.

### 3. Three are left undated, deliberately

ADR-005 (`2025-01-XX`), ADR-006 and ADR-008 (both *"December 2024"*) give a month with
no day. Inventing one would be overstating, and the whole corpus of dates is only worth
anything if none of them is invented (ADR-059).

They stay undated and the check keeps naming them. **The blind spot goes from an
unexplained 28 to a stated 3**, which is the improvement; reducing it to zero by making
something up would not be.

## Consequences

**The canonical order no longer resembles the numbering, for the first dozen ADRs.**
ADR-010 dates itself `2025-02-07` and ADR-001 dates itself `2025-12-24`, so ADR-010 now
sorts first. The early corpus was numbered by topic and backfilled by hand, and its
dates were never chronological. The order is now what the record actually says rather
than what the numbering implies.

**Sixty-nine of seventy-three ADRs are now orderable**, up from forty-four. No gap
changed, and none was expected to.

**The remaining 3 will stay.** Nothing else in the repository knows when those decisions
were taken, so this is not deferred work with an owner. It is a stated limit.

## Refs

#862 · ADR-039 §3 · ADR-059 · ADR-065 · ADR-072
