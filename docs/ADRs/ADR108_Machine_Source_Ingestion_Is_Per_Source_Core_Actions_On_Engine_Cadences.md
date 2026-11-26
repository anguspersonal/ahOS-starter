# ADR108: Machine-source ingestion is per-source core actions on engine cadences, with roles floored in code

- **Status:** Accepted
- **Created:** 2026-10-14
- **Accepted-on-dev:** 2026-10-14
- **Deciders:** Angus Hally (owner: §4 sent mail and §5 evidence consumption chosen on 2026-10-14, recorded on #1767); drafted by the architect under [ADR-102](./ADR102_Operating_Model_Architect_Owner_Executor.md)
- **Amends:** [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md) (§1: a policy row may collapse discover and enrich into one pass through `capture` when the item is the content; §3: the role floor for machine surfaces ships in code; §4: a Shape column, rows 1.7 and 1.8 tightened, rows 1.1 to 1.3 amended (identity is `page_id`, `last_edited_time` is the change hash), row 1.11 added); [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) (Amendment 1: atoms the day-scoped evidence read considers are not marked per atom; Amendment 3: the "unconsumed atoms should only be from today" signal counts the narrative tier; §13: the evidence-only day's list comes from the evidence aggregate); [ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md) (§1 and §4: the set the slice bounds, and the reported "of N", are the unconsumed narrative set; Amendment 1: the no-migration choice is reversed for the `not_consumed` predicate, §7; §2 unchanged)
- **Builds on:** [ADR-016](./ADR016_Discover_And_Index_Axis.md), [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md), [ADR-028](./ADR028_Surface_Registry_And_Reference_Artifacts.md), [ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md), [ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md), [ADR-084](./ADR084_Entity_Domain_Is_Derived_By_Rule_Residue_Stored_As_An_Override.md), [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md), [ADR-106](./ADR106_GitHub_Actions_Migrate_Into_ahKMS_Under_Ledger_And_Approval_Gate.md)
- **Amended by:** [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md) (§5: what the day aggregate counts, its two clocks, late arrivals, multi-day entries and the per-correspondent grouping; closure by any of the four kinds)
- **Resolves:** #1767 (the RFC this ADR answers)

## Context and problem

Issue #1767 proposes a "modular multi-source ingestion framework": a `BaseIngester`
class with `fetch`, `dedup`, `transform` and `batchInsert`, seven ingestion sources
registered as `resource` entities, and a volume target of about a thousand evidence
atoms a day feeding the end-of-day ritual. It asks four questions: where the code lives,
what schedules it, how Notion edits are filtered, and whether the role map should bind
`github`, `slack`, `slack_dm` and `notion` to `evidence`.

The problem behind it is real. On 2026-10-13 the day's GitHub activity, Slack DMs and
sent mail reached ahKMS only because an attended session ran `ingest_github` and
`ingest_slack` and captured the mail by hand. Nothing schedules those ingests, although
[ADR-046 §4](./ADR046_Per_Source_Ingestion_Policy.md) has said "scheduled, daily" for
them since August. And when they do run, their rows narrate: the live `surface_role_map`
was empty on 2026-10-14, so every `github`, `slack` and `slack_dm` row resolved to the
`narrative` default, and the backlog slice's first fifty "narrative" rows were GitHub
issues, Slack DMs and sent mail. `ahos_doctor` had warned about exactly those surfaces
for weeks and proposed a data migration nobody ran.

Most of what the RFC asks is already decided, and the record says so in several places:
[ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md) puts every
action in `@ahkms/core` over ports with the SDK in `core/adapters`;
[ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md) as amended by ADR-101
names engine cadences on the Railway host as the substrate for unattended work;
[ADR-046 §3](./ADR046_Per_Source_Ingestion_Policy.md) and §4 rows 1.5 to 1.8 give email,
Slack and GitHub the `evidence` role; the migration ledger #1338 and packets #1531
(`ingest_github`) and #1535 (`ingest_slack`) already specify two of the seven sources in
exactly that shape. What the RFC surfaces that is not yet written down is narrower, and
this ADR records only that: the write shape per source, how evidence is consumed at
volume, the role floor, how a machine atom's domain is derived, the Notion feed, and the
alternatives it declines.

## Decision drivers

- **Reach for an existing decision before a new mechanism** (`vision.md`, principle 8;
  [ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md)). A second
  abstraction for a job the action, port and cadence shape already does is drift.
- **One write primitive, one ledger** ([ADR-018 §2](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)): every atom is written by the `capture` action through `executeAction`; an insert path beside it is an unrecorded write.
- **Facts at write, interpretation at read** ([ADR-046 §2](./ADR046_Per_Source_Ingestion_Policy.md)): an ingester stamps what the API served; role and trust derive from `surface` at read ([ADR-046 §3](./ADR046_Per_Source_Ingestion_Policy.md), [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md)).
- **No write amplification; derive, do not store** ([ADR-036 §2](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md), [ADR-052 §1](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md)).
- **The queue is bounded and nothing decays** ([ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md)): a volume target is a promise about what the ritual can still read.
- **A floor beats a nag.** The #570 Drive floor fixed this class of defect once; a doctor warning that proposes a data migration did not.

## Considered options

### Option A — The RFC as written: a `BaseIngester` framework, sources as `resource` entities, ~1,000 atoms/day

- **Pros:** one place to look for "how ingestion works"; per-item and per-source isolation named explicitly; no model at write.
- **Cons:** a class hierarchy beside the action registry is two homes for one rule (the drift ADR-101 exists to end); `batchInsert` writes `artifacts` beside `capture`, so nothing it writes is ledgered or deduplicated by the capture key; it stamps `role` on the row, which has no column and is derived at read; `resource` is a tracked document ([ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md)) and a source entity puts source machinery on the node class [ADR-028 §1](./ADR028_Surface_Registry_And_Reference_Artifacts.md) keeps free of it; the volume target is stated without the read path that would have to carry it; "~500-word Daily Log" re-decides [ADR-051 §3](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) in passing.

### Option B — Per-source core actions on engine cadences; shared helpers only; roles floored in code (chosen)

- **Pros:** every piece lands where ADR-101, ADR-104 and ADR-105 (draft, #1466) already put it; #1531 and #1535 are the first two packets unchanged; the role defect is a floor with the doctor as its guard; isolation is the cadence contract the discover cadence already uses.
- **Cons:** no single framework to read; seven sources are seven packets; the role floor changes what tonight's ritual narrates, which the owner must know; the evidence-consumption rule (§5 below) touches the ritual.

### Option C — Keep ingestion attended and on demand

- **Pros:** nothing to build.
- **Cons:** the 2026-10-13 mode is the failure the RFC describes: a day's evidence exists only if someone remembers to ask for it, and the ritual then reads live connectors at 9pm, the resilience failure [ADR-046 §4](./ADR046_Per_Source_Ingestion_Policy.md) was written against.

## Decision

We chose **Option B**. Sections 1 and 2 restate placement and substrate from the record
([ADR-039 §1](./ADR039_ADR_Immutability_Metadata_And_Guards.md): a restatement is not a
decision), so the RFC's questions have one answer in one place; §1 also decides the dedup
key and the shared helper, which are new. Sections 3 to 7 are the decisions this ADR
makes. Section 8 names what it declines.

### 1. Package placement (restates ADR-101; the dedup key and the shared helper are decided here)

Each machine source is one `defineAction` in `@ahkms/core` over a port
(`GithubActivityPort`, `SlackPort`, `GmailPort`, `NotionPort`), with the vendor SDK in
`core/adapters` and each item written through the core `capture` action as a nested
`executeAction` call (caller `internal`, its own ledger row, [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md)),
as `ingest_github` and `ingest_slack` already do inside the front door and as #1531 and
#1535 specify for placement and capture ([ADR-101 §1](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md),
#1528). What the sources share is a pure helper, not a base class, in
`core/src/domain/ingest`, the directory #1545 opens for pure ingest code (a sibling file
of that packet's pointer rules, not part of it): a date window in, the envelope dedup key
per [ADR-046 §4](./ADR046_Per_Source_Ingestion_Policy.md), and a capture payload out
with `surface`, `content_subtype`, the envelope and the `dedup_key` stamped. Dedup is the
capture key and its unique index (`artifacts.dedup_key`, migration 106; a second call
returns the first row with `deduplicated: true`), keyed `<surface>:<envelope id>`, with a
connection segment only where one surface has several connections (Gmail, Notion;
[ADR-060 §1](./ADR060_Many_Connections_Per_Provider_And_Semantics_Attach_To_The_Connection.md)).
This replaces the per-window `artifacts.source` lookup #1531 and #1535 specify (today's
`findAlreadyIngested`, which no index serves without `source_channel`, migration 118):
both packets are amended, and the rows already ingested by URL get their `dedup_key`
backfilled before the `source` lookup goes, so no existing item is captured twice
([ADR-069 §1](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md)).
There is no `BaseIngester` and no `batchInsert`; outside core there is only the
composition-root wiring ADR-101 allows.

### 2. Scheduling substrate (restated; one target named)

Unattended ingestion runs as engine cadences in `packages/core/src/engine/cadences/`,
one per source, hosted by the engine process `node packages/core/dist/engine/main.js` on
the worker's Railway service ([ADR-101 §2](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)).
Each cadence invokes one registry action through `executeAction` with caller `worker`:
#1554's `actionCadence` shape and ADR-105 R5 (draft, #1466), still unbuilt, since
`deriveCadence.ts` calls the action body directly today (#1415). Production runs none of
the engine's cadences yet: the service starts `node app.js` (`packages/worker/railway.json`),
and `KMS_ENGINE_ENABLED` gates only `engineHost.js`, an empty runner that #1409 deletes.
A cadence goes live through the start command (#1409), its own variables (#1410) and a
migration that seeds its `scheduler_locks` row and widens `scheduler_runs_cadence_check`
(migration 131's pattern), one per source. Per-source isolation comes from the runner:
each cadence holds its own lock and writes its own `scheduler_runs` row, so one source's
failure never aborts another; the legacy `discoverCadence.ts` reached the same behaviour
inside one shared lock, a shortcut not carried over. GitHub Actions stay for repository
engineering only ([ADR-093 §1](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md)).
Cloud Run jobs are declined because ADR-101 §2 already names the engine as the one place
product cadences run and its consequences rule out a new service; ADR-093 never weighed
Cloud Run. `check-no-new-cadence.js` already forbids the legacy `schedule/` directories;
nothing yet asserts the engine location positively. The synthesis half is unchanged: the
attended ritual stays the owner's session, the unattended sweep stays a Claude Routine
([ADR-093 §2](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md); its audit is #1764),
and the engine runs no ritual because Synthesize is human-gated
([ADR-050 §8](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md)), while
it does host the derive LLM batch ([ADR-101 §1](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md)).

### 3. Write shape per source (amends ADR-046 §1 and §4)

[ADR-046 §4](./ADR046_Per_Source_Ingestion_Policy.md)'s structural notes make "everything
is scheduled at the pointer layer" the default under §1's discover-shaped rule, and it
stays the default. A policy row may collapse discover and enrich into **one pass through
`capture`** when the item *is* the content and the source serves it in the listing pass or
in one bounded per-item read (Slack search, GitHub events, Gmail `messages.get` on the
owner's sent mail); this is not a second write path, it is the `capture` write once, with
content, in place of a pointer insert followed by an enrich update. Embedding for one-pass
evidence atoms follows §8 (pointer-style, batched), a capture option the first packet
names. The §4 table gains a **Shape** column:

| Row | Source | Shape | Unit and key | Notes |
|---|---|---|---|---|
| 1.8 | GitHub, the owner's own events | content, one pass | the owner's authored, commented, reviewed or merged event, keyed by event id or SHA | Row 1.8 already said "events are the content". The unit is the event, not the issue or PR: an issue touched on three days is three events, and an item ingested once is never frozen at first sight. #1531 is amended accordingly. |
| 1.7 | Slack, the owner's own messages | content, one pass | `channel + ts` | Scope stays `from:@me` as built (#1012; `tools/slackIngest.ts`, `slack/client.ts`): the owner's own words in channels and DMs, never other people's messages in channels the owner posted in. Row 1.7's "channels-posted-in + DMs" is tightened to that. #1012 recorded the cost ("thread context is lost"); the alternative, capturing the parent message of each reply as a second atom on its own surface at `evidence`, is not adopted here and can be reopened as a §4 row. |
| 1.5 / 1.6 sent | Gmail, mail the owner sent | content, one pass | `message_id` | Bounded by the owner's own output. Declares `gmail_ingest` in `ARTIFACT_SURFACES`; its floor entry ships in this ADR's PR (§4). `gmail_send_draft`'s receipt is amended to stamp the sent message id (today it records only the thread id, `tools/gmail.ts`, and returns the message id without storing it), and both writers use the key `gmail:<account>:<message_id>` as `dedup_key`, so the ingester's capture is a no-op where the act already captured ([ADR-069 §1](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md)). |
| 1.5 / 1.6 received | Gmail, mail received | pointer, then budgeted enrich | `message_id` | Unchanged: the INBOX + SENT and category-label filter belongs at enrich time behind the `GmailPort` reader (#1497, #1489). "Key non-triage threads" is write-time interpretation and is declined ([ADR-046 §2](./ADR046_Per_Source_Ingestion_Policy.md)). |
| 1.1 to 1.3 | Notion meeting notes | pointer, then enrich | identity `page_id`; `last_edited_time` is the change hash, not part of the identity | Unchanged, `narrative`. Amended: as built the pointer is one row per page and an edit updates it and re-originates it to `last_edited_time` ([ADR-088 §2](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md)); the rows read as page + version and were never that. Known gap: a note edited after the ritual marked it does not return from `not_consumed`; [ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md) Option C (a `resurfaced` marker) is the recorded fix and is its own packet. Nothing Notion reaches the ritual until a `NotionPort` reader enriches it; that is its own packet. |
| 1.11 (new) | Notion pages other than meeting notes, both workspaces | pointer, then enrich: the existing Notion discover pointer, **re-originated** on a substantive change | identity `page_id`; a substantive change is two envelope facts together, `last_edited_time` moved and `last_edited_by` is not ahOS's own integration user, and the page is not in a ritual-output container (the Daily Log databases, the State Doc) | No atom is ever minted per edit: the one pointer re-originates to the change's date and re-enters the day window ([ADR-016 §2](./ADR016_Discover_And_Index_Axis.md): changed pointers refresh the map; [ADR-088 §2](./ADR088_A_Day_Window_Reads_Valid_Time_Coverage_Reads_Transaction_Time.md)). Formulas and rollups do not move `last_edited_time`; ahOS's own writes do, hence the author and container filters. The hash over the properties the row names, and the enrich-time text hash, decide what a re-enrich writes, not whether the pointer re-originates: a body-only edit must count, and the pointer cannot see the body. Notion tasks are excluded: the ritual reads the Tasks DB live (`dos` skill step 7; [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md), [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md)) and excludes it from intent ([ADR-051 §5](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)). Role `evidence`, trust medium. **Precondition:** the Notion connector splits into four discover connectors, `notion_meetings_work`, `notion_meetings_personal`, `notion_pages_work`, `notion_pages_personal`, whose surfaces are therefore `discovered_<connector>` (the 1.10a pattern); the two `notion_meetings_*` surfaces stay `narrative` (rows 1.1 to 1.3), the two `notion_pages_*` surfaces are floored at `evidence`; and existing `discovered_notion` rows are re-channelled by a backfill migration in the same packet, because re-discovery matches on `source_channel` + `source` and a new connector name would otherwise give every page a second pointer ([ADR-069 §1](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md)). Connection names (`notion_work`, `notion_personal`) are not surface names (§6). One `discovered_notion` surface can neither tier meeting notes against project pages nor tell the two workspaces apart. |

Drive keeps the two-cadence model. Each new surface also gets its
[ADR-046 §4](./ADR046_Per_Source_Ingestion_Policy.md) trust row (`surface_trust_map`:
GitHub high, Slack medium, sent mail high) in the packet that declares it.

### 4. Role defaults (amends ADR-046 §3)

Yes to `github`, `slack` and `slack_dm`, plus `derived`, the mail-body surface
`gmail_ingest` (rows 1.5/1.6) and, one packet later, `act_receipt` (below, landing in
#1771), and the mechanism is the shipped floor, not a data migration: they join `DISCOVER_ROLE_SEED` at
`evidence` (the #570
pattern: deployed with the code that stamps the surface, overridable per key from the
owner's stored map). `ahos_doctor`'s `surface_role_map` check stays as the guard for a
surface on its bulk list that the effective map does not carry; a new bulk surface is
added to that list and to the floor together. Role is never stamped on a row: the RFC's
`role: 'evidence'` field has no column and no meaning; `surface` is the key the floor
reads ([ADR-046 §3](./ADR046_Per_Source_Ingestion_Policy.md)). `notion` is not a surface
and is not floored: rows 1.1 to 1.3 are `narrative` by decision and row 1.11 declares
its own surface when built.

**Sent mail (decided by the owner, 2026-10-14).** [ADR-046 §4](./ADR046_Per_Source_Ingestion_Policy.md)
rows 1.5/1.6 put the owner's sent mail at `evidence`, trust high. The `email_sent`
comment in `vocab.ts` (#1006) called it narrative material, and the receipt
`gmail_send_draft` writes lands on `act_receipt`, which resolved to `narrative`. The
owner chose that the ADR stands: ingested sent mail corroborates, the session summary and
captures narrate. So `act_receipt` joins the floor and the `email_sent` comment is corrected, so that a
receipt and the ingested copy of the same mail resolve alike. Not in this ADR's PR:
`resolveSynthesisRole` drops a robot row before it reads the map, but the ranked read the
ritual uses (`roleRankedSearch`) partitions tiers by surface in SQL and applies the #1222
robot exclusion to the narrative tier only, so flooring `act_receipt` first would list
every `[auto-task]` and "Scheduled routine completed" receipt in the evidence tier. #1771
applies the exclusion to every tier and adds the floor entry in the same change. This
reverses #1222's acceptance that attended sends keep their role; robot receipts stay
`excluded` whatever surface they carry. The alternative,
amending rows 1.5/1.6 so role splits by direction and sent mail narrates, was declined.

### 5. Evidence is consumed by the day, not by the atom (decided by the owner, 2026-10-14; builds the ADR-046 §3 gate ADR-067 left unbuilt)

The ritual reads two bounded slices of fifty ([ADR-067 Amendment 1](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md), `dos` Setup
reads 4 and 5) and marks every atom those reads returned ([ADR-051 Amendment 1](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md));
[ADR-046 §3](./ADR046_Per_Source_Ingestion_Policy.md) gives, as an investment guideline
and not a hard rule, that narrative items are read one by one and evidence is "consulted
in bulk on demand"; [ADR-051 §13](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) says evidence-only days list evidence
structurally. At hundreds of evidence atoms a day, per-atom marking cannot keep up: the
queue grows by the difference every night (1,713 to 3,137 under the fifty-a-night drain,
[ADR-067 Amendment 1](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md)), [ADR-051 Amendment 3](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)'s health signal
("unconsumed atoms should only be from today") goes permanently red, and the ranked slice
spends its fifty on rows that may never narrate. The owner's own summary of the model,
which this section records: capture every machine atom deterministically as evidence,
read the narrative (human-written) captures one by one, and aggregate the evidence over
its ingestion pipelines. "Narrative (human-written)" is read as the `narrative` tier of
[ADR-046 §4](./ADR046_Per_Source_Ingestion_Policy.md), which includes AI-written meeting
notes (rows 1.1 to 1.3, 1.10b). This clause makes the guideline the rule for the queue,
one tier above the metrics-and-excluded gate ADR-067 Amendment 1 named and left unbuilt.
Therefore:

- **The per-atom unconsumed queue is narrative-only by default.** `knowledge_search`'s
  `not_consumed` read, the backlog slice and the Amendment 3 signal default to the
  `narrative` tier; a caller names other tiers explicitly (`roles: [...]`, ADR-046 §3's
  consumer override), and the ritual never does.
- **Evidence reaches the ritual as a day-scoped aggregate read**: counts per surface and
  per connection (repo, channel, correspondent) plus a bounded top-N by `effective_at`,
  used to corroborate the narrative and to fill §13's structural list. A grouped read
  over the existing columns, no new store.
- **Evidence consumption is one row per day per domain, on the day's Daily Log twin.**
  When a domain's day closes, Step 8c writes one `artifact_external_links` row on that
  day's twin, `external_id` the Daily Log page, with a kind outside
  `SYNTHESIS_MARKER_KINDS` (`evidence_aggregated` attended, `evidence_aggregated_unattended`
  for the sweep; the `consumed_by_state` pattern of [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) Erratum 1), never a
  marker per evidence atom and never a synthesis kind on the twin
  ([ADR-050 §7](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md)). The
  readers change with it, in the same packet: `dos_synthesis_coverage` and the streak
  count a day with evidence atoms, no narrative marker and this row as closed, not
  `neither`, and `no_material` stays "zero atoms of any tier"; the #561 sweep's
  `stampable` test becomes "at least one unconsumed narrative atom, or a non-empty
  evidence aggregate for that day", so §13's evidence-only log is still written and the
  day still closes; `external_link_create`'s kind list gains the two kinds. Atoms still
  never decay ([ADR-067 §2](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md)): they stay searchable and consultable; they are
  simply not queued.

The packet for this clause changes `knowledge_search`, the `dos` skill (reads 4 and 5,
the sweep's eligibility, Step 8c), `dos_synthesis_coverage`, the streak derivation and
`external_link_create` together. The architect's recommended order (fork D on #1767, open)
lands it before any ingestion cadence is enabled on a schedule.

> **Erratum (2026-10-14):** fork D was decided on #1767 the same day (D1). The follow-up order in Consequences stands as written, so the "fork D on #1767, open" in this section, in §7's heading and body, and in Consequences is answered. A code map of this section found readers it does not list, and questions it leaves open. Both are recorded on #1781, which carries the slice plan. Any answer there that changes this section's decision is recorded in a new ADR that amends it. This erratum is metadata under ADR-039 §1: no decision changes, so the Status line is not stamped.

### 6. A machine atom's domain is derived at read from its connection (no change to ADR-046 §2; applies ADR-084 to atoms)

The RFC partitions atoms by domain at write. The record forbids that: "Domain is derived,
never captured" (`vision.md`, "The two axes"; [ADR-084](./ADR084_Entity_Domain_Is_Derived_By_Rule_Residue_Stored_As_An_Override.md):
a stored value exists only where derivation cannot reach), and
[ADR-018 §2](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) and
[ADR-046 §1](./ADR046_Per_Source_Ingestion_Policy.md) allow no domain inference at write.
Nor is a `domain:` tag an envelope fact under [ADR-046 §2](./ADR046_Per_Source_Ingestion_Policy.md):
no API returns "work"; the Gmail API returns `owner@work.example.com` and the GitHub
API returns `example-org/core`, and the domain is ahOS's own rule applied to them.

So an ingested atom stores its **connection**, which is an envelope fact, and never its
domain. Where one surface is one connection the surface already says it (`slack`,
`slack_dm`, the `discovered_gmail_attachment*` pair, the four Notion connectors of row
1.11); otherwise the connection goes in the envelope (`account` for `gmail_ingest`; for
`github`, one identity over both organisations per [ADR-106](./ADR106_GitHub_Actions_Migrate_Into_ahKMS_Under_Ledger_And_Approval_Gate.md),
the repository owner is already the `repo:` tag). The ritual derives the domain from the
connection by a fixed rule at read, before it reads content: `example-org/*` and the Work
Google, Notion and Slack connections are `work`; `anguspersonal/*`, `google_personal`
and `notion_personal` are `angus` ([ADR-051 §1](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md);
[ADR-107](./ADR107_Three_Value_Entity_Domain_Axis_Work_Angus_CrossDomain.md) Rules
item 3 for the Google and Notion accounts; the #565 repo rule `/close` and `dos` already
apply). It is the `resolveTrust` / `resolveSynthesisRole` shape: surface plus one envelope
fact, derived at read, stored nowhere. The `/close` `domain:` tag on a session summary
stays the one stored exception, a user-side tag from an attended session (#565), and the
ritual routes on no other writer's `domain:` tag.

Under §5 this rule reaches only what it needs to: the evidence aggregate is grouped by
connection, so each group's domain is the connection's, and the §13 list for each
domain's log is drawn from its own connections. Narrative atoms keep routing on content
(`dos` Step 1; a mixed atom goes to `angus` because that direction leaks nothing,
[ADR-051 §2](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)).
Nothing in this section is a write-time rule, so `capture_preferences.tag_rules` cannot
become the routing-at-write ADR-018 rejected.

### 7. Read-path preconditions (what, not how; their order against §5 is fork D on #1767, open)

The volume §3 produces is a consequence, not a goal, and it is a read-path commitment.
Before any ingestion cadence is scheduled:

- **The engine process runs on the worker's Railway service and has written a
  `scheduler_runs` row.** That is one executor packet, #1409 (the service starts
  `core/dist/engine/main.js`; today it starts `node app.js`, and `engineHost.js` starts a
  runner with no cadences, so no flag alone produces a run row), and one owner step,
  #1410 (`supabase db push` of the pending migrations, which seed the engine lock rows;
  the service variables; a redeploy). Migrations 127 and 131 seed the lock rows; #1410
  tracks what production has applied.
- **`knowledge_search` evaluates `not_consumed` in the database**, not over a client-side
  marker list, and the synthesis read's count is served by an index whose predicate
  matches its filter, both shown by `EXPLAIN` in production (#1769). The reason is the
  defect class, not a threshold reached: the marker list is fetched unpaginated (PostgREST
  caps it at 1,000 rows, the cap [ADR-067 Amendment 1](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md) records; under a thousand
  rows exist today) and, above 150 ids, is applied in JavaScript over a fixed over-fetch
  that is never refilled, so a tier short-pages once more than fifty of its newest rows
  are consumed. Whether the count today walks every one of the owner's rows or only the
  enriched subset is for #1769's `EXPLAIN` to show. The coverage and streak readers share
  the same marker fetch and §5 changes them; #1769 or a named sibling covers them.

The second item is a correctness precondition and the architect's to order; where the
engine step, #1769 and §5's packet fall relative to each other is the owner's (fork D).
This reverses [ADR-067 Amendment 1](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md)'s choice to avoid a migration for the
`not_consumed` predicate, and nothing else in it: ranking stays in SQL, role stays derived
at read.

> **Erratum (2026-10-14):** the order against §5 was decided on #1767 (D1): the role floor, then #1769, then the engine (#1409, #1410), then §5. The "named sibling" for the coverage, streak and Daily Log queue marker reads is #1779. Metadata under ADR-039 §1.

### 8. What the RFC asked for that this ADR declines

- **Sources as `resource` entities with `level: meta`.** Declined as framed. `level: meta`
  is the operating system describing itself ([ADR-107](./ADR107_Three_Value_Entity_Domain_Axis_Work_Angus_CrossDomain.md),
  orthogonal axes), and a GitHub organisation, a Slack workspace or a Notion workspace is
  not; ADR-107's own table files `Work MVP Repo` and `App Store Connect` as ordinary
  `work` entities, so a repository or workspace may be an instance-level entity when
  atoms are about it, but it is not minted as a precondition of ingesting from it and no
  atom links to it per row ([ADR-036 §2](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md)).
  The declared set of connections already has a home: one `user_integrations` row per
  connection ([ADR-060 §1](./ADR060_Many_Connections_Per_Provider_And_Semantics_Attach_To_The_Connection.md))
  and one engine cadence per source (§2). Each atom carries its `surface` and
  `source_channel`; run health and silence are queries over `scheduler_runs`
  ([ADR-052 §1](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md));
  inbound mirroring registers a surface's records as reference artifacts
  ([ADR-028 §6](./ADR028_Surface_Registry_And_Reference_Artifacts.md)), and entities are
  the derived nouns those records are about, carrying no source machinery (ADR-028 §1 and
  its Option 2). If an ingest action is ever wanted in the graph it is registered under
  [ADR-031](./ADR031_Capability_Registry.md), whose `kind` vocabulary
  (`skill | agent | command`) would need a value for actions; nothing here decides that.
- **"~500-word Daily Logs".** [ADR-051 §3](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
  fixes the shape (paragraph, bullets, tomorrow) and sets no length; the `dos` skill's
  Summary is fifty words and the body one paragraph. §11 to §13 already place the
  unattended draft, its markers and its twin, which is what the RFC's §3 describes. If a
  length ceiling is ever wanted it is a `dos_config` value, as the State Doc's is, not an
  ADR clause.
- **"~1,000 atoms/day" as a target.** Read as a quota, struck; read as the capacity the
  read path must carry, it is §7's requirement. The measured day, 2026-10-13, is 161
  GitHub items, 14 Slack DMs and 4 sent mails, about 180 atoms before Notion and received
  mail; the GitHub count is items, and §3's events will differ. Restated from measured
  counts once §3's units are built, and gated by §5 and §7.
- **"Zero LLM inference costs or token spend".** False as built: every new `capture` row
  embeds once through OpenAI when the key is set (a dedup hit returns before the embed),
  and an embedding call is a model call billed per token. "No LLM inference at write" is
  the true claim. Whether evidence atoms embed at all, embed title and the source-provided
  description as pointers do, or embed in batches is decided per §4 row in its packet;
  the default is pointer-style, batched.

## Consequences

- **Good:** two of the seven sources are already specified (#1531, #1535) and change
  only their unit and dedup key; the role defect is fixed by one floor; the record now
  says why there is no ingestion framework and no source entities, so the next RFC does
  not reopen them; the evidence rule keeps the ritual's queue bounded at any ingest volume.
- **Cost / bad:** tonight's ritual narrates fewer rows: GitHub, Slack, derived and
  mail-body rows move to `evidence` and corroborate instead. The owner can promote any
  surface back per key in `surface_role_map`. §5 changes `knowledge_search`, the `dos`
  skill, the coverage and streak readers and the marker writes; the recommended order
  lands it before any cadence (fork D, open). The RFC's seven sources
  are four connector actions (GitHub, Slack, Gmail, Notion), each parameterised by
  account, and they remain separate packets sequenced behind #1511
  (`ArtifactRepository`) per #1338's order.
- **Follow-up (in order):** the role floor (this ADR's PR; `act_receipt` via #1771 once the
  ranked read's robot exclusion covers every tier); the read-path precondition
  (#1769, §7); the engine process live on the worker service (#1409 then #1410, §7); §5's narrative-only queue and day-level evidence read; #1531 and #1535 amended
  to §3's units and keys, reopening when #1511 merges, with the GitHub `read_repos`
  allowlist and `GITHUB_TOKEN_INGEST` per [ADR-106](./ADR106_GitHub_Actions_Migrate_Into_ahKMS_Under_Ledger_And_Approval_Gate.md);
  sent mail (§3) alongside them; received mail and the Notion feed after the Gmail OAuth
  seam (#1497, #1489) and #1545/#1625. `docs/architecture/architecture.md` is unchanged
  by this ADR (design only, [ADR-039 §2](./ADR039_ADR_Immutability_Metadata_And_Guards.md));
  the packets that build each cadence update it.

## Links

- Resolves: #1767
- Related packets: #1338, #1531, #1535, #1545, #1554, #1553, #1511, #1625, #1627, #1579, #1497, #1489, #1466, #1764
- Related: [ADR-016](./ADR016_Discover_And_Index_Axis.md), [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md), [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md), [ADR-028](./ADR028_Surface_Registry_And_Reference_Artifacts.md), [ADR-036](./ADR036_IRI_Grounded_Vocabulary_Self_Describing_Graph.md), [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md), [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md), [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md), [ADR-052](./ADR052_System_Metrics_Are_Derived_And_The_Monitor_Sits_Outside.md), [ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md), [ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md), [ADR-087](./ADR087_The_Orchestrator_Runs_On_Agent_Platform_Not_A_Custom_Daemon.md), [ADR-093](./ADR093_Scheduling_Substrate_Split_By_Job_Class.md), [ADR-098](./ADR098_Tracked_Documents_Are_A_Resource_Entity_With_A_Canonical_Pointer.md), [ADR-101](./ADR101_Two_Packages_Two_Processes_Core_Is_Rulebook_And_Engine.md), [ADR-104](./ADR104_Every_Action_Call_Is_Ledgered_And_Outward_Agent_Calls_Wait_For_The_Owner.md), [ADR-106](./ADR106_GitHub_Actions_Migrate_Into_ahKMS_Under_Ledger_And_Approval_Gate.md), [ADR-107](./ADR107_Three_Value_Entity_Domain_Axis_Work_Angus_CrossDomain.md)
