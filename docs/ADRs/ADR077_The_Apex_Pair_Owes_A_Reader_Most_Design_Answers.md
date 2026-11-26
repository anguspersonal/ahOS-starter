# ADR-077: The apex pair owes a reader most design answers, and the claim is measurable

- **Status:** Accepted
- **Created:** 2026-08-28
- **Accepted-on-dev:** 2026-08-28
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) (the apex docs get shorter by de-storing, not longer),
  [ADR-066](./ADR066_The_Vision_States_What_Is_True_Not_How_It_Changed.md) (raised this question and explicitly declined to answer it),
  [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md) (the four lanes, which is the rule this is measured against)

## Context and problem

ADR-066 ended with an item it would not settle:

> **Not decided here:** whether the apex pair is *sufficient*.

Its own gap was mixed-mode prose — a document narrating how it had changed rather than
stating what was true. Sufficiency is a different gap: not whether the documents are
**wrong**, but whether they are **enough**. The discrepancy register carried it forward as
**D50** and it is the last live entry on that board.

**The prerequisite is met for the first time.** `vision.md` states what is true rather than
how it changed (ADR-066), both apex docs carry live watermarks and both currently read
level (ADR-076), and ADR-075 wrote down what each lane is for. Before that, "are the docs
sufficient" could not be asked cleanly, because it was tangled with "are the docs current"
and "what are the docs even for".

**The honest objection, which this ADR has to answer rather than ignore.** The case against
stating it was recorded on D50 as: *"a target nobody measures is decoration, and the honest
measurement is expensive."* That is correct, and ADR-052 §4 already supplies the standard —
*"a surface that cannot report on its own absence is not a health surface."* A stated
percentage with no method and no baseline would fail that standard on the day it landed.

## Decision

### 1. The principle

**The apex pair owes a reader most design answers without a walk down the ADR chain.**
`vision.md` plus `architecture.md` should let a developer or an agent settle roughly **70%**
of the design questions that actually arise, and the remaining 30% should be questions where
the ADR chain is genuinely the right place to look.

The number is a target, not a measurement, and §5 says so where a reader will see it.

### 2. "Deducible" has a sharp definition, or the measurement is not repeatable

An open `needs-grill` issue counts as **deducible** when a reader holding **only** the two
apex documents can either

- state the decision the issue needs and **point at the sentence** that settles it, or
- state that the question is **deliberately open**, and point at the fence that says so.

It does **not** count as deducible when the reader could guess correctly, or could infer it
from knowing the system, or finds a sentence that is merely consistent with the answer. The
test is *point at the text*, because anything softer measures the reader rather than the
document.

The second branch matters as much as the first. ADR-075 kept the fences in
§*What this document does not decide* precisely so that "we have not decided this" is an
answer the document can give. An issue the apex pair correctly identifies as open is one it
answered.

### 3. It lives in §*Keeping this document true*, not in the load-bearing principles

This is a placement decision and getting it wrong would be a category error.

The **load-bearing principles** list says what ahOS *is*, and opens *"these we won't give up
cheaply"*. Every entry is about the system: coherence not consolidation, the dumb capture
primitive, one substrate many consumers. A target about how well the documentation performs
is not a property of the system and does not belong in a list of them.

§*Keeping this document true* is the section that already holds the document's obligations
to its reader — the rules, the mechanisms, and what they do and do not prove. Sufficiency is
another such obligation, so it goes there.

### 4. Missing the target means a principle is missing, not that the docs are too short

**This is the load-bearing half of the decision**, because the obvious reading of a
sufficiency target is "write more documentation", and that reading is wrong here.

ADR-058 made the apex docs shorter on purpose, by de-storing derived state. ADR-075 gave
each lane a job and put reference material somewhere else. A document that answers more
questions by growing has satisfied this target and broken both of those.

So when the measurement comes in under target, the correct response is to ask **which
principle is absent** — what general statement, once made, would have settled that cluster
of issues — and to state that. If no such principle exists and the answer is genuinely
specific, the issue was never apex-doc material and the ADR chain is where it belongs. That
is the 30%, and it is not failure.

### 5. The baseline has not been taken, and that is stated in the document

The measurement was attempted while this ADR was written and could not be run: the GitHub
API rate limit for this account was exhausted, so the `needs-grill` backlog could not be
read. Rather than delay the decision or quietly ship a number nobody produced, the principle
lands with its own status attached.

`vision.md` therefore states the target **and** that it is unmeasured, in the same sentence.
Until the first run, this is a claim about what the documents owe, not a report on whether
they pay. **A reader must not be able to mistake the second for the first**, which is the
whole of D50's objection and the only defence against it.

The first measurement is tracked as its own issue and is deliberately small: **a sample of
twenty**, not all forty-three. A method that costs an afternoon gets run; one that costs a
week gets quoted and never repeated, which is how ADR-052 §4's dead surface appears.

### 6. It is measured on the same trigger as the watermark

The apex-watermark check already fires on drift, and a scoped pass already reads both
documents against a window of ADRs. Sufficiency is measured **on that same occasion**,
because a pass that has just re-read both documents is the cheapest possible moment to ask
whether they are enough, and a separate cadence is a second thing to remember.

## Consequences

**The claim can now fail, which is the point.** A target with a definition and a method is
falsifiable; the previous state — nothing stated — could not be wrong because it said
nothing. Expect the first number to be uncomfortable, and expect 70% to turn out to be the
wrong figure. Both are improvements on silence.

**D50 closes, and the discrepancy register reaches zero live entries.** Fifty-four
discrepancies, opened as an audit of the apex docs against the ADR corpus and the code.
Worth recording what the board actually taught: **four entries were resolved by re-reading
rather than by fixing** — D30's verdict was wrong, D33 asked the wrong question, D49 was
filed as taste when it was a lane question, and D47 was filed as an unfilled gap when
ADR-059 §7 had already decided to accept it. An entry is a claim with a timestamp and it
decays like any other.

**The 30% is a real allowance, not a rounding error.** Thirteen of forty-three issues being
ADR-chain questions is the expected shape of a repository with 77 ADRs, and a target of 100%
would be a demand that the apex docs absorb the decision record — the exact thing ADR-039 §2
and ADR-075 both refuse.

**The unmeasured state is itself a finding if it persists.** If the first measurement has not
been taken by the next scoped pass, that is evidence about this ADR rather than about the
backlog, and the honest response is to withdraw the target rather than let it sit as
decoration. ADR-059 §7 is the precedent: a mechanism that does not earn its keep gets closed
`wontfix` and the narrowing gets recorded.

## Refs

D50 · ADR-039 §2 · ADR-043 · ADR-052 §4 · ADR-058 · ADR-059 §7 · ADR-066 · ADR-075 · ADR-076
