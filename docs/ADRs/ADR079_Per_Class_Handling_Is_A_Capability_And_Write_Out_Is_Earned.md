# ADR-079: Per-class handling is a capability, and write-out is earned rather than configured

- **Status:** Accepted
- **Created:** 2026-08-29
- **Accepted-on-dev:** 2026-08-30
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, capture, synthesis, capabilities, permissions
- **Builds on:** [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) (§4: the capture primitive is dumb, interpretation is read-time),
  [ADR-031](./ADR031_Capability_Registry.md) (capabilities are served knowledge),
  [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md) (the per-**source** policy layer, whose per-**class** twin this declines to build),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (§1/§2: stamp the underlying event, never the aggregate),
  [ADR-061](./ADR061_Meeting_Notes_Are_A_Source_Adapter_Not_A_Capability.md) (the same question already answered for one class family),
  [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md) (the four lanes)
- **Resolves:** #589 (vouchers) · #590 (bills) · #597 (business cards)

## Context and problem

Three issues, filed weeks apart, ask the same four questions in nearly the same words: does
this class of thing get a `content_subtype`, does handling happen at capture or in a sweep,
does it spawn a task or reminder, and where does the rule live. #589 was opened after a
voucher was captured **eleven days after it expired** and nothing flagged it. #590 wants
amount and due date extracted from a bill. #597 wants a business card to become a `people`
row.

All three end with the same acceptance line: *"SOP documented (ADR or docs/ page, per repo
convention)"*. That hedge is the finding. The author could not tell which lane the rule
belonged in, because there is no lane for operating policy.

Three issues repeating one question is not three SOPs waiting to be written. It is one
absent decision being re-litigated, and taken separately each would invent its own answer.

**This was predicted.** [ADR-078](./ADR078_The_First_Apex_Sufficiency_Baseline_Is_45_Percent_And_The_Target_Stands.md)
§4 named this exact cluster as one of four absent principles the apex-sufficiency baseline
surfaced, and said one general statement would settle it. This is that statement.

## Decision drivers

- The apex docs must answer this afterwards, or ADR-078's diagnosis was wrong
- Nothing here may weaken ADR-018 §4: the capture write stays dumb
- ADR-058 and ADR-075 forbid answering by lengthening the apex docs
- The live bottleneck is derivation quality, not derivation existence, so new machinery is
  expensive and must earn its place against the cut line

## Considered options

The four options differ on **one axis: where a class's rule lives.** The other three
questions are consequences, not independent choices.

### Option A — No layer

Close all three `wontfix`. No subtypes, no handling, no automation.

- **Pros:** cheapest; consistent with the cut line and with the stated bottleneck; ADR-059 §7
  precedent for declining a mechanism that has not earned its keep.
- **Cons:** leaves a real and repeated failure. R2 promises retention, not attention
  (ADR-067), so an expired voucher is the system working as specified, and that is exactly
  what makes the specification too weak here. The class of thing carries a **deadline**, and
  a deadline that passes silently is a loss the record cannot undo.

### Option B — A capability

Per-class guidance lives in a skill, registry-hosted, invoked at read time.

- **Pros:** no new machinery; bounded by the tool surface a skill already has; and
  **ADR-061 answered this exact question for one class family already.** Plaud, Granola and
  Notion meeting notes "share no shape", and the answer was not a per-format table but an
  acquire-only adapter with per-format interpretation deferred to the read end.
- **Cons:** a skill's judgement is not inspectable the way a config row is; guidance can rot
  silently; "which skill handles this artifact" needs an answer.

### Option C — A per-class policy table

ADR-046's shape, one axis over: declared classes, declared handling, read by a consumer.

- **Pros:** inspectable, enumerable, testable; the policy shape is already designed once.
- **Cons:** new machinery, against principle 8's corollary (*"reach for properties and tags
  before new machinery"*). And decisively: **ADR-046's per-source layer is itself still
  `Proposed` with nothing built.** Building the per-class twin of a mechanism whose original
  has never shipped is the wrong order. The cut-line test applies directly, since the
  structure would be larger than the data it structures.

### Option D — A prose SOP per class in `docs/`

- **Pros:** cheapest to write.
- **Cons:** no lane owns it (ADR-075 gives `docs/` current state, ADRs the *why*, issues the
  undecided; operating policy is none of those). Unbounded: prose cannot say what a rule may
  *do*. This is what the three issues defaulted to for want of an alternative.

## Decision

**Option B**, with three clauses that make it operable.

### 1. Per-class handling is a capability, not a schema

**A recognisable class of captured thing is handled by a skill, at read time, never by a
per-class table and never at capture.** ADR-018 §4 is untouched: the write stays dumb.

This is principle 7 doing the work it was written for. *"Capabilities are knowledge too.
Skills, agents, and commands are things the user knows how to do."* How to handle a business
card is a thing the owner knows how to do. That is what a skill is.

It is also ADR-061 generalised. That ADR resolved a per-format problem with an acquire-only
adapter and read-end interpretation rather than per-format machinery; this is the same
resolution one family over, and consistency here is worth more than a marginally better
bespoke answer.

### 2. A class earns a `content_subtype` exactly when it has a handler

`content_subtype` is free-text `TEXT` with no constraint and eight live values, so today
anything can mint one and nothing says when one is earned. The rule:

> A class earns a `content_subtype` when it **requires handling different from the standard
> path**, or when the owner asks for one.

"Different" covers both directions deliberately. `task_request` and `event_request` need
*extra* steps. `daily_log` needs to be *withheld*, excluded from search by default so the
ritual's output is never the ritual's input (ADR-051 §9). A rule saying only "needs extra
steps" would fail to explain a value already in use, which is how it was caught.

Under clause 1 this is near-tautological in the useful direction: **the subtype is the join
key between an artifact and the capability that knows what to do with it.** It stops being a
taxonomy question. A class with no handler does not need a marker, and a subtype whose
handler is retired goes with it.

The column currently carries at least three other concepts (`derived` is provenance; `note`,
`photo` and `document` are format markers). **This ADR does not retro-fit them.** Recording
the overload is enough; a migration to split the column is not paid for by anything decided
here.

### 3. What a handler may do is banded, and the band is earned rather than configured

The powers these three issues want are all outward writes: create a task, set a reminder,
create a `people` row. The machinery to govern that **already exists and is undocumented**:
`user_preferences.confidence_thresholds`, keyed by decision family (`task_creation`,
`entity_creation`, `artifact_linking`, `relationship_suggestion`, `security_classification`),
each a three-band window of `block` / `review` / `auto_apply`.

Three bands, not one threshold, and that matters: `review` is R3's *"ambiguity is surfaced,
not guessed"* made operable. R3 has always said the system asks rather than picks where it
cannot tell; the bands are where "cannot tell" acquires an edge.

**The number is a rank, not a probability.** A model's "70% confident" is a generated token,
not a measurement: the same voucher through two phrasings gives different numbers, and a
business card's 70 and a bill's 70 are not the same quantity. The bands survive that because
they need only a coarse ordering, not calibration. Nothing downstream may treat the value as
a probability, and no calibration reporting should ever be built on it.

**So the band is earned:**

> A decision family starts in `review`. It is promoted to `auto_apply` only when its
> correction ledger supports the threshold.

A new family has no correction corpus, so its confidence is uncalibrated by definition. The
`review` band is what produces the corpus: propose, the owner accepts or rejects, and that is
a labelled example. Auto-applying on day one skips the step that would have earned the right
to auto-apply. This is the same discipline ADR-077 and ADR-078 established for the
sufficiency target: state the claim, measure it, never ship the number unmeasured.

**The ledger is events, never an aggregate.** ADR-052 §1/§2 already settles the storage
shape: *"where history is missing, stamp the underlying event rather than the aggregate."* A
correction is an event, `user_edits` is its ledger, and accuracy is derived from it at read.
No accuracy column, no score, no streak.

### 4. Delete is not in the band model

ADR-034 already governs deletion: reversible by default, honoured uniformly on the read side,
with hard deletes destructive-by-exception behind an explicit opt-in. A handler inherits that
contract unchanged. **No confidence band authorises a delete**, and the permission set is
deliberately not uniform: creating a task is cheap to undo, and deleting is not.

### 5. What this ADR does not decide

- **Whether any specific class gets a handler.** #589, #590 and #597 now have a shape to be
  answered in, not answers. Each still has to argue that its class clears the cut line.
- **Retro-fitting the overloaded `content_subtype` values** (clause 2).
- **The wiring**, which is #948: corrections are recorded without `confidenceBefore`, only
  one of five families is captured at all, `runBatchLearningAnalysis` has zero callers, and
  nothing reads `learned_pattern`. Clause 3 is a decision about shape; #948 is what would
  make it true. Until #948 lands, **no family may sit in `auto_apply`**, because the ledger
  that would justify it is not being written.

## Consequences

**The bands are load-bearing in a way they were not before.** They were a safety feature;
clause 3 also makes them the training-data generator. That raises the cost of the `review`
band being unimplemented, which is why #948 stops being tidy-up and becomes the dependency.

**One of fifteen dials is honoured today.** Five families times three bands, and only
`relationship_suggestion.auto_apply` is read by anything
(`packages/worker/src/workflows/steps/organizeEntities.ts:122`). This ADR makes the other
fourteen normative, which converts a latent inconsistency into a stated gap with an issue
against it. That is the intended direction: ADR-052 §4's *"a surface that cannot report on
its own absence is not a health surface"*, applied to a settings page that currently offers
fifteen controls and honours one.

**A class with no handler now reads as a deliberate state.** Previously "no SOP for vouchers"
was an unfilled gap of unknown size. Under clause 2 it is a class that has not earned a
handler, which is a complete answer rather than a missing one.

**The apex pair can now answer this cluster.** ADR-078's baseline scored #589, #590 and #597
as misses. A reader holding only the apex docs can now state that per-class handling is a
capability invoked at read time, that a subtype marks the existence of a handler, and that an
outward write is banded and starts in review. That is three sample issues moved on one
sentence, which is the §4 mechanism working as designed rather than as an assertion.

**The risk this accepts.** A skill's judgement is less inspectable than a config row, and
guidance in a skill body can rot with nothing failing. That is the same bet ADR-061 already
took for meeting notes; if it turns out wrong there, it is wrong here, and both should be
revisited together rather than diverging.

## Current-state sync (ADR-039 §2)

This changes the system's shape, so `docs/architecture/architecture.md` is updated in the
same PR: it currently documents neither `user_preferences.confidence_thresholds`, nor
`user_edits`, nor the `learning/` subsystem, all of which are as-built and none of which had
a record. `docs/vision.md` is **not** changed: nothing here alters what ahOS is for or moves
anything across the cut line, and R3 gains an operational edge rather than a new meaning.

## Refs

#589 · #590 · #597 · #948 · #313 · #635 · ADR-018 §4 · ADR-030 · ADR-031 · ADR-034 · ADR-039 §2 · ADR-046 · ADR-051 §9 · ADR-052 §1/§2/§4 · ADR-058 · ADR-059 §7 · ADR-061 · ADR-067 · ADR-075 · ADR-078 §4
