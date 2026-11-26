# ADR-066: `vision.md` states what is true, not how it changed — the changelog moves to the decision record

- **Status:** Accepted
- **Created:** 2026-08-26
- **Accepted-on-dev:** 2026-08-26
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) (as-built state belongs to `architecture.md`),
  [ADR-063](./ADR063_Apex_Docs_Reconciled_Against_The_Settled_Discrepancies.md) and
  [ADR-064](./ADR064_Architecture_Gets_A_Scoped_Reconciliation_Pass_And_Its_First_Watermark.md) (the reconciliation passes this follows)

## Context and problem

`vision.md` runs four modes of prose and signals none of them. A reader is several lines
into a paragraph before they can tell whether it is stating what is true, recounting what
the document used to say, proving a citation still holds, or reporting what is built.

Measured across the 500-line document: **19 passages, roughly 90 lines, about 18%**. Three
of the clusters sit in the first two screens — the *"This is a rewrite, not an edit"*
blockquote at line 10, the `#843` reversal at 95, the *Partially built* note at 103 — so
the meta-commentary arrives before the thesis.

**This is a readability decision, not a deducibility one.** The separate question of
whether the apex pair is sufficient to answer a design question without walking the ADR
chain is not addressed here: that gap is *silence*, and it is not what this changes.

### The concrete harm

Line 488 read: *"As-built architecture: `architecture.md` — currently incomplete; it omits
the MCP server entirely (#408)."*

`architecture.md` has carried a `### MCP server` section since #408 closed as completed on
**2026-08-05**. That claim was false for three weeks. It survived because it read like the
surrounding narrative rather than like a claim anyone would check. Mixed-mode prose does
not merely slow reading — it camouflages rot.

## Decision drivers

- **Mode-switching without a signal is the cost.** Not verbosity. Prose that changes what
  it is asserting, mid-section, with no marker, forces the reader to re-parse.
- **The repo already routes this content elsewhere.** `docs/README.md`: current state in
  `docs/`, the *why* in `docs/ADRs/`. The changelog passages are in the wrong file under
  rules that already exist, not under a new rule invented here.
- **A correction is only worth its lines while someone might act on the wrong version.**
  After that it is history, and history has a home.

## Considered options

### Option A — Move all lineage into a "how we got here" section

- **Pros:** one place; the body becomes pure present tense.
- **Cons:** builds a second ADR log inside an apex doc, which `docs/README.md`'s lane rule
  forbids. It also separates a correction from the claim it corrects: the ADR-016 note
  exists to stop a reader applying *"Map, don't store"* at the point they would apply it,
  and at the bottom of the document it stops nobody. **Rejected.**

### Option B — Keep the lineage inline as GitHub footnotes

- **Pros:** renders as one click; definitions collect at the bottom automatically.
- **Cons:** these files are read raw more than rendered — by agents, by the guard scripts,
  and in a terminal. Raw, a footnote is a marker with its content 80 lines away, which
  inverts the benefit. Zero footnotes exist in the corpus today; the `## Refs` line is
  already the same pattern in a form that survives raw reading. **Rejected.**

### Option C — Write the same content better, in separate paragraphs

- **Pros:** no new structure; addresses the immediate reading problem.
- **Cons:** an exhortation, not a rule. Nothing constrains the next author. **Rejected as
  insufficient**, though the chosen option subsumes its intent.

### Option D — Four rules on what a passage may carry (chosen)

Separate the four modes by rule rather than by section.

## Decision

### 1. Changelog mode is deleted

Nine passages: the rewrite blockquote (10), the `#843` reversal (95), the *"failure this
document was written to correct"* aside (165), the R3 parenthetical (281), the stale-cut-line
justification (346), the *not-now* test's provenance framing (348), `#841`'s drift-point
count (359), the six-shipped-entries note (378), the *only parked RDF item* note, the
*does-not-decide* preamble (447), and the ADR-039 gap narrative (470).

Every one is recorded in ADR-057, ADR-063 or the issue that drove it. Two carried
content that is **not** changelog, and it was kept rather than dropped:

- The R3 parenthetical's bottleneck loop (*thin graph, weak context, weak processing, thin
  graph*) is the argument for the cut line's priority call, so it moved to the cut line.
- The *not-now* test (structure larger than the data it structures) is a reusable test, so
  only its *"the previous version recorded a good tell"* framing was cut.

### 2. Supersession bookkeeping collapses to the citation — but never to a *bare* one

Six passages tightened. The rule as first stated was "collapse to the bare citation", and
**running it proved that wrong**: `pr-guards.yml`'s apex-doc citation guard runs in `fail`
mode and requires an apex doc citing a superseded ADR to name its successor within six
lines. Three collapses tripped it (ADR-018 twice, ADR-051 §9 once).

The guard is correct and the rule is amended: **where the cited ADR is superseded, one
clause naming the successor is the floor.** What goes is the enumeration of which sections
changed and what they used to say, not the successor itself. ADR-018 §4 keeps *"ADR-050
supersedes ADR-018 elsewhere, leaving §4 intact"* — one clause where there were three lines.

### 3. As-built state moves to `architecture.md`

Per ADR-058, which decided this lane and was not finished. The *Partially built* blockquote
about `entity_type='domain'` (migration 075's deliberately-narrow seeding, the unbuilt
general axis, the `notion_personal` → `notion_angus` rename that has not landed) moves into
§*Capability status* verbatim in substance. The `dos`-retirement status collapses to a
pointer, because `architecture.md` §7 already carries it under an explicit
*not yet implemented* banner.

The stale MCP-server claim is deleted rather than corrected: `architecture.md` is linked
two lines above, and a status assertion about another document is the exact shape that
rotted.

### 4. One exception is kept deliberately

The **ADR-016 note** stays. *"Map, don't store"* is still in circulation as a principle,
a reader may still act on it, and the note stops them at the point of use. It is tightened
from seven lines to five and reframed from *"the prior vision stated"* to what is true now.

That is the test the rule generalises to: **a correction earns its lines while the wrong
version is still live, and not after.**

### 5. *Requirements* is renamed to *What we promise the user*

The same class of error one level up: the heading asserted the wrong *kind* of thing. R1–R6
are not requirements in the engineering sense — none is a spec constraint, none carries a
target or an owner, and R2 is the customer-facing tagline (*never forget anything ever
again*) stated as one of six. **Promise** is the document's own word for exactly this: the
thesis already uses it. *Objectives* was rejected because it implies targets and owners
these do not have.

**The `R1`–`R6` labels do not change.** Four accepted ADRs cite them by label — ADR-041
(R3), ADR-042 (R6), ADR-063 and ADR-064 (R2/R4) — and ADR-039 §1 makes an accepted
decision immutable, so renaming the identifiers would orphan citations that cannot be
edited to follow. The section says so, and says to read `R` as an identifier rather than as
*requirement*, which is the question the labels have been quietly raising.

## Consequences

**`vision.md` goes 500 → 452 lines, 4,522 → 3,957 words**, with ~90 lines of changelog cut
and ~35 added back as tightened claims and §5's heading note. A scan for changelog phrasing
(*previous version*, *prior vision*, *the old*, *used to*, *earlier position*) returns
nothing.

**Neither watermark moves.** Removing narrative is not a review against ADR-060/061/062/063
/064, so `vision.md` stays at `Reviewed-against: ADR-059` and remains **5 behind** — the
same reasoning ADR-063 applied, and the same reason ADR-059 demands evidence for a bump.
`architecture.md` keeps ADR-063 for the same reason: receiving one relocated paragraph is
not a review against ADR-064.

**The R2/R4 question is untouched and still open.** ADR-064 recorded that ADR-062 bears on
what R2 and R4 mean, that it is the owner's judgement, and that a reconciliation pass may
not make it. That holds: this pass moved no requirement.

**The rule now has a guard behind half of it.** §2 is enforced by the existing citation
guard. §1, §3 and §4 are not enforced by anything, and a future author can reintroduce
changelog prose with no CI objection. Stated rather than solved: the same enforcement gap
ADR-063 and ADR-064 both recorded, and ADR-056 already rejected the per-ADR declaration
block as the instrument for it.

**Not decided here: whether the apex pair is *sufficient*.** The proposal that `vision.md`
plus `architecture.md` should let a reader deduce most design questions, and the test of it
against the `needs-grill` backlog (43 open today), is a separate decision and needs its own
ADR. This change is a prerequisite for reading the vision top down, not an attempt at that
target.

## Refs

#408 · #843 · #841 · #415 · ADR-016 · ADR-018 · ADR-039 §2 · ADR-043 · ADR-050 · ADR-051 ·
ADR-056 · ADR-057 · ADR-058 · ADR-059 · ADR-063 · ADR-064
