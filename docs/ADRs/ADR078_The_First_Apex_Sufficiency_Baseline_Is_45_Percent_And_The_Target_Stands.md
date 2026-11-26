# ADR-078: The first apex-sufficiency baseline is 45%, and the 70% target stands

- **Status:** Accepted
- **Created:** 2026-08-28
- **Accepted-on-dev:** 2026-08-29
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, process
- **Builds on:** [ADR-077](./ADR077_The_Apex_Pair_Owes_A_Reader_Most_Design_Answers.md) (states the target and ships it unmeasured),
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) (the apex docs get shorter by de-storing, not longer),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (§7: a mechanism that does not earn its keep gets closed),
  [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md) (the four lanes, and where an undecided question lives)

## Context and problem

ADR-077 stated that `vision.md` plus `architecture.md` should settle roughly **70%** of the
design questions that arise, and shipped that target **unmeasured** because the GitHub API
rate limit was exhausted the day it was written. Its §5 committed to the first measurement
and its Consequences committed to withdrawal if the measurement never happened.

The measurement has now been taken, on
[#945](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/945). The result
is **9 of 20, or 45%**, against a 70% target.

Three things now need deciding, and leaving any of them implicit would reproduce the exact
failure ADR-077 was written against: a claim in an apex document that a reader cannot tell
apart from a result.

## Decision

### 1. The baseline is 45%, and it is recorded as a measurement rather than an estimate

Twenty open `needs-grill` issues, judged against `docs/vision.md` (watermark ADR-076) and
`docs/architecture/architecture.md` (watermark ADR-075) and **nothing else**. The pool was
the 46 open `needs-grill` issues on 2026-08-28, less #945 itself, which is the measurement
issue rather than a design question. Systematic sample over the pool sorted ascending by
issue number, indices `floor(i * 45/20)` for `i` in `0..19`:

```
173 313 344 447 494 569 576 589 597 635
638 657 666 703 741 744 810 812 875 934
```

**Result: 9 of 20.** Six on the first branch of ADR-077 §2 (the answer is stated and a
sentence can be pointed at), three on the second (the question is correctly fenced as open).
One of the nine, #810, is recorded as marginal; the strict reading that drops it gives 8 of
20, or 40%. The per-issue judgements and the sentence pointed at in each case are on #945,
so the number is checkable rather than asserted, which is ADR-052 §4's standard applied to
this ADR's own claim.

**The fence branch did not flatter the number.** That was the pre-registered worry, given
ADR-075 had just created three fences. It supplied 3 of 20, and it is worth recording that
the method survived its first obvious failure mode.

### 2. The 70% target stands, and the reason is a ceiling rather than optimism

ADR-077 predicted *"expect 70% to turn out to be the wrong figure."* The measurement says
otherwise, and this is the load-bearing half of this ADR.

Of the eleven misses, **three are the irreducible remainder**: #703 is config-schema detail,
#666 turns on an unresolved conflict between two Accepted ADRs and needs an erratum, and
#576 needs a data model that does not exist yet. Those belong to the ADR chain and always
did. They are 15% of the sample, which puts the **ceiling at roughly 85%**.

The other **eight fall into four clusters** (§4), each closable by one general statement.
Closing all four moves the sample from 9 to 16 or 17 of 20, which is **80 to 85%**.

So 70% is not an aspirational figure that the first measurement embarrassed. It sits
comfortably below a ceiling this sample can actually locate, and four sentences clear it.
**Lowering a target the evidence says is reachable would be the worse error**, because it
converts a bar into a description, and a target that only ever ratifies the current number
cannot fail. ADR-077's whole argument was that a falsifiable claim beats a safe one.

### 3. A fence counts in **either** apex document, not only in `vision.md`

ADR-077 §2's second branch reads *"point at the fence in §*What this document does not
decide*"*, which locates fences exclusively in `vision.md`. The measurement found two cases
(#744, #875) where `architecture.md` fenced a question correctly and named its issue, and a
literal reading of §2 scores both as misses. That under-counts the pair the metric exists to
measure.

**A question is fenced when either apex document states it is open and says where it lives.**

This is stated here as a new decision rather than stamped onto ADR-077 as an erratum, and
the distinction matters. ADR-039 §1's test is *if the edit requires no new decision it is
metadata; if it requires one, it is a new ADR*. Broadening what counts as a fence changes
what the metric measures, so it is a decision. Errata stay reserved for corrections that
need no judgement, which is what keeps them cheap enough to be honest.

### 4. The four absent principles are named, and each is a candidate ADR

ADR-077 §4 requires that a below-target result be answered with *which principle is absent*,
never with more prose. The four clusters, each with the issues it would settle:

| Absent statement | Would settle |
|---|---|
| Whether per-type handling policy for recognisable real-world artifact classes exists at all, and which lane it lives in | #589, #597, #590 |
| Whether `entities.properties` carries declared per-type shapes or stays free-form `jsonb` | #173, #344, part of #313 |
| Capability **authoring** as distinct from capability **serving**: canonical home, one source, where a defect goes | #447, #812, and #810's weakness |
| A default for the `audience` visibility axis | #741 |

**Three of these four are one sentence.** The first is a lane assignment rather than
content, which is to say it is answered by ADR-075's machinery and not by writing more into
either apex document. This is the point ADR-077 §4 exists to protect: a document that
answers more questions by growing has satisfied the target and broken ADR-058.

None of them is minted here. Each deserves its own decision with its own argument, and
bundling four into this one would produce exactly the unexamined agreement ADRs exist to
prevent.

### 5. This ADR changes no system shape, and says so

ADR-039 §2 requires an ADR that changes the system's shape to update `architecture.md` in
the same PR, and requires a process or meta ADR to state explicitly that it does not. This
is the latter: it changes a documentation obligation and the definition of a metric.
`architecture.md` is untouched, deliberately.

`vision.md` is updated in this PR, per ADR-043, because §*Keeping this document true*
currently states the target *"has never been measured"* and that sentence is now false.

## Consequences

**The claim has now failed once, which is what makes it a claim.** 45% against 70% is the
first result this mechanism has produced, and producing an uncomfortable number on the first
run is the strongest available evidence that the metric is measuring something. A target
that scored well on its first attempt would deserve more suspicion, not less.

**The next measurement is a re-run, not a redesign.** Same method, same sample size, on the
same trigger as a scoped pass (ADR-077 §6). The sample is drawn fresh, because the pool
moves; the indices rule makes it reproducible without making it identical. If the four
cluster ADRs land in between, the number should move, and if it does not, the clusters were
the wrong diagnosis and that is worth knowing.

**Withdrawal stays live as an outcome, on a narrower trigger.** ADR-077's Consequences made
withdrawal the honest response to a target that stayed *unmeasured*. That trigger has now
been discharged. The remaining one is narrower: a target that is measured, diagnosed, and
still does not move once the named principles land is a target measuring the wrong thing.
[#946](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/946) carries that
review.

**A metric can now be wrong in a second way.** §3 widened what counts as a fence, which
raises the score without either document changing. That is correct here, because the
documents were already doing the work and the definition was under-describing them, but it
is the kind of change that can be made for the wrong reason. Any future widening of the
definition belongs in an ADR for the same reason this one does.

## Refs

#945 · #946 · ADR-039 §1/§2 · ADR-043 · ADR-052 §4 · ADR-058 · ADR-059 §7 · ADR-075 · ADR-077 §2/§4/§5/§6
