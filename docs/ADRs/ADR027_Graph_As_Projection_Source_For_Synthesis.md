# ADR027: Graph as the projection source for synthesis (north star)

- **Status:** Accepted
- **Created:** 2026-06-27
- **Accepted-on-dev:** 2026-06-28
- **Deciders:** Angus

## Context and problem

ahOS has, in effect, two read-side outputs over the same captured atoms:

- the **entity graph** (`entities` + `entity_relationships` + `artifact_entity_links`) — durable, structured, machine-first recall ("never forget"); and
- the **State Doc / Daily Log** — a curated, human-first, present-tense view of where things stand.

Three Accepted/Proposed ADRs already shape how these are produced:

- **ADR-022** — the State Doc is a **projection**, not a source of truth (today, a top-N projection of canonical Notion source DBs).
- **ADR-023** — synthesis is done by **sibling consumers** (`dos-eod`, `dos-personal`, `dos-infra`), many consumers over one substrate.
- **[ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) (Link · Act · Synthesize)** — decomposes synthesis into **Link** (graph extraction), **Act** (external objects), **Synthesize** (state doc), each with its own marker and cadence. (Drafted as `024`; number minted as `038` when it landed on `dev` on 2026-07-20, since `024` had been taken by the Self/User Entity ADR.)

What none of them pin down: **does `Synthesize` (state doc) derive from the entity graph, or does it re-read raw atoms in parallel with `Link`?** Today the two run as **siblings that both interpret raw atoms**, which means the *same atoms are interpreted twice* (once into the graph, once into the state narrative) and the two outputs can drift. The State Doc projects from Notion source DBs (ADR-022), not from the graph. This ADR sets the long-term direction for that gap; it does not rip out the current pipeline.

## Decision drivers

- **One interpretation, not two.** Double-interpreting atoms is the core smell — it costs tokens and lets graph and state diverge.
- **Single source of truth for facts.** "What is true about X" should have one home.
- **Capture stays dumb; interpret at read** (ADR-018) — unchanged.
- **Additive, incremental, single-user-appropriate** (vision) — a north star reached in steps, not a big-bang re-architecture (which the vision explicitly warns against).
- **Not everything is a graph fact.** Reflections, affect, "the question you're avoiding" are narrative, not entities/edges.

## Considered options

### Option A — Keep siblings parallel over raw atoms (status quo)

`Link` and `Synthesize` both read atoms independently.

- **Pros:** already built; no coupling; each consumer fully autonomous.
- **Cons:** double interpretation; graph and state can disagree; ADR-013's split leaves "where's the truth about X?" ambiguous.

### Option B — Graph is the source of truth; everything projects from it (chosen as north star)

`Link` is the single interpretation layer. The State Doc (and, over time, tasks/calendar materializations) **project from the graph**, falling back to raw atoms only for narrative/affective content the graph cannot represent.

- **Pros:** one interpretation; graph and state cannot drift on facts; "get X about Y" and the state narrative share a source; composes with ADR-022 (state doc is *still* a projection — just of the graph) and [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) (Synthesize reads Link's output).
- **Cons:** partially supersedes ADR-013's memory-vs-working-state split; needs the graph to model enough (helped by the self entity (ADR-024) and event type (ADR-025) already added); risk of over-modelling if pushed too far too fast.

### Option C — State doc is its own source of truth

The narrative is authored directly and the graph mirrors it.

- **Cons:** inverts "structured truth is the substrate"; the human narrative becomes load-bearing for machine recall; worst drift profile. Rejected.

## Decision

**Option B is the north star, reached incrementally.**

1. **The entity graph is the canonical structured source of truth** for facts (people, events, relationships, and over time tasks-as-nodes). Atoms remain the immutable record beneath it; the graph is the single interpretation of them.
2. **`Synthesize` projects from the graph**, not from a parallel re-reading of raw atoms, for every facet the graph holds. It reads raw atoms **only** for narrative/affective content with no graph representation (reflections, mood, open questions).
3. **`Link` runs before `Synthesize`** for a given atom — a soft pipeline (capture → Link → Synthesize), not two independent parallel passes. This is the concrete resolution of [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md)'s open "parallel vs pipeline" point.
4. **ADR-022 still holds** — the State Doc remains a curated top-N projection; this ADR only changes *what it projects from* (the graph, plus the canonical task/meeting DBs as those themselves become graph materializations).
5. **Incremental path, not big-bang:** start by having `dos-eod`/`process_artifact` share the graph as the intermediate representation for people/events/relationships; leave tasks in Notion as the actionable surface (Act) while also representing them as graph nodes; migrate more facets to graph-sourced projection as the graph proves out.

## Consequences

- **Resolves the consumed-by overload cleanly** (this was the question that started the thread): adopt [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md)'s **per-step ledger**. `Link`'s "consumed" marker is the `artifact_entity_links` rows themselves; `Act`'s is `kind='task'|'event'`; `Synthesize`'s is `kind='consumed_by_state'`. **Graph extraction must NOT write `consumed_by_state`** — that marker belongs to the state-doc step only. `process_artifact` is updated accordingly in this PR.
- **Supersedes part of ADR-013** (the strict memory-vs-working-state *separation* of truth): working-state surfaces become projections/materializations of the graph rather than independent sources. ADR-013's capture primitive and lineage model are unchanged.
- **Follow-ups (separate work):** teach `dos-eod`'s Synthesize step to read the graph for people/events/relationships; decide the task-as-node model; define how narrative atoms (no graph rep) are still surfaced.
- **Accepted:** Resolved 2026-09-25 (#744). The scope of ADR-027 is explicitly narrowed to knowledge-state projections.

## Amendment: Live metrics are outside ADR-027's scope (2026-09-25, #744)

ADR-027 governs **knowledge-state projections** — structured facts, people, events, relationships, and task materializations derived from captured knowledge atoms.

The Monday report composed under #647 combines two sources with fundamentally different authority:
1. **Narrative from the State Doc** (knowledge state, which adheres to ADR-027 and ADR-022); and
2. **Numbers from live proxies** (PostHog and RevenueCat live reads).

Live operational telemetry and usage metrics are not knowledge facts derived from captured atoms, and they are not mediated by the State Doc. Querying analytics proxies directly for live numbers bypasses the State Doc by design and preserves separation of concerns, without violating ADR-027's constraint that the graph is the canonical source of truth for knowledge state.

## References

- Builds on / refines: ADR-018 (capture dumb / interpret at read), [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) (state doc is a projection), [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) (sibling consumers), [ADR-038](./ADR038_Three_Step_Independently_Triggerable_Synthesis.md) (Link · Act · Synthesize).
- Partially supersedes: ADR-013 (memory vs working-state as separate sources of truth).
- Enabled by: [ADR-024](./ADR024_Self_User_Entity.md) (self entity), [ADR-025](./ADR025_Event_Entity_Type.md) (event type), [ADR-026](./ADR026_Rationalised_Provenance_And_Derived_Trust.md) (provenance/trust).
- Refined by: #744 (adjudication of live metrics outside projection source).
