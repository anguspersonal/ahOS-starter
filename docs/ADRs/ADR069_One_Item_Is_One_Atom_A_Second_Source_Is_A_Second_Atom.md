# ADR-069: One item is one atom — a second source is a second atom on the same entity

- **Status:** Accepted
- **Created:** 2026-08-27
- **Accepted-on-dev:** 2026-08-27
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, capture, synthesis, entities, meeting-notes, ahos
- **Supersedes in part:** [ADR-062](./ADR062_Atom_Identity_Is_The_Entity_Not_The_Message.md) §1
  (its second paragraph only — the storage rule; §1's identity rule stands)
- **Builds on:** [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) §2 (capture is atomic and dumb) and §4 (interpretation at read time, per consumer),
  [ADR-025](./ADR025_Event_Entity_Type.md) (the `event` node a meeting's atoms hang off),
  [ADR-060](./ADR060_Many_Connections_Per_Provider_And_Semantics_Attach_To_The_Connection.md) §4 (unknown must not render as clean),
  [ADR-062](./ADR062_Atom_Identity_Is_The_Entity_Not_The_Message.md) §1 (identity resolves on the entity),
  [ADR-067](./ADR067_The_Ritual_Queue_Is_Bounded_Atoms_Never_Decay.md) §5 (the gap it named — see Erratum 1 there)

## Context and problem

ADR-062 §1 decided one thing and then asserted a second. The decision — *"Identity is
the entity the atom concerns... Resolution happens on the entity, not the message"* — is
right and stands. The assertion that followed it is a **storage** rule:

> A second source for an entity that already has an artifact **attaches as an additional
> source**. It does not capture a second atom about the same thing.

**There is no data shape behind that sentence, and reading the code shows there never
was.**

- `artifacts.source_drive_file_id` is a scalar column. One artifact carries one source.
- `artifact_external_links.kind` runs `task | event | daily_log | synthesized |
  synthesized_unattended`. There is no `source` kind, so an attachment has nowhere to live.
- The only implementation, `meetingNotesIngest.ts:220`, covers just the case of the
  **same** doc arriving twice, and what it writes for the attach is a string pushed into
  the tool's text response:

```ts
notes.push(`Doc already captured as artifact ${artifactId} — attaching as an
  additional source rather than re-capturing (ADR-062 §1).`);
```

No row. No timestamp. A sentence.

### The live defect it produced

`doc_urls` is an array (`meetingNoteEmails.ts:184`) and `meeting_notes_detect` prints all
of it (`meetingNotes.ts:103`). Then ingest takes one:

```ts
const docId = args.doc_id ?? (match.doc_urls[0] ? docIdFromUrl(match.doc_urls[0]) : null);
```

A meeting email carrying **a team summary and your own Plaud summary** captures the first
and silently discards the second. The message is then labelled (`:273`), and that label is
the idempotency guard checked at the top of the next call (`:185`), so the discarded
summary cannot be recovered by calling again. The `doc_id` argument's own description
names the case it does not handle: *"when the message's body has none, **more than one**,
or the wrong one."*

Detect shows you two documents; ingest keeps one; nothing says which was dropped.

### Why this reaches past one tool

§1's storage sentence is what made **ADR-062 §4 unreachable**. §4 requires a late source to
be surfaced against the day it belongs to. Under the attach rule, a late source joins an
artifact that already carries a `synthesized` marker, so a `not_consumed` read never
returns it and the next run never sees it. ADR-067 §5 named that gap and proposed a
timestamp predicate over rows that do not exist (Erratum 1 there).

The gap is prospective, not live: because the attach was never built, a genuinely
different late source today captures a **new** artifact, which is unconsumed, which the
queue picks up. §4 works by accident of §1 being unimplemented — and would break the day
anyone implemented it.

## Decision drivers

- **"One distinct item is one atom" is already the rule** (ADR-018 §2, whose unit is
  *"one artifact per distinct **item**"*). §1's sentence was the exception, and it is the
  exception that produced the defect.
- **Multiplicity is interpretation, and interpretation happens at read time** (ADR-018 §4).
  Deciding that four arrivals are one meeting is a synthesis judgement, not a write-path one.
- **Reach for an existing decision before a new mechanism** (`vision.md`, principle 8). The
  entity join exists, is indexed, and needs no migration.
- **Unknown must not render as clean** (ADR-060 §4). A team's account of a meeting and your
  own recording are two accounts with different authorship and different trust. Collapsing
  them into one atom destroys exactly the distinction that decides which to believe.

## Considered options

### Option A — Build the multi-source shape §1 implies

An `artifact_sources` table, a migration, a backfill across ~153k artifacts, and every
capture path taught to write a source row. §4's predicate then becomes a join on
`created_at`.

- **Pros:** it is what §1 describes, and makes "one atom per real-world thing"
  literally true.
- **Cons:** the measured population does not justify it. ADR-067 established that the
  1,713-atom backlog comes from **days the ritual never ran**, not from late sources, so
  this builds a table and a backfill for a rounding error. It is the *not-now* test the
  vision already states: structure larger than the data it structures. **Rejected.**

### Option B — One atom holding an array of source URLs

- **Pros:** no new table; the config already carries `doc_urls` as an array.
- **Cons:** a URL is a pointer, not content. Stored this way the second summary is never
  fetched, never embedded, and invisible to `search_knowledge`'s body arm — it would be
  present as a link and absent as knowledge. It also flattens the authorship distinction
  that ADR-060 §4 exists to protect. **Rejected.**

### Option C — A `resurfaced` marker kind

Whoever attaches a late source to a marked artifact writes an `artifact_external_links`
row; `not_consumed` gains "no marker, **or** a `resurfaced` row newer than the newest
marker".

- Cheap, uses the existing ledger, and fits ADR-062 §2's rule that idempotency sits on
  existing ledgers rather than a new status field. **Rejected as unnecessary** under this
  decision, and recorded because it is the correct answer if Option A is ever built.

### Option D — One capture, one atom; multiplicity at the entity (chosen)

## Decision

### 1. One item is one atom, and ADR-062 §1's storage sentence is overruled

ADR-062 §1's **first** paragraph stands unchanged and is the foundation of this decision:
identity resolves on the entity, not the message. Its **second** paragraph is superseded.

A second source for an entity that already has an artifact **captures its own atom** and
links to the same entity. It does not attach to the existing artifact, because there is
nothing to attach to.

**The unit is the item, not the capture action, and the distinction is load-bearing.**
ADR-018 §2's unit is *"one artifact per distinct **item**"*; how many items arrived in one
invocation is irrelevant to it. A capture carrying a note and two summary URLs is **three
items and therefore three atoms**, all linked to the one entity — which is exactly what §6's
first build item does with one call. Read as a rule about the *action* rather than the
*item*, this section would forbid that build item, and the wrong reading resolves in favour
of keeping today's data loss.

### 2. Multiplicity is an entity-level fact, and the schema already carries it

`artifact_entity_links` is unique on `(artifact_id, entity_id, link_type)`. N artifacts can
each link `primary` to one `event` node with no constraint conflict and **no migration**.
The join that expresses "these four things are one meeting" is already there and already
indexed.

### 3. ADR-062 §4 becomes reachable, with no new mechanism at all

`not_consumed` keys on the **artifact's own** marker, not its entity's. A new atom carries
no marker, so it returns from an unconsumed read regardless of what happened to the event
last week. The late source reaches the next ritual through the ordinary queue.

ADR-067 §5 named a missing mechanism and proposed a predicate over an
`artifact_external_links` source row. **That row does not exist**, and the gap it described
does not survive this decision, so the predicate is neither built nor needed. Recorded as
Erratum 1 on ADR-067 rather than as a supersession: §5's actual decision — that §4 is
delivered by the ordinary ritual rather than a bespoke notification — is exactly what this
section implements.

### 4. `captured_at` stays capture time; the meeting's date lives on the entity

`drive/shared.ts:140` sets `captured_at` to now, and that is correct under ADR-018 §2: it
records when ahOS got the thing, which is a fact about capture. A Thursday-ingested
transcript of a Tuesday meeting was captured on Thursday.

The day it *belongs to* is the `event` node's `date`/`start` property (ADR-025), which is
where a meeting's date already lives.

**Backdating `captured_at` is refused.** The allowlist at `vocab.ts:610` exists precisely
to stop callers filing atoms into arbitrary day buckets (#414), and a source adapter is
exactly the caller that allowlist protects against. Day attribution for a late source is a
read-end join, never a write-end edit.

### 5. The read end groups a day's atoms by entity

Sections 1 and 2 create two read-end problems, and one change answers both: **the ritual
groups a day's atoms by their linked entity.**

- The meeting renders **once with N sources**, not N times.
- It renders under the **meeting's** date rather than each atom's capture date, which is
  what actually delivers §4's *"against the day it belongs to"*.

Not built. Named here so it is designed rather than discovered mid-build.

### 6. Two build items, in this order

1. **`meeting_notes_ingest` loops `doc_urls`** instead of taking `[0]`. Each doc becomes
   its own atom; all of them link to the one `event`. The Gmail label stays at the end of
   the run, which is right once a single call handles every doc in the message.
2. **The entity-grouped read** of §5.

(1) is a live data-loss fix and does not depend on (2). (2) without (1) makes duplicate
rendering visible with nothing yet producing the duplicates.

## Consequences

**Both apex docs change in this PR** (ADR-039 §2). `vision.md`'s R4 said an event arriving
through four sources is *"one atom with four sources attached, not four atoms"* — the exact
claim this overrules — and now says four atoms on one entity. `architecture.md`'s entities
paragraph is tightened so *"attaches to the existing entity"* cannot be misread as attaching
to the existing artifact.

**ADR-062 gains a partial-supersession header**, which arms the citation guard: both apex
docs cite ADR-062, so each must name ADR-069 within six lines. Both now do.

**ADR-067 §5 gains an erratum** covering two wrong claims, recorded there rather than here.

**The vision's watermark moves to ADR-068, not ADR-069, and the reason is worth recording.**
R4 *is* genuinely reviewed against this ADR, so `ADR-069` would be the true value — but
`check-apex-watermark.js` rejects a watermark naming an ADR that carries no
`Accepted-on-dev` date, and ADR-069 will merge `Proposed` because ADR-065's auto-stamper is
a GitHub Action and Actions are quota-starved (#867). Naming it would leave the check red
for weeks. So the watermark understates deliberately, with the ADR-069 review noted beside
it in prose: **understating self-corrects, overstating does not** (ADR-059). The bump to
ADR-069 is owed once it is stamped.

**ADR-068 is hand-stamped here**, which it has needed since it merged in #913 on 2026-08-26.
It is the fifth instance of the #862 defect class and the first since ADR-065 decided the
fix, which is the whole argument of ADR-065 restated as a fact: the mechanism is right and
it cannot run.

**`architecture.md`'s watermark does not move**, and stamping ADR-068 pushes it over the
alarm line. It stays at ADR-063 (receiving one tightened paragraph is not a review) and its
gap goes 4 → **5** (ADR-064 through ADR-068), which trips
`check-apex-watermark.js`'s 5-ADR threshold from `ok` to `BEHIND`.

**That is the mechanism working, not a regression to suppress.** It is ADR-065's argument
demonstrated on live data: the gap read 4 only because ADR-068 was filtered out for being
unstamped, and stamping it revealed the real number. ADR-064's case for taking the doc to
zero was that the figure is load-bearing only from zero, because only then does the next
unsynced ADR move it — this is that happening. The remedy is a scoped pass in ADR-064's
shape, which is its own decision and its own PR, not a quiet bump here.

**Nothing about the backlog changes.** ADR-067's finding stands: 1,713 unconsumed atoms and
36 uncovered days come from days the ritual never ran, and this decision does not touch that.

**Already-lost data is not recovered.** Every meeting email processed to date captured
`doc_urls[0]` and was labelled; the discarded summaries are still in Gmail and Drive but
nothing in ahOS points at them. Recovering them means re-processing labelled messages, which
the guard refuses by design. Out of scope, stated so it is not assumed away.

**The unenforced half, again.** Nothing stops a future author reintroducing an attach-style
write path, and no guard reads §1. Same enforcement gap ADR-063, ADR-064, ADR-066 and
ADR-068 each recorded, and §6's ordering is a note in a document rather than a constraint.

## Refs

#414 · #569 · #874 · #875 · #911 · ADR-018 §2/§4 · ADR-022 · ADR-025 · ADR-038 §2 ·
ADR-039 §2 · ADR-046 §3 · ADR-050 §6 · ADR-059 · ADR-060 §4 · ADR-061 ·
ADR-062 §1/§2/§4/§5 · ADR-067 §5 · ADR-068
