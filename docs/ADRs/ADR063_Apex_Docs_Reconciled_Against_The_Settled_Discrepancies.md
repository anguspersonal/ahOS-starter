# ADR-063: The apex docs are reconciled against every settled discrepancy, and the two watermarks deliberately do not move

- **Status:** Accepted
- **Created:** 2026-08-26
- **Accepted-on-dev:** 2026-08-26
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, process, vision, architecture
- **Builds on:** [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §2 (same-PR current-state sync),
  [ADR-043](./ADR043_Apex_Doc_Changes_Require_An_ADR.md) (a substantive apex-doc change needs a minted ADR),
  [ADR-056](./ADR056_Apex_Doc_Freshness_Is_Enforced_By_Four_Mechanisms.md) (the freshness mechanisms),
  [ADR-057](./ADR057_Vision_Reconciled_Against_The_August_ADR_Batch.md) (the precedent: one ADR for a refresh, not one per drift point),
  [ADR-058](./ADR058_Vision_Sheds_As_Built_State_To_Architecture.md) (as-built state belongs to `architecture.md`),
  [ADR-059](./ADR059_Apex_Docs_Carry_A_Reviewed_Against_Watermark.md) (the watermark, and what bumping it requires)

## Context and problem

A full audit on 2026-08-26 compared all 62 ADRs against `vision.md` and
`architecture.md` and found **35 discrepancies**. Twenty-one were *settled* — one
side was provably a stale sentence and correcting it required no decision. This ADR
records the correction of those, and, just as importantly, what was deliberately
**not** corrected.

The audit's own finding is the reason it was needed. Every existing guard passes on
all 35:

- `check-adr-citations.js` only asks whether an apex doc citing a **superseded** ADR
  names its successor. It cannot see an ADR that is never cited at all.
- `check-adr-index-status.js` compares an index row to its file's status line. Both
  agreeing and both wrong passes cleanly (the #862 class).
- `check-apex-watermark.js` measures distance from a self-declared baseline. A doc
  can be three ADRs behind and print `ok`.

So ADR-039 §2's same-PR sync rule and ADR-043's both-directions binding are
**conventions with no enforcement**, and 25 of 62 ADRs were cited by neither apex
doc. That gap is not closed here; it is stated so the next mechanism proposal starts
from a measured number rather than an impression.

## Decision drivers

- **A stale sentence in an apex doc is worse than an absent one.** Both documents are
  read as current by agents and by the owner. `vision.md`'s *Not now* section was
  parking work that had already shipped, which is the most expensive direction for an
  error: it tells a reader not to look.
- **The two docs must not contradict each other.** Four discrepancies were the apex
  docs disagreeing about the same subject while citing the same ADR. Whatever else is
  true, that cannot be.
- **Correct without deciding.** Only the settled tier is touched. Anything needing a
  judgement stays open and is named below.
- **Never overstate freshness** (ADR-059): understating self-corrects, overstating
  does not.

## Decision

### 1. `vision.md` stops describing decisions as accomplishments

Four corrections, all the same class — a decided shape written in the present tense:

- **The `dos` ritual.** The vision said "*one ritual writes them all … the ritual is
  `dos`*". No `dos` capability exists; all three siblings are live; ADR-054 §7 names
  #415 as the issue that executes the retirement and #415 is open. Now stated as
  decided-and-unexecuted, pointing at `architecture.md` §7 for as-built detail.
- **"ADR-051 superseded ADR-023's three sibling consumers outright."** True of the
  decision, false of the system. Now says so.
- **Two domains "wired from day one".** ADR-054 §6 argues a present-but-unwired domain
  would be *worse* than an absent one — a constraint on how to ship it, not a claim
  that it ships. Only `work` synthesises; the personal State Doc has never had a
  writer.
- **`architecture.md` is named as the arbiter** for as-built state, per ADR-058.

### 2. `vision.md`'s *Accepted and next* list is trimmed to what is genuinely unbuilt

Six of its seven entries had shipped: relationship reification (#327), the Event →
Calendar half of Act (#126), graph search (#137), PARA containment (#170),
entity/people CRUD (#133), and two of #359's four parts (`export_rdf` in #893, the CI
vocabulary gate in #892). **Every failure was in the same direction** — work landed,
the list was never trimmed — so the section read as a longer backlog than existed.

`#338` (multi-account connectors) is removed from *Not now* outright: it shipped in
#856 two days before the audit, and `tools/drive/shared.ts:79` names the issue in a
comment.

What survives is the judgement, not the status. This is ADR-058's reasoning applied
one section over: a second copy of a fact is two records free to disagree.

### 3. `architecture.md` absorbs the ADRs that changed the shape it describes

- **ADR-055** — `routing` had a third value in production (`mcp`, Brevo) while the
  doc described a two-value world. ADR-055 was cited by `vision.md` and not by the
  document that owns routing.
- **ADR-060** — `user_integrations` is one row **per connection**, keyed
  `"<provider>:<slug>"`. The doc sourced that table to ADR-032/ADR-045, the exact two
  ADRs ADR-060 was written to correct.
- **ADR-061** — the two live meeting-note capture paths, split by surface, with §6's
  refusal of a third recorded and the converge/grandfather/retire question left open
  (#874).
- **ADR-062** — identity resolves on the entity, not the message; a late source
  attaches, and a post-synthesis arrival is reported rather than folded or dropped.
- **Nineteen registered tools** were missing from a list the doc labels "as built":
  Gmail (4), the Notion passthrough (3), PostHog (3), Brevo (2), meeting notes (2),
  plus `export_rdf`, `create_daily_log_entry`, `get_synthesis_coverage`,
  `check_dos_config_drift` and `get_artifact_and_file`. Whole integrations were
  invisible.
- **A duplicated `### MCP server` section** is merged. One service was documented
  twice under one heading, and ADR-048's inbound webhook surface lived only in the
  copy a reader would never reach.
- **`dos-hl config`** → `dos_config`, renamed by #881 the day before.

### 4. ADR-019 is stamped `Accepted`

It was the only numbered ADR on `dev` still reading `Proposed`, while
`architecture.md` describes the capability registry as "a served component, not a
plan" — registered, served, binding layer live since #62. Metadata is mutable under
ADR-039 §1, so this is a correction.

It carries **no `Accepted-on-dev` date**, deliberately: it predates the ADR-039 §3
rule and belongs to the 24 undated ADRs the watermark excludes. Backfilling one date
in isolation would make the exclusion list look decided when it is not.

Note the second-order finding: ADR-019 was hiding inside that exclusion. #862 proposes
exempting undated ADRs from its guard; this is the evidence that the exemption should
be **undated *and* not `Proposed`**, since an undated ADR still reading `Proposed` is
a real defect wearing the exemption's clothes.

### 5. Neither watermark moves, and that is the decision

The tempting move is to bump `vision.md` to ADR-062 and give `architecture.md` its
first real value. Both are refused.

**`vision.md` stays at ADR-059.** ADR-060, 061 and 062 have landed since that review.
This ADR corrects stale sentences; it does not review the vision *against* those three
— and ADR-062 in particular bears on R2 and R4, which is a judgement about what the
system is for and belongs to the owner. ADR-059 requires **evidence** for a bump, and
"we fixed some sentences" is not evidence of a reading.

**`architecture.md` stays at `never`.** Fifteen targeted corrections are not a review
against 34 ADRs. Bumping it would convert a measured gap into a false claim of
currency, which is precisely the failure ADR-059 exists to prevent.

So the vision still reports 3 behind and architecture still reports 34 behind. Both
numbers are honest, and both stay on the board.

## Consequences

**What improves.** The two apex docs no longer contradict each other. `vision.md` no
longer parks shipped work or claims unshipped work as running. `architecture.md`
covers every accepted ADR that changed the shape it describes, and its tool list
matches `server.ts`.

**What is deliberately unchanged.** Fourteen discrepancies below the settled tier,
including every genuine decision:

- `architecture.md`'s 34-ADR gap: backfill or reset the baseline (#902). The audit
  moved the lean *toward* backfill — fifteen distinct corrections is not what a merely
  unstamped doc looks like — but #851's own commit says "*move* Working-today … keep
  the rest of the cut line prose", and a move carries no review evidence either way.
- Whether an ADR still `Proposed` on `dev` should be guarded or auto-stamped (#862).
- Whether `vision.md` should carry an *Accepted and next* list at all, given that
  every one of its six stale entries failed in the same direction.
- Nine ADRs cited by neither doc where the omission is arguable rather than settled:
  ADR-025, ADR-026, ADR-027, ADR-028, ADR-029, ADR-034, ADR-037, ADR-044, ADR-056.

**What this does not fix.** The absence of enforcement. Every discrepancy corrected
here passed every guard in the repo, and will recur the same way. ADR-056 already
scored a per-ADR declaration block against this exact problem and rejected it — an
ADR-level instrument for a document-level question — so the next proposal needs a
different shape, not a retry.

## Refs

#902 · #862 · #874 · #875 · #415 · #359 · #338 · ADR-039 §2 · ADR-043 · ADR-056 ·
ADR-057 · ADR-058 · ADR-059
