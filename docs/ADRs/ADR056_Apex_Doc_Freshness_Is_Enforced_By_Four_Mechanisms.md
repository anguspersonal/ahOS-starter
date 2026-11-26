# ADR-056: Apex-doc freshness is enforced by four mechanisms, not one — and the declaration block is the ledger, not the alarm

- **Status:** Accepted
- **Created:** 2026-08-23
- **Accepted-on-dev:** 2026-08-24
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, process, governance, ci, vision
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) (immutability, metadata, same-PR sync),
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change requires a minted ADR),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (derived not stored; the monitor sits outside; stamp the event)
- **Resolves:** #849 (this PR) · frames #848, #850, #851

---

> **Same-PR sync note (ADR-039 §2).** Process/meta plus one CI step. Changes no
> components, boundaries, flows or runtime topology, so it updates no
> `architecture.md` — stated explicitly per ADR-039 §2 rather than skipped. It
> does not itself change `vision.md`; the drift this ADR responds to is fixed
> under #842 to #846, each carrying its own doc edit.

## Context and problem

[ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (2026-07-23) bound the
apex docs and the decision record together in both directions: a substantive
change to `vision.md` or `architecture.md` requires a minted ADR, and an ADR
that changes what ahOS is for must update the doc in the same PR.

It is prose, and nothing enforces it. An audit on 2026-08-23 (#841) found the
result:

- `docs/vision.md` last touched **2026-07-23**. ADRs **044 through 055** created
  **2026-08-05 to 2026-08-11**, with amendments running to **2026-08-22**.
- **No ADR authored since 043 cites or edits `vision.md`.**
- Five substantive drift points (#842 to #846), the load-bearing one being that
  the entire Projections section rests on ADR-023's three sibling synthesis
  consumers, sixteen days after [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
  superseded ADR-023 outright.

The vision is itself a rewrite written to correct this exact failure. Its
opening says a north star that contradicts accepted decisions "is worse than no
north star, because it produces confident wrong answers", and its closing
section asserts *"ADR-043 closes that gap, in both directions."* The failure
recurred within a month, and the mechanism the document credits for its own
freshness had never been armed.

The proposal that prompted this ADR was a single guard: a required
`updates-vision` / `updates-architecture` block in every ADR, with CI rejecting
an ADR that omits it or claims `yes` without touching the file. Recording that
proposal, and why it became one of four mechanisms rather than the mechanism, is
the purpose of this ADR. Without it the reasoning would live only in issue
threads — the defect [ADR-049](./ADR049_PARA_Containment_Primary_And_Secondary_Edges.md)
was written to correct, whose round-1 QA review flagged that its decision "lived
only in the #170 issue thread and the PR body, not in `docs/ADRs/`".

## Decision drivers

- **The failure is silent and compounding.** A stale apex doc does not break a
  build; it produces confident wrong answers, in the document new contributors
  and agents read first.
- **A mechanism must be able to fail.** A rule nothing can enforce is a rule
  that has already been broken once here.
- **A mechanism must not claim more than it checks.** A guard that reads as a
  correctness proof while checking a tick-box is the same silent-wrong-answer
  defect wearing a green build.
- **The judgement must be durable and attributable.** "Which ADRs claimed they
  did not change the vision" should be a query, not an audit.
- **No second store** (ADR-052 §1, ADR-022) — the freshness signal must derive
  from what the repo already holds.
- **Cheap now beats complete later** (ADR-052) — single maintainer.

## Considered options

### Option A — the declaration block alone

Every ADR declares `updates-vision` / `updates-architecture`; CI fails a missing
declaration, and fails a `yes` unaccompanied by the corresponding file change.

Scored against the five drift points it was filed to prevent:

| Drift | Caught by the block? |
|---|---|
| #842 three sibling consumers | only if ADR-051's author ticked `yes` |
| #843 `domain` names two things | no — nothing in an ADR file signals it |
| #844 cut line omits four ADRs | only if four separate authors each ticked `yes` |
| #845 multi-user understated | no |
| #846 bottleneck items designed | no |

- **Pros:** durable record; per-ADR attribution; cheap; the author is the person
  who best knows what their own decision changed.
- **Cons:** two of five, both contingent on an honest tick. The enforcement bite
  lands only on the self-selected `yes` path, and the `no` box is always
  available and uncontradictable by CI. Worse, it asks a **document-level**
  question with an **ADR-level** instrument: ADR-051's author was reasoning
  about mixed days and marker kinds, and "does this substantially change the
  vision" is a question about the vision, best answered by reading it.

### Option B — the citation guard alone

Fail when an apex doc cites an ADR whose Status line says it is superseded.

- **Pros:** zero judgement from anyone; fires the day the supersession lands;
  the fact is already in the repo in a fixed place, because ADR-039's same-PR
  supersession stamp puts it there.
- **Cons:** catches one of the five. Silent on every drift that does not travel
  through a citation.

### Option C — a periodic human review alone

Read the apex docs against the ADR batch since the last review.

- **Pros:** the only thing that catches semantic drift (#843, #845).
- **Cons:** it is exactly what failed. A review nobody performs reports nothing,
  and ADR-052 §4's test applies: *"a surface that cannot report on its own
  absence is not a health surface."*

### Option D — four mechanisms, each with one job (chosen)

## Decision

**Apex-doc freshness is enforced by four mechanisms. None is sufficient alone,
and each is chosen for a different failure mode.**

| Mechanism | Job | Issue |
|---|---|---|
| **Citation guard** | precise alarm, no judgement | #849 — **this PR** |
| **Watermark + scheduled check** | reports its own absence | #850 |
| **Declaration block** | durable, attributable ledger | #848 |
| **Stop storing the derived sections** | removes the failure class | #851 |

### 1. The citation guard ships first, in `warn`

`scripts/check-adr-citations.js`, wired into `pr-guards.yml` and gated on the PR
touching `docs/ADRs/**` or an apex doc, so a stale citation never blocks
unrelated work.

**The rule:** if an apex doc cites `ADR-NNN` and that ADR is superseded, the
successor's id must appear within six lines of the citation. Update the claim,
or name the successor beside it. Silence fails.

**Acknowledgement, not a hidden marker.** ADR-040 rejected machine identifiers
in prose a human reads, and that reasoning transfers. Naming the successor in
the sentence is checkable *and* improves the document. It is also not invented
here: `docs/architecture/architecture.md:147` already does it, flagging its own
ADR-023 material as a superseded shape and naming ADR-051 and ADR-054 in the
same block. One apex doc already writes this way; the guard asks the other to.

**Only a supersession that names a successor counts.** ADR-039 §1 permits
amendment in place, and ADR-052 §5 and ADR-054 §8 are both "superseded **in
place**", by themselves, naming no other ADR. There is nothing a citing document
could acknowledge, and a rule the prose cannot satisfy is a broken guard rather
than a strict one.

**It ships in `warn` because nine citations are stale on the day it lands.** The
flip to `fail` is one line and belongs in the PR that clears them (#842, #844).
A grandfather allowlist was rejected: a list of known-stale citations is a second
store of what the check derives, and it would outlive its entries.

### 2. The declaration block is the ledger, not the alarm

Option A's block is **kept**, at #848, with its job restated: it records the
judgement durably and attributably, and it is not what detects drift.

This is ADR-052 §2's shape — *"stamp the event and the aggregate derives
forever; snapshot the aggregate and you have built a store that only knows the
days it ran."* Whether the vision was reconciled against a given ADR is a
per-ADR fact. Stamping each ADR makes "how many ADRs since the last
reconciliation, and which" computable for any past date. #850's watermark is the
aggregate; the block is the event behind it.

Two constraints follow, recorded so the build does not lose them:

- **The trigger is added *or modified*.** August's largest changes arrived as
  in-place amendments to accepted ADRs, not as new files. A guard keyed on
  added-only catches none of them.
- **A boolean is one value short.** ADR-050's own doc-sync note defers its
  `architecture.md` edit with a stated reason, because the existing prose was
  still true as-built. Under `yes | no` that PR either fails or records a false
  `no`. A third value, `deferred` with a reason and an issue reference, keeps
  the honest case honest.

### 3. What the guards prove, stated plainly

**No mechanism here proves an apex doc is correct.** The citation guard proves
the author saw a supersession; someone may append "(superseded by ADR-051)" and
leave a wrong paragraph standing. A `yes` in the declaration block is satisfied
by a whitespace touch. `no` is unfalsifiable by construction.

This is recorded as a decision rather than a caveat, because the alternative —
a guard that reads as a correctness proof — reproduces the defect this ADR
exists to close, with a green build attached. The guards convert **silent
omission** into **a visible claim with a name on it**. Judgement remains human,
and #850 is where it is scheduled to happen.

### 4. The structural fix is named, not deferred by silence

#851 records the observation that most of what rotted (Working today, Accepted
and next, the bottleneck list) is an **aggregate over the ADR corpus and issue
state**, which ADR-052 §1 and ADR-022 already say should be derived rather than
stored, and half of which is as-built content sitting outside its own docs lane.
It is the only one of the four that removes the failure class rather than
detecting it, and it is `needs-grill` rather than scheduled here.

## Consequences

- **Good:** the ADR-023 drift class becomes unmissable at the moment it is
  created. The four mechanisms have non-overlapping jobs, so none has to be
  argued as sufficient. The reasoning behind the split is in the decision record
  rather than in an issue thread.
- **Cost / bad:** four mechanisms is more than one, and three are unbuilt at
  merge time — a partially-built defence is easy to mistake for a complete one,
  which is why §3 exists. The citation guard adds a `pr-guards` step (~1s) and
  ships reporting-only, so between this merge and #842 it is a green check
  emitting warnings, which is a state that can be ignored indefinitely. The
  acknowledgement window (six lines) is a heuristic; a citation and its
  successor separated by a long block quote will report a false positive, and
  the fix is to reword rather than to widen the window.
- **Follow-up:** #842 to #846 (the drift itself, and the flip to `fail`) ·
  #848 (declaration block) · #850 (watermark) · #851 (derive the cut line) ·
  #847 and #620 (ADR-043 is still stamped `Proposed` on `dev`, so the rule this
  ADR operationalises is not yet formally Accepted).
- **Amended 2026-08-24, after acceptance (ADR-039 §1):** #848 was closed `wontfix`, so
  this decision stands as **three** mechanisms, not four. The reasoning above is unchanged and is why the
  block was considered at all; what changed is the verdict on building it. See
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) §7, which
  records what is given up (per-ADR attribution) and why the ADR-052 §2 argument
  in §2 above does not survive: the watermark derives from `Accepted-on-dev`, a
  stamped event, not from the block.

## Links

- Builds on: [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md),
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)
- Related: [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md),
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md) (machine identifiers
  in human prose), [ADR-049](./ADR049_PARA_Containment_Primary_And_Secondary_Edges.md)
  (an ADR written because the decision lived only in an issue thread)
- Issues: #841 (the audit), #849 (this guard), #848, #850, #851, #842–#846, #847
- Implementation: `scripts/check-adr-citations.js`,
  `packages/mcp-server/src/__tests__/checkAdrCitations.test.ts`,
  `.github/workflows/pr-guards.yml` (step 2a)
