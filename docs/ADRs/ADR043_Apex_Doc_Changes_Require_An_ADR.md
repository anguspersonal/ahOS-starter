# ADR043: A substantive change to vision.md or architecture.md requires a minted ADR — extends ADR-039 §2 to the doc→ADR direction and to vision.md

- **Status:** Accepted
- **Created:** 2026-07-23
- **Accepted-on-dev:** 2026-07-23
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, process, governance, vision
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md)
  (immutability, metadata, same-PR sync), [ADR-014](./ADR014_Repo_Operating_System.md)
  (docs lanes)

> **Scope note (ADR-039 §2).** Process/meta only. Changes no components, boundaries,
> flows, or runtime topology, so it updates no `architecture.md` — stated explicitly per
> ADR-039 §2. It adds a metadata pointer to ADR-039 (§1-sanctioned) and updates the
> vision's *Keeping this document true* section, both in the same PR.

## Context and problem

ADR-039 §2 binds **one direction**: a shape-changing ADR must update the as-built docs
(`architecture.md`) in the same PR. It says nothing about the **reverse** — a change to an
apex doc is not required to carry a decision record explaining or authorising it — and it
does not mention `docs/vision.md` at all.

That asymmetry is the documented cause of the worst drift this repo has had. The vision's
own *Keeping this document true* section names it exactly:

> ADR-039 §2 requires a shape-changing ADR to update `architecture.md` in the same PR.
> Nothing binds an ADR to this document — which is why the previous version drifted by
> construction rather than by neglect, and why it ended up contradicting three accepted
> ADRs. … **An ADR that changes what ahOS is for, or moves something across the cut line,
> must update this document in the same PR.** That rule belongs in ADR-039 and is tracked
> separately.

The 2026-07-04 → 2026-07-20 vision drift happened because the north star could change
without a decision record. A wrong north star is worse than none: it produces confident
wrong answers. The fix is to require the why-record on both apex docs, in both directions.

## Decision drivers

- **The two apex docs are the most costly to let drift silently.** `vision.md` (north
  star) and `architecture.md` (as-built) are the documents readers and agents trust as
  ground truth.
- **ADR-039 already set the pattern** — *"ADRs answer why; docs answer what,"* enforced by
  same-PR discipline. This extends it symmetrically rather than inventing new machinery.
- **Do not over-generalise.** A rule that made a typo fix need an ADR would itself be the
  narrow-rule-hardened-into-absurdity failure the repo keeps hitting (and the very thing
  ADR-042, its sibling in this PR, corrects). The rule must carve out non-substantive edits.

## Considered options

### Option A — amend ADR-039 in place
Rejected: ADR-039 is immutable by its own §1. Adding a process rule is a new decision, so
it is a new ADR, not an in-place edit.

### Option B — leave the rule as prose in the vision doc
Rejected: a rule tracked only inside the document it governs is exactly the un-enforced
state that permitted the drift. The vision itself says the rule *"belongs in ADR-039."*

### Option C — mint this ADR extending ADR-039 §2 (chosen)
A first-class, citable process decision that completes the §2 symmetry.

## Decision

**1. Doc→ADR, both apex docs.** A **substantive** change to `docs/vision.md` or
`docs/architecture/architecture.md` must be accompanied — in the same PR — by a minted ADR
recording the why (context, options ruled out, decision). "Substantive" = a change to
content, a principle, a requirement, the cut line, or a stated current-state fact.

**2. Metadata carve-out (mirrors ADR-039 §1).** These do **not** each need their own ADR:
typo / link / formatting fixes; index, date, or pointer corrections; and edits that merely
*reflect* a decision already recorded in an ADR landing in the same PR. **The test:** if the
edit changes what the doc asserts, it needs a why-record; if it doesn't, it is metadata.

**3. Symmetry, stated.** With this ADR the binding is complete in both directions:

| Direction | Rule | Source |
|---|---|---|
| ADR → as-built | a shape-changing ADR updates `architecture.md` in the same PR | ADR-039 §2 |
| doc → ADR | a substantive `vision.md` / `architecture.md` change carries a minted ADR | **this ADR** |
| ADR → vision | an ADR that changes what ahOS is for updates `vision.md` in the same PR | this ADR (formalises the vision's own note) |

**4. Enforcement is review-time,** like ADR-039 §2's same-PR sync: a reviewer checks an
apex-doc PR for its paired ADR. No new CI guard is mandated. *(A future guard could flag a
PR that touches an apex doc substantively with no ADR added; noted, not required — the
substantive/metadata line is a judgement CI cannot fully make.)*

**5. Same-PR housekeeping.** The vision's *Keeping this document true* section is updated to
cite this ADR as the landed rule, and ADR-039 gets a metadata pointer (*"§2 extended by
ADR-043"*) — both in this PR.

## Consequences

- **Good:** the apex docs cannot silently diverge from the decision record; every principle
  in the vision traces to a decision — the property the vision rewrite was fighting for, now
  enforced rather than hoped for.
- **Cost:** a reviewer forcing-function on apex-doc PRs, and some risk of ADR proliferation
  — bounded by the metadata carve-out (§2).
- **Meta-only:** no system shape changes; no `architecture.md` edit (ADR-039 §2).

## Links

- [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §2 — the direction this
  extends; gets the same-PR *"extended by ADR-043"* pointer.
- [ADR-014](./ADR014_Repo_Operating_System.md) — the docs lanes (`docs/` = what, ADRs =
  why) this rule binds together.
- [ADR-042](./ADR042_Intelligent_Flows_Are_First_Class.md) — the first vision change minted
  under this rule (same PR); also the sibling case of the over-generalisation this §2
  carve-out guards against.
- `docs/vision.md` → *Keeping this document true* (updated in this PR).
