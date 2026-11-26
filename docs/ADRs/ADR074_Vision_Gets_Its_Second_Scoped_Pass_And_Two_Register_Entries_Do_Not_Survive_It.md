# ADR-074: `vision.md` gets its second scoped pass, and two register entries do not survive it

- **Status:** Accepted
- **Created:** 2026-08-28
- **Accepted-on-dev:** 2026-08-28
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (a bump requires evidence),
  [ADR-068](./ADR068_Vision_Gets_Its_Scoped_Pass_And_The_Watermark_Goes_Live.md) (the first pass, whose shape this repeats),
  [ADR-070](./ADR070_Architecture_Gets_Its_Second_Scoped_Pass_Against_The_064_To_068_Gap.md) (the same treatment applied to `architecture.md`)

## Context and problem

Two windows, reviewed together because they land in the same document.

**The gap.** `vision.md` read 5 behind, at the threshold:

```
BEHIND  docs/vision.md — is 5 ADR(s) behind, the oldest unreviewed landing 1 day(s) ago
          in the gap: ADR-069, ADR-070, ADR-071, ADR-072, ADR-073
```

**Three register entries**, each recorded as an ADR reflected in `architecture.md` and not
in this document: ADR-037, ADR-056 and ADR-028. All three were half-closed by ADR-064's
pass (#905), which fixed the architecture side; the vision side was left because ADR-068's
window was ADR-060 to ADR-067 and all three sit outside it.

**Two of the three did not survive contact with the current document**, which is the more
useful result and the reason this ADR is not simply three edits.

## Decision

### 1. The gap was 5, and only two needed reading

| ADR | Vision bearing | Disposition |
|---|---|---|
| **069** | one item is one atom | Covered — R4 was rewritten for it in #915/#916, in the PR that decided it (ADR-039 §2) |
| **070** | architecture's scoped pass | **None.** A review of a different document |
| **071** | guards run locally | **Material, narrowly** — §*Keeping this document true* describes what keeps this file honest, and ADR-071 changed where those mechanisms execute and repaired the watermark's own measurement |
| **072** | the stamp is a `post-merge` hook | **Material, narrowly** — same section, same reason |
| **073** | the pre-rule corpus is backfilled | **None.** Metadata about ADR ordering; changes nothing about what ahOS is for |

### 2. ADR-037 is not missing, and the entry describing it has decayed

The register recorded *"vision.md cites ADR-036 for the vocabulary layer and never
ADR-037"*, evidenced by `grep -n 'ADR-037' docs/vision.md → no match`. That grep now
returns two hits (§*Accepted and next*, §*Where the trail lives*), both pairing `ADR-036/037`.
ADR-066's rewrite (#907) resolved it in passing, without anyone recording that it had.

More to the point, the citation was never wrong. **ADR-037 refines ADR-036 §1 and §1a
only**, and says so in its own header: *"ADR-036's C+C decision (registry rows,
`instance_of` derived) stands; this ADR only sharpens how the IRI itself is physically
stored."* Every bare `ADR-036` citation in this document is about §2, derive-at-read —
the part that stands:

```
:175  ADR-036 is titled "instance_of derived at read" and its §2 is "derived, never written"
:185  ADR-036 already chose derive-at-read
:192  ADR-036 made read-time derivation the house pattern
:422  ADR-036 downgrades the triple store to "a soft block for now, not forever"
```

**No edit.** Closed as verified-absent rather than fixed, which is a different outcome and
worth distinguishing: nobody should later "restore" a correction that was never needed.

### 3. ADR-056 is genuinely missing, and from the one section that cannot afford it

§*Keeping this document true* named ADR-039 §2 and ADR-043 and stopped. Those are the
**rules**. ADR-056 is the ADR that decided *what enforces them*, and the document carried
one of its mechanisms — the `Reviewed-against:` watermark, four lines from the top — while
explaining none of it.

The section now names the four mechanisms ADR-056 accepted, says three ship (#848 closed
`wontfix`, ADR-059 §7 narrowed the set), and states what they do and do not prove.

**A correction to what this pass first wrote.** The draft called ADR-039 §2 and ADR-043
*"two of the three mechanisms"*. They are not mechanisms at all; ADR-056 lists the citation
guard, the watermark, the declaration block and de-storing the derived sections, and
*builds on* ADR-039 and ADR-043 as the rules. Caught by reading ADR-056's table rather than
trusting the sentence. Recorded because a scoped pass that cannot report its own errors is
the thing ADR-052 §4 refuses.

### 4. ADR-028's frame is already here; what was missing is that the document argues with it

The entry asked whether ADR-028's *"registry over a federation of surfaces"* framing should
displace this document's own. It should not, and the question was the wrong one: the frames
are the same claim in different vocabulary. *"Surface plurality is the premise"* and
*"coherence, not consolidation — make knowledge coherent where it lives"* is
map-don't-store, stated as a thesis rather than as a storage rule.

**The real finding is a contradiction the document does not acknowledge.** §*Storage* says
*"'Map, don't store' is still in circulation as a principle and does not hold"*, attributes
the phrase to ADR-016, and stops. But **ADR-028's first decision driver is verbatim "Map,
don't store"**, and ADR-028 is the later ADR. A reader who follows the citation finds a
live decision opening with a phrase this document declares dead.

They reconcile, and the note now says how: in ADR-028 it is a driver for the narrower
`reference` vs `content` question, and its answer is the L3 rule read from the other side.
A `reference` artifact is exactly the "map when there's a reason" case.

### 5. The watermark moves to ADR-073, and `architecture.md` is deliberately not covered

`Reviewed-against: ADR-073 · 2026-08-28 · evidence: ADR-074`. ADR-073 is the newest ADR in
the gap and is stamped, so the check can resolve it — the first time in this sequence that
a pass has been able to name the true head rather than understate (ADR-072 made the stamp
reliable).

**`architecture.md` stays 5 behind.** All three register entries were vision-side halves,
and the ADR-069–073 gap against `architecture.md` is a different reading of a different
document. Doing it here would be the unbounded pass ADR-064 and ADR-068 both refused. It is
outstanding work, and saying so is cheaper than a watermark that claims a review nobody did.

**What the claim covers** (ADR-059): all five ADRs in the gap were dispositioned, the two
with live bearing read in full against this document, and the three register entries
re-derived against the current text rather than against their own descriptions. It does
**not** cover re-deriving the vision from all 74 ADRs.

## Consequences

**Two of three register entries closed without an edit to the thing they described.** One
had been fixed by an unrelated rewrite; one was asking the wrong question. That is a
result about the register: an entry is a claim with a timestamp, and it decays like any
other. Re-deriving before fixing is the difference between closing a defect and performing
one.

**§*Keeping this document true* is now the only section that describes its own
enforcement**, including the two ways it can still be wrong: a bumped watermark proves a
claim was made, not that it was right, and until ADR-071 §4 the gap it measured could be
silently understated.

**The alarm completed a second cycle.** It went to zero under ADR-068, drifted to five as
ADR-069 through ADR-073 landed in a single day, and fired. That is the ADR-064 prediction
holding for the second time, and this is the pass it asked for.

**The enforcement gap is unchanged**, as ADR-063, ADR-064, ADR-066, ADR-068 and ADR-070
each recorded. Nothing made ADR-071 or ADR-072 update this document when they landed; the
threshold caught it a day later.

## Refs

#848 · #850 · #862 · #867 · #905 · #907 · ADR-016 · ADR-028 · ADR-036 · ADR-037 ·
ADR-039 §2 · ADR-043 · ADR-052 §4 · ADR-056 · ADR-059 §7 · ADR-064 · ADR-068 · ADR-070 ·
ADR-071 §4 · ADR-072
