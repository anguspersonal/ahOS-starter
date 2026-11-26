# ADR039: ADRs are immutable records — mutable metadata, same-PR current-state sync, CI-guarded numbering

- **Status:** Accepted
- **Created:** 2026-07-20
- **Accepted-on-dev:** 2026-07-20
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, process, ci
- **Builds on:** [ADR-014](./ADR014_Repo_Operating_System.md) (docs lanes), [ADR-020](./ADR020_Open_Contradictions_To_Resolve.md) (the contradictions register)

## Context and problem

The question posed: should ADRs be a **historical reference** of decisions made, or **living
documents** each owning the current truth of its topic? The append-only model makes current
state hard to see — readers walk a supersession chain. The living model would keep each file
current, but rewrites history in place.

This repo has already run both experiments, and the costs are on record:

- **[ADR-020](./ADR020_Open_Contradictions_To_Resolve.md) exists** because ADRs written in
  waves contradicted each other. Resolving that required each position *as originally
  worded*. Under a living model that raw material would have been overwritten and ADR-020
  could not have been written.
- **The 024 collision (found 2026-07-20).** The three-step synthesis ADR was drafted
  2026-06-22 claiming integer `024` on a branch that never merged. On 2026-06-28 a different
  ADR legitimately took `024` on `dev` — and *the same commit* introduced the mint-at-merge
  rule intended to stop such collisions. The orphan on the unmerged branch was invisible to
  that rule. Issue #126 then cited it and the citation did not resolve; the document has
  since landed as [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md).
- **`docs/architecture/architecture.md` — the designated "what the system is now" doc — does
  not mention `packages/mcp-server` at all.** A dozen accepted ADRs reshaped the system
  around it and none was obliged to touch the as-built doc. The current-state lane exists
  (ADR-014) but nothing feeds it, which is exactly why "what is current?" gets asked of the
  ADR chain instead.

Two distinct failures are tangled here and must be separated:

1. **Numbering collisions** — two documents claiming one integer.
2. **Citing an ADR that is not on `dev`** — the #126 failure. **No naming scheme fixes
   this.** The orphan would have been equally un-resolvable under a date-based name; what
   was wrong was that an unmerged draft was treated as authoritative.

## Decision drivers

- **Citations must be stable.** Issues, PRs, commits, skills, and agent routines resolve ADR
  references constantly. Over 100 GitHub issues and PRs already cite ADRs by integer, and
  those bodies **cannot be rewritten**. A reference's meaning must not drift after writing.
- **"Accepted" must keep meaning something** — a status attached to specific frozen content.
- **Current state must be answerable in one read**, not by walking a chain.
- **Git history is an archive, not an interface.** Prose diffs show *that* text changed, not
  *that a decision reversed and why*.
- **One convention, stuck to.** A mixed naming scheme is worse than either scheme alone.
- **Failure modes belong to machines, not memory.** Mint-at-merge asked humans to run a
  manual dance, and it failed within a week of being written.

## Considered options

### Option A — living documents, updated in place

- **Pros:** current state visible per topic; no supersession chains to read.
- **Cons:** every existing citation silently changes meaning; acceptance semantics decay;
  reversal rationale survives only as diffs; ADR-020-style reconciliation becomes
  impossible; agents that loaded rules last month drift invisibly against the same
  identifier.

### Option B — immutable records, current state nowhere in particular (status quo)

- **Pros:** history intact; citations stable.
- **Cons:** the observed pain — current state reconstructed by chain-walking;
  `architecture.md` drifts stale with no forcing function; supersession pointers applied
  inconsistently.

### Option C — rename every ADR to a date+slug scheme

Considered and **rejected**. It would permanently break 100+ GitHub issue and PR references
(those bodies cannot be rewritten), and it does not address failure 2 above — an orphaned
draft is equally un-citable whatever it is called. It would also be the single largest
citation-breaking act in the repo's history, taken in the same breath as an ADR whose core
argument is citation stability.

### Option D — immutable records + mutable metadata + same-PR sync + CI-guarded integers (chosen)

Keep the record class immutable; let metadata and the current-state lane answer "what is
current?"; and hand the numbering failure mode to CI rather than to discipline.

## Decision

### 1. Decision content is immutable; metadata is mutable

Once **Accepted**, an ADR's decision content — context, drivers, options, decision,
consequences — is frozen. Changing the decision means a **new ADR** that supersedes it.

Mutable metadata, edited in place with no new ADR: the **Status** line, supersession
pointers, errata/numbering notes, link and typo fixes. The test: **if the edit requires no
new decision, it is metadata; if it requires one, it is a new ADR.**

**Same-PR supersession stamp.** A superseding ADR must update its predecessor's Status line
(`Superseded by ADR-XXX` / `Superseded in part by ADR-XXX (<which clause>)`) **in the same
PR**. A reader landing on any ADR then finds either a current decision or a pointer to its
successor — never a silently-stale record. This is what makes the immutable model navigable:
you need not know the chain, because each link carries its own forward pointer.

### 2. An ADR that changes the system's shape updates the as-built docs in the same PR

If an accepted ADR changes what the system *is* — components, boundaries, flows, runtime
topology — the same PR updates the current-state docs, in particular
[`docs/architecture/architecture.md`](../architecture/architecture.md). A process- or
meta-only ADR (like this one) states that explicitly instead. Reviewers check for one or the
other.

Restated: **ADRs answer "why is it this way?"; `docs/` answers "what is it now?"** A
current-state doc cites ADRs for reasoning and never restates their content; an ADR never
becomes the place readers go to learn present shape.

> **Extended by [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (2026-07-23):** §2
> binds the ADR→as-built direction. ADR-043 adds the reverse and covers `vision.md` — a
> *substantive* change to `docs/vision.md` or `architecture.md` must carry a minted ADR
> recording why, in the same PR. This is a pointer under §1's mutable-metadata rule; no
> decision of ADR-039 changes.

### 3. Naming is unchanged — `ADR[NNN]_Descriptive_Title.md`, integer + slug, dates in metadata

The integer sequence continues. Dates live in the metadata block (`Created`,
`Accepted-on-dev`), never in the filename; **canonical order is by `Accepted-on-dev`** — the
integer is a stable label, not a timeline.

**Mint-at-merge is retired.** Claim the next free integer at authoring; do not use an
`ADR-DRAFT-<slug>.md` name and do not rename at merge. That dance existed to dodge
collisions, but it introduced citation instability (slug → integer mid-life) plus rename
churn, and it failed anyway. Collisions become a CI problem instead:

- **ADR number guard** — fails a PR to `dev`/`main` that adds an ADR
  whose integer already exists on the base branch. If two branches genuinely race, the second
  to reach CI renumbers on-branch, before any citation exists.
- **ADR link guard** — fails a PR whose changed files link to a
  `docs/ADRs/ADR*.md` path absent from the PR's own tree, catching dangling ADR references
  where they are introduced.

> **Erratum (2026-07-21):** both guards shipped as standalone workflows
> (`adr-number-guard.yml`, `adr-link-guard.yml`) and now run as **steps** in
> [`pr-guards.yml`](../../.github/workflows/pr-guards.yml). Their logic is unchanged; the five
> PR guards were consolidated into one job because GitHub bills per job rounded up to the whole
> minute, so five ~20-second checks cost five minutes (#435, forced by the billing block #432).
> This is metadata under §1 — no decision changes, so the Status line is not stamped.

**Scope limit, stated plainly:** the link guard covers **repo files only**. It would *not*
have caught #126, whose bad citation lived in a GitHub issue body no CI can see. Citing an
ADR that is not yet on `dev` stays a review-time judgement; the mitigation is the existing
rule that an ADR is Accepted only once merged, so an unmerged draft is never authoritative
to cite.

## Consequences

- **Good:** citations stay stable — nothing is renamed, and the 100+ existing GitHub
  references keep resolving; collisions become structurally impossible at merge rather than
  discipline-dependent; "what is current?" is answered by `architecture.md` plus the Status
  line, not by chain-walking; supersession is legible at the superseded file, not only at its
  successor.
- **Cost:** two forcing functions to honour in review (same-PR stamp; same-PR as-built sync
  or an explicit waiver), and two more CI jobs on docs PRs.
- **Neutral:** the `ADR-DRAFT-*` files currently in the folder keep their names until
  accepted, at which point they take the next free integer.
- **Follow-up:** `architecture.md`'s existing staleness predates §2 and is tracked in #408
  rather than fixed here — this ADR is meta-only and changes no system shape.

## References

- [ADR-014](./ADR014_Repo_Operating_System.md) — established the docs lanes this ADR wires
  together. Its `ADR[NNN]_Title` naming clause is **reaffirmed**, not superseded.
- [ADR-020](./ADR020_Open_Contradictions_To_Resolve.md) — the reconciliation register whose
  existence is the strongest local evidence for immutability.
- [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) — the collision that
  triggered this decision.
- #408 — backfill `architecture.md` to current reality.
