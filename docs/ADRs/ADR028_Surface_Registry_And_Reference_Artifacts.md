# ADR-028: ahOS as a registry over a federation of surfaces — reference vs content artifacts

- **Status:** Accepted
- **Date:** 2026-06-22
- **Accepted-on-dev:** 2026-06-22
- **Deciders:** Angus Hally (solo maintainer)
- **Tags:** architecture, knowledge-management, registry, artifacts, federation, map-not-store

> **Naming note.** This is **not** the in-flight `ADR031_Capability_Registry`
> (PR [#118](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/118)),
> which registers *capabilities/skills*. This ADR is about the **data substrate**
> as a registry over external systems of record. Different "registry"; held on a
> separate number to avoid the clash. Qualify the word wherever both appear.

## Context and problem

ahOS's thesis is *"never forget anything"* — track knowledge across many surfaces
(Notion, Drive, Gmail, Calendar, CRM…). For much of that knowledge the **human
reading and editing surface is the source system itself**: meeting notes are read
in Notion, tasks are worked in Notion. ahOS does not need to *own* that content; it
needs to *know it exists, where it lives, and how it relates*.

A dogfooding session (2026-06-22) on the meeting → task flow forced two questions
the model had not pinned down:

1. **What does ahOS store for a meeting note?** The Notion AI meeting note carries
   a clean structured summary *and* a ~4,000-word transcript. Capturing it whole
   violates capture faithfulness/atomicity (ADR-018). Storing nothing loses the
   "record of events."
2. **What is a task, to ahOS?** A task created in Notion is currently "known" only
   as a cross-store link (`artifact_external_links kind='task'`) hanging off the
   source artifact — not a queryable node. We want ahOS to be *aware of the task
   and know where to go for it*.

Underneath both: **is a "registry node" (a reference to an external thing) a
different kind of node from an artifact (which also carries a source link)?** This
ADR settles that, because the answer shapes the schema, search, and every consumer.

Builds directly on ADR-016 (Discover & Index — "centralise the map, disperse the
content"; discovered items are `artifacts` rows in *registry/pointer mode*),
ADR-013/018 (capture primitive; synthesis-time interpretation), ADR-022 (State Doc
is a projection of canonical source DBs, not a copy), the 2026-06-15 vision
brainstorm ("Map, don't store"; "cross-store lineage is the actual data model"),
and issue [#134](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/134).

## Decision drivers

- **Map, don't store.** Source surfaces stay the system of record; ahOS holds
  identity, location, and relationships (#134, ADR-016, ADR-022).
- **One queryable substrate.** The registry promise — *"ask ahOS what exists and
  where"* — is only cheap if it is one substrate to query, not a union of classes.
- **Capture faithfulness/atomicity (ADR-018).** Derived summaries and transcripts
  must not pollute faithful captures.
- **No drift.** Anything that caches mutable external state must not become a stale
  shadow database.
- **Maximum reuse, minimum new surface (ADR-016 binding constraint).** Do not
  rebuild the substrate; add to `artifacts` + `entities`.
- **Trustable completeness.** ahOS must be able to *mirror* a surface, not only
  register what it happened to touch — otherwise "what do I have?" is answered from
  a sliver (ADR-016's own argument).

## Considered options

### Option 1 — New first-class "registry node" class (artifacts + entities + registry nodes)

- **Pros:** legible — a task is never typed as an "artifact"; isolates the
  mutable-state-cache concern.
- **Cons:** **duplicates** the pointer-mode-artifact machinery ADR-016 already
  established; **fragments** the substrate (every consumer and search must union
  artifact + registry forever); creates a boundary to police between "pointer-mode
  artifact" and "registry node," which are the *same shape*. Also collides
  conceptually with the in-flight *capability* registry (PR #118, ADR-031).

### Option 2 — Task as an entity subtype

- **Pros:** reuses the entity graph and its edges.
- **Cons:** entities are *derived, deduplicated semantic nouns* (the things
  artifacts are *about* — people, projects, areas) and deliberately carry **no**
  source/lifecycle/content machinery. A task is an external operational record, not
  a concept other artifacts are about; this forces the wrong machinery onto the
  wrong class. (A meeting *series* — "Briana–Angus Weekly" — is a legitimate
  entity; the *instance* is not.)

### Option 3 — Split "capture" from "artifact" (captures + artifacts + entities)

- **Pros:** revives the dos-inbox "immutable timeline entry" feel.
- **Cons:** re-litigates ADR-018, which deliberately collapsed dos-inbox capture
  onto `/capture` + `artifacts`. "Capture" is a *verb/event* that produces an
  artifact, not a node class.

### Option 4 (chosen) — Registry = the artifact substrate in *reference mode*; `reference` vs `content` as a first-class artifact subtype

Two node classes stay (`artifact`, `entity`). The artifact gains a first-class
subtype discriminator: **content** vs **reference**. A reference artifact is a
pointer (identity + source URL/external_id + edges, no local body); a content
artifact is source material that may carry bytes/extracted text. The "registry" is
not a new structure — it is the `artifacts` substrate viewed through reference
artifacts + cross-store links.

- **Pros:** reuses everything (ADR-016 pointer-mode artifacts,
  `artifact_external_links`, search, lifecycle); one substrate to query; preserves
  faithfulness (reference artifacts have no body to pollute); names the real
  distinction without a new class; consistent with map-not-store and ADR-016's
  binding constraint.
- **Cons:** the word "artifact" now spans content + reference (mitigated by the
  subtype label); mirroring still introduces a sync surface (mitigated by the
  cache-not-truth + federation clauses below).

## Decision

Adopt **Option 4**. ahOS **is a registry/index over a federation of surfaces**: it
holds the *map* (identity, location, relationships); content and human interaction
stay in the source surfaces. The registry is materialized in the **existing
`artifacts` substrate**, with a first-class **`content` vs `reference`** artifact
subtype. No new node class.

### Decision details — the contract

1. **Two node classes only:** `artifact` and `entity`. Entities are unchanged
   (derived semantic nouns).
2. **Artifact subtype is first-class:** every artifact is `content` or `reference`.
   - **Content artifact** — source material (a captured note, a council letter, a
     meeting note). May carry bytes/extracted text. The thing knowledge is
     *derived from*.
   - **Reference artifact** — a pointer to an external operational record (a task,
     a calendar event, a CRM row). Identity + source pointer + edges; **no local
     body**.
3. **Subtype is orthogonal to `lifecycle_stage`.** Subtype is the *nature* of the
   thing (stable); lifecycle is *how much we've materialized* (progresses). A
   discovered Drive file is a **content** artifact currently in pointer/`discovered`
   lifecycle (it can later be enriched to bytes/text). A task is a **reference**
   artifact that stays a pointer forever (nothing to enrich). This resolves
   ADR-016's deferred "lifecycle-stage vs companion-table" question in the
   direction of *a discriminator on `artifacts`, not a separate table*.
4. **The immutable artifact row never holds mutable external state.** A reference
   artifact's identity (source, external_id, edges, captured_at) is append-only.
   The **mutable** bits (a task's status/assignee/due as last seen) live as a
   **freshness-stamped cache off the artifact** — on the cross-store link/cache
   row, never on the artifact, **never treated as truth**. (Exact column/table at
   build time, per ADR-016's deferral.)
5. **Federation resolves live state.** When a stage needs a reference artifact's
   current state ("is this task still open?"), it fetches from the source surface
   at read time. The registry answers *existence + location + relationships*;
   federation answers *current state*. Do not cache what you can resolve live.
6. **Reference artifacts arise from both directions:**
   - **Outbound (ahOS emits):** when ahOS creates an external record (e.g.
     `create_task`), it registers a reference artifact + the `kind='task'`
     cross-store link in the same act (depends on #144/#145).
   - **Inbound (ahOS mirrors):** a scheduled sweep of a surface's records registers
     reference artifacts. This is **ADR-016 Discover & Index extended from content
     surfaces to operational-record surfaces** — same cheap cadence, same
     upsert-by-source-id idempotency, now materializing reference artifacts.
     **Mirror is in scope now, not later** (a registry that only knows what ahOS
     touched cannot answer "what do I have?").
7. **Idempotency is mandatory.** Every reference artifact is keyed by
   `(provider, external_id)` and **upserted**, so re-runs — and the outbound and
   inbound paths meeting in the middle — reconcile to one node, never duplicate.
   Act-dedup uses the same lineage: a re-mirrored meeting must not re-emit its
   tasks, because the `kind='task'` link already records "tasks extracted from
   artifact X."
8. **Automate discovery/linking; gate action/synthesis.** Pull, register, and link
   may run unattended. Creating external records (act) and writing the State Doc
   (synthesis) stay user-invoked or reviewed — consistent with dos-eod and ADR-022.

## Consequences

- **Good:**
  - One substrate answers "what exists, where, and how related" — the registry
    vision, with no class union.
  - Faithfulness preserved: content stays in the source; reference artifacts have
    no body to pollute (ADR-018 intact).
  - Tasks (and later events, CRM rows) become first-class, traceable nodes instead
    of edge attributes.
  - Pure reuse of ADR-016 machinery; honors its "additive, not re-architecture"
    binding constraint.
  - Mirroring gives a completeness the maintainer can trust — the whole point of
    centralising the map (ADR-016).
- **Cost / bad:**
  - **The body of a reference artifact is not ahOS-searchable** (a task's full
    Notion content; a meeting transcript). ahOS search finds the *node* and its
    summary/edges; deep content search is the source surface's job. State this — do
    not let "ahOS knows your tasks" imply full-text coverage.
  - **Mirror needs per-surface server-side readers.** Today only Drive has one;
    **Notion is write-only via the server** (ADR-016) — the meeting/task access in
    this session was *agent-driven* via MCP. So v1 inbound mirror runs
    **agent-driven** (a scheduled agent/skill over MCP); an autonomous server-side
    Notion reader is a tracked dependency, not an assumption.
  - The word "artifact" now spans content + reference; the subtype label is the
    mitigation, and schema/UX should always surface it.
- **Follow-up:**
  - Schema: add the `content|reference` subtype discriminator to `artifacts`;
    define the freshness-stamped state cache on the link/cache row.
  - Wire `create_task` (and future emitters) to register a reference artifact +
    link in one act — blocked on #144/#145.
  - Build the inbound mirror as Discover & Index over operational-record surfaces
    (agent-driven v1), keyed/upserted by `(provider, external_id)`.
  - Land the motivating instance — the **meeting pipeline**: discover/capture →
    content artifact (retrieval summary + source URL, *no transcript*) → link
    people/areas/projects → act (tasks as reference artifacts, gated) → synthesise
    (State Doc, gated).
  - Coordinate naming with PR #118's **capability** registry (ADR-031) so
    "registry" is qualified wherever both appear.
  - Feed the structural model into the reserved **ADR-021 / `docs/vision.md`**
    vision slot, which this ADR underpins.

## Links

- Refines/extends: [ADR-016](./ADR016_Discover_And_Index_Axis.md) (Discover &
  Index; registry-not-store; centralise the map)
- Related: [ADR-013](./ADR013_Capture_Primitive_and_Memory_Working_State_Split.md),
  [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
  (capture faithfulness; synthesis-time interpretation),
  [ADR-022](./ADR022_State_Doc_Is_A_Projection_Not_An_Overflow_Sink.md) (projection
  over canonical sources)
- Distinct from: `ADR031_Capability_Registry` (capability/skill registry, in flight
  on PR [#118](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/118)) — different "registry"
- Vision slot: reserved ADR-021 + `docs/vision.md` (from
  `docs/sessions/2026-06-15-ahOS-vision-brainstorm.md`)
- Issues:
  [#134](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/134)
  (map don't store Notion),
  [#144](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/144)
  (create_task config-lookup bug),
  [#145](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/145)
  (create_task rich properties + workspace targeting)
