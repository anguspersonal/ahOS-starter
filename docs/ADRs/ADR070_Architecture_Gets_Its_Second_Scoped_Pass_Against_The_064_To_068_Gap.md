# ADR-070: `architecture.md` gets its second scoped pass, against the ADR-064–068 gap

- **Status:** Accepted
- **Created:** 2026-08-27
- **Accepted-on-dev:** 2026-08-27
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, architecture, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) (as-built state belongs here),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (a bump requires evidence),
  [ADR-064](./ADR064_Architecture_Gets_A_Scoped_Reconciliation_Pass_And_Its_First_Watermark.md) (the first pass, whose shape this repeats),
  [ADR-068](./ADR068_Vision_Gets_Its_Scoped_Pass_And_The_Watermark_Goes_Live.md) (the same treatment applied to `vision.md`)

## Context and problem

`architecture.md` reached zero in ADR-064 and has been drifting since. As of `adfe435` the
check reads:

```
BEHIND  docs/architecture/architecture.md — is 5 ADR(s) behind
```

**That is the first time either apex doc has tripped its own alarm**, and it happened for
the right reason. The number read 4 until #915 hand-stamped ADR-068; the fifth ADR was
invisible because `check-apex-watermark.js` filters non-live ADRs before measuring, which is
the defect ADR-065 exists to close. Stamping revealed the real figure and the threshold
fired.

ADR-064's argument was that the number is load-bearing only from zero, because only then
does the next unsynced ADR move it. This is that prediction coming true, and the response it
implies: a pass, not a quiet bump.

## Decision

### 1. The gap was 5, and only two ADRs needed reading

Traced before reading anything:

| ADR | Architecture bearing | Disposition |
|---|---|---|
| **064** | the doc's own first pass | Covered — it *is* the review that set the current watermark, and is cited as its evidence |
| **065** | ADR acceptance is auto-stamped | **Material, narrowly** — see §2. Not in the body: a CI stamper does not change runtime architecture, and §Purpose scopes this document to runtime. But the header blockquote makes a claim about what keeps *this file* honest, and ADR-065 changed that |
| **066** | the vision states what is true | Covered — its as-built half already landed here in #907 (the `entity_type='domain'` blockquote now in §*Capability status*) |
| **067** | the ritual's queue is bounded | **Material** — see §2. §7 is the section that owns the read-side consumers and it says nothing about the queue's shape |
| **068** | the vision's scoped pass | **No architecture bearing.** It is a review of a different document; nothing in it describes runtime shape |

ADR-069 is deliberately excluded from the count: it is not stamped, so it is outside every
gap the tool measures. Its content already landed here in #915, in the same PR that decided
it (ADR-039 §2), so this pass has nothing to add for it.

So the real question was two ADRs against one document, not five.

### 2. Three findings, from two ADRs

**ADR-067 — §7 describes the consumers and not the queue.** §7's superseded-shape blockquote
already carries ADR-051's bound: *"consumption becomes two-level (artifacts → daily log →
state doc) so catch-up is bounded by **days** rather than atoms."* ADR-067 adds a second
bound one level in, and the document had neither it nor its refusal: the unconsumed-atom set
is canonical and the ritual reads a **bounded top-N slice** of it (ADR-022's shape), **nothing
decays** — an atom leaves the queue only by being consumed — ranking uses ADR-046 §3's
existing source roles rather than a new axis, and the bound is **reported** (*"showing 40 of
1,713 unconsumed"*) so a large backlog is a number rather than a silence. §7 now says so,
marked decided-and-unbuilt, which is what it is.

**ADR-067's measurement — "Working. … End-of-day synthesis for the `work` domain" is true
and misleading.** §*Capability status* opens *"Everything below is current reality, not a
plan"*, and on 2026-08-26 the reality was **36 of 43 days with no synthesis marker at all**;
of the seven that closed, two are `synthesized_unattended`, a machine draft nobody confirmed.
The capability works. It has run on 16% of days. Those are different claims and the section
made only the flattering one. This is as-built state and squarely ADR-058's lane.

**ADR-065 — the freshness blockquote overstates what the watermark proves.** The header says
the three mechanisms *"convert silent omission into a visible claim with a name on it."*
ADR-065's finding is that the claim could be **silently wrong**: an ADR merging `Proposed`
was filtered out before the gap was measured, so the watermark under-reported and said
nothing. It bit this repo four times in seventeen days, and the number above was 4 instead of
5 for that exact reason. One clause, because the mechanism is now decided even though it
cannot run.

### 3. What was considered and deliberately left out

- **ADR-067 §5's late-source mechanism.** Superseded by ADR-069 before this pass ran, and
  ADR-069's content is already here (§*Entities, people, and graph*). Adding it again would
  be two records of one fact.
- **ADR-065 in the body.** Recorded because a reader checking coverage will look for it: a CI
  stamper is not runtime architecture, and citing it beside the tool families would be the
  citation-for-its-own-sake ADR-059 refuses. The header note is the whole of its bearing.
- **ADR-066 and ADR-068's vision-side content.** Not this document's lane, by ADR-058.

### 4. The watermark moves to ADR-068, not ADR-070

`Reviewed-against: ADR-068 · 2026-08-27 · evidence: ADR-070`. **ADR-068 rather than ADR-070
for the same reason `vision.md` reads ADR-068 rather than ADR-069**: the check rejects a
watermark naming an ADR with no `Accepted-on-dev` date, and ADR-070 will merge `Proposed`
because ADR-065's stamper is a GitHub Action and Actions are quota-starved (#867). Naming it
would trade a real alarm for a broken one. Understating self-corrects; overstating does not
(ADR-059).

**What the claim covers, stated so it is auditable** (ADR-059, and the limits ADR-064 and
ADR-068 both stated): all five ADRs in the gap were dispositioned, the two with live bearing
were read in full against the document, and the three others were each given a stated reason.
It does **not** cover re-deriving the architecture from all 70 ADRs. An ADR outside this gap
whose decision section understates what it changed could still be missing.

## Consequences

**Both apex docs read level again**, and for the first time both are level with a gap that was
measured honestly rather than shrunk by an unstamped ADR.

**The alarm worked, start to finish.** ADR-064 predicted the number would become useful at
zero; #915 made it accurate by stamping; the threshold fired; this is the pass it asked for.
That is the whole mechanism completing one cycle, which it had never done before.

**Two ADRs now sit unstamped on `dev`** (ADR-069 and this one), so both watermarks will read
2 behind the moment #867 clears and the stamper runs. That is the understatement self-
correcting, exactly as intended, and needs no action.

**`§Capability status` now carries a number that will go stale.** "36 of 43 days" is dated
in place and #911 owns the investigation. A dated measurement that rots visibly is the trade
ADR-058 already made for this section; an undated "works" that rots invisibly is what it
replaced.

**The enforcement gap is unchanged**, as ADR-063, ADR-064, ADR-066 and ADR-068 each
recorded. Nothing made ADR-067 update this document when it landed; the alarm caught it a
day later, which is the mechanism measuring drift rather than preventing it.

## Refs

#569 · #573 · #862 · #867 · #902 · #911 · ADR-022 · ADR-039 §2 · ADR-043 · ADR-046 §3 ·
ADR-051 §10 · ADR-056 · ADR-058 · ADR-059 · ADR-064 · ADR-065 · ADR-066 · ADR-067 ·
ADR-068 · ADR-069
