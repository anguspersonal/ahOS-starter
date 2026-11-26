# ADR-058: The vision sheds as-built state to `architecture.md`, and the rest of the cut line stays hand-written

- **Status:** Accepted
- **Created:** 2026-08-24
- **Accepted-on-dev:** 2026-08-24
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, architecture, governance
- **Builds on:** [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change requires a minted ADR — this is that ADR),
  [ADR-057](./ADR057_Vision_Reconciled_Against_The_August_ADR_Batch.md) (the refresh this follows),
  [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) (a projection that also stores is neither),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (§1/§2 — derive aggregates, do not snapshot them)
- **Resolves:** #851

---

> **Same-PR sync note (ADR-039 §2).** This ADR moves content *into*
> `docs/architecture/architecture.md`, which changes in the same PR. No components,
> boundaries, flows or runtime topology change — only where an existing description of them
> is written down.

## Context and problem

`docs/vision.md`'s **cut line** — roughly a quarter of the document — answers "where are we
now?" in four parts: *Working today*, *Accepted and next*, *North star*, *Not now*.

#841's audit found that **four of its five drift points sat in that one region**. The
thesis, the load-bearing principles, the requirements and the open questions barely moved in
a month. The rot is not spread through the document; it is concentrated, and it is
concentrated in the parts that are least like prose.

#851 named why. Those parts are **aggregates** — facts computable from the ADR corpus and
issue state — stored by hand as a dated snapshot. The repo has already ruled on that shape
in another context, [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) §2:

> Stamp the event and the aggregate derives forever. Snapshot the aggregate and you have
> built a store that only knows the days it ran.

The cut line knew 2026-07-20 for a month. That is precisely the failure §2 describes, in a
markdown file rather than a table.

There is a second, sharper problem with *Working today* specifically. `CLAUDE.md` and
`docs/README.md` state the lane rule the whole repo runs on: **current state → `docs/`, why
→ `docs/ADRs/`, planning → GitHub Issues.** *Working today* is current state. It belongs to
`architecture.md`. Carrying it in the vision as well meant **two records of one fact, free
to disagree** — the failure [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) §16
and [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md) §1 both refuse
elsewhere.

## Decision drivers

1. **Remove the failure class where it is cheap; detect it where removal is not.** #849's
   citation guard and #850's watermark detect drift. Deleting a duplicated record removes
   the possibility of that particular drift entirely, which is strictly better where it
   applies.
2. **Do not pay for machinery whose input is unreliable.** Whatever replaces a hand-written
   aggregate must be at least as trustworthy as what it replaces.
3. **Keep the vision readable.** It exists to be read carefully by a person. A mechanism
   that makes it harder to read has taken more than it gave.

## Considered options

### Option A — leave the cut line alone

Rely on #849 and #850 to report staleness. Rejected in part: it accepts a duplicated
as-built record indefinitely, and duplication is the one problem here that can simply be
deleted rather than monitored.

### Option B — #851 in full: move *Working today*, and generate *Accepted and next*

Generate the second section from ADR `Status` + `Accepted-on-dev` cross-referenced against
issue state, delimited by markers in the prose. Rejected — see §2 below.

### Option C — move *Working today*, keep the rest hand-written (chosen)

#851's own stated minimum viable version: *delete Working today, point at
`architecture.md`, and let #850's review keep the rest current — no generator at all.*

## Decision

### 1. *Working today* moves to `architecture.md`

It becomes a **Capability status** section there: what runs, what is built but disabled, and
where derivation is thin. The vision keeps a pointer.

The split is **facts down, judgement up**. The list of what works is as-built state and
moves. The claim it supports — *"the live bottleneck is derivation quality, not derivation
existence; improving it beats adding anything new"* — is a priority call, which is exactly
what a vision is for, and stays.

`architecture.md` is fit to receive it: **#408 closed**, and it now covers the mcp-server,
the capability registry and the remote MCP surface. #851 named that dependency when it was
still open; it no longer is.

### 2. No generator for *Accepted and next*

Three reasons, in descending order of weight:

- **The input was wrong until today.** #847 found **seventeen** ADRs whose status metadata
  contradicted the README's own rule, some for months, and #853 is the fix. A section
  derived from ADR status would have been confidently wrong for that entire period, and
  would have *looked* authoritative while being so. #853's guard reduces that risk; it does
  not retire it.
- **It repeats a trade this repo has already refused.** Delimiting a generated block
  requires machine-readable markers in prose a human reads —
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md) rejected exactly that for the
  State Doc. The argument is weaker here (nobody reads `vision.md` every morning), but it is
  the same argument, and overturning it deserves its own decision rather than arriving as a
  side effect.
- **Label state is not run state.** ADR-052 §7's rule bears directly: a tile with no data
  behind it is marked structurally, never by a caption. A generated line asserting a
  capability exists, derived from a label that only records intent, is that failure.

*Accepted and next*, *North star* and *Not now* therefore stay hand-written. The last two
are genuine authored positions and do not rot at all; the first is small, and #849 and #850
are what report it going stale.

### 3. What this does not claim

This removes **one** duplicated record. It does not make the cut line self-maintaining, and
the section is still dated by hand. #850 remains the mechanism that would report the
staleness rather than requiring someone to notice it, and it is unaffected by this ADR.

## Consequences

- **Good:** the duplicated as-built record is gone, so the largest single source of the
  drift #841 found cannot recur. The lane rule is honoured rather than merely stated. The
  vision gets shorter in the part that was least worth reading there.
- **Cost / bad:** the vision no longer answers "what works today?" without a hop to another
  document, and the cut line was described in that document as "the most useful thing this
  document does". The loss is bounded — three of its four parts remain — but it is real, and
  a reader who wanted one page now needs two.
- **Cost / bad:** `architecture.md` now carries a section whose facts go stale on the same
  cadence the vision's did. Moving a maintenance burden is not discharging it. What changes
  is that the burden now sits in the document that is supposed to bear it, with only one
  copy to update.
- **Follow-up:** #850 (watermark) is now the main remaining mechanism for this class.
  #848 (declaration block) is unaffected.

## Links

- Resolves: #851 · part of #841
- Builds on: ADR-043, ADR-057, ADR-022, ADR-052 §1/§2
- Depended on: #408 (`architecture.md` backfill — closed, which is what made §1 possible)
- Related: ADR-040 (the markers-in-prose trade refused again here),
  ADR-051 §16 and ADR-054 §1 (one record per fact), #849, #850, #853
