# ADR062: An atom's identity is the entity it concerns, not the message it arrived in

- **Status:** Accepted · Superseded in part by [ADR-069](./ADR069_One_Item_Is_One_Atom_A_Second_Source_Is_A_Second_Atom.md) (§1's second paragraph only — the storage rule: a second source captures its **own atom** linked to the same entity, rather than attaching to the existing artifact. §1's identity rule, and §2–§6, stand unchanged)
- **Created:** 2026-08-25
- **Accepted-on-dev:** 2026-08-25
- **Deciders:** Angus

## Context and problem

The same real-world thing can arrive more than once, from more than one source, at
times the system does not control. A meeting produces a Gemini notes email, and
possibly also a Plaud recording, a Granola summary and a colleague's Notion page.
A person, a decision or a commitment can surface in a document today and a chat
thread tomorrow.

Nothing currently decides what that means. The failure has two shapes:

1. **Duplication.** If "have I already got this?" is answered by the message, a
   second source for the same meeting captures a second artifact, and the day now
   contains two atoms about one event that no reader can tell apart.
2. **Silent rewrite, or silent loss.** If a source arrives *after* the day has been
   synthesised, either it is folded in (rewriting a record the owner already read and
   confirmed) or it is dropped (the system holds a source it never surfaced). Both
   fail quietly.

The trigger was a drafted meeting-note spec whose most useful sections were exactly
these: resolve on the meeting, not the email; a late source produces a delta, not a
reopen. The problem is not meeting-shaped, so neither is this decision.

## Decision drivers

- **The message is a source; the thing is the thing.**
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
  already separates faithful capture from read-time interpretation. Identity belongs
  on the same side of that line as the interpretation.
- **No global processed flag.**
  [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) §2: each step
  checks only its own marker, and "there is no global 'processed' flag, and there
  never was." Any idempotency here must key on existing ledgers.
- **Confirmed output must stay distinguishable from unconfirmed.**
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) §6 makes
  that the whole point of two marker kinds. A late source that silently edits a
  `synthesized` day destroys the distinction from the other end.
- **Prefer a loud gap to a quiet guess.** The recurring failure mode on this system
  is confident wrongness, not breakage.
- **Do not build machinery that the ledger cannot support yet.**

## Considered options

### Option A — identity is the message (the implicit status quo)

- **Pros:** nothing to decide; the source is already the unit of capture.
- **Cons:** N sources for one meeting produce N unrelated atoms; the reader
  reconciles by hand, every time, forever.

### Option B — identity is the entity, and a late source reopens the synthesis

- **Pros:** the record always reflects everything known.
- **Cons:** a machine-sourced fact can overwrite a human-confirmed one, which is
  precisely the indistinguishability ADR-050 §6 exists to prevent. It also makes a
  closed day permanently reopenable, which is the opposite of what closing is for.

### Option C — identity is the entity; a late source attaches, and after synthesis is reported rather than folded (chosen)

- **Pros:** duplication disappears at the point it is created; confirmed records are
  never silently edited; and the thing the system cannot compute is surfaced instead
  of guessed at.
- **Cons:** the human does the reconciliation for post-synthesis arrivals until
  claim-level provenance exists; and "report" is a weaker promise than the delta the
  drafted spec asked for.

## Decision

We choose **Option C**.

### 1. Identity is the entity the atom concerns

Resolution happens on the entity, not the message. For a meeting that is the calendar
event; where no calendar event exists, a synthetic `event` node built from date,
attendees and title ([ADR-025](./ADR025_Event_Entity_Type.md)), which may later be
reconciled against a real one. The same rule holds for any entity type.

A second source for an entity that already has an artifact **attaches as an
additional source**. It does not capture a second atom about the same thing.

### 2. Idempotency keys on existing ledgers, never on a new status field

The artifact-to-entity link is the "have I got this already?" record; the
`artifact_external_links` markers are the "has this been consumed?" record. No
`processed` column and no `unprocessed → in-progress → processed` machine is
introduced. ADR-038 §2 holds unchanged, and `lifecycle_stage` is a different axis
that is not repurposed for this.

### 3. Before synthesis, a late source simply attaches

Nothing else happens. The atom has not been consumed, so there is nothing to
contradict.

### 4. After synthesis, a late source is reported, never silently folded and never silently dropped

The source attaches (§1) and is **surfaced to the owner against the day it belongs
to**. The synthesised record is not rewritten by a machine.

### 5. Reported, not diffed, until claim-level provenance exists

The drafted spec asked for a computed delta: diff the new source against what was
synthesised, stage only material additions. **That is not computable today.** The
markers record *that* an atom was consumed and *which object* consumed it; they do
not record *which claims* were carried into that object. Computing a delta would mean
re-reading the daily log's prose and re-deriving claims from it, which is inference
about inference.

So the honest behaviour is the weaker one: report the arrival, let the owner judge.
This is a decision, not a deferral — a computed delta built on re-derived claims
would produce exactly the plausible-and-wrong output this system keeps designing
against. It is the same missing substrate that
[#673](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/673)
reaches from the other side, where a re-run cannot tell which page is the log for a
given day.

### 6. Human-confirmed beats machine-sourced

Where a late machine-sourced claim contradicts one the owner confirmed, the confirmed
one stands and the contradiction is flagged. This is an application of ADR-050 §6
rather than a new rule, and is recorded here only because it is the rule §4 leans on.

## Consequences

- **Good:** multi-source arrival stops producing duplicate atoms, at the point of
  capture rather than at read time.
- **Good:** a confirmed day is never edited by a machine, so `synthesized` keeps
  meaning what ADR-050 §6 says it means.
- **Good:** the gap (§5) is visible in the design rather than hidden inside a delta
  that would look computed and be guessed.
- **Cost:** for post-synthesis arrivals the owner does the reconciliation. On a busy
  week that is real work, and it is the price of not fabricating a diff.
- **Cost:** synthetic-versus-real event reconciliation (§1) has no mechanism yet;
  there is no generic entity merge in the tool surface.
- **Follow-up:** claim-level provenance (what a synthesis actually carried) is the
  substrate that would upgrade §5 from *report* to *delta*, and would also unblock
  #673. That is [#875](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/875).

## Links

- Related: [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md),
  [ADR-025](./ADR025_Event_Entity_Type.md),
  [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md),
  [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md),
  [ADR-061](./ADR061_Meeting_Notes_Are_A_Source_Adapter_Not_A_Capability.md)
- Issues: #673, #873, #875
