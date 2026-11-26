# ADR-022: The State Doc is a curated top-N projection of canonical source DBs (not an overflow sink)

**Status:** Accepted
**Date:** 2026-06-15
**Accepted-on-dev:** 2026-06-15
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, dos-hl, notion, synthesis, state-doc, naming
**Builds on:** ADR-013 (capture/working-state split), ADR-018 §7 (dos-hl port)

> **Numbering note.** This takes **022**. `021` is intentionally skipped/reserved.

---

## Context

`dos-hl` (ADR-018 §7) maintains a Notion **State Doc** — a concise "current truth" view — with
sections such as **Open Actions**, **Recent Communications**, and investor comms. Those sections
draw from Notion databases: a **Tasks DB**, a **Meetings DB**, and an **Investor CRM**.

The wiring shipped with the dos-hl port (PR #85) describes the relationship **backwards**:

- Config keys named `tasks_overflow_data_source_id` / `meetings_overflow_data_source_id`.
- Prose in `notion-integration.example.json` (`_key_purpose`) and `dos-hl/SKILL.md` Step 5 framed
  as *"where Open Actions overflow lands when the State Doc cap is exceeded"* — i.e. the State Doc
  is primary and the DB is a sink the State Doc spills into.

That direction is inverted, and it muddies the data model.

## Decision

**The source databases are canonical; the State Doc is a curated top-N (~10) projection selected
from them.** Concretely:

- The **Tasks / Meetings / Investor CRM databases hold the full, canonical lists.** They are the
  source of truth for their domain.
- The **State Doc surfaces the top ~10** of each as a skimmable view. Items beyond the top-N are
  **not "overflowed out of" the State Doc** — they were never the State Doc's to own; they simply
  remain in the source DB, unsurfaced.
- "Demote the oldest from the State Doc when a section exceeds its cap" is therefore a **view
  re-selection** (drop from the top-N), not a data move. ~~The mechanic in dos-hl Step 5 is
  unchanged; only its *framing* is corrected.~~ **— see Erratum 1 below.**
- This is the same **registry-not-store** posture as the rest of ahOS (ADR-016): the State Doc is
  a projection over canonical stores, not a second store. *(Erratum 2: the original text cited
  this as "Map, don't store / vision.md §1". That was a vision-doc formulation ADR-016 never
  decided — ADR-016 says "centralise the map, disperse the content" and explicitly defers the
  storage decision. The current vision states the rule as "store by default; map when there's a
  reason." The projection argument here is unaffected: it is about the State Doc not being a
  second store, not about where bytes live.)*

**The same pattern holds for all three:** Tasks, Meetings (Recent Communications), and Investors.

**Naming consequence.** The `*_overflow_data_source_id` keys point at the canonical **sources**, so
the "overflow" name is misleading. Rename them to `*_source_data_source_id` (tracked in #88).
`tasks_database_id` (the `create_task` write target) and the Tasks *source* are the **same Notion
DB** in two id forms — a `database_id` for `create_task` writes, a `data_source_id` for dos-hl's
top-N selection.

`daily_log_data_source_id` is **unaffected** — the Daily Log is an append-only journal dos-hl
*writes* to, not a top-N source.

## Consequences

- **Good:** the data model is stated correctly — canonical source → projected view — matching the
  rest of the system; readers stop inferring a "State Doc is primary" model.
- **Cost:** a cross-file rename (`integrations.ts`, `getNotionConfig.ts`, `dos-hl/SKILL.md`, the
  example json) — tracked in **#88**. No data migration: `user_integrations` has no notion row yet.
- **Now (this ADR's commit):** the *prose* in `dos-hl/SKILL.md` Step 5 and
  `notion-integration.example.json` is corrected to the projection framing; the key **rename** is
  deferred to #88 (cross-file + would churn config shape).

## Errata

Recorded 2026-07-21 under [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1 — these
corrections require **no new decision**, so this ADR is edited in place and its Status line is not
stamped. **The decision above is correct and reaffirmed:** canonical DBs, State Doc as projection.

### Erratum 1 — "the mechanic in dos-hl Step 5 is unchanged" was false when written

The sentence directly contradicted the bullet it closed. The shipped mechanic at
`.claude/skills/dos-hl/SKILL.md` did **write** at cap time — *"ensure those items exist as rows …
via `notion-create-pages`"* — and a write is not a view re-selection. "Ensure those items exist" is
only necessary if the items are *not already* in the canonical DB, which is the sink model this ADR
had just rejected, restated as an implementation detail six lines below the prose rejecting it.

This exemption was the **root cause of the duplicate-task bug (#129)**: an atom already Acted into
a Notion task is narrated into Open Actions, and days later the cap-time write creates it a second
time. By then the item is a sentence and the `artifact_id` needed to consult the Act ledger was
lost when the atom became prose — which is why #129's proposed fix (pass `single_task` at the
cap-time write) was not implementable.

Corrected by **[ADR-040](./ADR040_State_Doc_Write_Through_Projection.md)**: actions are written
through to the Tasks DB at identification via `create_task`, and cap enforcement writes nothing.
Discrepancy found 2026-07-20 while grilling #129.

**Still outstanding:** Recent Communications retains the same cap-time sink mechanic against the
Meetings DB / Investor CRM — ADR-040 fixed the actions half only. Tracked as **#422**.

### Erratum 2 — the "Map, don't store" citation

The Decision bullet and the Links section cited *"`docs/vision.md` §1 (Map, don't store)"* as the
governing principle. That formulation was a vision-doc overreach: ADR-016 says *"centralise the
map, disperse the content"* and then explicitly defers the storage decision (*"Build-time decisions
(pointer table vs. lifecycle stage; …) are deliberately deferred"*). The vision was rewritten
2026-07-20 and now states the rule as **"store by default; map when there's a reason."**

This does not affect ADR-022's argument, which is about the State Doc not being a *second store* —
a claim about projection semantics, not about where bytes live.

## Links
- Implementation follow-up: **#88** (rename overflow → source).
- Builds on: [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md) §5/§7,
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) §7.
- Corrected by: [ADR-040](./ADR040_State_Doc_Write_Through_Projection.md) (write-through at
  identification). Remaining gap: **#422** (Recent Communications).
- Principle: [ADR-016](./ADR016_Discover_And_Index_Axis.md), `docs/vision.md` (projections are
  outputs, never sources).
