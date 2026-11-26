# ADR040: Open Actions is populated by writing through to Tasks DB, never by spilling over

- **Status:** Accepted
- **Created:** 2026-07-20
- **Accepted-on-dev:** 2026-07-20
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, dos-hl, notion, synthesis, state-doc
- **Builds on:** [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) (State Doc is a projection), [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) §5 (Act idempotency)

## Context and problem

[ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) decided that the
canonical databases are the source of truth and the State Doc is a curated top-N
**projection** over them. It explicitly rejected the "overflow sink" model in which the
State Doc is primary and spills into a DB when full.

It then wrote: *"The mechanic in dos-hl Step 5 is unchanged; only its **framing** is
corrected."*

That exemption is the problem. Under projection semantics, dropping an item from the
top-N is a **no-op on the source DB** — you display fewer rows. But the shipped mechanic
in `.claude/skills/dos-hl/SKILL.md` writes:

> If approved, **ensure those items exist as rows** in the source Tasks DB via
> `notion-create-pages` … and drop them from the State Doc top-N view in the same update.

*"Ensure those items exist"* is only necessary if the items are **not already in the
Tasks DB** — that is, if Open Actions items are born in the State Doc as prose and the
canonical DB has never heard of them. Which is the sink model, restated as an
implementation detail directly beneath prose asserting the opposite. The same section of
the same file contains both models, six lines apart.

The observable cost was filed as **#129**: an atom eagerly Acted into a Notion task
(writing a `kind='task'` lineage row) is still correctly narrated by Synthesize into Open
Actions; days later the cap is hit and that prose line is written to Tasks DB as a
**second** task. The lineage row from the first creation still exists, but nothing
consults it — by cap time the item is a sentence, and the `artifact_id` needed to check
the ledger was lost when the atom became narrative.

#129 proposed passing `single_task` at the cap-time write. That cannot be implemented:
there is no `artifact_id` at that point to pass. The duplicate is not a missing flag, it
is a **write occurring at a moment the declared model says involves no write**.

## Decision drivers

- **ADR-022's model is right and stays.** This ADR does not revisit it; it removes the
  exemption that prevented it from being true.
- **Provenance must survive.** Any path that creates a task must carry `artifact_id`, or
  the Act ledger ([ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) §5)
  cannot protect it. Provenance does not survive prose, so the write must happen while the
  atom is still in hand.
- **One writer.** Idempotency guarantees are only worth what the least-careful writer
  honours. `create_task` already implements `single_task` and `dedup_key` correctly; a
  second writer bypassing it makes those guarantees advisory.
- **The State Doc must stay a view.** A projection that also stores things is neither.
- **Nothing may silently disappear.** A rule that keeps items out of the projection must
  not make them unreachable.

## Considered options

### Option A — patch the cap-time write (the #129 proposal)

Teach the cap-time write to check the Act ledger before creating.

- **Pros:** small, local, no change to when things are written.
- **Cons:** **not implementable** — the ledger is keyed on `artifact_id` and the cap-time
  path holds only prose. Would require smuggling artifact ids into State Doc text, which
  pollutes the projection with machine identifiers and contradicts ADR-022's framing. Also
  leaves the State Doc a store, so the same class of bug recurs for Recent Communications,
  Known Blockers, and eventually events (#126).

### Option B — content-keyed dedup at cap time

Have the cap-time write pass `dedup_key` = a hash of the action text.

- **Pros:** works without provenance.
- **Cons:** State Doc lines are routinely reworded during the diff-approval step, and a
  reworded line hashes differently, so it double-creates exactly when the user has been
  most engaged. Silent and data-dependent — the worst failure profile available.

### Option C — write through at identification time (chosen)

When synthesis identifies a new open action, create it in the Tasks DB immediately via
`create_task`, carrying `artifact_id` and a priority. Open Actions then renders it because
it is in the Tasks DB, like every other row.

- **Pros:** `create_task` becomes the only writer, so the shipped guard covers every path;
  lineage is written for free; the cap becomes a pure display setting with no side effects;
  #129 becomes unreachable rather than guarded; extends to events (#126) by construction.
- **Cons:** every approved action lands in Notion immediately, so the State Doc stops being
  a place to hold something loosely. Requires a priority at creation time.

## Decision

We choose **Option C**.

### 1. Actions are written through at identification, not at cap time

When Step 5 identifies a new open action, `dos-hl` calls **`create_task`** with:

- `artifact_id` — the originating atom, so a `kind='task'` lineage row is written and the
  existing `single_task` / `dedup_key` guard applies
- a **`Priority`** (see §3)
- `Status: To Do`

`Backlog` is **not** the default. Per the operator's usage, `Backlog` means *actively
deferred* — a deliberate decision — not a holding pen for the untriaged. An action the user
approved at EOD is one they intend to do.

`notion-create-pages` is no longer used to write tasks. **`create_task` is the only writer
to the Tasks DB.**

### 2. Cap enforcement is view re-selection, with no write

When the projection exceeds its cap, items are dropped **from the view only**. They remain
in the Tasks DB, unsurfaced. No row is created, updated, or moved. This is what ADR-022
always said; it is now also what the mechanic does.

Open Actions renders:

- **all open actions generated today**, uncapped, and
- the **top `open_actions_cap` open tasks** read from the Tasks DB, ordered by
  `Normalised Priority` → `Due date` ascending (undated last) → `created_at` ascending.

The tiebreak is load-bearing, not cosmetic. `Normalised Priority` yields only three tiers,
so "top N" without a tiebreak is non-deterministic — the same data can produce a different
State Doc on two consecutive runs.

Completed items render in a **Done today** section, sourced from the Tasks DB `Completed at`
date property.

### 3. A priority is assigned at creation

`Normalised Priority` maps unset priority into its bottom tier alongside `Low`/`P3`/`P4`:

```
if(or(Priority=="High", Priority=="P0", Priority=="P1"), 1,
   if(or(Priority=="Medium", Priority=="P2"), 2, 3))
```

So an action created without a priority appears on the night it was created (via the
"generated today" rule) and then effectively never resurfaces, because it is competing for
the top-N from the bottom tier. Write-through without an assigned priority would trade a
duplicate-item bug for a disappearing-item bug.

`dos-hl` therefore proposes a priority alongside each new action in the same diff-approval
exchange, using the [Issue priority framework (P0–P4)](https://app.notion.com/p/3299e609fe018130996ee76e36100a99)
that governs the Tasks DB.

### 4. ADR-022 is reaffirmed, not superseded

Its decision — canonical DB, projected State Doc — is correct and unchanged. What this ADR
removes is the sentence exempting the mechanic from it. ADR-022's Status line is **not**
stamped; the false sentence is handled as an erratum (#412) under
[ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1, since correcting it requires
no new decision.

## Consequences

- **Good:** #129's duplicate becomes unreachable rather than guarded; `create_task` is the
  single writer so the Act ledger covers every path; the cap has no side effects; the State
  Doc is finally a projection in mechanism as well as in prose; a future `create_event`
  (#126) inherits the same discipline without further design.
- **Cost / bad:** every approved action lands in Notion immediately — the State Doc can no
  longer hold an action loosely, and Tasks DB grows faster. `dos-hl` gains a Tasks DB read
  in Setup and a priority prompt in Step 5, making the ritual slightly longer.
- **Neutral:** `open_actions_cap` changes meaning from "how many we keep before spilling" to
  "how many pulled rows we display", and its value wants raising (~20) to match. That is a
  `user_integrations` config change, not a code change.
- **Erratum (2026-07-20, same day, pre-adoption):** §1 and the Consequences below were
  written treating the `artifact_external_links` lineage ledger as the mechanism that
  prevents duplicate tasks. It is not sufficient, and #413 established why: the ledger
  only records tasks **ahkms created**, so a task entered directly in Notion is invisible
  to it and a ledger-based check would duplicate it. The duplicate guard is a check
  against the **Tasks DB itself** — the system of record — performed before proposing any
  new action. The lineage link remains valuable as **provenance** (which thought produced
  this task) and `single_task`/`dedup_key` remain a cheap second line against re-running
  this ritual over the same atoms, but neither is the primary guard. The decision in §1
  and §2 is unaffected: write through at identification, never at cap time.
- **Follow-up:**
  - `Completed at` must be populated by a Notion automation on `Status` → `Done`, or the
    Done-today section renders empty while looking authoritative (#414).
  - Recent Communications has the same sink-shaped mechanic against the Meetings DB /
    Investor CRM and is **not** fixed here — same treatment, tracked separately.
  - The cowork-surface copy of `dos-hl` has forked and has no ahkms lineage at all (#415);
    this ADR governs the repo copy.

## Links

- [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) — the projection
  model, reaffirmed; the exempting sentence is corrected by erratum (#412).
- [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) §5 — the Act ledger
  and the `single_task` / `dedup_key` guard this write-through makes reachable.
- [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §2 — why `architecture.md` is
  updated in this PR.
- #129 — the duplicate-task bug, closed as superseded by this decision.
- #410 — implementation. #412 — ADR errata. #414 — `Completed at` automation.
