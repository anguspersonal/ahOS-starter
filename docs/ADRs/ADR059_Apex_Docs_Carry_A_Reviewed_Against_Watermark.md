# ADR-059: The apex docs carry a `Reviewed-against` watermark, and the gap is measured in unreviewed decisions rather than elapsed time

- **Status:** Accepted
- **Created:** 2026-08-24
- **Accepted-on-dev:** 2026-08-24
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, architecture, governance, ci
- **Builds on:** [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (mechanism 2 of the four it considered — this is the build, and §7 narrows the set to three),
  [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md) (§4 report your own absence; §10 alert on crossing, not on holding),
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (the rule this schedules a check for),
  [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) (`Accepted-on-dev` is the canonical ordering key)
- **Resolves:** #850

---

> **Same-PR sync note (ADR-039 §2).** Adds one metadata line to
> `docs/architecture/architecture.md` and one to `docs/vision.md`, plus a scheduled
> workflow. No components, boundaries, flows or runtime topology change. The apex-doc
> edits are metadata, not decision content, so ADR-043's substantive-change rule is not
> what brings this ADR into being — ADR-056's decision table already accepted the
> mechanism. This ADR exists to record the three things that table left open (§1 to §6),
> and the one it later gave up (§7, added by amendment — #848 closed `wontfix`, so three
> mechanisms ship rather than four).

## Context and problem

[ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) accepted four
mechanisms for apex-doc freshness and gave this one its job: **report its own absence**.
Of the five drift points #841 found, two (#843's `domain` collision, #845's understated
multi-user line) left no trace in any ADR file. No citation went stale, no status
flipped, no declaration was skipped. They were semantic collisions between a document
and a corpus, visible only to a human reading one against the other.

Nothing catches those except a human reading the doc. What can be built is the thing
that says nobody has, which is ADR-052 §4's test: *"a surface that cannot report on its
own absence is not a health surface."* Every other mechanism in ADR-056 lives inside the
act of writing an ADR, so none can report that nobody looked at the vision for a month.

ADR-056 named the mechanism and #850 specified it. Three questions were left open, and
§1 to §6 close them. §7 records a fourth thing that changed after ADR-056 was written:
the declaration block it kept as mechanism 3 is not being built.

## Decision drivers

1. **A signal that fires when nothing is wrong is worse than no signal**, because it
   trains the reader to close the issue unread — the failure ADR-052 §10 was written
   against.
2. **The watermark must never overclaim.** A freshness marker that says more than was
   actually read is the same confident-wrong-answer defect as a stale vision, wearing a
   date.
3. **Declare the blind spot.** A check that quietly excludes part of its input is the
   defect this mechanism exists to catch.

## Decision

### 1. What the watermark is

One line in each apex doc's header:

```
**Reviewed-against:** ADR-055 · 2026-08-24 · evidence: ADR-057
**Reviewed-against:** never · evidence: ADR-059
```

Three `·`-separated facts: the newest ADR the review covered (or `never`), the date the
review happened, and the evidence it produced.

**The named ADR is the newest one accepted on `dev` at review time**, never one landing
in the same PR. So a batch that mints its own ADRs understates its own freshness by
those ADRs. That is deliberate: understating is self-correcting and overstating is not.
`vision.md` therefore ships watermarked `ADR-055` even though ADRs 056 to 059 were
written with it open.

**The watermark is not a citation.** It records how far a reading got, and that stays
true after the named ADR is superseded. ADR-056's citation guard is amended to skip the
line for that reason — asking a historical marker to keep acknowledging successors is
the opposite of what a watermark is for.

### 2. The gap is measured in unreviewed decisions, not elapsed time

#850 proposed "5 ADRs or 30 days, whichever first" without saying 30 days of what. Both
readings were available and they behave very differently:

| Clock | Fires when |
|---|---|
| Time since the review | A quiet month in which no decision was made |
| Age of the oldest unreviewed ADR (**chosen**) | One decision left unreconciled too long |

The first is rejected under driver 1. There is nothing to reconcile in a month with no
ADRs in it, and an issue saying otherwise is noise with a countdown attached. So:

- `adrsBehind` — live ADRs whose `Accepted-on-dev` sorts after the watermark
- `daysBehind` — age of the **oldest** of those, `0` when there are none

Alarm at **5 ADRs or 30 days**, both configurable. The ADR-count trigger fires faster
during a burst (August was 12 ADRs in 6 days), which is the right way round: a burst is
when a document goes wrong quickly.

`Superseded` and `Deprecated` ADRs count as part of the corpus. A supersession is itself
a decision the apex docs may need to reflect, and ADR-023 is precisely that case.

### 3. Bumping the watermark requires evidence

The `evidence:` field is required, and it is either a diff to the doc or an ADR
recording the range reviewed and that nothing needed to change. **An unexplained bump is
a tick-box**, and ADR-056 §3 already refused a mechanism that reads as a correctness
proof while checking one.

This is a convention, not a check. The line is one edit away from being false, exactly
as a `no` in #848's declaration block is. Stated here rather than implied, so the limit
is on the record with the mechanism rather than discovered later.

Where the evidence lives is settled by ADR-043: a substantive apex-doc change already
requires a minted ADR, so the review's artefact goes there. No new convention, no
`Reviewed:` log at the foot of the doc.

### 4. `architecture.md` starts at `never`, and that is the point

#850 asked whether `architecture.md` should get the same treatment, and deferred on the
grounds that #408 left it incomplete. **#408 is closed** and the document now covers the
mcp-server, the capability registry and the remote MCP surface, so it gets a watermark.

Its honest value is `never`: parts of it have been reconciled piecemeal under ADR-039
§2's same-PR rule (`architecture.md:147` acknowledges ADR-051 and ADR-054), but **no
batch review has ever been performed**. The first scheduled run will therefore open an
issue naming **every ADR accepted on `dev`** — 27 when this was written, 32 once ADRs 056
to 060 were stamped, and growing until the review happens. The figure is deliberately not
pinned here: a hand-written count of a growing corpus is the exact drift class this ADR
exists to report.

That is not a bug in the check, it is the first true thing it has ever said, and
inventing a flattering starting watermark to avoid it would be the overclaim driver 2
forbids. The cost is real and is recorded in Consequences.

### 5. The blind spot is reported, not hidden

Twenty-four live ADRs predate the `Accepted-on-dev` rule and carry no date. They cannot
be placed in canonical order, so they sit in no gap — correct for them, but a **new** ADR
landing undated would be invisible for the same reason. The check counts them and the
issue names them under *Outside this measurement*, per driver 3.

A watermark naming an ADR that cannot be placed is reported as `unresolvable` rather
than resolved leniently: it looks like a claim and measures nothing, which is worse than
no watermark at all.

### 6. One issue, scheduled weekly

Weekly, on `dev`, opening **one** issue on crossing, editing it in place as the gap
grows, closing it when every watermark is back within threshold. Never a weekly
duplicate — ADR-052 §10's alert-on-crossing rule.

`dev` rather than `main`, because `Accepted-on-dev` is the ordering key and `main` lags
by a release, so it would report a gap that is already closed. Weekly rather than daily,
because the input only changes when an ADR merges, and re-posting the same numbers six
times is how a health surface becomes wallpaper.

Not a PR guard: the failure being detected is elapsed time with nothing happening, which
a PR-triggered check cannot see by construction, and blocking an unrelated PR on a
document nobody has read punishes whoever happens to push next.

### 7. The declaration block is not built — three mechanisms, not four (#848)

> **Amended 2026-08-24, after acceptance (ADR-039 §1).** This section was added the same
> day this ADR reached `dev`, when Angus closed #848. The sections above are unchanged.

ADR-056 decided four mechanisms and shipped one. #849, #851 and this ADR are the other
three. **#848 is closed `wontfix`**, so what actually ships is three, and that narrowing
is recorded here rather than left as an issue that quietly ages.

The case against it is ADR-056's own scoring, which never improved on further thought.
It catches **two of five** observed drift points, both contingent on an honest tick; the
`no` box is available on every ADR and is unfalsifiable by construction; and it asks a
**document-level** question with an **ADR-level** instrument — "does this substantially
change the vision" is a question about the vision, best answered by reading it. Against
that, it would tax every ADR written from now on, forever.

The other three now cover the classes it would have covered. What it uniquely offered
was **attribution**, and that is what is knowingly given up: *which ADRs claimed they did
not change the vision* stays an audit rather than a query.

**The ADR-052 §2 objection does not survive contact.** ADR-056 §2 cast the block as the
*event* and this ADR's watermark as the *aggregate*, and warned that an aggregate without
an event behind it is a store that only knows the days it ran. But the watermark does not
derive from the block and never did: `adrsBehind` and `daysBehind` derive from
`Accepted-on-dev`, which is a genuinely stamped event, is the canonical ordering key
(ADR-039), and is now guarded (#853). The aggregate has an event behind it. What #848
would have added is a *judgement* event on top — the one part of the chain that can be
dishonest without anything noticing.

**What would reopen it.** A second maintainer. Attribution is worth little when every
ADR has the same author, and worth a great deal when it does not — at that point "who
said this did not change the vision" is a question with more than one possible answer.

## Consequences

- **Good:** the one drift class no guard can see now has a mechanism that reports nobody
  has looked. It reports its own blind spot as well as its finding, and it says nothing
  during a quiet period, so the times it does speak carry information.
- **Cost / bad:** the first run opens an issue naming **27 unreviewed ADRs against
  `architecture.md`**. A 27-ADR review is exactly the kind of task that gets ignored, and
  an ignored issue on day one is how this mechanism becomes wallpaper before it has said
  anything else. Mitigated only by the ADR index carrying a one-line summary of each,
  which is what a batch review actually reads; not mitigated by anything structural.
- **Cost / bad:** the watermark is one line away from being false and nothing checks the
  claim behind it, only its shape. §3 is the whole defence. This is the same limit
  ADR-056 §3 recorded for the other three mechanisms, and it is why there are four.
- **Resolved dependency:** the check is only as good as `Accepted-on-dev`, which #847
  found wrong on seventeen ADRs. **#853 landed on `dev` on 2026-08-24** and is merged into
  this branch, so `vision.md` resolves level rather than `unresolvable`. Had it not, the
  watermark would have measured nothing.
- **Cost / bad:** §7 closes #848, so ADR-056's four mechanisms ship as three and the
  per-ADR attribution ledger is not built. Nothing records which ADRs claimed they did
  not change the vision; establishing that after the fact is an audit.
- **Follow-up:** reconciling `architecture.md` against its 27-ADR backlog is the work the
  first scheduled issue will describe. #848 reopens if a second maintainer joins.

## Links

- Resolves: #850 · part of #841
- Builds on: ADR-056 (mechanism 2), ADR-052 §4/§10, ADR-043, ADR-039
- Amends: ADR-056's decision from four mechanisms to three (§7 — #848 `wontfix`)
- Related: [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) §3 (which
  named this as the remaining mechanism for the class), #848, #849, #853, #408
- Implementation: `.github/scripts/check-apex-watermark.js`,
  `.github/scripts/check-apex-watermark.test.js`,
  `.github/workflows/apex-watermark.yml`, `scripts/check-adr-citations.js`
  (watermark-line exclusion)
