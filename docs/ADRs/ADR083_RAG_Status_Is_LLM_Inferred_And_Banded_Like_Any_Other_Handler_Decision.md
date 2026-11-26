# ADR083: RAG status is LLM-inferred, and banded like any other handler decision

- **Status:** Accepted
- **Created:** 2026-09-12
- **Accepted-on-dev:** 2026-09-12
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, synthesis, projections, capabilities, permissions
- **Builds on:** [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md)
  (the fence this ADR resolves; an undecided question lives on an Issue until it graduates),
  [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md)
  (the banding mechanism this ADR reuses rather than re-inventing),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (§1/§2:
  stamp the underlying event, never the aggregate),
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) (§4: capture
  stays dumb; interpretation happens at read time),
  [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) (projections are
  outputs, not sources), [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive change to
  `vision.md` needs a minted ADR, updated in the same PR)
- **Resolves:** #934

## Context and problem

`vision.md`'s *Projections* section promises a **state doc per domain** carrying "RAG
status per area/project — at-a-glance health". §*What this document does not decide*
fenced off the mechanism: rule-derived, LLM-inferred, or user-asserted, with a stated
leaning toward rule-derived ("a rule you can read off is debuggable; an unexplainable
verdict about your own life erodes trust the first time it is wrong"). ADR-075 §4 moved
that reasoning off `vision.md` and onto this issue, because an ADR cannot record a leaning
that might still move.

**Grounding in what exists today, not in theory:** nothing in the codebase currently
computes or displays a RAG status anywhere. A repo-wide search for RAG-status
terms (`rag_status`, `ragStatus`, red/amber/green, traffic-light) across
`packages/web`, `packages/mcp-server`, `packages/worker` and `supabase/migrations`
returns nothing; the only three hits for "RAG status" in the whole repo are this issue,
`docs/vision.md`'s own aspirational line, and ADR-075 quoting it. The state-doc writer
(`packages/mcp-server/src/tools/updateStateDoc.ts`) has no health or status field. This is
a decision about a mechanism for a feature that has not been built yet, not a retrofit.

The owner resolved the leaning on the issue (2026-08-30, two comments): **option 2,
LLM-inferred by a dedicated agent call, validated empirically over time** — explicitly
overriding the stated rule-derived leaning. The second comment named the reason the
override is safe rather than reckless: ADR-079 settled this exact shape (an inference a
per-class handler makes, gated by confidence bands, promoted only once a correction ledger
supports it) for a different cluster of decisions, and it transfers directly. This ADR
mints that decision and answers the one thing the issue left open: whether the rule-derived
signals (staleness, overdue, blocked) survive as inputs to the agent or are discarded.

## Decision drivers

- **The trust concern behind the original leaning does not disappear because the decision
  went the other way.** *"An unexplainable verdict about your own life erodes trust the
  first time it is wrong"* is a real hazard of LLM-inferred status, not an artefact of the
  rule-derived option that lost. Whatever this ADR decides has to name what makes the
  verdict inspectable despite not being rule-derived.
- **Reuse the existing trust mechanism rather than inventing a parallel one.** ADR-079
  already answered "how do we let a per-class model judgement stand unattended without
  trusting it blindly" for five other decision families. Consistency with that shape is
  worth more than a marginally better bespoke answer for a sixth (ADR-079's own stated
  principle, applied here).
- **ADR-079 §5's constraint transfers automatically and must be stated, not silently
  inherited.** No decision family may sit in `auto_apply` until #948 (the correction-ledger
  wiring) lands, because the ledger that would justify it is not being written for *any*
  family yet.
- **Nothing here may weaken ADR-018 §4.** RAG status is a read-time projection derived at
  the state-doc ritual, never a capture-time write.
- **Do not build the feature while deciding the mechanism.** The issue's "Done when" is
  mint-the-ADR plus rewrite-the-vision-fence; the state-doc schema, the agent call, and the
  UI surface are separate, unbuilt work and stay out of scope here.

## Considered options

### Option A — Rule-derived (staleness, overdue, blocked)

- **Pros:** debuggable — the verdict is a query result, not a generated token; matches the
  leaning `vision.md` shipped with; no inference cost, no new failure mode.
- **Cons:** the value `vision.md` asks for is "at-a-glance health", a summary judgement
  about a project, and staleness/overdue/blocked are symptoms rather than that judgement —
  a project can be genuinely fine with several stale-looking tasks (an agreed pause) or
  genuinely in trouble with none (the two tasks that matter are both fine on paper and both
  wrong). A fixed rule has no way to weigh that without becoming a growing pile of
  special-cased thresholds, and it has no feedback path: the only way it improves is a human
  editing SQL.

### Option B — LLM-inferred, unbanded

- **Pros:** captures the judgement a fixed rule cannot.
- **Cons:** this is precisely the failure the original leaning was written to avoid, and the
  owner's own second comment names it directly: *"trusting a model's self-reported judgement
  about your own life... is the thing the leaning was written to avoid."* An agent's asserted
  verdict, written straight to the projection with nothing between it and the reader, is
  option 2 without the safeguard the leaning demanded. Rejected as stated.

### Option C — LLM-inferred, banded per ADR-079 (chosen)

- **Pros:** reuses machinery that already exists rather than inventing bespoke trust
  plumbing for one more decision family — `user_preferences.confidence_thresholds` already
  holds five families as a three-band (`block`/`review`/`auto_apply`) window, and the
  worker already makes per-artifact calls to the Anthropic API for analysis
  (`packages/worker/src/utils/anthropic.ts`, used by `analyze.ts`), so "a dedicated agent
  call" is an existing shape of call, not new infrastructure. A new family starts in
  `review` — surfaced for confirmation on the same pending-decision path other `review`-band
  items already use (`packages/web/components/notification/NotificationCard.tsx`) — and is
  promoted to `auto_apply` only once its correction ledger supports the threshold. That is
  what turns "we will test over time" (the owner's first comment) into a gate with a number
  behind it, and it is the direct answer to the trust concern: the first wrong verdict is
  one the owner corrected, not one they discovered later.
- **Cons:** inherits ADR-079 §5's dependency on #948. No family — old or new — may honestly
  reach `auto_apply` until the correction-ledger wiring exists, so `rag_status`, like the
  other five, ships review-only until then.

### Option D — User-asserted

- **Pros:** zero inference risk; maximal trust, since the human wrote the verdict.
- **Cons:** provides none of the value `vision.md` asks for. *Projections* wants a status
  the owner does not have to maintain by hand — a manually-maintained RAG field is exactly
  the kind of status board that goes stale the moment attention moves elsewhere, which is
  the failure "at-a-glance health" is meant to solve rather than reproduce. Not what the
  owner decided.

## Decision

**Option C.** RAG status is computed by a dedicated agent call, not a rule and not the
user, and the call's output is banded exactly per ADR-079:

- A `rag_status` decision family joins the five already in `confidence_thresholds`, using
  the same three-band shape (`block` / `review` / `auto_apply`).
- **It starts in `review`.** Every verdict is surfaced for confirmation before it is
  asserted anywhere the owner treats as ground truth.
- **It is promoted to `auto_apply` only when its correction ledger supports the
  threshold**, and per ADR-079 §5, **no family — this one included — may sit in
  `auto_apply` before #948 lands**, because the ledger that would justify it is not being
  written yet for any family.
- **The confidence number is a rank, not a probability**, exactly as ADR-079 states for the
  other five families: it orders verdicts coarsely, it is not calibrated, and nothing
  downstream may treat it as a measurement.
- **Corrections are events, never an aggregate** (ADR-052 §1/§2): a correction to a RAG
  verdict is a row in the same ledger every other family writes to, and the accuracy figure
  that eventually justifies promotion is derived from it at read time, not stored as a
  score.

**On inputs — the one thing the issue left for this ADR to decide:** staleness, overdue and
blocked are kept as **inputs to the agent call, not discarded.** Which mechanism renders
the verdict (a rule versus a model) is a different question from which signals are worth
looking at, and discarding them would throw away the one part of the rule-derived option
that was empirical grounding rather than a mechanism choice. There is no reason a dedicated
agent call should reason about project health from *less* evidence than a hand-rolled rule
would have used. The call is handed these three signals — plus whatever else the
per-area/project projection already carries once it exists. What the call's output looks
like beyond a banded verdict (whether it carries a rationale string, and in what shape) is
not decided here — it is implementation detail for whichever issue builds the agent call,
not a mechanism question this ADR needs to settle. The trust concern in the issue body is
answered by the banding itself (Decision drivers, above): a `review`-band verdict is
surfaced for confirmation, not asserted, so the first wrong one is corrected rather than
discovered later.

## Consequences

- **Good:** the `vision.md` fence stops being a leaning that could still move; the cluster
  of undecided operating-policy questions ADR-078/ADR-079 named shrinks by one; #934 closes
  with a citable mechanism and a stated trust contract.
- **Cost / left out:** this ADR settles the mechanism and the trust contract. It does
  **not** build any of it. As of this ADR, there is no `rag_status` key in
  `confidence_thresholds`'s default JSONB or in its Zod schema
  (`packages/mcp-server/src/tools/updateUserPreferences.ts`), no `rag_status` branch in the
  decision-family `CASE` inside `should_auto_apply_decision`, and no per-area/project field
  in the state-doc writer. Wiring those in is left to whichever issue proposes the actual
  per-area/project state-doc view; opening that issue is not done here (scope: this one
  issue, one PR).
- **Follow-up:** whoever wires this needs (a) a `rag_status` entry added to
  `confidence_thresholds`'s default and to the family-mapping logic once a real consumer
  exists, and (b) #948 to land before `rag_status` — or any family — may leave `review`.
  Neither is opened as a new issue here.
- The `vision.md` fence is rewritten, not deleted outright: *what computes RAG status* now
  has an answer, folded into the *Projections* section where the feature is described,
  while *which areas/projects get a RAG status, and what the view renders* remains unbuilt
  product surface and is not asserted as shipped (ADR-058/ADR-075's as-built/vision split).

## Links

- Resolves: #934
- Related: [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md),
  [ADR-079](./ADR079_Per_Class_Handling_Is_A_Capability_And_Write_Out_Is_Earned.md),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md),
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md),
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md)
- Dependency: #948 (correction-ledger wiring; blocks any family reaching `auto_apply`)
