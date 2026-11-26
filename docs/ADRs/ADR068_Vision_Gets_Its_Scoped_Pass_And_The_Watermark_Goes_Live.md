# ADR-068: `vision.md` is reconciled against the ADR-060–067 gap, and its watermark goes live

- **Status:** Accepted
- **Created:** 2026-08-26
- **Accepted-on-dev:** 2026-08-26
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, process
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (a bump requires evidence),
  [ADR-064](./ADR064_Architecture_Gets_A_Scoped_Reconciliation_Pass_And_Its_First_Watermark.md) (the same treatment applied to `architecture.md`),
  [ADR-066](./ADR066_The_Vision_States_What_Is_True_Not_How_It_Changed.md) and
  [ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md) (the two passes this closes over)

## Context and problem

`vision.md` sat at `Reviewed-against: ADR-059` while eight accepted ADRs landed after
it. Until #909 stamped ADR-065, ADR-066 and ADR-067, the watermark reported **5** and the
true figure was **8** — the under-reporting ADR-065 describes, where an unstamped ADR is
filtered out before the gap is measured.

A permanently-8-behind watermark is decorative. ADR-064 made the same argument for
`architecture.md`: the number is only load-bearing once it is at zero, because only then
does the next unsynced ADR move it off zero. This does for the vision what ADR-064 did for
architecture.

## Decision

### 1. The gap was 8, and only two ADRs needed reading

Traced before reading anything:

| ADR | Vision bearing | Disposition |
|---|---|---|
| **060** | metric semantics attach to the connection | **Material** — see §2 |
| **061** | meeting notes are a source adapter | **Material** — see §2 |
| **062** | atom identity is the entity | **Already covered** — ADR-067 §6 adjudicated its bearing on R2 and R4; the vision cites it twice, both from that pass |
| **063** | the settled-discrepancy reconciliation | Covered — the vision was its subject |
| **064** | architecture's scoped pass | Covered — it is the ADR that *identified* the R2/R4 debt ADR-067 then paid |
| **065** | ADR acceptance is auto-stamped | **No vision bearing.** A CI stamper does not change what ahOS is for, and neither apex doc cites it — correctly |
| **066** | the vision states what is true | Covered — it rewrote the document |
| **067** | the ritual queue is bounded | Covered — it edited R2, R4 and *Projections* |

So the real question was two ADRs against one document, not eight.

### 2. Two findings, both additive

**ADR-060 — R3's discipline is not graph-only.** R3 says *"ambiguity is surfaced, not
guessed"* and then illustrates it with three questions that are all graph-shaped: *is this
a duplicate? which person is this? which domain?* ADR-060 §4 applies the identical rule to
measurement — *"a connection with **no** contract declared must not read the same as one
with an **empty** contract. Unknown is not clean"* — and its driver names why the stakes
differ: a wrong metric is *"plausible, well-formatted, and arrives with no signal at all"*,
where a wrong email is a 403. R3 now carries the general form, with that asymmetry stated.

**ADR-061 — the adapter layer was unnamed.** *The model, in one sentence* claims *"one
capture primitive, one substrate, **no special cases**"*. ADR-061 §2/§3 is the mechanism
that makes that claim survive contact with producers that share no shape: an adapter at the
front that **only acquires** (find, fetch, capture, link, tidy — no classification, no
summarising), and per-format interpretation deferred to the read end. Without it, a reader
asks how a Plaud transcript and a Gemini notes doc both arrive with no special-casing, and
the document has no answer.

### 3. What was considered and deliberately left out

- **ADR-061 §6** (the web `analyze` → `cleaned_meeting_notes` path sitting on the wrong side
  of ADR-018) is as-built state. ADR-058 puts it in `architecture.md`, which already carries
  it at §3b. Not duplicated here.
- **ADR-061 §4** (multi-source precedence for a contested claim) is open, but it is already
  *placed* — it has a home in the read-end guidance and is tracked. *What this document does
  not decide* lists five broad questions; adding a tracked, placed one would turn it into an
  issue list.
- **ADR-060 §1/§2/§3/§5** (the `user_integrations` row shape, credential refs, the read-surface
  rules) are architecture, cited twice there already.

### 4. The watermark moves to ADR-067, and the stale `Date` is corrected

`Reviewed-against: ADR-067 · 2026-08-26 · evidence: ADR-068`. The header's `Date` also read
**2026-08-24** while ADR-066 had rewritten a fifth of the document that same day; corrected
to 2026-08-26. A stale date in a freshness-critical header is the defect class this whole
sequence exists to close.

**What the claim covers, stated so it is auditable rather than decorative** (ADR-059, and
the same limits ADR-064 stated): all eight ADRs in the gap were dispositioned, the two with
live bearing were read in full against the document, and the six others were each given a
stated reason. It does **not** cover re-deriving the vision from all 67 ADRs. An ADR outside
this gap whose decision section understates what it changed could still be missing.

## Consequences

**`vision.md` goes 8 behind → level, and the number becomes load-bearing.** The next ADR
that lands without updating it moves the watermark off zero immediately, which is the whole
purpose of the mechanism and was impossible while the baseline sat 8 back.

**Both apex docs now carry a live watermark for the first time.** `architecture.md` reached
zero in ADR-064 and is currently 4 behind (ADR-064 through ADR-067); the vision reaches zero
here. Nothing is at `never`, and neither number is being shrunk by an unstamped ADR.

**ADR-065 remains correctly uncited by both.** Recorded because a reader checking coverage
will notice: it is a CI mechanism, and an apex doc citing it would be the citation-for-its-
own-sake ADR-059 refuses.

**The enforcement gap is unchanged**, as ADR-063, ADR-064 and ADR-066 each recorded. Nothing
made ADR-060 or ADR-061 update the vision when they landed; a human noticed two days later.
The watermark measures the drift, it does not prevent it.

## Refs

#902 · #911 · ADR-043 · ADR-058 · ADR-059 · ADR-060 §4 · ADR-061 §2/§3/§4/§6 · ADR-062 ·
ADR-063 · ADR-064 · ADR-065 · ADR-066 · ADR-067
