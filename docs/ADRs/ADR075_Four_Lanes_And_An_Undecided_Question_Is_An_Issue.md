# ADR-075: Four lanes, and an undecided question is an Issue

- **Status:** Accepted
- **Created:** 2026-08-28
- **Accepted-on-dev:** 2026-08-28
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, process
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) (decision content is immutable once Accepted; the `ADR-DRAFT-*` dance is retired),
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) (as-built belongs to `architecture.md`; this finishes the job on four sites it missed),
  [ADR-065](./ADR065_ADR_Acceptance_Is_Stamped_Automatically_On_Merge_To_Dev.md) (merging to `dev` *is* the act of accepting),
  [ADR-072](./ADR072_The_Post_Merge_Hook_Stamps_And_Commits.md) (and a hook now does it within minutes of a pull)

## Context and problem

`docs/README.md` carries a *"Where does X go?"* table with nine rows. It has **no row for
`vision.md`** and **no row for a question that has not been decided**. Both gaps have been
paid for.

**The as-built gap.** ADR-058 moved as-built state out of `vision.md` and into
`architecture.md`. It did that job on §*Working today*, which now says so in its own words
— *"a second copy here would be two records of one fact, free to disagree"* — and missed
four other sites in the same document, one of them a table column literally headed
**Status**.

**The undecided gap.** §*What this document does not decide* holds five open questions in a
document whose every other sentence is a settled position. Three of them carry a leaning or
a leading candidate, which is exactly the kind of content that moves.

**And a question left open since ADR-063.** Its *what this does not decide* list included
*"whether `vision.md` should carry an* Accepted and next *list at all, given that every one
of its six stale entries failed in the same direction"*. The discrepancy register carried it
forward as **D49** and recorded it as a judgement call for the author. It is not a judgement call. It is a lane question, and the reason it
looked like taste is that the lane rule had never been written down.

The prompt for writing it down was a plain observation: *the word "Accepted" in that heading
does no work, because everything in `vision.md` is accepted by definition.* That is true, and
it generalises.

## Decision

### 1. Four lanes, and what each one is for

| Lane | Holds | Mutability |
|---|---|---|
| **`vision.md`** | Where the system is going, the load-bearing principles, the cut line | Everything it **asserts** is accepted |
| **`architecture/architecture.md`** | Current state, as-built | Tracks reality; changes when reality does |
| **`docs/ADRs/`** | *Why* a structural choice was made, and what was rejected | **Immutable** once Accepted (ADR-039 §1) |
| **GitHub Issues** | Plans, backlog, and **questions not yet decided** | Mutable by design |

The fourth lane is not new — `docs/README.md` already says *"A plan / spec / requirement /
backlog item → **GitHub Issues.** Never `docs/`."* What is new is that **an undecided
question is one of those things**, and that the first lane exists at all.

### 2. "Accepted by definition" is a rule about assertions, not about topics

The obvious reading of §1 is that an open question cannot appear in `vision.md`, since it is
not accepted. That reading is wrong and would delete the most protective section in the file.

**A named non-decision is itself an assertion about direction, and an accepted one.** It is
accepted that we have not decided how RAG status is computed. What is *not* accepted, and
what moves, is the reasoning underneath: the rubric, the leaning, the leading candidate.

So the split is between the fence and what stands behind it, not between decided and
undecided topics.

### 3. An open question is an Issue, never an ADR

Three independent reasons, any one of which is sufficient:

**Immutability.** ADR-039 §1 freezes decision content once Accepted. An ADR recording
*"leaning: rule-derived first"* could not be revised when the leaning moved; it would need a
successor ADR each time. A chain of superseded records tracking a decision that has not
happened yet is the worst available fit, not the best.

**There is no home on `dev` for a Proposed ADR.** The ADR README's status rule is that an
ADR *"becomes `Accepted` **only when merged to `dev`**"*, which makes the merge the act of
acceptance. ADR-065 automated it and ADR-072 put it in a `post-merge` hook, so a
deliberately-Proposed ADR is flipped to `Accepted` on the next `git pull` — asserting a
decision nobody made, and then freezing it.

**The old mechanism for this is retired.** `ADR-DRAFT-<slug>.md` was the answer to
"where does an unaccepted ADR live", and ADR-039 retired it: it *"traded a collision risk
for citation instability (slug → integer mid-life) plus rename churn, and failed anyway (the
024 collision)"*. Three legacy drafts survive on `dev` and ADR-065 carries a permanent
exemption so the stamper never touches them. **That exemption is grandfathering, not an
invitation.** New drafts do not get created.

### 4. The fence stays in `vision.md`; the reasoning moves to the Issue

§*What this document does not decide* keeps its purpose, stated in its own opening line:
*"silently assuming a decision is how this document drifts."* Move the section wholesale and
that protection disappears from the exact document it protects, which is the failure the
section was built to prevent.

Each item keeps a one-line fence. The rubric, the leaning and the candidate move to a
`needs-grill` issue, where they can change without ceremony and where, on resolution, they
graduate into a numbered ADR with the argument already attached.

**The corollary matters more than the rule: not every fence needs an issue.** Applying this
to the five items gives three different answers, and that is the correct outcome rather than
an inconsistency:

| Item | Behind the fence | Treatment |
|---|---|---|
| 1. L3 map-versus-store | a four-reason rubric and a per-connector line | fence + issue (#936) |
| 2. What computes RAG status | three options and a stated leaning | fence + issue (#934) |
| 3. How an entity's domain is assigned | a leading candidate and a storage argument | fence + issue (#935) |
| 4. How far read-time inference should go | two sentences, nothing behind them | **fence only** |
| 5. Conflict and loop semantics | deliberately open, with a stated trigger | **fence only** |

Item 5 is the instructive one. *"Deliberately open until it moves off the north star"* is a
fence with a trigger and no question behind it yet. Opening an issue for it would create a
backlog entry nobody can act on, which is how a `needs-grill` list stops being read.

**A fence with nothing behind it is complete as a fence.** The rule is *reasoning that moves
goes to Issues*, not *every bullet gets an issue*.

### 5. The four as-built sites in `vision.md` are corrected, and one heading is wrong twice

ADR-058's pass left four:

| Site | What it says |
|---|---|
| §*Load-bearing principles*, item 7 | *"live, with the binding layer shipped in #62"* |
| §*Inference runs at three tiers* | a table column headed **Status**, reading **Shipped** |
| §*Superseded here means superseded as a decision* | *"**#569** ships `dos`"* |
| §*Accepted and next* | *"the other two halves of #359 **shipped**"*, *"Entity/people CRUD **shipped** under #133"* |

The last is the sharpest, because that section **disclaims the thing it is doing**, five
lines below doing it: *"This list carries the judgement that something is worth doing next,
and nothing else."* It was not true as written.

**The heading is wrong twice over.** *Accepted* is redundant, since everything in this
document is accepted; *next* is build status, which is `architecture.md`'s lane. It becomes
**What we build next**, carrying priority judgement and issue numbers and no status at all.

**The rename has a cost, and it is paid rather than avoided.** ADR-058, ADR-063 and ADR-074
all refer to the section by its old name, and all three are Accepted and therefore immutable
(ADR-039 §1) — they cannot be updated to the new one, and should not be, since they describe
the document as it was. The section keeps a one-line note naming its former heading so a
reader arriving from any of them lands in the right place. Renaming a heading that three
frozen records cite is a real cost; leaving a heading that is wrong twice over is a larger
one.

This also explains a history the register recorded without diagnosing: #904 corrected six
stale entries in that section, every one of them in the same direction (shipped work still
listed as pending). They went stale *because* the section held status it had promised not to
hold. #904 fixed the entries and left the cause.

### 6. `docs/README.md` gains the two missing rows

The *"Where does X go?"* table is the operative statement of the lanes, so it is where the
gap gets closed rather than in this ADR alone.

## Consequences

**D49 stops being an open decision.** It was filed as *should this section exist*, a matter
of taste. Under §1 it is answered mechanically: keep the judgement, drop the status, rename
the heading. Two of the register's three remaining live entries were of this shape, which
suggests the register has been carrying lane questions as taste questions for a while.

**ADR-058's claim becomes true for the first time.** *"As-built state is that document's
lane"* has been the stated rule and a partially-kept one since #850. After this there is no
as-built state in `vision.md`.

**The `needs-grill` backlog acquires three entries with real arguments in them**, rather than
one-line prompts. That is the point of moving reasoning rather than deleting it.

**The enforcement gap is unchanged**, as ADR-063, ADR-064, ADR-066, ADR-068, ADR-070 and
ADR-074 each recorded in turn. Nothing stops the next edit putting a `Shipped` back into
`vision.md`; the citation guard does not read for lane violations and no guard proposed here
would. Saying so is cheaper than implying otherwise.

**This ADR is itself a test of §3.** It is a decision, so it is an ADR. The three questions
it displaces are not decisions, so they are issues. If that split is wrong, it is wrong here
first and visibly.

## Appendix: what was removed from the fences, verbatim

Recorded here so the repository never depends on an issue surviving to keep it. The live
versions are #934 and #935. **This
is a snapshot of what `vision.md` said on 2026-08-28, not a current statement of the
leaning** — the live version moves on the issue, and an ADR is exactly the wrong place to
look for what is currently believed about an open question (§3).

**Item 2, what computes RAG status:**

> Rule-derived (staleness, overdue, blocked), LLM-inferred, or user-asserted. *Leaning:
> rule-derived first — a rule you can read off is debuggable; an unexplainable verdict about
> your own life erodes trust the first time it is wrong.*

**Item 3, how an entity's domain is assigned:**

> *Leading candidate: derive it transitively along PARA containment (a task inherits its
> project's domain) and assert directly only where there is no chain to inherit from — which
> would make most assignments free.* Storage is part of the same question rather than a
> separate one: the old argument for a node-and-edge over a field was that multi-membership
> would duplicate, and that argument no longer applies.

**Item 1** lost nothing: its rubric is the four reasons in §*Storage*, which stay in the
document because they are a settled rubric, and only the per-connector line is open.

## Refs

#62 · #133 · #359 · #569 · #904 · ADR-016 · ADR-039 §1 · ADR-043 · ADR-051 · ADR-057 §7 ·
ADR-058 · ADR-063 · ADR-065 · ADR-072 · ADR-074 · D49
