# ADR[NNN]: <Short title of the decision>

<!-- Claim the next free integer AT AUTHORING and name the file
     ADR[NNN]_Descriptive_Title.md. Do not use an ADR-DRAFT-<slug>.md name and do
     not rename at merge — mint-at-merge was retired by ADR-039, which moved
     collision-prevention to CI (adr-number-guard.yml). If two branches race for a
     number, the second to reach CI renumbers on-branch, before any citation to the
     losing number exists. -->

- **Status:** Proposed | Accepted | Deprecated | Superseded by [ADR-XXX](ADRXXX_...)
  (a decision is **Accepted only once merged to `dev`**; until then it is Proposed)
- **Created:** YYYY-MM-DD  <!-- authoring date; stable -->
- **Accepted-on-dev:** YYYY-MM-DD | (pending merge)  <!-- merge-to-dev date; the canonical ordering key -->
- **Deciders:** <names>

## Context and problem

<!-- The situation and the force requiring a decision. 2–5 sentences. Link the
     code, docs, or prior ADRs that set the stage. -->

## Decision drivers

- <!-- the constraints / goals that the chosen option has to satisfy -->

## Considered options

### Option A — <name>

- **Pros:** …
- **Cons:** …

### Option B — <name>

- **Pros:** …
- **Cons:** …

## Decision

We chose **<option>** because …

## Consequences

- **Good:** …
- **Cost / bad:** …
- **Follow-up:** …

## Links

- Related: [ADR-XXX](ADRXXX_...)

<!--
  Conventions (see docs/ADRs/README.md):
  - File name: ADR[NNN]_Descriptive_Title.md, next free integer, zero-padded to 3.
  - Immutable once Accepted — supersede with a new ADR, don't edit the decision out.
  - Add a row to the index table in docs/ADRs/README.md in the same PR.
  - The docs-index-guard workflow enforces that index update.
-->
