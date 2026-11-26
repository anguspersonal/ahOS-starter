# ADR-046: Per-source ingestion policy — how external records become atoms

- **Status:** Accepted
- **Created:** 2026-08-05 (grill session A, #497)
- **Accepted-on-dev:** 2026-08-05
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, ingestion, discovery, synthesis, provenance, trust
- **Builds on:** ADR-016 (discover & index axis), ADR-018 (dumb capture / synthesis-time interpretation), ADR-026 (rationalised provenance & derived trust), ADR-038 (Link · Act · Synthesize)
- **Resolves:** #488 (per-source ingestion policy) · #490 (planned-intent provenance)
- **Amended by:** [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md) (§1: a policy row may collapse discover and enrich into one pass through `capture` when the item is the content; §3: the role floor for machine surfaces ships in code; §4: a Shape column, rows 1.7 and 1.8 tightened, rows 1.1 to 1.3 amended, row 1.11 added)

---

## Context and problem

Today, only *explicit captures* become atoms. Everything else produced in a day is
invisible to synthesis. Evidence from the 2026-08-04 failure case
(`docs/sessions/2026-08-04-eod-synthesis-failure-case.md`):

- The Advisor recurring meeting produced a rich Notion AI meeting note (12 action
  items, corrected conversion metrics) — never became an atom; dos-hl doesn't read
  the Meetings DB.
- Two other meetings the same day left **no record at all** beyond calendar events.
- The Bri/Melanie weeklies produce **Gemini notes in Google Drive** — a third
  location for "meeting notes."
- Email, Slack, Notion edits, GitHub activity: similarly un-ingested.

Separately (#490), the 3am auto-planner emitted best-effort guesses while a
connector was down, and EOD synthesis treated those descriptions as facts about the
day — intent laundered into record.

The concrete source inventory this ADR sets policy for (from #488):

| # | Source |
|---|--------|
| 1.1 | Notion meeting notes — Work public DB |
| 1.2 | Notion meeting notes — Work private DB |
| 1.3 | Personal-Notion meeting notes |
| 1.4 | Dex (personal CRM) |
| 1.5 | Work email (Gmail) |
| 1.6 | Personal email (Gmail) |
| 1.7 | Work Slack |
| 1.8 | GitHub activity (anguspersonal + example-org org) |
| 1.9 | RescueTime |
| 1.10 | Gemini meeting notes in Google Drive |

## Decision drivers

- **ADR-016's binding constraint:** additions ride the existing substrate; any
  design that quietly re-decides what the substrate already decided is rejected.
- **ADR-018's boundary:** no interpretation at write time — because rules can't
  keep pace with vocabulary (the treadmill), write-time misclassification fails
  silently and permanently, and different consumers legitimately want *different*
  taxonomies over the same atoms. These failure modes are **amplified** at
  machine-ingestion volume, so ingestion inherits the rule with more force, not
  less.
- **Flood control:** discovery across 10 sources surfaces far more than EOD
  synthesis can read; without an explicit gate, dos-hl drowns.
- **Resilience:** the 2026-08-04 failure was partly a *connector outage at
  synthesis time*. Ingestion should decouple the EOD ritual from third-party
  uptime.
- **No new machinery beyond need** (single-user vision).

## Considered options

1. **A distinct "ingest" pipeline** that writes synthesis-ready, content-bearing
   atoms directly per source. Rejected: duplicates ADR-016's discover→enrich with
   a second scheduler and re-decides the substrate — the exact re-architecture
   trap ADR-016's binding constraint names.
2. **Binary synthesis-eligibility** (in/out per surface). Rejected: real sources
   need *graded* use — RescueTime should feed aggregates but never narrative;
   GitHub should corroborate but not be narrated.
3. **Two columns: `eligible` + `role`.** Rejected: makes the incoherent state
   (`eligible=true, role=null`) representable. One role enum with an `excluded`
   value makes it unrepresentable.
4. **Lazy (on-demand-only) enrichment for high-volume sources.** Superseded:
   day-scoping bounds the cost directly (a day's email/Slack is a few dozen small
   bodies), and same-day local copies buy connector-outage resilience.
5. **A distinct stored provenance class for planner output** (e.g.
   `provenance ∈ {observed, intended, derived}`). Rejected for now: deriving
   modality from `surface` at read gets the same behaviour with zero new columns,
   and ADR-018 says the writer doesn't classify. Logged as a might-do (§5) —
   there is a respectable envelope-rule argument that "this atom is a plan" is an
   objective fact the planner knows at write time, so a stored
   `content_subtype: intent` would be legitimate if read-time derivation ever
   proves insufficient.

## Decision

### 1. Ingestion is discover-shaped — a policy layer, not a pipeline

Ingestion = **discover** (cheap pointer, scheduled, per ADR-016) → **enrich**
(content extraction on a budget) → **synthesis reads enriched artifacts alongside
captured atoms, filtered by per-source policy**. No second write path, no new
store, no new scheduler. The genuinely new pieces are only:

- teaching synthesis consumers to read enriched artifacts (today they read only
  captured atoms);
- the per-source policy table (§4);
- the role gate that keeps synthesis from drowning (§3).

Both write paths remain **dumb** (ADR-018): an ingested meeting note gets no
workspace/type/domain inference at write, same as a capture. A captured atom is
*first-person voice*; an ingested record is *third-party evidence about the day*.
Same table; the `surface` field (ADR-026) carries the distinction and trust
derives from it.

### 2. The envelope rule: deterministic metadata at write is provenance, not interpretation

ADR-018 forbids **judgement** at write time, not **facts**. Deterministic copies
of what the source API serves — Gmail `from`/`to`/`subject`/`date`/`thread-id`/
`message-id`; Notion properties + `last_edited_time`; Drive owner/modified-time/
mime-type — are provenance, stored at write in `artifacts.file_metadata`
(existing jsonb, migration 010). The test:

> **Metadata comes from the envelope, not from reading the content.** A
> field-copy from the API response is a fact. Anything requiring the body to be
> parsed or a model to be run is interpretation — deferred to enrichment or
> synthesis-read.

Envelope metadata is load-bearing, not cosmetic: dedup keys are envelope fields
(§4), and absence detection joins calendar envelopes against note envelopes
(§ absence, pending). Each source's stored fields are named in its policy row —
metadata earns its place per source.

### 3. Synthesis-eligibility is a role ladder, one stored value per surface

An ordered ladder of usage permissions, each tier including everything below:

| Role | Synthesis may… | Example surfaces |
|---|---|---|
| `narrative` | quote/bundle it into the day's story — plus everything below | captured atoms (default), meeting notes (1.1–1.3, 1.10b) |
| `evidence` | consult it to corroborate/reconcile — never narrate it alone — plus below | email, Slack, GitHub, Dex, calendar, whole-account Drive discover (1.10a) |
| `metrics` | see only aggregates; individual items are invisible | RescueTime |
| `excluded` | nothing — synthesis never touches it | (none initially; the parking tier) |

- **Storage:** one **maximum-permission** value per surface. A meeting note at
  `narrative` is automatically usable as evidence and countable — no
  dual-membership. Mirrors `TRUST_TIERS`: ordered, compared at read.
- **Vocabulary placement:** open app-layer vocab in `vocab.ts` (like `SURFACES`),
  no DB CHECK — consumers read it; the DB never enforces it. A future `attention`
  tier (time-sensitive surfacing, Monitor & Trigger axis) can be added without
  migration.
- **Map placement:** `surface → role` map in user preferences, sibling to
  ADR-026's `surface_trust_map`. It is the **default lens**; per ADR-023 a
  consumer may override for its own purposes (a deep-work report may promote
  RescueTime to narrative locally).
- **Role and trust are orthogonal axes**, both derived from `surface` at read:
  role says *how* synthesis may use an item; trust (ADR-026) says *how much to
  believe it*. An unverified item at `narrative` is narrated *as unverified* —
  the #490 territory.
- **Investment guideline (not hard rule):** per-item cost scales with tier.
  Narrative items are read one-by-one (and are the priority targets for
  entity-linking and act-proposals); evidence is consulted in bulk on demand;
  metrics only aggregates; excluded gets nothing. The ladder is one knob with two
  effects: a permission boundary and an enrichment-budget boundary.

**Explicitly outside the gate** (the ladder is MECE *within* synthesis use;
these are named so nobody mistakes the gate for exhaustive):

- **Search** — everything discovered is searchable regardless of role.
  `excluded` ≠ invisible; it means "won't appear in the Daily Log."
- **Link** (ADR-038) — entity extraction rides the enrichment path; whether a
  source gets linked is an enrichment-budget question, guided (not gated) by
  tier.
- **Act** — ingested content **never** directly creates tasks/events. An
  "Action items" section in an AI meeting note is *not* a declaration under
  ADR-038 §4; it is material synthesis may *propose* from. This closes the
  tempting shortcut that would launder machine guesses into Notion rows.

### 4. The per-source policy table

| # | Source | Pointer cadence | Enrich timing | Dedup key (envelope) | Role | Trust (ADR-026 map) |
|---|---|---|---|---|---|---|
| 1.1 | Notion meeting notes, HL public | shared Notion discover (live) | same-day, before EOD | `page_id + last_edited_time` | narrative | medium (AI-written) |
| 1.2 | Notion meeting notes, HL private | same | same-day | same | narrative | medium |
| 1.3 | Personal-Notion meeting notes | same (unblocked by #482) | same-day | same | narrative | medium |
| 1.10a | Whole-account Drive discover (`gdrive` connector, as shipped) | shared Drive discover (live) | same-day | `file_id + modified_time` | **evidence** | medium |
| 1.10b | Gemini notes in Drive (once the connector is scoped to them) | shared Drive discover (live) | same-day | `file_id + modified_time` | narrative | medium (AI-written) |
| 1.5 | Work Gmail | scheduled, frequent | same-day, day-scoped + envelope-filtered; history on-demand | `message_id` | evidence | high (sent) / medium (received) |
| 1.6 | Personal Gmail | scheduled, frequent | same | `message_id` | evidence | same split |
| 1.7 | Work Slack | scheduled, daily | same-day, day-scoped (channels-posted-in + DMs); history on-demand | `channel + ts` | evidence | medium |
| 1.8 | GitHub (anguspersonal + example-org) | scheduled, daily | none needed — events are the content | event id / commit SHA | evidence | high (machine record) |
| 1.9 | RescueTime | scheduled, daily | none — aggregates only | `date + category` | metrics | high (machine measurement) |
| 1.4 | Dex | weekly or on-demand | on-demand | `note_id` / `reminder_id` | evidence | high (user-authored) |

Structural notes:

- **Why row 1.10 split (amended 2026-08-07, #570 / PR #583).** As first written,
  row 1.10 read "Gemini notes in Drive → `narrative`". That assumed a Drive
  discover scoped to meeting notes. The `gdrive` connector as shipped (ADR-016
  Slice 1/3) inventories the **whole Drive account**, and a bulk personal-archive
  backfill through it flooded the day-window synthesis read with a decade of
  un-narrated PDFs (#567) — the incident that produced #570. Telling meeting
  notes from old PDFs *at write* would be content interpretation, which ADR-018
  forbids on this path, so the distinction has to be made where the connector's
  scope is known: in the role map. Hence 1.10a — what the connector actually
  is today — at `evidence`: searchable and consultable, never narrated bare,
  the same tier §4 gives every other bulk/machine source. 1.10b keeps the
  original intent as the target state; reaching it is a **connector-scoping**
  change plus a one-line `surface_role_map` entry, not an ADR change.
  Implemented as `DISCOVER_ROLE_SEED` in
  `packages/mcp-server/src/captureConfig.ts` — a floor applied under the
  owner's stored map, so configuring 1.10b later overrides it per surface.
- **Cadence splits in two.** Pointer cadence is cheap and roughly uniform (the
  shared discover cadence). The real per-source decision is **enrich timing**:
  - *narrative* → **same-day, all items** — EOD synthesis needs the content
    tonight;
  - *evidence* → **same-day, day-scoped, envelope-filtered** (Gmail category
    labels exclude Promotions/Updates; INBOX + SENT only; Slack scoped to
    channels-posted-in + DMs — all deterministic, source-served facts, so the §2
    test passes). **History enriches only on consultation.**
  - *metrics* → never enriched; aggregates are pulled at read.

  This replaces #488's "auto-ingest vs read-at-EOD vs ignore" trichotomy:
  everything is scheduled at the pointer layer; tiers differ in when content is
  pulled.
- **Resilience rationale:** same-day enrichment means EOD synthesis reads
  **local enriched copies**, not live connectors. A connector outage at 9pm no
  longer degrades the ritual to best-effort fiction (the 2026-08-04 mode).
- **Trust column = ADR-026's `surface_trust_map`**, new entries only. Deliberate
  asymmetries: AI meeting notes are `medium` (models hallucinate action items);
  git SHAs and RescueTime measurements are `high` (machines don't lie about
  facts they mechanically record); Dex notes are `high` (user-authored).
- **One half-step extension to ADR-026:** email trust splits by direction —
  *sent* is the user's voice (`high`), *received* is third-party claims
  (`medium`). The split is derivable from the stored envelope (`from:`), so
  trust derives from **surface + one envelope fact**. This is the only place the
  pure surface→trust model stretches; recorded here so the extension is a
  decision, not drift.

### 5. Planned-intent provenance (#490): modality, not trust, derived at read

The 2026-08-04 failure was **not** a trust failure. "The 3am planner proposed
renegotiating LogicRays" is a perfectly reliable record — *of an intention*. The
sin was synthesis reading a **prospective** statement as a **retrospective**
one: intent narrated as event. Trust tiers cannot express that distinction — an
`unverified` tag would make synthesis *hedge* ("possibly Mitesh…") when it must
instead *reclassify* ("this was planned; did it happen?").

Therefore:

- **No new provenance class, no new stored field.** Planner output is captured
  as ordinary atoms with `surface=auto_planner` (objective, ADR-026-clean).
  `surface_trust_map` maps planner surfaces low, but trust is the minor axis.
- **Modality is derived at read, exactly parallel to trust.** Atoms from
  planning surfaces are **intent**, not **record** — deterministic from
  `surface` alone. For a user capture like "I'll ship X tomorrow," modality is
  inferred at synthesis-read like workspace/type/domain (ADR-018 machinery, no
  additions). The invariant: **synthesis never narrates intent as event; it may
  only reconcile it.**
- In role-ladder terms: intent atoms enter synthesis not as `narrative`
  material but as **the plan set the reconciliation step consumes**. They
  produce narrative only *through* reconciliation.
- **Might-do, not built:** a stored `content_subtype: intent` marker (see
  Considered option 5) if read-time derivation proves insufficient.

#### Plan-vs-actual reconciliation

- **Reconciliation is a sub-product of the Synthesize step** — not a fourth
  step in ADR-038's Link · Act · Synthesize. Its value is bundling the day's
  plan against the day's evidence, which is exactly Synthesize's batch
  semantics. No new step, no new trigger surface.
- **Inputs:** the day's intent atoms (the plan set) + the `evidence` tier doing
  the job §3 built it for (GitHub events, sent email, calendar, RescueTime) +
  the day's narrative atoms.
- **Output:** a *Planned vs actual* section in the Daily Log; each planned item
  resolves to one of four states:

  | State | Meaning |
  |---|---|
  | `done` | corroborated by evidence or narrative |
  | `mutated` | something recognisably related happened instead; the mutation gets a clause (deferral to tomorrow is a flavour of `mutated` or `skipped` — no fifth state) |
  | `skipped` | the user confirms it consciously didn't happen |
  | `unconfirmed` | no evidence either way and unresolved when asked |

- **The confirmation flow rides the existing ritual.** dos-hl is already
  interactive; reconciliation adds one pass: items the evidence cannot settle
  are asked. The user's answer during the ritual **is** the promotion moment —
  intent becomes fact only through evidence or the user's word, never by
  default. `unconfirmed` is recorded *as unconfirmed* in the Daily Log — the
  honest state, never laundered.
- **No auto-carryover.** `unconfirmed` items do not roll forward into
  tomorrow's plan or nag daily. Auto-carryover is the planner's business
  (out of scope, below), and silently re-asserting stale intent is a miniature
  of the original laundering sin.
- **Substrate footprint: near zero.** Reconciled intent atoms get the standard
  `consumed_by_state` link when folded in; resolution values live in the Daily
  Log narrative. If #493 (streaks) later wants structured resolution data,
  *that* is when a structured marker earns its place.

**Out of scope: forward planning.** This ADR governs how plans are *read*, not
how they are made. The planner deserves its own design **after** reconciliation
exists — reconciliation is the feedback loop that makes a planner worth having.

### 6. Absence as signal: the same reconciliation mechanic, a second expectation source

Absence is **not a new mechanism**. Reconciliation (§5) compares an *expected
set* against *observed evidence*; absence detection adds a second source of
expectations alongside planner intent: **calendar events** (evidence tier,
#478). A calendar meeting generates the expectation "a note should exist in
1.1 / 1.2 / 1.3 / 1.10."

- **The join runs on envelopes** (§2): event time window, attendees, title vs
  note properties and modified-time — deterministic where possible,
  LLM-assisted where fuzzy (read-time interpretation, where ADR-018 puts it).
- **Nothing is stored.** An absence is *derived at read*, never written as a
  record — it is refutable retroactively (a Gemini note syncing at 23:00 would
  contradict a stored "no note" fact). This is ADR-013 §7's "store the positive
  fact, derive the rest" applied to gaps.
- **It lands in two places, both ephemeral:** a *Gaps* line in the Daily Log
  ("2 of 3 meetings today have no note"), and a **ritual prompt** — "No record
  of the Andrew weekly. Anything worth capturing before we close the day?"
  Absence detection becomes a capture opportunity at the moment memory of the
  meeting still exists — the mechanism that would have saved the two unrecorded
  meetings on 2026-08-04.
- **Scope guard: expectation generators are argued in one at a time.** Only
  sources with an expectation generator produce absence signals; a day with no
  Slack messages is not a gap. Exactly one generator ships with this ADR:
  calendar → meeting notes. Future candidates (e.g. planned deep-work block →
  RescueTime focus time) must each earn their place — absence signals are noise
  magnets if every source emits them.

## Consequences

### Positive

- The 2026-08-04 gap closes structurally: meeting notes in all three locations
  become same-day narrative material without a single new pipeline.
- Zero new substrate: `artifacts` registry mode, `file_metadata`, the discover
  cadences, the enrichment budget, `surface_trust_map`, and user-preferences
  maps all already exist. The delta is policy entries + widening the synthesis
  read query + new discover connectors (Gmail, Slack, GitHub, RescueTime, Dex).
- Synthesis becomes robust to connector outages (local enriched copies).
- Policy is tunable without migration: promoting Slack from `evidence`, adding
  an `attention` tier, or re-weighting trust are prefs/vocab edits.
- Intent can no longer launder into record: modality derivation + the
  reconciliation gate mean a planned item enters the State Doc only through
  evidence or explicit confirmation. `unconfirmed` is a first-class honest
  state.
- The two unrecorded-meeting failure modes both close: notes that exist are
  ingested (narrative tier), and meetings with no note trigger a
  capture-prompt at EOD (absence generator).

### Negative / risks

- Store growth: day-scoped email/Slack enrichment accretes content daily.
  Bounded by the envelope filters; revisit if volume bites.
- New discover connectors are real implementation work (Gmail, Slack, GitHub,
  RescueTime, Dex listings) — each needs the per-connector `scheduler_runs`
  treatment ADR-016 established.
- The role/trust maps are conventions in prefs — a typo fails soft. Mitigated by
  the suggested vocab lists in `vocab.ts`.

## Current-state sync (ADR-039 §2)

Design-only: this ADR sets policy for capabilities not yet implemented and
changes no as-built component, boundary, or flow, so `architecture.md` is
deliberately unchanged in this PR. The sync obligation attaches to the
implementation slices cut from this ADR.

**Slice log** (each entry is a merged slice discharging part of that obligation):

- **#570 / PR #583 — §3 role ladder in code, §2 envelope stamp on discover.**
  `SYNTHESIS_ROLES` in `vocab.ts`; `default_role` / `surface_role_map` /
  `resolveSynthesisRole()` in `captureConfig.ts` (structural mirror of ADR-026's
  `resolveTrust`); `discoverItems()` stamps `surface = source_channel` per §2;
  `DISCOVER_ROLE_SEED` implements row 1.10a as a floor under the owner's stored
  map. Amended §4 row 1.10 → 1.10a/1.10b in the same PR (see the structural note
  there) rather than letting code silently contradict the table.
- **#1210 — rows 1.5/1.6 at the pointer layer, attachments only.** A Gmail
  attachment connector (`gmail_attachment` / `gmail_attachment_work`) runs
  inside the shared discover cadence and lock, behind its own opt-in
  `KMS_GMAIL_ATTACHMENT_DISCOVER_ENABLED`. One pointer per attached file anywhere
  in the mailbox (spam, trash and drafts aside), keyed `<message_id>:<part_id>`.
  The pointer layer is deliberately NOT scoped to INBOX + SENT: §4 uses that as
  the *enrich-timing* filter for evidence sources and schedules everything at the
  pointer layer, and an `in:inbox` listing would never see received mail archived
  before the next run (gmail_automations archives the threads the owner has
  processed). Embedded images (image parts with a Content-ID not marked
  `attachment`) and calendar invitations (`.ics`) are counted as excluded, not
  pointed at; both are §2 envelope facts. §2 envelope fields (sender name and
  address, to, subject, date, filename, MIME type, size, ids, disposition) go to
  `processing_metadata.discovery`, which is where the pointer path already keeps
  its envelope, rather than `file_metadata`. Each run sweeps new mail first, then
  spends the rest of its per-account budget backfilling history newest first.
  Role `evidence` via `DISCOVER_ROLE_SEED`; origination is the message date.
  Message-level pointers and same-day enrichment of email bodies (the rest of
  rows 1.5/1.6) are not built; attachments are not enriched yet.
- **#1767 — §3 role floor extended to the machine-ingest surfaces.** `github`,
  `slack`, `slack_dm`, `derived` and `gmail_ingest` join `DISCOVER_ROLE_SEED` at
  `evidence` (rows 1.7, 1.8 and the body-ingest surface of rows 1.5/1.6; `derived`
  per its surface comment). Until then the live store's
  stored map was empty, so every row those ingests wrote resolved to the
  `narrative` default and narrated bare, the flood §3 exists to prevent; the
  doctor had warned about the four surfaces and proposed a data migration. The
  floor is the #570 mechanism: shipped with the code that stamps the surface,
  overridable per key from the owner's stored map. `act_receipt` (the send
  receipt `gmail_send_draft` writes, #1006) follows in #1771: the owner decided
  on 2026-10-14 (#1767, ADR-108 §4) that sent mail corroborates per rows
  1.5/1.6, but the ranked read's robot exclusion runs on the narrative tier
  only, so the floor entry lands with the change that applies it to every tier.
  No tool writes `gmail_ingest` yet; the 13 Oct sent-mail atoms were captured by
  hand under it and now resolve to `evidence`.

## Links

- Builds on: [ADR-016](./ADR016_Discover_And_Index_Axis.md),
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md),
  [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md),
  [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md)
- Composes with: [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md),
  [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md)
- Issues: #488, #490 · tracking #497 · session note
  `docs/sessions/2026-08-04-eod-synthesis-failure-case.md`
