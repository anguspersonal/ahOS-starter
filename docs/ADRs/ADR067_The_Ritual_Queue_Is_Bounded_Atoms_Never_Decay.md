# ADR-067: The ritual's queue is bounded; atoms never decay — R2 promises retention, not attention

- **Status:** Accepted
- **Created:** 2026-08-26
- **Accepted-on-dev:** 2026-08-26
- **Deciders:** Angus (solo maintainer)
- **Tags:** meta-adr, docs, vision, synthesis, dos, ahos
- **Amended by:** [ADR-108](./ADR108_Machine_Source_Ingestion_Is_Per_Source_Core_Actions_On_Engine_Cadences.md) (§5: the set the slice bounds, and the reported "of N", are the unconsumed narrative set, evidence is aggregated per day; §7: Amendment 1's no-migration choice is reversed for the `not_consumed` predicate; §2 unchanged, atoms never decay)
- **Builds on:** [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) (a projection is a curated top-N over a canonical source),
  [ADR-046](./ADR046_Per_Source_Ingestion_Policy.md) §3 (source roles, the ranking substrate),
  [ADR-051](./ADR051_One_EOD_Ritual_Domain_Routing_And_Audience_Projections.md) §10 (consumption is two-level),
  [ADR-062](./ADR062_Atom_Identity_Is_The_Entity_Not_The_Message.md) §4 (a late source is surfaced, never silently folded or dropped),
  [ADR-066](./ADR066_The_Vision_States_What_Is_True_Not_How_It_Changed.md) (the vision states what is true)

## Context and problem

R2 reads *"Never forget. Any kind of information can be captured seamlessly."* It quietly
conflates three different promises:

| | What it would mean | Deliverable? |
|---|---|---|
| **Retention** | it is stored, searchable, linked | yes |
| **Attention** | it eventually reaches you | **no, not at any volume** |
| **Effort** | you never do the remembering | no; ADR-062 §4 already spends your effort |

ADR-064 flagged that ADR-062 bears on R2 and R4 and left it to the owner. This settles it,
and settles the mechanism that makes the answer honest.

### The backlog is not hypothetical

Measured on production, 2026-08-26:

- **1,713 unconsumed atoms** captured before 2026-08-20.
- **36 of the 43 days** from 2026-07-15 to 2026-08-26 carry no synthesis marker at all.
  Seven days closed; two of those seven are `synthesized_unattended` only, meaning a
  machine draft nobody confirmed.

The load-bearing detail: **that backlog does not come from late sources.** It comes from
days the ritual never ran. ADR-062 §4's post-synthesis arrival is a rounding error beside
it. Any bound designed against the §4 case would be aimed at the wrong population.

## Decision drivers

- **Unbounded attention is not deliverable, and pretending otherwise is the failure mode
  this system keeps designing against.** A promise that everything eventually surfaces is
  false at 1,713 and absurd at a million.
- **Prefer a loud gap to a quiet guess** (ADR-062). A bound that hides what it excluded
  reintroduces exactly the silence that ADR was written against.
- **Reach for an existing decision before a new mechanism** (`vision.md`, principle 8).
- **A projection never stores anything the source doesn't already have** (`vision.md`,
  *Projections*). The corollary drawn here: a projection must never *destroy* anything the
  source has either.

## Considered options

### Option A — Atoms decay: unprocessed for long enough, drop them from the queue

The atom stays searchable; it simply stops being surfaced. Attractive because it bounds the
queue with one rule and no ranking.

- **Pros:** simple; bounds growth absolutely; mirrors how a person treats an old inbox.
- **Cons, and they are decisive on the measured data:** decay keys on age, and age cannot
  distinguish *an atom you saw and deprioritised* from *an atom that never surfaced once*.
  Today almost the entire backlog is the second kind, so an age rule would silently discard
  the whole July backlog having never shown the owner any of it. "Not forgotten, it just
  didn't bubble up" is true of the first kind and false of the second.
  **Rejected.**

### Option B — Leave the queue unbounded; the ritual reads everything unconsumed

- **Pros:** nothing is ever excluded; no ranking to get wrong.
- **Cons:** already unworkable at 1,713, and the failure is silent — the ritual gets slower
  and less useful with no signal that the queue is the reason. **Rejected.**

### Option C — Bound the queue, not the atoms (chosen)

Apply ADR-022's shape, already decided for a different projection.

## Decision

### 1. The ritual's atom queue is a **bounded projection over a canonical source**

ADR-022 settled this exact question for the State Doc: *"The source databases are canonical;
the State Doc is a curated top-N (~10) projection."* The answer to "what about everything
else" was never *delete it*, it was *the projection shows what fits; the source stays whole*.

The unconsumed-atom set is the canonical source. The ritual reads a bounded slice of it.
Everything outside the slice stays unconsumed, searchable, entity-linked, and eligible for
any later run.

### 2. **Nothing decays.** No drop semantics are introduced

No age threshold, no expiry column, no eviction. An atom leaves the queue exactly one way:
by being consumed. This is the difference between bounding a *view* and destroying a
*record*, and only the first is a projection.

### 3. Ranking uses the source roles that already exist

ADR-046 §3 assigns every source a role — `narrative > evidence > metrics > excluded`. That
is the ranking substrate; no new axis is minted for this. The precise ranking function is an
implementation question, not an ADR one.

> **Built 2026-09-25 — see Amendment 1 below** for the ranking function as built and why its
> tie-break reads `effective_at` (#911). A pointer under ADR-039 §1; §3 is unchanged.

### 4. The bound is **reported**, never silent

The ritual states what it left behind: *"showing 40 of 1,713 unconsumed."* One line. It is
what keeps ADR-062's "loud gap" driver intact under a bound, and it converts the backlog
from an invisible condition into a number the owner can act on.

Note the standing constraint: ADR-052 §11 records that ahOS has **no outbound channel at
all** (#573), so today this can only appear inside a ritual the owner is already running.

### 5. ADR-062 §4 is implemented **by the ritual**, not by a bespoke notification

§4 requires a late source to be *"surfaced to the owner against the day it belongs to."* It
does not prescribe how. The mechanism is the ordinary queue: the atom is unconsumed, so the
next run picks it up, and day attribution is already correct because
`get_synthesis_coverage` and the day-window reads bucket on `captured_at`, never on write
time.

**This is not an overrule of §4. It is §4's how.** ADR-062 stands unamended.

**One mechanism is missing and is named here.** ADR-062 §1 makes a late source *attach to
the existing artifact* rather than create a new atom, and that artifact already carries the
earlier run's `synthesized` marker — so a `not_consumed` read will not return it and the
next run would never see it. The predicate must therefore be *"a source was attached after
the synthesis marker was written"*, comparing the `artifact_external_links` row's timestamp
against the marker's. Both rows exist today. This is deliberately **not** claim-level
provenance (#875): it asks whether anything new arrived, never what changed, so ADR-062 §5's
report-not-diff refusal is untouched.

### 6. R2 promises **retention**. R4 extends to atoms

- **R2** is narrowed to what is true and deliverable: captured, never silently dropped.
  Attention is explicitly not promised, which is what §1's bound makes honest. The effort
  question is answered by **not** being R2's: R3 already owns it, and owns it correctly
  (*"ambiguity is surfaced, not guessed... it asks rather than picking"*). Reading R2 as a
  promise about effort would put it in direct contradiction with R3, which mandates spending
  the owner's attention precisely when the system cannot tell.
- **R4** currently resolves only *entities* (person, project, commitment). ADR-062 §1 makes
  the same rule hold one level down, at capture: four sources for one meeting are one atom
  with four sources attached, not four atoms. R4 was understated, and this is additive.

## Consequences

**The vision stops promising something it cannot deliver.** R2 covers retention only, and
`vision.md` now says so.

**The bound is a number, not a silence.** §4 means the 1,713 becomes visible the first time
the ritual runs under this decision, which is the opposite of what decay would have done.

**Ranking quality becomes load-bearing, and it is not yet good.** With everything surfaced
the order did not matter; under a bound it decides what the owner sees. ADR-046's roles are
a coarse instrument for it. Accepted, because the alternative was worse and because a bad
ranking loses *attention* while decay would have lost *the record*.

**Nothing here is built.** The `dos` ritual that would carry it does not exist (ADR-054 §7,
still unexecuted). This decides the shape before the build rather than after, which is the
whole point of deciding it now.

**A citation defect surfaced and is not fixed here.** `vision.md` and ADR-054 §7 both name
**#415** as the issue executing the `dos` retirement; #415 is actually *"dos-hl has forked
across surfaces"*. The retirement has no executing issue. Recorded rather than corrected,
because fixing it means deciding which issue owns that work.

**The 36 uncovered days are the larger problem and are untouched.** #561's fallback sweep
appears to have run twice in six weeks. Bounding the queue makes a large backlog usable; it
does not explain why the backlog got large.

## Errata

**One entry, Erratum 1, was recorded 2026-08-27.** It is a correction of fact with no
decision attached, so this ADR's Status line is unchanged: §5's decision — that ADR-062 §4
is delivered by the ordinary ritual rather than a bespoke notification — stands and is
implemented by ADR-069. What was wrong is the mechanism §5 named beside it.

### Erratum 1 — §5's "both rows exist today" is false, and its day-attribution claim is wrong

§5 says the predicate must be *"a source was attached after the synthesis marker was
written"*, comparing *"the `artifact_external_links` row's timestamp against the marker's"*,
and asserts **"Both rows exist today."**

**The marker row exists. The source row does not.**

- `artifact_external_links.kind` runs `task | event | daily_log | synthesized |
  synthesized_unattended`. There is no `source` kind, so an attached source has nowhere to live.
- A source is a **scalar column on the artifact**, `artifacts.source_drive_file_id`
  (`meetingNotesIngest.ts:149`). One artifact, one source.
- The only place ADR-062 §1's attach is implemented (`meetingNotesIngest.ts:220`) writes
  **nothing**. Its "attaching as an additional source" is a string pushed into the tool's
  text response, not a row.

§5 also states that *"day attribution is already correct because `get_synthesis_coverage`
and the day-window reads bucket on `captured_at`, never on write time."* That is true of
**markers** — a marker backfilled late still attributes to the atom's day — and false of the
case §5 applied it to. For an imported doc `captured_at` **is** write time
(`drive/shared.ts:140` sets it to `now`), so a Thursday-ingested transcript of a Tuesday
meeting attributes to Thursday.

**Both are moot under
[ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md)**, which
supersedes ADR-062 §1's storage rule. A late source is its own atom carrying no marker of
its own, so it returns from an unconsumed read with no timestamp comparison at all, and the
meeting's day becomes a read-end join onto the `event` node rather than a property of the
atom.

## Amendment

**One entry, Amendment 1, was recorded 2026-09-25 (#911).** §3 chose the ranking substrate
and left *"the precise ranking function"* to implementation. This records the function as
built and the choices inside it, so the next reader inherits them rather than re-deriving
them. It fills in what §3 delegated and changes no decision in §1–§6, so this ADR's Status
line is unchanged (ADR-039 §1), the same as Erratum 1.

### Amendment 1 — §3 as built: role tier, then `effective_at`, over the whole set

**The function.** `dos` Setup read 5 takes the backlog slice as
`knowledge_search { captured_before: <today 00:00 UTC>, not_consumed: true, limit: 50,
rank_by_role: true }`. The key is:

1. **Role tier**, in ADR-046 §3's ladder order: `narrative`, `evidence`, `metrics`,
   `excluded`. A row's role is `resolveSynthesisRole`'s answer: the owner's
   `surface_role_map` layered over the shipped Drive seed, keyed on `surface`, then on
   `source_channel`, then `default_role`.
2. **`effective_at`, newest first**, within a tier.

**It ranks the whole unconsumed set, in the database, with no migration.** Role is derived at
read and never stored (ADR-046 §3), so there is no column to `ORDER BY`. Four shapes were
weighed:

| Option | Why not |
|---|---|
| Re-sort the fetched page | Ranks 50 rows chosen by date, not the set. A narrative atom below the date cut never surfaces, which is the failure this section exists to prevent |
| Fetch the whole set's `id, surface, source_channel, effective_at`, rank in JS | Correct, and calls the one resolver directly, but the wire cost grows with the backlog it is meant to bound: 3,197 unconsumed on 2026-09-24, several PostgREST pages at its 1,000-row cap, every night |
| An RPC, or a stored `role` column | A migration; and a stored role is an interpretation the map owns, stale the moment the owner edits the map (ADR-046 §3 derives it at read for exactly that reason) |
| **One query per tier (chosen)** | — |

`roleTierFilters` (`packages/mcp-server/src/captureConfig.ts`) restates
`resolveSynthesisRole`'s precedence as one row filter per role. Because the resolver is a
function of the row, the filters **partition** any row set, so `knowledge_search` fetches
tiers in ladder order, asks each only for the rows there is still room for, and **counts** a
tier with no room left without fetching it. That is at most four round trips whatever the
backlog's size. The cost is the precedence written twice, in TypeScript and as a PostgREST
filter; `searchRoleRank.test.ts` evaluates the generated filters against the resolver over
a grid of rows, so the two cannot drift silently.

**The tie-break reads `effective_at`, not `captured_at`.** ADR-088 split the two clocks by the
question asked: *did I run the ritual* is a property of the ingest and stays on transaction
time; *what is this day about* is a property of the content and reads valid time. *Which of
two equally-ranked atoms gets tonight's slot* is the second kind of question. Recency stands
in for "still matters now", and when an atom arrived says nothing about that. Arrival order
would also bring back the incident ADR-088 §4 fixed, one tier down: a bulk import resolving
to `narrative` would take the front of the slice under its ingest date. And it keeps the
slice sorted by the clock it filters on. **The cost, accepted:** an atom that arrived yesterday
and that its source dates to 2017 sorts under 2017 within its tier and may never be shown by
the slice. It stays unconsumed, counted in *"showing 50 of N"*, and searchable. That is §6's
retention promise; attention was never promised.

**Newest first, not oldest.** The backlog grew from 1,713 to 3,137 between 2026-08-26 and
2026-09-24 while the fifty-a-night drain ran (#911), so the slice does not drain the backlog
and cannot be judged as if it did. Oldest-first would spend every night on the July blackout's
oldest atoms. Newest-first spends the fifty on what is most likely still live.

**It changes order, never membership.** `metrics` and `excluded` rows are ranked last, not
dropped. Dropping them would be ADR-046 §3's synthesis gate, which is a separate thing and is
still unbuilt, and it would make the slice's *"of N"* disagree with the health signal of
ADR-051 Amendment 3. The same filters select the same rows, and the total is identical with
the flag off.

**What it does today.** The owner's stored `surface_role_map` is empty, so the effective map
is the shipped seed alone: the four Drive discover surfaces resolve to `evidence` and
everything else to `narrative`. Today the whole effect of the ranking is to put captured and
meeting material ahead of bulk Drive documents. Consequences called ADR-046's roles a coarse
instrument, and that still holds. Mapping email, Slack and GitHub surfaces to `evidence`, per
ADR-046 §4, sharpens the ranking with no code change.

## Refs

#573 · #875 · #415 · #561 · #666 · #911 · ADR-022 · ADR-046 §3 · ADR-050 §6 · ADR-051 §10 ·
ADR-052 §11 · ADR-054 §7 · ADR-062 §1/§4/§5 · ADR-064 · ADR-066 · ADR-069 · ADR-088
