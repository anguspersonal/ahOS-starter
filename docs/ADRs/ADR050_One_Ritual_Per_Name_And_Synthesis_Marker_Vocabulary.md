# ADR-050: One ritual per name — capability lineage, and the synthesis-marker vocabulary

- **Status:** Accepted
- **Created:** 2026-08-05
- **Accepted-on-dev:** 2026-08-05
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, skills, capture, synthesis, dos, lineage, registry
- **Builds on:** ADR-013 (capture primitive + memory/working-state split), ADR-018 (unified capture surface + synthesis-time interpretation), ADR-022 (State Doc is a projection, not a sink), ADR-023 (sibling read-side consumers), ADR-031 (capability registry), ADR-038 (three-step synthesis)
- **Supersedes in part:** ADR-013 §7 (marker name), ADR-018 §3 (mode selection) and §5 (marker name), ADR-038 §2 (marker vocabulary)
- **Resolves:** #487 (decommission the Notion Inbox DB), #415 (dos-hl forked across surfaces)
- **Amended by:** [ADR-109](./ADR109_Evidence_Closes_Its_Day_By_Arrival_Is_Listed_By_Date_Late_Arrivals_Ride_The_Next_Aggregate.md) (§8: a day may also be closed by an `evidence_aggregated` or `evidence_aggregated_unattended` row on its twin); [ADR-112](./ADR112_Three_Ritual_Verbs_Prep_Sync_Reflect_And_Task_Anchored_Reconciliation.md) (§1: the synthesis ritual's canonical verb is `sync` with `synth` and `dos` as permanent aliases; `prep`, `sync`, and `reflect` are all repo-authored under `.claude/skills/*`)

---

> **Same-PR doc-sync note (`docs/ADRs/README.md`).** This ADR changes real
> system shape (marker vocabulary, single-ritual serving, Inbox DB
> decommission), so the README's same-PR sync rule for `architecture.md`
> applies — but this PR defers that edit. `architecture.md:41` and `:139` are
> still accurate today (every call site still reads/writes
> `kind='consumed_by_state'`; the Daily Log is still Notion-only, not a
> derived artifact) — rewriting them now would replace true as-built prose
> with a description of an unbuilt future. `architecture.md` updates land
> with the code that makes each line true — alongside #560 (marker rename),
> #561 (fallback sweep), and #562 (Daily Log as artifact) — not with the
> decision that names the target.

## Context

ADR-018 (accepted 2026-06-16) retired `dos-inbox`, re-rooted `dos-hl` on ahkms
artifacts, and recorded that "the Notion Inbox DB sunsets." The **repo** copy
complied: `.claude/skills/dos-hl/SKILL.md` reads unconsumed atoms via
`search_knowledge` and states outright that it "does not write to a Notion Inbox
DB (that's deprecated — see ADR-018)."

The **chat / Cowork** copies never did. They are served from a different lineage
entirely — an indexed skill bundle outside this repo — and still read and write
the Notion Inbox DB. The capability registry lists them (`dos-eod`, `dos-inbox`,
`dos-braindump`, `dos-reflect`) as `surface=cowork+chat`, `home=claude(indexed)`,
`body: (none)`, pointing at `~/.claude/chat-skills/*.skill` — **a directory that
does not exist**. So the registry knows their names, holds none of their content,
and cannot serve them; meanwhile something else answers to those names on the
surfaces where Angus actually runs the ritual.

The cost came due on 2026-08-04. The EOD ritual read a "backlog" of 65 Inbox
entries spanning 1 May – 4 Jun and synthesised it as if it were current, while
that day's real atoms went unread. Nothing malfunctioned. A ritual under a
familiar name read a substrate that had been declared dead five months earlier,
and reported confidently.

Three further facts, established while grilling #487/#415 on 2026-08-05:

1. **The fork's justification had expired.** #415 asked whether a deliberately
   simpler chat variant was correct, on the premise that "a chat surface has no
   ahkms MCP by default." #84 — the authenticated remote serving surface — closed
   2026-07-07, and the connector is live on chat and Cowork (confirmed by the
   owner, 2026-08-05). There is no capability gap left to justify a second
   ritual.

2. **A skipped day's atoms do not pile up — they disappear.** `dos-hl`'s atom
   read is bounded to today (`captured_after` 00:00 → `captured_before` 23:59,
   `not_consumed: true`). Atoms captured on a day the ritual doesn't run are
   never in any later run's window. They accumulate invisibly in `artifacts`;
   the only thing that mentions them is Step 0's freshness preamble (#489)
   reporting an uncovered window. The system reports the gap; nothing collects
   it.

3. **The Synthesize marker is misnamed.** `artifact_external_links.kind =
   'consumed_by_state'` carries `external_id = <Daily Log page id>` (ADR-018 §5).
   The name says State Doc; the referent is the Daily Log entry. The State Doc is
   a projection (ADR-022/ADR-040) — an atom cannot meaningfully be "consumed by"
   something that is re-derived.

## Decision drivers

- **One name must mean one ritual.** The blast radius of a synthesis ritual is
  what the owner believes happened that day. A second lineage under the same name
  is undetectable at invocation time and produces confident wrong output — the
  observed 2026-08-04 failure, not a hypothetical.
- **Human-in-the-loop is load-bearing, not a limitation to automate away** (#493).
  The owner's live correction of the synthesis is both the quality gate and the
  product (accuracy, and the calm of a closed day).
- **Unconfirmed machine output must never be indistinguishable from confirmed
  output.** This is what Step 0 (#489) exists to enforce; any new path must not
  quietly defeat it.
- **The ritual body deserves review.** A bad edit to a 600-line ritual is a
  silent-wrong-answer defect, not a crash.
- **Measurement is a projection, not a second store** (ADR-022, applied again).
- **The vocabulary must generalise across sibling consumers** (ADR-023):
  `dos-personal` and `dos-infra` consume atoms into entirely different objects.

## Considered options

### Option A — Keep a deliberately simpler chat-surface variant

Maintain two rituals: the ahkms-rooted repo copy for Claude Code, a lighter
Notion-only copy for chat/Cowork.

- **Pros:** no migration; each surface gets a ritual matched to its tools.
- **Cons:** the premise (no ahkms on chat) expired with #84; two bodies under one
  name must be kept in sync by discipline forever; and this *is* the configuration
  that produced the failure case. Documentation does not fix it — the divergence
  is invisible precisely at the moment of use.

### Option B — Move every capability's canonical home to `kms-db`

Make the registry the single home for all skills, consistent with the stated
long-run direction, and delete the repo copies.

- **Pros:** one home, no sync step, immediate cross-surface serving; matches the
  direction of travel for single-file skills (the existing `skill-sync` contract).
- **Cons:** `register_capability` becomes an unreviewed write path into a ritual
  whose defects are silent. For a 600-line synthesis ritual that decides what the
  owner believes happened, losing PR review, CI, and ADR guards is the wrong
  trade — precisely because its failure mode is confident wrongness, not breakage.

### Option C — One ritual; repo canonical, registry a one-way projection (chosen)

A single `dos-hl` whose canonical body lives in the repo and is projected to the
registry on merge, served from there to every surface.

- **Pros:** one name, one body; edits keep PR review, CI, and ADR guards; the
  registry serves all surfaces; the failure mode of a stale projection is *loud*
  (hash mismatch) rather than silent.
- **Cons:** a sync step exists and can lag; the world stays two-homed (single-file
  user skills on `kms-db`, repo skills on `kms-repo`), which is a rule to
  remember rather than a single principle.

### Marker sub-options

- **Grandfather `consumed_by_state`, add the new kind alongside.** Cheapest now;
  permanently bakes in a name whose referent is wrong, at the exact moment the
  vocabulary doubles.
- **Let the fallback write `consumed_by_state` too.** Simplest; destroys the only
  signal that distinguishes "the owner read, corrected and confirmed this" from
  "a machine swept it while nobody watched." Rejected — it reproduces the #489
  failure mode with the evidence deleted.

## Decision

### 1. One `dos-hl`. No chat variant.

There is exactly one dos-hl ritual, served to `claude-code`, `cowork`, and `chat`.
The same rule applies to its ADR-023 siblings (`dos-personal`, `dos-infra`) as
they gain cross-surface serving.

### 2. Canonical home is `kms-repo`; the registry body is a one-way projection

The repo file is authoritative. On merge, its body is pushed to the registry,
which serves it to the other surfaces. **The projection is never edited in
place** — the same rule ADR-022 applies to the State Doc and ADR-040 to Open
Actions, applied now to capability bodies.

The general rule this establishes: **every capability has exactly one canonical
home, and the registry is authoritative only for capabilities whose home *is*
`kms-db`.** Single-file user skills keep `kms-db` (the existing `skill-sync`
contract, unchanged); repo skills keep `kms-repo` and gain a push. No capability
is owned by both.

### 3. The chat dos-* family retires

- **`dos-eod`** — the pre-rename name of `dos-hl`. Retired; the registry row is
  deleted (it is pointer-only with a dangling target).
- **`dos-inbox`** — already retired by ADR-018 §1 and already a documented
  deprecated alias of `/capture`. The chat copy is removed.
- **`dos-braindump`** — retired as a separate capability and folded into
  `/capture` as `--braindump`. Its multi-turn loop is interaction guidance, not a
  capability; its Inbox/Tasks split becomes `capture` + `create_task`, both of
  which carry lineage the direct Notion writes never did.
- **`dos-reflect`** — out of scope here; it consumes no Inbox and is left as-is,
  to be revisited alongside #493.

**This amends ADR-018 §3**, which selected source mode by command shape and
rejected a flag (its Option C). The amendment is narrow and deliberate: the
`--braindump` flag selects **scope direction only** — forward over turns not yet
taken, versus backward over turns already taken. It selects neither substrate nor
taxonomy, which is what Option C was rejected for. Capture remains dumb, atomic,
and single-substrate.

### 4. The Notion Inbox DB is decommissioned, archived in place, and not migrated

The DB is retained as a historical archive, its title marked to say so
(`… (ARCHIVED — decommissioned 2026-08-05, see ADR-050)`). The 65 stale entries
are **declared consumed wholesale**; individual rows are not flipped (flipping
`Status = Consumed` on each would record a "consumed by what?" that never
happened), and **nothing is migrated into `artifacts`**.

**Any future migration of that content into `artifacts` requires backdating
support to land first** — i.e. `captured_at` must carry the original event date.
This is a stated precondition, not a preference. ADR-018 deferred backdating
("add when the case actually shows up") and it does not exist; the #414
Completed-at backfill wrote ~350 rows dated 2026-08-04 and poisoned "Done today"
for that date. Backfilling 65 pre-launch entries at write-time dates would
surface them as *today's* unconsumed atoms — reproducing the failure this ADR
closes, on the day it closes it.

### 5. Three layers stop a retired copy from silently winning

The registry can serve the right ritual; it cannot un-serve a wrong one. The
cross-surface fallback only fires when a name is **missing** on a surface — a
stale copy that is *present* answers first and the fallback never runs.
Therefore:

1. **Remove and re-register.** Delete the chat/Cowork copies and the four
   dangling `home=claude(indexed)` registry rows; re-register `dos-hl` as
   `surface=claude-code+cowork+chat`, `home=kms-repo`, with the projected body.
2. **The ritual declares its own lineage.** Step 0 — already mandatory, already
   the place where freshness and unconfirmed machine output are reported — gains
   one line: name, home, and content hash of the body being executed, emitted
   **before** any read. A stale copy then announces itself in its first line of
   output instead of producing confident wrong synthesis. This is the layer that
   survives someone re-indexing a skill from a surface the repo does not control,
   and the only one that works when nobody is watching (see §8).
3. **Kill the pipe at the substrate.** Archive/lock the Inbox DB in Notion so a
   forgotten reader fails loudly rather than succeeding wrongly. Partial by
   construction: chat-surface copies write through the owner's own Notion auth,
   not the ahKMS integration, so revoking the integration's access does not bind
   them.

### 6. The synthesis marker names the step; `external_id` names the object

`kind` records **which synthesis step** ran; the `external_id` column already
records **which object consumed the atom** (Daily Log page, personal log, issue
comment). Two kinds, sharing a prefix so "any synthesis marker" stays one cheap
predicate:

| `kind` | Meaning |
| --- | --- |
| `synthesized` | The Synthesize step completed **with the human in the loop** — read, corrected, confirmed. |
| `synthesized_unattended` | A fallback sweep produced a draft **that no human has confirmed**. |

`synthesized` **replaces `consumed_by_state`**, which named the State Doc while
pointing at the Daily Log entry, and which does not generalise to the ADR-023
siblings that consume atoms into other objects.

> **Pointer, 2026-08-22 — no decision of this ADR changes.** This section's reading
> — `synthesized` names the **first** hop, atom → daily log — was confirmed by the
> owner, resolving [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md)
> Erratum 2 in its favour. One fact above is now historical: `consumed_by_state`
> **returns, for the second hop** (daily log → State Doc), on a different link and
> deliberately outside `SYNTHESIS_MARKER_KINDS` — so this section's "any synthesis
> marker" predicate is untouched. See ADR-051 Erratum 1's resolution. The rename is a data migration
plus call-site changes (see Implementation references); `kind` is free `text`
with no CHECK constraint, so **no schema migration is required** and
`UNIQUE (artifact_id, provider, kind, external_id)` keeps every marker idempotent.

**`search_knowledge`'s `not_consumed` predicate must match any synthesis kind**,
not `consumed_by_state` alone. Left unchanged, swept atoms would keep presenting
as unconsumed forever — the exact pile the fallback exists to prevent.

### 7. Daily Log entries become artifacts — derived, not self-consumed

A Daily Log entry is an **immutable record of a day**: it is knowledge, and it
belongs in `artifacts` where `search_knowledge` can reach it. Today it exists
only in Notion, so "what did I decide on 12 August" is unanswerable from the
memory side. The **State Doc stays Notion-only** — it is a mutable projection
(ADR-022/ADR-040), and freezing a view that is meant to be re-derived would be a
category error.

The Daily Log artifact is **derived from** its source atoms; it is *not*
"consumed by itself." A self-referential marker would satisfy `external_id NOT
NULL` while describing nothing true. The migration's own comment anticipated the
honest form: *"'internal' is allowed for links to other Supabase rows (e.g. a
state-doc derived artifact)."*

The real requirement behind the self-reference — **the Daily Log must not appear
as an unconsumed atom in the next run's queue** — is met by the established
pattern: `content_subtype='daily_log'`, excluded from `search_knowledge` by
default, mirroring `include_task_requests` (#413) and `include_event_requests`
(#126).

This also constrains the fallback: because `external_id` is `NOT NULL`, a sweep
**cannot** record itself without producing an object to point at. A "mark them
swept, write nothing" fallback is not representable without a sentinel id. The
ledger's shape therefore *requires* the sweep to leave a reviewable draft behind
— draft-and-stop is enforced by the schema, not by convention.

### 8. Rituals are not autonomously schedulable; the fallback is bounded here and built elsewhere

Per ADR-038, the three steps schedule differently: **Link** is model-invoked and
attended as-built (`process_artifact`), so the graph does not receive links for
atoms captured on a day nobody sits down, and ADR-038 §3's "eager by default" is
policy, not running code (see Erratum 1 below); **Act** fires only on
declaration, never on a guess; **Synthesize** is batch by nature and human-gated
by design. The repo scheduler (`packages/mcp-server/src/schedule/`) is a
code-cadence host with no model in the loop and cannot run a ritual at all.

The fallback path is **deferred to its own issue**. This ADR fixes only its
boundaries:

| The fallback may | The fallback may not |
| --- | --- |
| Write a Daily Log entry explicitly marked draft/unconfirmed | Write the State Doc |
| Stamp `synthesized_unattended` on that day's atoms | Stamp `synthesized` |
| Report the sweep in the next run's Step 0 | Create tasks/events from undeclared atoms (ADR-038 §4) |

**The measurement falls out of the ledger; no second store is built.** Every day
is closed by `synthesized` (the owner ran it), `synthesized_unattended` (the
fallback swept it), or neither (uncovered). Ritual adherence and State Doc
trustworthiness are both projections over markers already being written. The
streak/point mechanic belongs to #493; the coverage view to #495 (see Erratum 2
below).

## Consequences

### Positive

- ✅ One name, one ritual, one body. The 2026-08-04 failure class is closed at its
  root rather than documented around.
- ✅ Edits to the ritual keep PR review, CI, and ADR guards.
- ✅ Unattended output is permanently distinguishable from confirmed output — a
  question answerable in one query, three months later.
- ✅ Skipped days stop being silent losses: they become a reported, recoverable
  state with a draft attached.
- ✅ Daily Log entries become searchable knowledge instead of Notion-only prose.
- ✅ Ritual adherence is measurable with no new store.
- ✅ The marker vocabulary generalises to `dos-personal` and `dos-infra` unchanged.

### Negative

- ❌ A sync step exists between the repo body and the registry projection, and can
  lag. Mitigated by the Step 0 hash declaration making a stale body loud.
- ❌ Two canonical homes persist (`kms-db` for single-file user skills,
  `kms-repo` for repo skills). This is a rule to remember, and it does not reach
  the "single home for all capabilities" end state.
- ❌ The rename touches live data and several call sites; until it completes, the
  vocabulary is briefly mixed.
- ❌ Layer 3 (locking the Inbox DB) only partially binds, since chat copies
  authenticate as the owner rather than as the ahKMS integration.
- ❌ Retiring `dos-braindump` costs a familiar command name; the affordance
  survives as a flag, but muscle memory does not.

### Neutral

- The 65 archived Inbox entries remain readable in Notion and unreachable from
  `search_knowledge`, deliberately.
- `dos-reflect` is untouched.
- The Notion Daily Log DB, Tasks DB, Meetings DB, and Investor CRM are unchanged.
  Only the Inbox layer is removed, completing what ADR-018 began.

## Implementation references

- Ritual (canonical body): `.claude/skills/dos-hl/SKILL.md` — Step 0 gains the
  lineage declaration (§5, item 2)
- Capture skill (gains `--braindump`): `.claude/skills/capture/SKILL.md`
- Marker table + `NOT NULL` on `external_id`:
  `supabase/migrations/20260606140000_047_add_artifact_external_links.sql`
- `not_consumed` predicate (must match any synthesis kind):
  `packages/mcp-server/src/tools/search.ts` (the `consumed_by_state` equality)
- Consumption-link write path: `packages/mcp-server/src/links.ts`,
  `packages/mcp-server/src/tools/createExternalLink.ts`
- Tool descriptions naming the marker: `packages/mcp-server/src/server.ts`
- Registry projection + capability rows: `packages/mcp-server/src/tools/capabilities.ts`,
  `packages/mcp-server/src/skill-sync/`
- Scheduler (code cadences only, no model): `packages/mcp-server/src/schedule/`

## Errata

Recorded under [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1 — no
correction below changes a decision, so this ADR is edited in place and its Status
line is not stamped. Each names the date and the issue it was found under.

Errata 1 and 2 were recorded 2026-08-20 while building #561.

### Erratum 1 — §8's premise "Link is eager and already runs on the `enrich` cadence" is false as built

§8 leans on ADR-038's scheduling split to argue that a skipped ritual day costs
only the Synthesize step, because Link has already run: "the graph does not rot on
a skipped day — entity links land regardless". Verified on `dev` 2026-08-20, no
cadence runs Link at all:

- `packages/mcp-server/src/schedule/index.ts` starts three cadences — `discover`,
  `enrich`, and (opt-in) `notion_automations`. None of them is a Link pass.
- `schedule/enrichCadence.ts` calls `enrichNextCore`
  (`packages/mcp-server/src/tools/enrichNext.ts`), which does **content
  extraction** — pointer to body, `discovered` to `extracted`. It never calls
  `artifact_entity_sync`.
- `artifact_entity_sync` is reachable only as an MCP tool call, i.e. from the
  `process_artifact` skill or an explicit request. Nothing schedules it.

So the graph **does** rot on a skipped day: a day nobody processes leaves its atoms
with no entity links, and no cadence comes back for them. ADR-038 §3's statement
that Link is "eager by default" is policy, not running code.

**This changes no decision in §8, and #561 does not fix it.** The two markers are
independent by ADR-038 §2 — each step checks only its own marker — so leaving Link
unrun does not disturb the synthesis marker or the coverage read built on it.
#561's sweep deliberately does not run Link either: that would be a second
unattended writer inside an issue whose entire discipline is draft-and-stop. The
gap was tracked in #665, with the substantive scheduling question split out to
#1133 (deferred until #636 is decided).

### Erratum 2 — the "#495/#491" pairing in §8 is vestigial

§8 assigns "the coverage view to #495/#491". The coverage view is #495 alone. #491
is Work **business** metrics (a Monday snapshot), is `needs-grill`, is absent
from ADR-052 §5's tab list, and has been superseded in practice by #647. Pairing it
with #495 reads as though system self-analytics has two homes; it has one.

### Erratum 3 — "must match any synthesis kind" is necessary but not sufficient: the reads are also per **domain**

Recorded 2026-08-21 while building #677. §6's rule — "`search_knowledge`'s
`not_consumed` predicate must match any synthesis kind" — is correct and unchanged,
but read alone it describes a predicate on `kind` and nothing else, which is what
`not_consumed`, `getSynthesizedArtifactIds` and `get_synthesis_coverage` were all
built as.

`kind` says *how confidently* an atom was consumed. `provider` — already in this
section's own `UNIQUE (artifact_id, provider, kind, external_id)` — says *by whom*.
Both belong in the predicate, and they are independent: an atom folded into the
`angus` Daily Log looked already-consumed to a `work` read, and a day logged in
one domain read as covered for both (ADR-051 §11 says there is one log per domain,
so that is a false close). This was latent until #674 gave the `angus` domain a
Daily Log to write to; before that every marker in the store was a Work one and
`provider` was effectively constant.

**This changes no decision.** The reads now take an optional domain and resolve it
to a provider through `packages/mcp-server/src/domains.ts`; unscoped they apply no
provider predicate at all, so every pre-#677 caller keeps its exact behaviour. A
domain-scoped ritual must pass its own domain — see `.claude/skills/dos-hl/SKILL.md`
Setup reads 4 and 8, and `.claude/skills/dos-personal/SKILL.md` Setup read 4.

## Links

- Resolves: #487, #415
- Supersedes in part: [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md) §7,
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) §3 and §5,
  [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) §2
- Related: [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md),
  [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md),
  [ADR-031](./ADR031_Capability_Registry.md),
  [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md),
  [ADR-042](./ADR042_Intelligent_Flows_Are_First_Class.md)
- Follow-on issues: #560 (marker rename); #561 (fallback sweep); #562 (Daily
  Log as artifact); #677 (the marker reads are per domain, not just per kind —
  Erratum 3); #493 (streaks), #495 (self-analytics), #665 (ADR-050 §8 Link
  erratum), #1133 (substantive Link host decision; deferred to #636)
