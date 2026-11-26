# ADR-038: Synthesis decomposes into three independently-triggerable steps (Link · Act · Synthesize)

**Status:** Accepted · Superseded in part by [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (§2's Synthesize marker is renamed `consumed_by_state` → `synthesized` and gains `synthesized_unattended`; the three-step decomposition itself is unchanged)
**Date:** 2026-06-22 (drafted) · 2026-07-20 (number minted, accepted on `dev`)
**Accepted-on-dev:** 2026-07-20
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, capture, synthesis, dos, lineage, eager-processing
**Builds on:** ADR-013 (capture primitive + memory/working-state split), ADR-018 (unified capture surface + synthesis-time interpretation), ADR-022 (State Doc is a projection), ADR-023 (sibling read-side consumers)

> **Numbering note.** Drafted as `ADR-024` on `feat/synthesis-steps-and-end-skill`, but that
> branch was never merged and **024 was subsequently minted for
> [ADR-024 Self/User Entity](./ADR024_Self_User_Entity.md)**. Per
> [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md) §Context — which referred to
> this ADR *by slug* precisely because its "number [is] minted at merge" — it lands here as
> **038**, the next free integer. This preserves the index invariant that each integer maps to
> exactly one file.
>
> **Why Accepted rather than Proposed.** The decomposition was already implemented and shipped
> to `dev` without the record: `createTask.ts` carries the §5 `single_task` / `dedup_key` guard,
> `process_artifact` documents the per-step ledger in its three-step table, and
> [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md) §Consequences adopts this
> ADR's per-step ledger as settled and resolves its open "parallel vs pipeline" point. The code
> shipped; only the decision record was left behind. Landing it as Accepted records what is
> already true rather than re-opening a decision the codebase has been running on since June.
>
> **Delivered:** the **Event → Calendar** half of the Act facet (§6) —
> [#126](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/126) shipped a
> native `create_event` MCP tool (option (a): mirrors `create_task`'s dedup/provenance/
> lineage treatment exactly, against the same `external_links.kind`/`provider` free-text
> columns — no migration needed). Previously deferred as out-of-scope by
> [ADR-025](./ADR025_Event_Entity_Type.md).

---

## Context and problem

ADR-018 split the pipeline into **dumb capture** (write one faithful artifact per atom, infer nothing) and **smart synthesis** (a read-side consumer — `dos-eod` — that interprets and projects at read time). Synthesis runs at end-of-day; consumption is recorded as a single positive lineage link, `artifact_external_links(kind='consumed_by_state')` (ADR-018 §5, migration 047).

That shipped a latent conflation. "Processed at EOD" treats synthesis as **one monolithic operation on one schedule**, but it is not:

- An atom that *is a task due in an hour* cannot wait for EOD. Some atoms are **time-sensitive**.
- The marker is not named `consumed` — it is named **`consumed_by_state`**. The `_by_state` suffix only makes sense if there are *other ways to be consumed*. The schema already anticipated multiple consumption kinds; we had only built one.

The triggering question was "what does *process immediately* mean?" Pulling on it reveals that synthesis already does three distinct things with three different write targets, idempotency characteristics, and natural timings — and that only two of the three were ever candidates for "immediate." This ADR makes that decomposition explicit so that eager processing is possible **without** re-importing inference into capture (which ADR-018 forbids).

## Decision drivers

- **Capture stays dumb (ADR-018 boundary is non-negotiable).** Eager processing must be *synthesis run early*, never *capture inferring*. ADR-018 forbids producer-side inference; it does **not** forbid running a synthesis step early.
- **Time-sensitive atoms must be actionable now.** A captured task or event loses its value if it waits for EOD.
- **No double-processing.** Eager processing now plus EOD later must never duplicate (e.g. two Notion tasks from one atom).
- **Reuse the substrate.** The `artifact_external_links.kind` ledger and the idempotent `artifact_entity_links` upsert already exist; the decomposition should fall out of them, not add a parallel mechanism.
- **Don't re-import classification coupling.** ADR-018 deliberately moved workspace/type/domain classification to read time, per-consumer (ADR-023). The decomposition must not drag classification back to capture time or hard-wire it to one consumer.

## Considered options

### Option A — Make capture eagerly infer and act

Capture detects "this is a task" and creates the external object inline.

- **Pros:** one step; immediate.
- **Cons:** straight violation of ADR-018 — inference and side effects move back into the producer. Silent mis-acts (a guessed task is a real Notion row). Couples capture to one downstream system of record.

### Option B — Keep synthesis monolithic, allow "run EOD now" on demand

Leave synthesis as one operation; let the user trigger the whole EOD pass early.

- **Pros:** no new concepts; reuses the existing consumer wholesale.
- **Cons:** the **Synthesize** step's value *is bundling* — narrating one atom into the State Doc in isolation defeats it. Running the whole pass per atom over-processes and produces incoherent state updates. Still all-or-nothing: you cannot get "make the task now, leave the narrative for tonight."

### Option C — Decompose synthesis into three independently-triggerable steps (chosen)

Split synthesis into **Link**, **Act**, and **Synthesize**, each with its own trigger, its own consumption marker, and its own natural timing. The same atom can be processed by each step at a different moment.

- **Pros:** eager processing for the steps that benefit (Link, Act) without touching capture; the bundling step (Synthesize) keeps its batch semantics; "consumed" generalizes from a boolean to a per-step ledger that the schema already supports; the PARA/facet ambiguity dissolves (a facet's step decides its timing); composes with ADR-023 (each sibling consumer runs the three steps with its own taxonomy/destination).
- **Cons:** consumers must learn per-step dedup (check *your* marker, not a global flag); more `kind` values in the ledger; a declaration/trigger surface has to be defined.

## Decision

We choose **Option C**. Synthesis is three steps, not one.

### 1. The three steps

| Step | Writes to | Idempotent today? | Natural timing | Consumption marker |
| --- | --- | --- | --- | --- |
| **Link** — entity extraction + linking | internal knowledge **graph** (`artifact_entity_links`) | ✅ yes — `artifact_entity_sync` upserts on `(artifact_id, entity_id, link_type)` | **eager by default** (cheap, internal, safe to re-run) | the link rows themselves |
| **Act** — materialize external objects | external **systems of record** (Notion Tasks, Calendar) | ❌ no — `create_task` inserts a new page per call | **eager on declaration** (side-effecting, time-sensitive) | `artifact_external_links(kind='task' | 'event')` |
| **Synthesize** — state update | the **working-state** surface (State Doc / Daily Log; the ADR-022 projection) | n/a — it is a narrative bundle | **batch / EOD by nature** | `artifact_external_links(kind='consumed_by_state')` |

### 2. "Consumed" is a per-step ledger, not a boolean

`artifact_external_links.kind` *is* the consumption ledger. `consumed_by_state` is the **Synthesize** marker only. `kind='task'`/`'event'` are **Act** markers (the lineage link `create_task` already writes). The `artifact_entity_links` rows are the **Link** ledger. Each step checks **only its own marker** to decide "have I already processed this atom?" — there is no global "processed" flag, and there never was.

### 3. Eagerness policy follows the step

- **Link → eager by default.** Cheap, internal, idempotent. Linking "Sam" and the "cake" project the moment the atom lands costs nothing and EOD will not double it.
- **Act → eager only on declaration** (see §4). Side-effecting and time-sensitive.
- **Synthesize → batch / EOD by nature.** Its value is bundling and pushback across the day's atoms; it is *not* a limitation that it cannot run per-atom — it is the point. "Process immediately" therefore only ever meant **Link + (declared) Act**.

### 4. The trigger rule: declaration, not inference

Eager **Act** fires only on an **explicit signal**, never on a guess:

- A **typed capture** that declares the facet — e.g. "capture a **task**: call the dentist at 2pm" — is a *declaration*. Capture is not inferring type; the user stated it. This is ADR-018-safe.
- A **plain capture** ("dentist 2pm") never triggers Act. Guessing it is a task would be exactly the producer-side inference ADR-018 bans; it waits for EOD.
- A future explicit `/process <facet>` command is an equivalent declaration surface.

Declaration ≠ inference is the entire safety argument: the user (or an explicit command) supplies the type; the system never derives it at capture time. (See [`docs/agents/ask-before-adding.md`](../agents/ask-before-adding.md) for the repo-wide "Ask before adding" operational rule.)

### 5. Idempotency and the one required guard

Each step is safe to run twice because each checks its own marker:

- **Link** is already idempotent (`artifact_entity_sync` upserts). No change.
- **Act** is **not** idempotent (`create_task` inserts). Dedup must key on the *logical task*, **not** the atom. An atom can legitimately derive **many** tasks (a transcript → several action items — the read-time fan-out ADR-013/ADR-018 explicitly allow), so a blanket "skip if any `kind='task'` link exists for the atom" would wrongly cap an atom at one task. Two sub-cases:
  - **Atom *is* a task** (a declared `capture a task` — the path prototyped here): the atom maps 1:1 to a task. The caller asserts this via a `single_task` flag, and the guard skips creation when a `kind='task'` link already exists for the atom. This is what makes eager Act and the EOD Act step safe for declared tasks — whichever runs first wins, the other no-ops. **This is the minimal guard the prototype implements.**
  - **Atom *spawns* tasks** (transcript, brain-dump): 1:N. Each logical task needs its own idempotency key; dedup is on `(artifact_id, key)`. This needs a `dedup_key` on the lineage link. ~~and is **deferred**~~ — **Erratum (2026-07-21): `dedup_key` shipped 2026-07-06**, two weeks before this ADR landed. See Errata below.
- **Synthesize** is unchanged — it already excludes `consumed_by_state` atoms (`search.ts`).

> This refinement came *from* the prototype: the first-cut "per-atom skip" guard was caught contradicting the one-atom-many-tasks data model before it shipped. Prototyping the path de-risked the ADR, which is the point.

### 6. Facet families map onto steps

The fan-out facets (People, Orgs, Projects, Areas, Resources, Memories, Tasks, Facts, Decisions/Agreements, Questions, Events) are not one undifferentiated set; each belongs to a step:

- **Link facets** — People, Orgs, Events-as-node, Facts, Decisions, Questions, Projects-as-node, etc. Any `entity_type` rides the idempotent `artifact_entity_sync` path.
- **Act facets** — Tasks (→ Notion), Events (→ Calendar). The only ones that create a side-effecting external object.
- **Classification facets** — PARA buckets used *as a classification* ("this belongs to the Resources area"). These stay in **Synthesize**, per-consumer, exactly where ADR-018/023 put workspace/type/domain. They are not eager-able.

This dissolves the "is a Project a facet?" question: **it depends which step is consuming it.** "Project: Cake" as a *node you link to* is a Link facet (eager); "sort this into the Projects bucket" is classification (Synthesize, deferred, per-consumer). The same word resolves differently per step, and the step decides the timing — no global facet classification needed.

### 7. The steps decouple in time

Because each step has its own trigger and its own marker, one atom can be **Link-processed at capture**, **Act-processed on declaration**, and **Synthesize-processed at EOD** — three independent processing events on the same atom, with no double-processing because each step consults only its own ledger entry. ADR-023's sibling consumers (`dos-personal`, `dos-infra`) each run the same three steps with their own taxonomy and destination; the step model is shared, the policy is consumer-local.

## Consequences

- **Good:** time-sensitive atoms (tasks, events) become actionable the moment they are captured, **without** weakening capture's dumbness — the ADR-018 boundary holds because eager processing is synthesis-run-early, gated on declaration. "Consumed" generalizes cleanly to the per-step ledger the schema already implied. The facet/PARA ambiguity dissolves. The three steps compose with ADR-022 (Synthesize writes the projection) and ADR-023 (each consumer runs all three).
- **Cost / bad:** every consumer must adopt per-step dedup — in particular the EOD **Act** step must check for an existing `kind='task'`/`'event'` link before creating, or eager + EOD will duplicate. More `kind` values in the ledger to keep coherent. A declaration/trigger surface (typed capture and/or `/process`) has to be specified and built.
- **Follow-up:**
  - Teach the EOD consumer the Act dedup checks: pass `single_task` for atoms it infers *are* a task (skip if a `kind='task'` link exists); for transcript-style atoms that spawn many tasks, key each on a per-task `dedup_key`. *Without this, eager Act + EOD double-create.*
  - ~~Add a `dedup_key` to the lineage link so the 1:N (spawned-tasks) case is idempotent server-side, not just the 1:1 `single_task` case.~~ **Delivered** — migration `20260706120000_064_add_dedup_key_to_artifact_external_links.sql` (2026-07-06).
  - Specify the declaration surface: typed capture (`capture a task: …`) first; `/process <facet>` later.
  - Dogfood the prototyped **capture-a-task** path end-to-end (dumb capture → eager Act with the `single_task` guard → lineage link).
  - Decide whether eager **Link** runs inside `/capture` for declared facets or stays a separate explicit step.

## Errata

Recorded 2026-07-21 under [ADR-039](./ADR039_ADR_Immutability_Metadata_And_Guards.md) §1 — no new
decision is required, so this ADR is edited in place and its Status line is not stamped.

### Erratum 1 — `dedup_key` was described as deferred after it had shipped

This ADR was authored 2026-06-22 and landed verbatim on 2026-07-20 in #406. Its "deferred" claims
were already two weeks stale at merge, and the document contradicted itself: the header note
describes `dedup_key` as **present** in `createTask.ts`, while §5 and the follow-up list describe it
as pending.

`dedup_key` shipped **2026-07-06** in migration
`20260706120000_064_add_dedup_key_to_artifact_external_links.sql` — a partial unique index on
`(artifact_id, provider, kind, dedup_key) WHERE dedup_key IS NOT NULL` — wired through `links.ts`,
`createTask.ts`, `createExternalLink.ts` and `server.ts`, with coverage in `createTask.test.ts` and
`links.test.ts`. Both stale references are struck above.

### Erratum 2 — the ledger is provenance, not the duplicate guard

§5 presents the `artifact_external_links` ledger plus `single_task`/`dedup_key` as what makes eager
Act and the EOD Act step safe ("whichever runs first wins, the other no-ops"). That is true only
for tasks **ahkms itself created**. A task typed directly into Notion has no lineage row, so a
ledger-based check is blind to it and will duplicate it.

Established 2026-07-20 while grilling #413. The duplicate guard belongs against the **system of
record** — `dos-hl` now compares each candidate action against the open Tasks DB set before
proposing anything (PR #425). The lineage link remains valuable as **provenance** — which thought
produced this task — and `single_task`/`dedup_key` remain a cheap second line against re-running
the same ritual over the same atoms, but neither is the primary guard.

The §5 *decision* — a per-step ledger, each step checking only its own marker — is unaffected.

### Erratum 3 — the eager-Act-at-capture trigger described in §4 does not exist

§4 describes a typed capture (`capture a task: …`) triggering eager Act. As of 2026-07-21 the
`capture` skill records `content_subtype: task` and creates nothing; it states explicitly that it
never acts. The only task-creating paths on `dev` are `create-task`, `process_artifact` Step 7, and
`dos-hl`. The declaration surface remains an open follow-up, correctly listed as such below — but
§4's present-tense framing reads as though it ships.

## Links

- Builds on / refines: [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md) §4–§5 (synthesis-time interpretation; the single `consumed_by_state` marker), [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md) §1 (capture primitive), §7 (positive lineage link).
- Composes with: [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) (the Synthesize step writes the curated top-N projection), [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) (each sibling consumer runs Link · Act · Synthesize with its own taxonomy/destination).
- Substrate: `artifact_external_links` (migration `20260606140000_047_add_artifact_external_links.sql`), `create_task` lineage link (`packages/mcp-server/src/tools/createTask.ts`), `artifact_entity_sync` upsert (`packages/mcp-server/src/tools/artifactEntitySync.ts`), consumed-atom filter (`packages/mcp-server/src/tools/search.ts`).
- Operational rule: ["Ask before adding"](../agents/ask-before-adding.md) — declaration vs inference, promise tracking, and unattended task-creation bounds (#1028).
