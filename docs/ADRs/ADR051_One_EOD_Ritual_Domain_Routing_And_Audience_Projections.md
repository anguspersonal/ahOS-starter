# ADR-051: One EOD ritual — domain routes, audience shapes, and the ritual's output is never its input

- **Status:** Accepted — superseded in part by [ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md) (§1, the closed `team | briana | external` audience enumeration, which becomes an open set of named specs); **both errata resolved 2026-08-22**, and **§14 superseded in place** the same day (`dos-catchup` retires — catch-up folds into attended `dos`); **§11 amended 2026-09-25** (an entry declares the days it `Covers`, #1016) — see the Errata and Amendment sections below
- **Created:** 2026-08-06
- **Accepted-on-dev:** 2026-08-07
- **Deciders:** Angus (solo maintainer)
- **Supersedes:** [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md)
- **Amended by:** [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md) (§5: marking by considered is per atom for the narrative tier only; the Amendment 3 signal counts the narrative tier; the §13 evidence-only list comes from a day-scoped evidence aggregate, consumed by one row per day on the twin); [ADR-110](./ADR110_Metrics_Ride_Artifacts_And_State_Doc_Is_The_Human_Review_Gate.md) (§12 and §14: the State Doc promotion hop is the load-bearing human review gate; `evidence_aggregated_unattended` logs do not wait in the State Doc review queue); [ADR-112](./ADR112_Three_Ritual_Verbs_Prep_Sync_Reflect_And_Task_Anchored_Reconciliation.md) (§1, §4, and §5: unified ritual invocation grammar `[action] [scope] [attended]` across `prep`, `sync`/`synth`/`dos`, and `reflect`; `sync` Step 2b owns 100% of proactive task-anchored reconciliation and 3-rule staleness triage scaled by `[scope]`, while `reflect` is pure reflection with zero task-list hygiene; unattended runs stage `<verb>-proposal` artifacts across the 6-cadence schedule)

## Context and problem

[ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md)
(2026-06-20) partitioned end-of-day synthesis into three sibling consumers —
`dos-hl`, `dos-personal`, `dos-infra` — one per workspace family. It explicitly
considered and rejected the design this ADR now adopts, as its Option A
("generalize `dos-eod` into a multi-workspace router").

On 2026-08-05 the partition failed on an ordinary day. The day held both Work
work and KMS repo work, and **no single ritual could close it**: each would have
synthesised its own slice and left the rest unconsumed, so the day was
structurally incapable of reaching a closed state (evidence atom `94c41618`).

The partition is a property of the **output surfaces** (Work Notion vs
personal Notion vs the repo), not a property of the day. A day is one day.

Two things changed since June that make the rejected option correct now:

1. **#565** gives `/close` a narrative session-summary capture. GitHub sits at
   role `evidence` in [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md) §3 —
   "never narrate it alone" — so before #565 a coding day was structurally
   un-narratable without `dos-infra`. With a `narrative` atom per session, the
   repo-native destination stops being a *ritual* concern and becomes a
   projection concern, and ADR-023 §4's third destination disappears.
2. The mixed-day failure moved from hypothetical to **observed**.

Two live defects were found in the same investigation and are load-bearing here:
a scheduled automation writing machine-generated "Day in Review" artifacts into
the atom stream, where the next synthesis would read them as inputs (#568); and a
bulk ingest whose unenriched pointers drowned the day window (#567). Both are
instances of one unnamed invariant, stated in §9 below.

## Decision drivers

- **A real day is not partitioned.** The ritual must be able to close a mixed
  day, which is the common case, not the edge case.
- **The owner will not run three rituals a night.** Stated constraint. A design
  whose safety depends on running all three is not a design that runs.
- **Capture stays dumb; interpretation happens at read**
  ([ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)).
- **State docs are projections, never sinks**
  ([ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md),
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md)).
- **Catch-up must be bounded.** The 2026-08-04 failure (`318216cc`, #492) was an
  unbounded catch-up over two months of atoms that produced a confident synthesis
  of May. Any design that lets the backlog scale with elapsed time reproduces it.
- **The ritual's outputs must never become its inputs** (#568).
- **No new machinery beyond need** — single user, single maintainer.

## Considered options

### Option A — keep ADR-023's three sibling rituals

- **Pros:** cross-audience leakage is structurally impossible (`dos-personal`
  cannot write to a team-visible surface); each consumer owns a clean taxonomy;
  no change.
- **Cons:** cannot close a mixed day, which is most days; requires the owner to
  run three rituals a night, which he does not and will not do; and the
  guarantee it buys is only real if all three actually run.

### Option B — one ritual, one canonical summary, per-item visibility tags

One canonical day summary; every section carries a visibility scope
(`personal-only` / `hl-shareable` / `team-shareable`) assigned during the ritual;
projections filter on the tag, default-deny for untagged. This was the design as
first drafted on #569.

- **Pros:** one ritual; an explicit safety mechanism replacing the lost wall.
- **Cons:** three, each fatal.
  1. **It conflates two axes.** `hl-shareable` means both "may be seen inside
     Work" and "belongs to the Work surface", and those come apart — a
     personal appointment that blocks a workday is personal-domain but is a
     Work capacity fact; a candid read on a teammate is Work-domain but
     goes to no audience.
  2. **The tags do not work.** Projections are **transforms, not filters**: the
     team update actually sent on 2026-08-05 (`654ebd2e`) shares almost no
     sentences with the draft it came from. The generator must read everything
     to rewrite it, so a per-line visibility bit gives assurance without
     providing safety.
  3. **The safety they were bought for already exists.** See the Decision §2.

### Option C — one ritual, two axes: `domain` routes, `audience` shapes (chosen)

- **Pros:** closes a mixed day; keeps the structural guarantee (as routing);
  reduces the audience mechanism to what it is actually good at; needs no
  per-item tagging at write time.
- **Cons:** supersedes an Accepted ADR; the single ritual now owns taxonomies
  that were previously consumer-local; domain routing is a strong default rather
  than an absolute barrier (§7).

## Decision

We choose **Option C**.

### 1. Two axes, not one

- **`domain`** — flat set, `work` | `angus`. Routes an item to a destination.
- **`audience`** — `team` | `briana` | `external`. Shapes a report.

Repo/KMS work is **`angus`** domain, not a third domain. Its detail already lands
in GitHub during the day via `/close`'s persistence ladder (#565), so the ritual
does not re-type it into Notion. `dos-infra` dissolves.

### 2. The structural guarantee survives as domain routing

ADR-023's wall does **not** become a filtering step. Personal material goes to
the personal Notion; Work material to the Work Notion; **every report is
written off the Work side.** Personal material is never in the report pipeline
to leak from. Domain routing does the job the three rituals used to do.

The residual risk is narrower: **sensitive Work material reaching the wrong
Work audience.** Its guards are the standing exclusions in each audience spec
(§4) and manual send (§8).

**Therefore the audience axis is a shaping mechanism, not a safety one.** Option
B's default-deny and per-item visibility tags are rejected.

### 3. The day summary is paragraph + bullets + tomorrow

One per domain, and **each version carries its own paragraph** — a paragraph is
never shared across audiences, since that is exactly how personal material would
reach a team message. The `tomorrow` line is a short statement of intent and is
load-bearing for §5.

### 4. Audience filtering happens at report-generation time

Not at source. Shaping through the audience's lens *is* the filter. Per-audience
exclusions live as **standing rules in that audience's spec** ("never include
individual performance, pay, or contractor issues"), not as per-item tags.

An audience spec has three parts with different owners:

| Part | What it is | Who writes it |
|---|---|---|
| Register | how it sounds | human |
| Standing exclusions | what it never contains | human |
| Examples | recent real sends | accumulated automatically |

Specs are stored as **DB config per
[ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md)**, so they resolve
on any surface rather than only where a file happens to sit.

Paste-backs of what was actually sent become **examples, never rules**.
Self-editing rules drift invisibly — you cannot see what changed or when;
examples can simply be read. The team spec's founding examples are `0e0394ef`,
`9df2d048` and `654ebd2e`.

### 5. Intent comes from yesterday; calendar corroborates

The appraisal answers "how did the day go against what you meant to do" — daily
and narrow. Tracking against larger goals belongs to the weekly and monthly
reflection, not here.

- **Source: yesterday's `tomorrow` line.** The owner's own words are `narrative`
  (ADR-046 §3).
- **Corroboration: calendar.** `evidence` — may confirm, may not narrate alone. A
  meeting in the diary was *scheduled*, not *intended*.
- **Notion Tasks are deliberately excluded.** A backlog is not a statement of
  daily intent, and including it would drown the appraisal in everything merely
  due.

Each night's summary sets up the next night's appraisal; the chain closes on
itself with no extra machinery. This is the first real consumer of #490 /
ADR-046 §5's intent-modality question.

### 6. The ritual flow — one review gate, nothing written until approval

1. Agent reads the day's artifacts
2. Agent shows **in chat, before writing anything**: both daily summaries, the
   report draft, and the reflection questions
3. Owner edits any of them
4. Owner copies the report out of chat and **sends it himself**
5. One approval → everything saves to the right Notion
6. Prompt: *"if you changed the update before sending, paste it back"*

Reflection questions arrive **with** the summary — not before (answering cold,
unshown your own day) and not after approval (answers landing outside the summary
just saved). Step 6 exists because on 2026-08-05 the sent version differed
completely from the draft, and the sent version is the one the register was
derived from; without it the system stores the wrong artifact and never improves
at the thing it keeps being corrected on.

### 7. Reports: team nightly, Briana and external on demand

Marginal cost is low once the summary exists, but a draft that is never sent
becomes noise, and noise gets ignored.

**The `angus` domain produces no report by default** — nothing is ever drafted
off the personal side unprompted. It is **not blocked**, though: an explicit
request generates one. Domain routing is therefore a strong *default*, not an
absolute barrier, which is a second reason §8 is load-bearing.

### 8. Manual send is load-bearing

Dropping per-item visibility tags is safe **because a human reads every report
before it leaves**. If any report ever auto-sends, §2 and §4 must both be
revisited — default-allow is only defensible behind a human gate.

### 9. The ritual's own output is never the ritual's input

> **Anything the ritual writes is excluded from the day window the ritual later
> reads.**

#562 makes the daily log an artifact; left alone, tomorrow's day-window read
consumes today's log as an input. That is #568's defect arriving by design rather
than by accident.

The mechanism already exists unused: ADR-046 §3's **`excluded`** role — "synthesis
never touches it… `excluded` ≠ invisible; it means won't appear in the Daily
Log", described there as the parking tier with no initial members. **The ritual's
own outputs are its first inhabitants**: daily logs, state-doc projections,
reports. Searchable, never narratable.

Enforcement runs through `surface → role`, so this depends on ritual outputs
carrying a `surface` (#570).

### 10. Consumption is two-level

> **Amended 2026-08-22 — see Amendment 2 below.** The two-level model itself is
> **unchanged**, and is what makes the fold in that amendment cheap. Only the
> second arrow's parenthetical is stale: `dos-catchup` retires, so read
> *"(ritual, or `dos-catchup`)"* as **"(the attended `dos` session)"**. Which hop
> `synthesized` names is settled by Erratum 2's resolution below — the struck
> sentence at the end of this section stays struck.

```
artifacts   ──consumed by──▶   daily log    (same day, attended or unattended)
daily log   ──consumed by──▶   state doc    (ritual, or dos-catchup)
```

Artifacts are consumed by the daily log **of the day they were created**, whether
or not a human was present. The daily log is consumed by the state doc, which
**always requires human approval**.

**Catch-up is therefore only ever over daily logs, never over artifacts.** Miss a
week and the review is five logs, not two hundred atoms. This is what makes the
2026-08-04 failure shape unreachable rather than merely unlikely.

Mechanically this needs no new structure — ADR-013's link already carries
provider/kind/target, so two consumptions are two links with different targets.
~~It does change the scope of #560's `consumed_by_state` → `synthesized` rename,
which now names the **second hop only**.~~ **— contradicts ADR-050 §6 and the
shipped code; RESOLVED 2026-08-22 in favour of ADR-050 and the code, so the strike
stands. See Erratum 2 below.**

### 11. The daily log

> **Amended 2026-09-25 — see Amendment 4 below.** "One per domain" is keyed on the
> days an entry declares it covers (`Covers`, empty meaning its own `Date`), not on
> `Date` alone (#1016).

- **One per domain, written only if something was captured that day.** Nothing
  captured, no log.
- Written to **Notion including on unattended runs** — Notion is the better
  editing surface, so an unattended draft lands where it can actually be fixed.
- Carries two Notion page properties: `synthesized` / `synthesized_unattended`,
  and consumed / unconsumed.
- Its ahKMS twin is an artifact row with the same marker, an external link to the
  Notion row, and a ~~`consumed_by_state`~~ link to the state doc **whose kind was
  unnamed between 2026-08-20 and 2026-08-22 and is `consumed_by_state` once more —
  the strike records the two days the name did not exist. See Erratum 1 below**.

**The Notion properties are projections, not sources.** The marker lives in
ahKMS; Notion displays it; the direction is ahKMS → Notion, never the reverse
(ADR-022/ADR-040 shape; ADR-050 §8's no-second-store constraint). Two records of
whether a day was closed would eventually disagree.

**Every consumer reading the Daily Log must respect the marker** — the weekly
reflection and every report must skip or flag `synthesized_unattended` entries.
Without that, an unreviewed draft is later read as the owner's account of that
day, which is the entire risk of writing it to Notion.

### 12. Unattended runs

> **Amended 2026-08-22 — see Amendment 2 below.** The State Doc row's **rule is
> unchanged**: an unattended run still never touches the State Doc. Only the name
> of what does is stale — `dos-catchup` retires, and the **attended `dos`
> session** is what updates it, with approval.

| | Attended | Unattended |
|---|---|---|
| Day summary | owner edits | written, marked `synthesized_unattended` |
| Written to Notion | yes | yes |
| State doc | updated | **not touched** — only `dos-catchup` updates it, with approval |
| Team update | drafted, owner sends | **not drafted at all** |
| Reflection questions | asked | skipped |
| Appraisal | done | done, marked unverified |
| **`tomorrow` line** | owner writes it | **not written** |
| Marker | `synthesized` | `synthesized_unattended` |

**The `tomorrow` line is the one that matters.** §5 makes tomorrow's intent the
thing the next appraisal is judged against; a machine writing it means the system
judges the owner against intentions he never held — #568's loop returning with a
permission slip. So unattended writes no intent, and the following night's
appraisal **has no intent to compare against and says so** rather than inventing
one.

### 13. Evidence-only days list evidence; they do not narrate it

A day where nothing was captured first-person but forty emails arrived has
`evidence` and no account. Email, calendar and GitHub sit at `evidence`
(ADR-046 §3) — may corroborate, never narrate alone. This is exactly the day the
fallback fires, and exactly what the killed automation got wrong ("No new
artifacts were captured into AHKMS today — context reconstructed from calendar",
`7f1a80b5`).

The log **is** written and lists the evidence — meetings attended, mail received
— with the absence of a first-person account marked **structurally, not as a
sentence in the prose.** A prose disclaimer gets skimmed and the entry then reads
as the owner's day.

### 14. `dos-catchup`, and promotion

> **Superseded in place 2026-08-22 — see Amendment 2 below.** The **first bullet
> stands**: #561's machine half is unchanged. The **second does not**.
> `dos-catchup` is retired as a separate ritual, and the attended pass it names
> becomes the standing shape of `dos` itself — the nightly session fetches today's
> atoms **and all unconsumed daily logs**. The closing claims survive with one half
> renamed: they are still two halves rather than alternatives, and an edit in
> Notion alone still does **not** promote a day.

- **#561** (fallback sweep) writes the unattended daily log and stamps
  `synthesized_unattended`. Machine-only, draft-and-stop.
- **`dos-catchup`** is the attended pass that consumes those logs: reads all
  unattended daily logs, proposes state-doc updates, owner approves, logs marked
  consumed, days promote to `synthesized`.

They are two halves, not alternatives. An edit in Notion alone does **not**
promote a day — the system cannot infer that an edit means "I have reviewed
this."

### 15. A day is done because the ritual ran

Not because every destination received a write. A domain with no material that
day produces no summary, and that is not an incomplete day. The alternative means
an ordinary Tuesday with nothing personal in it registers as half-finished.

**The streak recovers on promotion**: the criterion is that the owner closed the
day, and doing it late still counts.

### 16. What carries forward from ADR-023

- §5 (**lineage stays shared**) survives unchanged and is extended by §10 here.
- §6 (**taxonomies are consumer-local**) survives **re-homed**: with one consumer
  it has no owner, so the **projection** inherits it. Each audience spec owning
  its own register and exclusions (§4) is that principle in its new home. ADR-046
  §3's "per ADR-023 a consumer may override the role map for its own purposes"
  should be read against this clause.
- §3's four-value workspace partition (`work`/`personal`/`infra`/`other`)
  becomes the two-value `domain` of §1.

## Consequences

- **Good:** a mixed day can be closed, which was structurally impossible before.
  One ritual is one the owner will actually run. Catch-up cost stops scaling with
  elapsed time. The `excluded` role finally has a definition of its members, and
  #568's defect class becomes unreachable by construction rather than by
  vigilance. Two axes make the previously-ambiguous `hl-shareable` unrepresentable.
- **Cost / bad:** an Accepted ADR is superseded, and its strongest property —
  leakage being *impossible* rather than *routed against* — is weakened to a
  strong default with an explicit override (§7). The single ritual now owns
  taxonomies that were consumer-local. Safety depends on manual send (§8), which
  is a process guarantee rather than a structural one. The day summary gains a
  third required part (§3), which is more to produce at the end of a long day.
- **Follow-up:** #560's rename now covers one of two hops. #570 must land for §9
  to be enforceable. #561 and `dos-catchup` are complementary and both needed.
  #415 (registry retirement of the three dos-* rows) and #487 execute against
  this. #493's completed-day definition resolves from §15. Config unification
  (one config carrying both Notion wirings) remains to design.

## Errata

Recorded 2026-08-20 while building #561, under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1. Erratum 1 is a
correction with no decision attached, so this ADR is edited in place and its Status
line is not stamped. **Erratum 2 records an unresolved conflict between two
Accepted ADRs and needs a human decision — it is flagged, not settled, here.**

> **Both errata were resolved by Angus on 2026-08-22.** Each resolution is appended
> to its own erratum below, in place, per the convention this section already uses.
> **Those resolutions carry decisions** — one of them names a `kind` — so the "no
> decision attached, therefore the Status line is not stamped" formula in the
> paragraph above **no longer describes this section**. The Status line **is**
> stamped, on the same grounds as the Amendment section that follows.

### Erratum 1 — §11 names a marker kind that no longer exists — **RESOLVED 2026-08-22**

§11 describes the Daily Log's ahKMS twin as carrying "a `consumed_by_state` link to
the state doc". That kind was deleted on 2026-08-20 (#560, PR #658): the 34 rows
carrying it were backfilled to `synthesized` and it is absent from the vocabulary
in `packages/shared/src/constants/synthesisMarkers.ts`, which now holds exactly
`synthesized` and `synthesized_unattended`. Nothing reads or writes
`consumed_by_state` anywhere on `dev`.

The **decision** in §11 stands — the log-to-state-doc hop is a second link with a
different target, and Notion's properties are projections of the ahKMS marker,
never sources. What has no name today is that second hop's `kind`. Naming it
belongs to `dos-catchup`, which is the only thing that will write it, and which
cannot be settled without Erratum 2 below.

Neither gap reaches #561: the fallback sweep stamps the **first** hop (atom to
daily log) unambiguously, per ADR-050 §6 and `dos-hl` Step 9.

#### Resolution (Angus, 2026-08-22) — hop 2's kind is `consumed_by_state`

**The retired name returns, for its correct referent.** The marker sits on the
**daily-log artifact** — #562's ahKMS twin — with `external_id` = the **state-doc
page**.

ADR-050 §6's diagnosis of why the name was wrong is precisely why it is right
here. It was retired because it "named the State Doc while pointing at the Daily
Log entry." At hop 2 it names the State Doc **and points at the State Doc**, hung
off the daily log being consumed. The name was never bad; it was on the wrong
link.

- **Zero new vocabulary.** The string already exists in this repo's history and in
  the provenance of #560's 34 backfilled rows. Verified on this branch
  2026-08-22: nothing under `packages/` reads or writes it — it survives only in
  ADR prose and skill commentary.
- **It deliberately does not carry the `synthesized_` prefix.** ADR-050 §6's "any
  synthesis marker" predicate — `SYNTHESIS_MARKER_KINDS` in
  `packages/shared/src/constants/synthesisMarkers.ts` — is therefore **untouched**,
  and **every hop-1 read keeps working with no edit**: `not_consumed`,
  `getSynthesizedArtifactIds`, `get_synthesis_coverage`.
- **The twin constraint still holds.** `packages/mcp-server/src/vocab.ts` records
  that "a twin bearing a synthesis marker would read as a consumed atom AND would
  add a phantom count to its own day in `get_synthesis_coverage`". A twin carrying
  `consumed_by_state` breaches neither, because `consumed_by_state` is not a
  synthesis marker — it is a pointer kind, alongside `daily_log`.
- **The two hops stay separately countable**, which §10's two-level model
  requires.

**Build note, carrying no decision:** `create_external_link`'s description
(`packages/mcp-server/src/server.ts`) currently says *"there is no 'state_doc'
kind"*. That stays literally true — the kind is `consumed_by_state` — but the
vocabulary it describes gains a link that points at a State Doc, and the
description will need to say so. Execution belongs to #666.

This resolution carries a decision, so this ADR's Status line is stamped; see the
Amendment section below.

### Erratum 2 — §10 and ADR-050 §6 disagree about which hop the marker names — **RESOLVED 2026-08-22** (recorded as UNRESOLVED — needs Angus)

Two Accepted ADRs make incompatible claims about the same kind name:

- **ADR-050 §6** (Accepted 2026-08-05) defines `synthesized` as the **first** hop:
  the Synthesize step folded this atom into a daily log, with `external_id` naming
  the Daily Log page. This is also what shipped — `dos-hl` Step 9 stamps each
  contributing atom with `kind: "synthesized"` and the Daily Log page id, and it is
  what #560's backfill wrote.
- **ADR-051 §10** (Accepted 2026-08-07) says the #560 rename "now names the
  **second hop only**" — daily log consumed by state doc — while §11 still calls
  that second hop `consumed_by_state`, a kind that no longer exists. §10 is
  therefore internally inconsistent as well as inconsistent with ADR-050.

The code follows ADR-050. **This erratum does not resolve the conflict**, because
resolving it is a decision about the vocabulary, not a correction of a
misstatement: either §10's sentence is struck as an error, or the marker vocabulary
is re-cut into two named hops and the shipped rows are re-attributed.

Scope of the damage today is small and bounded: **#561 is unaffected** (it writes
the first hop, unambiguously). `dos-catchup` hits this head-on — it is the ritual
that would write the second hop — so this must be settled before `dos-catchup` is
built, and is recorded on that issue.

#### Resolution (Angus, 2026-08-22) — `synthesized` names hop 1

**Hop 1 — atom → daily log.** ADR-050 §6 is confirmed, the shipped code is
confirmed, and **§10's struck sentence stays struck**: it was the error.

Three independent things agree, and one sentence dissents:

- **ADR-050 §6**, Accepted two days earlier, defines it as hop 1.
- **The shipped code** writes it as hop 1 — `dos-hl` Step 9 and
  `packages/shared/src/constants/synthesisMarkers.ts` — and #560's backfill wrote
  34 rows on that reading.
- **`not_consumed` is only correct on that reading.** The predicate exists to keep
  an already-handled atom out of the next day-window read, and the thing that
  consumes an atom is the daily log. Attached to hop 2, the marker would leave
  every atom presenting as unconsumed until a State Doc update landed — the exact
  pile ADR-050 §6 says the predicate exists to prevent.

**§10's insight was right; its attachment was wrong.** Consumption **is**
two-level — that is the load-bearing claim of §10 and it stands unamended. What
§10 got wrong was inferring that #560's rename therefore moved to the second hop.
Two hops need **two names**, not one name relocated; hop 2 gets its own in
Erratum 1's resolution above.

This resolution carries a decision, so this ADR's Status line is stamped; see the
Amendment section below.

## Amendment

Recorded 2026-08-22 under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1, from the owner
stating the consumption model end to end in one pass. That statement also resolves
both errata above; the three amendments below are what it decides beyond them.

> "Atoms are only ever consumed by daily logs. They are marked every day as
> consumed by the daily logs, no matter what — even the atoms for the day go onto
> the day's daily log. Then in that same session, all unconsumed daily logs are
> handled. Once I approve any update to the state doc, all the atoms and daily
> logs that were considered in updating the state doc are marked. Even if no
> information goes in — if its info isn't important, that's part of the system
> working as expected. If the system is working correctly, unconsumed atoms
> should only be from today."
>
> — Angus, 2026-08-22

**These carry decisions**, so the formula the Errata section above was written
under — *no correction changes a decision, therefore the Status line is not
stamped* — does not hold. The Status line **is** stamped, the index row in
[`docs/ADRs/README.md`](./README.md) carries the same qualifier, and every affected
clause above carries an inline pointer down to this section.

**Amendment 2 reverses §14.** It is recorded in place rather than as a successor
ADR, on the precedent
[ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)
Amendment 5 set earlier the same day for a decision-carrying, reversing amendment:
the Status line is stamped, the index row carries the qualifier, the reversed
section carries a pointer, and **no frozen text is rewritten**.

### Amendment 1 — marking is by **considered**, not **contributed**

**Every atom the ritual read in its window is marked into that day's log** —
including atoms it judged unimportant and put nothing of into the prose.

> "Even if no information goes in — if its info isn't important, that's part of
> the system working as expected."

This **supersedes the rule shipped in `dos-hl` Step 9**, which stamps only atoms
"whose content contributed to the Daily Log entry"
(`.claude/skills/dos-hl/SKILL.md`). **The same rule binds the unattended sweep**
(#561), which marks what it read with its own `synthesized_unattended` kind —
ADR-050 §8's boundary on which kind a sweep may write is untouched.

**Why *considered* and not *contributed*.** "Considered" is a list the system
already has: the window read returned it. "Contributed" is a judgement about prose
that the system cannot verify after the fact — and it is the wrong thing to ask
for anyway, because **deciding an atom is not worth writing down is the ritual
working**, not the ritual skipping. The ledger records that an atom was put
through the ritual, not that it survived it.

**This resolves #564's question at the model level.** #564 proposed a third
terminal kind (`reviewed_not_used`) for atoms the ritual saw and excluded. **No
third kind is needed.** Its second motivation — that the ledger cannot tell
**unread** from **read-and-rejected**, both being the absence of a row — is
answered directly: read-and-rejected now carries a row, and absence means unread.
What is deliberately **not** distinguished is read-and-used from
read-and-rejected, because that is the judgement the system cannot verify. What
remains on #564 is the **build** change, not a design question.

### Amendment 2 — `dos-catchup` retires as a separate ritual; catch-up folds into attended `dos`. **§14 is superseded**

**§14's two-halves split no longer holds as two names.** #561's unattended sweep
survives unchanged as the machine half. The attended half is **not** a second
named ritual: it is the standing shape of `dos` itself.

**The attended session's standing shape:**

1. Fetch **today's atoms** and **all unconsumed daily logs**.
2. Handle everything.
3. Mark everything.

**One entry point, and the backlog is in the default path**, so it can never be
forgotten. A separate `dos-catchup` is a ritual the owner has to remember to run
on exactly the days he has already demonstrated he does not run rituals.

**§10 is unchanged and is what makes the fold cheap.** Catch-up is still only ever
over daily logs, never over atoms, so folding it in adds *five logs*, not two
hundred atoms, to a nightly run. The 2026-08-04 failure shape (`318216cc`) stays
unreachable for the reason it always was: the input is bounded by construction.

**Since #562, "all unconsumed daily logs" is a ledger query, not new machinery.** A
daily-log artifact carrying no `consumed_by_state` marker (Erratum 1's resolution
above) **is** the queue. Nothing has to be built to hold it.

**[ADR-054](./ADR054_One_Dos_Config_Two_Domains_And_An_Open_Audience_Set.md) §8's
argument survives its conclusion.** §8 refused `dos-catchup` as a *flag on `dos`*
because "behind a flag, that guarantee is enforced by a boolean, and one run with
the flag unset over a stale window restores the old failure". That reasoning is
untouched, and is exactly why this is **not a flag**: there is no dial, no unset
state, and no dangerous combination for a run to fall into. The logs-not-atoms
guarantee is enforced by there being **one** read shape. What §8 assumed, and what
is superseded, is that the only alternative to a separate capability was a flag.
ADR-054 §7's survives/retires list and §8's conclusion are amended there — see
that ADR's Amendment 2.

**`dos-catchup` was never built**, so retirement withdraws a *name*, not a
capability: there is no skill body under `.claude/skills/` and no registry row, and
#415's registry-retirement list is unaffected.

**What else above names the retired name, and how to read it now:**

| Clause | Reads now as |
| --- | --- |
| §10's diagram — "(ritual, or `dos-catchup`)" | "(the attended `dos` session)" |
| §12's table — "only `dos-catchup` updates it, with approval" | unattended still never touches the State Doc; the attended `dos` session is what updates it |
| §15 — "the streak recovers on promotion" | unchanged; promotion now happens **inside** the attended session |
| Consequences — "#561 and `dos-catchup` are complementary and both needed" | #561 and the attended `dos` session are complementary and both needed |

#666 stays open as the issue that **designs the fold**, rather than a separate
ritual.

### Amendment 3 — the standing invariant: **unconsumed atoms should only be from today**

> "If the system is working correctly, unconsumed atoms should only be from
> today."

Recorded as a **named health signal**, not as an enforcement. It is a derived read
over the ledger with no new store (ADR-050 §8), and it falls out of Amendments 1
and 2 together: Amendment 1 guarantees an attended run leaves no in-window atom
unmarked, and Amendment 2 guarantees the log backlog sits in the default path. An
unconsumed atom older than today therefore means one of the two did not happen.

It has a **sibling** on the other level of §10's model, and the two must not be
collapsed:

| Signal | Reads as |
| --- | --- |
| **Unconsumed atoms older than today** | the atom → log hop is failing: a run that did not finish, or a day nobody ran |
| **Unconsumed daily logs** | **the review queue** — normal, and the thing the attended session drains |

A backlog of logs is the system working. A backlog of atoms is the system broken.

Both belong to **Dashboard**, on the *"my pipeline"* side of ADR-052 Amendment 5's
discriminator — *my stuff versus the machine* — alongside consumption lag and
per-source freshness. Which tab, and what the tile looks like, stays #495's and
#493's to decide.

### Amendment 4 — an entry **declares** the days it covers; the ledger stays authoritative

Recorded 2026-09-25 from the #1016 grill. §11 keyed "one per domain" on the entry's
`Date`, which is the day it was **written**. Coverage (ADR-050 §8) buckets markers on
the atoms' `captured_at` (ADR-088 §3), so a catch-up run's entry was dated one day
while its markers sat on others: on 2026-09-07 a page dated 5 Sep carried markers on
28 Aug and 4 Sep, and the duplicate guard (#673), keyed on `Date`, then refused every
5 Sep entry for good.

**An entry's `Covers` is declared.** Each Daily Log carries a `Covers` property
(found by config role `covers`, never by name), which `daily_log_create` sets to the
distinct `captured_at` dates of the atoms the ritual stamps with that entry. A run
that closes its own day writes `Covers = [Date]`. **The marker ledger is
authoritative**; `Covers` is its Notion-side statement, in the same ahKMS → Notion
direction §11 already sets, and is written once at creation, never topped up.
**An empty `Covers` means the entry's own `Date`**: that is how every entry written
before the property reads, so there is **no backfill**, no write to a `Confirmed`
page, and the ADR-038 human gate is untouched. §11's "one per domain" is therefore
**one entry per (domain, covered day)**, and the duplicate guard keys on that.
`dos_synthesis_coverage` is unchanged. A consumer that needs *which entry closed day
X* (#493, #495) resolves it through `Covers`, falling back to `Date`.

Rejected: letting the sweep top up an existing entry (crosses ADR-038 and makes the
ledger a projection of Notion), and accepting the drift (every per-day consumer
reads wrong for as long as the backlog slice takes to reach the day).

### Amendment 5 — recovering an unclosed entry through the ahKMS twin (#721)

Recorded 2026-09-25 from the #721 grill. When a run writes a Daily Log page (Step 8a)
and creates its twin (Step 8b), but aborts or crashes before stamping consumption
markers (Step 8c), the Notion page exists while the ledger records the day's atoms as
unconsumed. A subsequent run would see the duplicate guard refuse the write, leaving
the day's atoms permanently unconsumed.

**Recovery through the twin.** On a duplicate refusal from `create_daily_log_entry`,
the tool inspects `artifact_external_links` for an existing Daily Log twin (`kind = 'daily_log'`)
matching the clashing page ID and reports `twin_present: boolean`.
- **`twin_present: true`**: the page was written by an earlier ritual run. The ritual skips
  8a and 8b and proceeds directly to 8c, stamping the run's atoms with `synthesized`
  markers against that page ID and reporting "recovered an unclosed entry for D".
- **`twin_present: false`**: the page is foreign (hand-written, pre-twin, or written by
  another surface). The ritual stops and reports "an entry exists for D but the ledger
  shows the day was never closed". No markers are stamped against a page the ritual did
  not write.

### Amendment 6 — `daily_log_create` writes the twin and its pointer (#2258)

Recorded 2026-11-21 from the #2258 grill and the owner ruling of the same day. Until
now Step 8 was three model-driven calls: `daily_log_create` (8a), then `capture` and
`external_link_create` (8b). Nothing in this ADR or ADR-050 said who writes the twin;
§11 and ADR-050 §7 only define what it is. On 2026-11-07 an attended catch-up run
ended after 8b's `capture` and before its pointer write, leaving two twins with no
`daily_log` pointer. Such a twin belongs to no domain, is invisible to every scoped
`dos_daily_log_queue` read, cannot be promoted, and makes Amendment 5's check answer
`twin_present: false` for a page the ritual did write.

**The writer of the twin and its pointer is `daily_log_create`.** The tool already
holds everything the twin needs (provider, title, body, date, pillars), and three
calls driven by a model strand state whenever a session ends between two of them.

**The order is page, then twin, then pointer**, in one tool call. The twin is captured
with the fields Step 8b used: the entry's title and full body (the `body` argument,
also when a Notion overflow append failed and the page holds less), `content_subtype:
"daily_log"`, `captured_at` set to the day the entry narrates, `surface: "dos"`, and
`processing_metadata.pillars`. The pointer carries `kind: "daily_log"`, the provider
the call resolved, the page id and the page URL. The call returns the twin's
`artifact_id`.

**This is a server-side sequence, not a cross-store transaction.** Notion and Postgres
share no transaction, `capture` stays the only artifact writer, and there is no
migration. So the failure mode is sequential with compensation:

- If the twin capture fails, no pointer is attempted.
- If the pointer write fails, it is retried once. If it fails again, the twin this
  call created is soft-archived (reversible, never a hard delete). The archive counts
  only when it returns that twin's row; one that throws or matches no row is reported
  as a live twin with no pointer.
- Compensation covers only a twin this call created. When `capture` reports
  `deduplicated: true` the twin belongs to an earlier write and is left alone; the
  reply names it and says its pointer is missing.
- Once the page exists the tool never throws for a twin or pointer failure and never
  deletes the page. It returns success for the page with a loud `twin: MISSING`
  warning. The worst case is therefore "page with no twin", which Amendment 5 already
  reports, and never a twin with no pointer.
- A later call never heals a day. A page with no twin still answers `twin_present:
  false`; repair stays explicit.

**During the rollout the write is opt-in.** `daily_log_create` takes `write_twin`
(boolean, default `false`) and writes the twin and pointer only when it is `true`.
Skills are served from `kms-db` and change after the tool does, so for a while an old
skill copy still runs Step 8b against the new tool, and `capture` deliberately never
dedups a `daily_log` twin (#1124): an unasked server-side write would leave that entry
with two twins. Without the argument the tool behaves exactly as before. #2317 passes
`write_twin: true` in the same edit that removes Step 8b from the dos and sync skills;
making it the default is #2335.

**What is left of the pointerless state.** It is now reachable only by a process
ending between two adjacent awaits inside one call (after the capture returns and
before the pointer write or the compensating archive lands). The doctor check from
#2314 reports it, and the sanctioned repair is a late `daily_log` pointer attach
through `external_link_create`, guarded by #2313.

One more state is left, and it is the reverse one: a pointer write that committed but
reported failure on both attempts ends with the twin archived and its pointer in
place. The duplicate guard does not filter on `archived`, so it answers
`twin_present: true` for that page. Making that read ignore archived twins is #2382.

**Amendment 5 is read accordingly.** Where it says the ritual "skips 8a and 8b", read
"skips 8a": once Step 8b leaves the skills there is no separate twin step to skip, and
the recovery path is otherwise unchanged. The frozen text above is not rewritten.

Rejected in the grill: a single-transaction RPC and a claim-then-finalize pattern
(both need a migration and neither can span Notion), and keeping the two calls in the
skill with only a repair action (it leaves the gap that 7 Nov fell into).

### Bears on, not settled here

Named so the next reader inherits these rather than rediscovering them.

- **Amendment 1 makes "inbox fully triaged" true by construction after every
  attended run.** #564's first motivation is met, but the resulting signal is
  degenerate *as a metric*: it reports that the ritual finished, which the
  synthesis marker already says. ADR-052 §8's rejection of inbox-zero as a streak
  criterion is unaffected in its conclusion, but its stated **reason** — marginal
  atoms stuffed into the log to clear the queue — no longer applies, because
  marking is now decoupled from the prose. #494's habit tile should be re-read
  against this.
- **ADR-050 §6's `external_id` examples narrow.** §6 offers "Daily Log page,
  personal log, issue comment" as objects a synthesis marker may point at. Under
  *"atoms are only ever consumed by daily logs"* the issue-comment case went with
  `dos-infra` (§1). §6's decision is unaffected — `external_id` names the object,
  whatever it is — but that example set is now historical.
- **"All the atoms and daily logs that were considered … are marked" is read here
  as one approval stamping both hops in one session** — atoms at hop 1, logs at
  hop 2 — not as atoms gaining a second, hop-2 marker. Erratum 1's resolution puts
  hop 2's marker on the daily-log artifact, and #666's settled mechanic (promotion
  promotes the log, not the atoms) is unchanged.

## Links

- **Supersedes:** [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md)
- Builds on: [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md),
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md),
  [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md),
  [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md),
  [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md),
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md),
  [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md)
- Related issues: #569 (the grill), #565, #566, #567, #568, #570, #562, #561,
  #560, #564, #493, #495, #415, #487, #490, #492
- Evidence atoms: `94c41618` (mixed-day failure), `7f1a80b5` (the pre-dawn
  writer), `318216cc` (2026-08-04 unbounded catch-up), `0e0394ef` / `9df2d048` /
  `654ebd2e` (team register), `097bf71f` (gate-keyed-on-unset-field)
