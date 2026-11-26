# ADR-064: `architecture.md` gets a scoped reconciliation pass and its first real watermark — the audit was the review

- **Status:** Accepted
- **Created:** 2026-08-26
- **Accepted-on-dev:** 2026-08-26
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, architecture, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (the freshness mechanisms),
  [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) (as-built state belongs here),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (the watermark, and that bumping it requires evidence),
  [ADR-063](./ADR063_Apex_Docs_Reconciled_Against_The_Settled_Discrepancies.md) (the settled-tier corrections this completes)

## Context and problem

`architecture.md` was created by #851 to receive the as-built state shed from
`vision.md`, and it was born carrying `Reviewed-against: never`. The watermark
reported **34 ADRs behind, oldest 59 days** — the largest single number the
freshness machinery produced, and #902 asked the question it forces: is that
34 real debt, or an artefact of nobody setting a baseline at creation?

ADR-063 corrected the settled discrepancies but deliberately left the watermark
alone, because correcting sentences is not the review a bump would claim. That
left the question open and the number on the board. This resolves it.

## Decision

### 1. The 34 is real debt, not a missing stamp

Decided on the evidence rather than the prior. Before the audit the
baseline-reset reading looked stronger: the doc was split out days after
#843/#846/#851 reconciled that content, so "current as of ADR-059, just
unstamped" was plausible.

The audit found **fifteen distinct discrepancies in this document**, including
ADR-055's third `routing` value missing while a two-value world was described,
ADR-060's schema change absent from the table it changed, nineteen registered
tools missing from a list labelled *as built*, and a duplicated `### MCP server`
section. That is not what a merely-unstamped document looks like.

The decisive piece of evidence points the same way: #851's own commit message
says "***move*** Working-today to architecture.md; keep the rest of the cut line
prose". A move carries no review evidence. `never` was strictly honest.

### 2. The pass is **scoped**, and the scope is stated

Not a line-by-line re-derivation of the document against 34 ADRs. What was done,
precisely:

- Every one of the 62 ADRs on `dev` had its citations traced through this
  document and `vision.md`, producing a coverage map: 22 cited by both, 7 by
  architecture only, 8 by vision only, **25 by neither**.
- For each of the 25, the ADR's decision was read and judged for materiality to
  the shape this document describes.
- Every claim this document makes that could be checked against the repo was
  checked — the tool list against `server.ts` (126 registered), the routing
  vocabulary, the `user_integrations` shape, the column names.

The eleven ADRs that pass found material are landed here: **ADR-002 / ADR-004 /
ADR-007** (the upload and PDF routes had no route back to the decisions that
produced them), **ADR-025** (entity types, now load-bearing for ADR-062),
**ADR-026** (provenance, and trust as *derived, never stored*), **ADR-027** (the
projection-source north star, explicitly marked as direction and not current
shape), **ADR-028** (reference versus content, the split that makes the registry
promise answerable), **ADR-029** (the rejected frameworks — a constraint the
stack section never carried), **ADR-034** (one delete vocabulary, reversible by
default), **ADR-037** (local name plus namespace pointer, never a stored CURIE),
**ADR-044** (foreign vocabularies are read-only and locally authoritative), and
**ADR-056** (the three surviving freshness mechanisms, named beside the
watermark they govern).

### 3. The watermark is set to ADR-063, and **the audit is the evidence**

ADR-059 requires evidence for a bump and refuses a tick-box. The evidence is the
coverage map above plus this ADR: every ADR in the corpus was examined against
this document, and everything that pass found is now in it.

**What that claim does and does not cover.** It covers citation tracing across
all 62, decision-level reading of the 25 uncited, and repo verification of every
checkable claim. It does **not** cover reading all 62 ADRs end to end and
re-deriving the document from them. An ADR whose decision section understates
what it changed could still be missing. That is a weaker guarantee than "fully
reviewed", and stating it here is what makes the watermark auditable rather than
decorative.

The result: `architecture.md` goes from **34 behind to level**. That number is
now load-bearing — the next ADR that lands without updating this document moves
it off zero immediately, which is the whole point of the mechanism and was
impossible while the baseline was `never`.

### 4. ADR-063 is stamped `Accepted` on the way through

It merged in #904 reading `Proposed` / `(pending merge)` — the fifth instance of
#862 in seventeen days, and predicted in that PR's own body. It is stamped here
because a `Proposed` ADR is filtered out before the gap is measured, so
`Reviewed-against: ADR-063` would otherwise name an ADR the watermark cannot see.

The fifth hand-correction in seventeen days is itself the argument: #862 should
ship **auto-stamping**, not a guard. A guard converts a silent wrong state into a
red build that still needs a human commit, at a rate of roughly one every three
days.

## Consequences

**`vision.md` moves from 3 behind to 4.** ADR-063 joining the corpus as
`Accepted` adds it to the gap. That is correct and was not avoidable: the vision
genuinely has not been reviewed against ADR-060, 061, 062 or 063, and ADR-062 in
particular bears on R2 and R4 — a judgement about what the system is for, which
belongs to the owner and not to a reconciliation pass.

**Nine of the register's unresolved entries close.** What remains open there is
the vision-side gap, #862's mechanism question, and the entries that were never
settled.

**The enforcement gap is unchanged.** Everything corrected here passed every
guard, and will recur the same way. ADR-056 already rejected a per-ADR
declaration block as an ADR-level instrument for a document-level question, so
the next proposal needs a different shape rather than a retry. The watermark now
being at zero at least means drift is visible from the first ADR that causes it.

## Refs

#902 · #862 · #744 · #851 · ADR-039 §2 · ADR-043 · ADR-056 · ADR-058 · ADR-059 ·
ADR-063
