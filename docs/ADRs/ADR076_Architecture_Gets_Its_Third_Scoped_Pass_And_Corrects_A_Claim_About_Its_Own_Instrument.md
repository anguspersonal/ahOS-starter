# ADR-076: `architecture.md` gets its third scoped pass, and corrects a claim about its own instrument

- **Status:** Accepted
- **Created:** 2026-08-28
- **Accepted-on-dev:** 2026-08-28
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, architecture, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (a bump requires evidence; understating self-corrects),
  [ADR-070](./ADR070_Architecture_Gets_Its_Second_Scoped_Pass_Against_The_064_To_068_Gap.md) (the second pass, whose shape this repeats),
  [ADR-071](./ADR071_Guards_Run_Locally_By_Default_CI_Is_The_Backstop.md) (§4 is the fix this document had not recorded),
  [ADR-075](./ADR075_Four_Lanes_And_An_Undecided_Question_Is_An_Issue.md) (this document is one of the four lanes, and the only one holding current state)

## Context and problem

`architecture.md` read **7 behind**, two past the threshold:

```
BEHIND  docs/architecture/architecture.md — is 7 ADR(s) behind
          in the gap: ADR-069, ADR-070, ADR-071, ADR-072, ADR-073, ADR-074, ADR-075
```

The gap opened because every pass since ADR-069 was vision-side. ADR-074 §5 said so
explicitly rather than hiding it — *"`architecture.md` stays 5 behind … it is outstanding
work, and saying so is cheaper than a watermark that claims a review nobody did"* — and
this is that work, two ADRs later.

**The finding is in the document's own freshness note**, which is the part of this file
that describes how it is kept true. It asserted, in the present tense, a defect that had
been fixed the day before.

## Decision

### 1. Seven in the gap, two with live bearing

| ADR | Bearing on `architecture.md` | Disposition |
|---|---|---|
| **069** | one item is one atom | **Already covered.** Landed in its own PR (#915/#916) under ADR-039 §2. Three citations at the entity-and-graph tools block, carrying §1, §2 and §3 |
| **070** | this document's second pass | **None.** A review of this document, already its watermark evidence |
| **071** | guards run locally; §4 repairs the watermark's own measurement | **Material.** §2 below |
| **072** | the stamper is a `post-merge` hook | **Material, narrowly.** Same note, same reason |
| **073** | the pre-rule corpus is backfilled | **Material, narrowly.** It is the follow-on to ADR-071 §4's widened blind spot, and the note now states where that number landed |
| **074** | `vision.md`'s second pass | **None.** A review of a different document |
| **075** | the four lanes | **Material, narrowly.** §3 below |

**ADR-069 needing no edit is the notable row.** It is the only ADR in this gap that
changed the system's shape, and it updated this document in the same PR, which is what
ADR-039 §2 asks for. The gap was made entirely of meta-ADRs that changed how the docs are
governed rather than what the system is. That is worth knowing before reading a 7 as
alarming.

### 2. The note claimed the watermark under-reports. It has not since ADR-071 §4

The freshness note read:

> an ADR merged still reading `Proposed` **is filtered out** before the gap is measured, so
> the figure **silently under-reports**

That was true when ADR-070 wrote it and false by the time anyone read it. ADR-071 §4
changed the instrument: unstamped ADRs are **counted and named** rather than dropped, held
out of `adrsBehind` only because an undated ADR genuinely cannot be placed in the canonical
order. The check now declares the blind spot instead of absorbing it.

**This is the worst class of staleness this document can carry**, and not because the claim
was large. A reader who believed it would discount every number in the file, including the
7 that prompted this pass. A stale fact about the instrument corrupts the reading of every
fact the instrument produces.

The note now states it as history, names the fix, and carries the two consequences that
followed: ADR-071's widened parser found ADR-006, ADR-008 and ADR-009 had never parsed at
all, and ADR-073 backfilled the datable remainder to leave three.

**One thing added rather than corrected.** The note listed three mechanisms and did not say
that one of them, ADR-039 §2's same-PR sync rule, has **no enforcement whatsoever**. Nothing
fails a PR that changes this document's shape and leaves it untouched. That absence is the
reason this ADR exists, so a note about freshness that omits it is selling the mechanisms
better than they perform.

### 3. This document's lane is now decided, not assumed

The Purpose section said *"the as-built 'what the system is now' doc (see `docs/README.md`
lanes)"*, pointing at a table that had no row for it. ADR-075 wrote the rows. The sentence
now names ADR-075 and states the boundary from the other side too: an undecided question is
a `needs-grill` issue, never a hedge in this file.

### 4. The watermark moves to ADR-075, and this pass claims no more than it did

`Reviewed-against: ADR-075 · 2026-08-28 · evidence: ADR-076`. ADR-075 is the newest ADR in
the gap and is stamped, so the check resolves it and this document reads level for the first
time since ADR-068.

**What the claim covers** (ADR-059): all seven ADRs in the gap dispositioned, the four with
any bearing read in full against this document, and the freshness note re-derived against
the current behaviour of `check-apex-watermark.js` rather than against its own description.
It does **not** cover re-deriving the architecture from all 76 ADRs, or against the code.
The ADR-064 refusal of the unbounded pass stands.

### 5. `vision.md`'s deliberate understatement is collected

ADR-075 set `vision.md` to `Reviewed-against: ADR-074` while naming ADR-075 as its
evidence, because ADR-075 was not stamped until it merged and a watermark cannot resolve an
ADR that is still `Proposed`. It said so in the line itself.

ADR-059's rule is that **understating self-corrects and overstating does not**, and this is
the self-correction: the review it names did happen, against ADR-075, and ADR-075 is now
stamped. The line moves to ADR-075 with no new reading.

Bundled here rather than left for its own PR because it is a metadata correction under
ADR-039 §1 that this pass's own claim depends on: §4 asserts both apex docs are level, and
that is only true once this one line moves.

## Consequences

**Both apex docs are level for the first time.** `vision.md` sits at ADR-075 and so does
this one. That state has not held since the watermark went live, and it will not hold long:
the alarm has now fired three times on a threshold of five, and nothing prevents a fourth.

**The 7 was not seven ADRs of drift.** Six of the seven were meta-ADRs about how the
documentation is governed, and the one that changed the system updated this file in its own
PR. The threshold measures ADRs, not shape changes, and cannot tell the difference. That is
not a defect in the threshold — an undifferentiated count is what makes it cheap and
unfakeable — but it is worth recording that a high number can mean a busy week in `docs/`
rather than a stale architecture.

**A document that describes its own instrument can be stale about the instrument.** The
freshness note is the newest and most-edited part of this file and it still carried a
day-old falsehood, because nobody re-reads the part of a document that explains how the
document is kept true. Both prior passes read the body and left the note alone.

**The enforcement gap is unchanged**, as ADR-063, ADR-064, ADR-066, ADR-068, ADR-070,
ADR-074 and ADR-075 each recorded in turn, and it is now stated in the document itself
rather than only in the ADRs. ADR-059 §7 settled that the mechanism for closing it is
declined until a second maintainer, so this is an accepted gap and not a queued task.

## Refs

#915 · #916 · ADR-039 §2 · ADR-043 · ADR-056 · ADR-059 §7 · ADR-063 · ADR-064 · ADR-065 ·
ADR-068 · ADR-069 · ADR-070 · ADR-071 §4 · ADR-072 · ADR-073 · ADR-074 §5 · ADR-075
