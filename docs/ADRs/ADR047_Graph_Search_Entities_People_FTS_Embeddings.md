# ADR-047: Graph search — entities and people get their own FTS + embeddings (Option A)

- **Status:** Accepted
- **Created:** 2026-08-05 (decision recorded on #137, 2026-07-17)
- **Accepted-on-dev:** 2026-08-05
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, search, retrieval, knowledge-graph, embeddings, migrations
- **Builds on:** ADR-012 (MCP tool layer — `search_knowledge`), ADR-027 (graph as
  projection source, status: Proposed — direction, not settled), ADR-034 (lifecycle
  semantics — archived rows)
- **Resolves:** #137 (search can't reach the knowledge graph) — the *decision*;
  the issue itself closes when the implementation slices (§ Tracer-bullet slices)
  ship.

---

## Context and problem

`search_knowledge` — the system's primary retrieval surface — queries only
`public.artifacts`. Both halves of its hybrid ranking are artifact-scoped by
construction:

- **FTS:** the generated `search_vector` tsvector and its GIN index exist only
  on `artifacts` (migration `20260527120000_044_add_artifacts_fts_search.sql`);
  keyword ranking runs in `fts_search_artifacts` (migration 066).
- **Semantic:** the `embedding vector(1536)` column, its HNSW index, and the
  RRF-fused `hybrid_search_artifacts` RPC also exist only on `artifacts`
  (migration `20260619120000_051_add_artifacts_embedding.sql`, archived opt-in
  added in 069, overloads fixed in 071).

`entities` and `people` carry **neither** column. Their only indexes are jsonb
`properties`/`tags` GIN indexes from the baseline schema — nothing text-rank- or
vector-shaped. So the derived PARAMPS graph layer — the very thing the system
extracts *from* artifacts — is unreachable by relevance or semantic search. It
is addressable only through structured lookups (`entities_query`,
`people_query`, `people_match`), whose text matching is client-side substring
filtering, not ranking.

The concrete failure (dogfooding, issue #137): searching "Sam" matched raw
artifact bodies containing the string, but a *Sam* **person row** would never
surface. Search and the knowledge graph are two disconnected query surfaces —
which also undercuts ADR-027's direction that the graph is the projection
source consumers should converge on.

A decision on #137 was queued as **needs-angus** because the options differ in
*ongoing cost*, not just shape. **Angus decided on 2026-07-17: Option A.** This
ADR records that decision and its rationale; it does not relitigate it.

## Decision drivers

- **Recall is the point.** An entity/person must be findable by its *own*
  name and fields (role, organization, relationship), even when no linked
  artifact's text mentions it. This is exactly what the projection option
  cannot deliver (see Considered options).
- **Mirror, don't invent.** The artifacts search stack (generated tsvector →
  GIN, `vector(1536)` → HNSW, RRF-fused hybrid RPC, best-effort embed-on-write
  + `embedding IS NULL` backfill queue) is proven through migrations 044 → 051
  → 066 → 069 → 071 and PR #515. The graph should get the *same* pattern, not
  a new one.
- **One consistent lifecycle boundary.** Archived/soft-deleted rows are
  excluded from search by default with an `include_archived` opt-in — the
  convention #140's investigation established for artifacts (migration 069)
  and that `entities_query`/`people_query` already follow. Graph search must
  inherit it, not fork it.
- **Degradation semantics already exist.** Search degrades to FTS-only (with
  an explicit `search_mode` notice — #136, #486) when the embedding provider
  is missing or down. The graph arms must ride the same behaviour, not add a
  second failure surface.
- **Cost is accepted, eyes open.** Option A means a second embedding pipeline
  paid on every entity/people write. The 2026-07-17 decision accepts that
  ongoing cost explicitly, in exchange for recall.

## Considered options

1. **A — entities/people get their own FTS + embedding columns** (chosen).
   Mirror the artifacts pattern: generated `search_vector` + `vector(1536)`
   `embedding` on both tables, their own GIN/HNSW indexes, their own hybrid
   RPCs, and dual-query wiring in `search_knowledge`. Strongest recall: a
   graph row is findable with zero linked artifacts, by any of its own
   fields, keyword or semantic. Cost: schema on two more tables, and an
   embedding call on every entity/people write (plus backfill).

2. **B — project search onto linked entities at read time.** Search artifacts
   as today, then surface linked entities/people through
   `artifact_entity_links` / the people links. Rejected: recall is bounded by
   what artifact text *says about* an entity — a sparsely-referenced person is
   invisible, and entity-field matches (role, org) are unreachable ("find my
   contacts at Acme" only works if some artifact body happens to contain
   "Acme"). The "Sam" failure that motivated #137 stays unfixed: a Sam person
   row with no artifact mentioning "Sam" never surfaces. It also inverts
   ADR-027 — the graph would be reachable only *through* artifacts, cementing
   artifacts as the primary surface.

3. **C — FTS-only on entities now, defer embeddings.** Add just the tsvector
   and wire it in; skip the embedding column and pipeline. Cheapest path that
   closes *part* of the gap (keyword recall), and was the triage
   recommendation. Rejected by the 2026-07-17 decision: it leaves graph
   retrieval permanently second-class (keyword-only while artifacts are
   hybrid), and the deferred half doesn't get cheaper later — it gets more
   expensive (a bigger backfill, plus interim search wiring built for
   asymmetric arms that would need reworking). The embedding cost was judged
   acceptable now.

## Decision

Adopt **Option A**. The build shape, in the order the tracer-bullet slices
ship it:

### 1. Schema: mirrored columns + indexes on `entities` and `people`

- **`search_vector`**: generated always-stored tsvector, GIN-indexed,
  mirroring migration 044. Source fields per table:
  - `entities`: `title` + `description` (+ selected scalar `properties`
    fields if the slice finds high-value ones — kept deliberately narrow;
    jsonb keys used must be immutable-extractable for a generated column).
  - `people`: `name` + `bio` + `role` + `organization` + `relationship`.
- **`embedding vector(1536)`**, nullable, HNSW cosine index, mirroring
  migration 051. Nullable is load-bearing: rows without an embedding still
  participate in FTS, and `embedding IS NULL` is the backfill work queue
  (same contract as artifacts, PR #515).
- **Invariant carried over from `embedText`** (embeddings.ts): the text a row
  is embedded from mirrors the fields its `search_vector` is built from, so
  both arms of hybrid search see the same text.
- Migrations follow the qa-rubric bar: destructive-DDL isolation,
  reviewed-before-applied, file-based `db push` only (no dashboard/MCP
  mixing — the migration-history-drift lesson).

- **Amended by addition, 2026-08-23 — `people` is a VIEW, not a table, so the
  two field lists above are one column set on one table.** The list above is
  left as written; this bullet is the correction. `public.people` is
  `SELECT … FROM public.entities WHERE entity_type = 'people'` — defined in
  migration 011, redefined in 027, last in 077. Nothing can be added to it.

  Its aliases map straight onto `entities`: `people.name` IS `entities.title`,
  `people.bio` IS `entities.description`, and `role` / `organization` /
  `relationship` are `properties ->> …` extractions the view already performs.
  So a single generated `search_vector` on `entities` over `title`,
  `description`, and those three scalar `properties` keys satisfies **both**
  bullets above at once — which is what migration 095 (#550) builds.

  Two composition calls made there, recorded here so slices 2–4 inherit them:
  `entity_type` is excluded (already exact-filterable via `entities_query`, so
  indexing it as text would make a search for "concept" match every concept
  row), and `properties.aliases` is excluded because it is a jsonb **array**,
  not a scalar, and so is not immutable-extractable in a generated column —
  which is the "must be immutable-extractable" caveat above resolving to *no*.

  The view is deliberately not redefined to expose `search_vector`/`embedding`:
  `CREATE OR REPLACE VIEW` could append them, but every `select('*')` against
  `people` would then carry a 1536-dimension vector per row for no gain, and
  slices 2–3 read the physical table.

- **Amended by addition, 2026-10-03 (Issue #1153, migration 125):**
  Aliases and term keys (`properties.expansion` and `properties.context`) ARE now
  included in `search_vector`. Aliases moved from jsonb to first-class `entities.aliases text[]`
  in migration 110 (ADR-092), and migration 125 wraps `array_to_string(text[], text)`
  in an `IMMUTABLE PARALLEL SAFE` function (`public.immutable_array_to_string`), making
  it immutable-extractable for stored generated columns. `embedEntityText` in
  `embeddings.ts` was updated in lockstep, preserving the invariant that embed text
  mirrors `search_vector`.

### 2. A second embedding pipeline: embed on entity/people writes

- Generalise the artifact embed-on-write helper (`embedAndStore`, currently
  hard-wired to `artifacts`) to be table-aware, keeping its contract:
  **best-effort, never fails the write**, logs and leaves `embedding IS NULL`
  on failure for the backfill to sweep.
- Wire it into **every write path that creates or mutates searchable text**
  on the two tables: `entities_create` / `entities_update` /
  `entities_upsert` (entities.ts, upsertEntity.ts), `people_create` /
  `people_update` / `people_upsert` (people.ts), the Link-step sync writers
  (`artifact_entity_sync`, `artifact_people_sync`), `promote_edge_to_node`,
  and merge/dedup flows (#310-style sweeps rewrite the surviving row's text —
  it must re-embed).
- Extend the backfill job (`backfill_embeddings`, #427 / PR #515) to sweep
  `entities` and `people` where `embedding IS NULL`, using the existing
  batched, chunk-retrying path (`embedBatchWithRetry`) — graph rows are
  short, so a full backfill is a handful of provider requests.
- **Ongoing cost is accepted** (2026-07-17 decision): one embedding call per
  text-bearing graph write, batched where writes are batched. Storage/index
  growth is bounded by graph size, which is orders of magnitude smaller than
  artifact text volume.

### 3. Graph hybrid-search RPCs, mirroring artifacts

- `hybrid_search_entities` / `hybrid_search_people` (and FTS-only fallback
  siblings mirroring `fts_search_artifacts`): same shape as
  `hybrid_search_artifacts` — FTS rank + vector rank fused with RRF,
  scoped to `user_id`, `limit`-capped.
- **`include_archived boolean default false` is in the signature from day
  one** — both to honour the #140/069 lifecycle convention and to avoid
  migration 071's trap (adding a parameter to a live RPC via
  `CREATE OR REPLACE` mints a second overload and breaks resolution in
  production; declare the full signature once).
- Two RPCs, not one unified graph RPC: `entities` and `people` are separate
  tables with different return shapes; fusion across result sets is the tool
  layer's job (§4), same as it will be across artifacts vs graph.

- **Amended by addition, 2026-08-23 — the "separate tables" premise is false;
  re-derive this choice before building slice 3 (#552).** The bullet above is
  left as written; this is the correction. `entities` and `people` are one
  table and a view over it (see §1's amendment), so "separate tables with
  different return shapes" is not an argument for two RPCs.

  Two RPCs may still be right — the *return shapes* genuinely do differ, since
  the view renames and flattens — but that is a different, weaker argument than
  the one recorded, and it should be made explicitly rather than inherited.
  A single RPC over `entities` with an `entity_type` filter is now the obvious
  alternative and was never actually considered.

### 4. `search_knowledge`: dual-query + merge/rank

- On a query-bearing search, embed the query **once** and fan out to the
  artifact RPC and the graph RPCs.
- **Fuse at the tool layer** (second-stage RRF or equivalent over the arms'
  ranked lists), with a **representation guard so graph hits are not buried**:
  strong entity/person matches must be able to reach the top of a merged
  list even when many artifacts weakly match the same text (the burying
  concern named in triage). Exact constants/weights are a slice-level
  concern; the invariant is: *a name-exact entity hit outranks incidental
  artifact body mentions*.
- Results are **labelled by kind** (artifact / entity / person) so callers
  can tell a graph hit from an artifact hit.
- Degradation semantics extend, not fork: no key / provider-down degrades
  *all* arms to FTS-only with the existing `search_mode` notice (#136,
  #486); a graph-arm failure must not take down artifact search.
- `include_archived` flows through every arm; default remains
  archived-excluded everywhere.
- Structured lookups (`entities_query`, `people_query`, `people_match`) are
  unchanged — they remain the precise/structured surface; `search_knowledge`
  becomes the unified relevance surface over both stores.

## Consequences

### Positive

- The knowledge graph becomes reachable from the primary search surface —
  the "Sam" class of failure closes structurally, including for entities
  with zero linked artifacts and for field-level matches (role, org).
- One retrieval model, twice applied: the artifacts pattern (044/051/066/069/
  071 + #515) is reused wholesale — same column shapes, same RRF fusion, same
  degradation and backfill contracts — so there is one search architecture to
  understand, not two.
- Lifecycle (#140) and degradation (#136/#486) conventions stay uniform
  across artifacts and graph.
- ADR-027's direction is reinforced: the graph is a first-class retrieval
  surface, not an annex behind artifacts.

### Negative / risks

- **A second embedding pipeline to run and pay for** — every text-bearing
  entity/people write now costs an embedding call (accepted explicitly,
  2026-07-17). Mitigated by batching, short texts, and the never-fail-the-
  write contract.
- More write paths to keep honest: a new entity/people writer that forgets to
  embed silently degrades semantic recall for those rows until a backfill
  runs. The `embedding IS NULL` queue + periodic backfill is the safety net.
- Merge/rank in `search_knowledge` adds real tuning surface (weights,
  representation guard). Bounded by keeping fusion in the tool layer where
  it is unit-testable, not in SQL.
- Schema growth on two more tables (tsvector + vector + two indexes each) —
  trivial at current single-user scale.

## Tracer-bullet slices

Ordered, each independently shippable and verifiable; lift these into issues
after this ADR merges (they were deliberately **not** pre-filed). Each slice
carries the ADR-039 §2 sync obligation for whatever as-built shape it changes.

### Slice 1 — Migrations: graph search columns + indexes

**Scope:** One reviewed migration adding to both `entities` and `people`: the
generated `search_vector` tsvector (field composition per §1), the nullable
`embedding vector(1536)` column, the GIN index on the tsvector, and the HNSW
cosine index on the embedding. No RPCs, no code changes — columns are inert
until later slices.
**Acceptance:**
- Migration applies via file-based `supabase db push` (no dashboard/MCP
  application), is destructive-DDL-isolated, and is idempotent
  (`if not exists` guards, matching 044/051 style).
- `search_vector` is populated for all existing rows (generated column);
  `embedding` is NULL everywhere; both indexes exist.
- Existing artifact search behaviour is untouched (no RPC signatures change).

### Slice 2 — Embedding pipeline for graph writes + backfill extension

**Scope:** Table-aware generalisation of `embedAndStore`; wire embed-on-write
into all entity/people write paths listed in §2 (CRUD tools, sync writers,
promote-edge-to-node, merge/dedup rewrites); extend `backfill_embeddings` to
sweep both tables' `embedding IS NULL` rows batched.
**Acceptance:**
- Creating/updating an entity or person with text fields leaves the row
  embedded (when a key is configured); provider failure or no-key leaves the
  row written with `embedding IS NULL` and never fails the write.
- A merge/dedup rewrite of a surviving row re-embeds it.
- `backfill_embeddings` reports per-table counts and drains pre-existing
  rows; re-running is a no-op on already-embedded rows.

### Slice 3 — Graph hybrid-search RPCs

**Scope:** Migration adding `fts_search_entities` / `fts_search_people` and
`hybrid_search_entities` / `hybrid_search_people`, mirroring the artifact
RPCs' RRF logic, with `include_archived boolean default false` in the full
signature from day one (071 lesson — no post-hoc parameter additions).
**Acceptance:**
- Each RPC returns rows ranked by fused FTS+vector score (hybrid) or
  ts_rank (FTS), scoped to the calling user.
- Archived rows are excluded by default and included with
  `include_archived => true`.
- A person row whose name matches the query but that has **no linked
  artifacts** is returned by its hybrid RPC (the #137 recall case, provable
  at the SQL layer before any tool wiring).

### Slice 4 — `search_knowledge` dual-query + merge/rank

**Scope:** Embed the query once; fan out to artifact + entity + people RPCs;
tool-layer fusion with the representation guard (§4); kind-labelled results;
degradation notice covering all arms; `include_archived` passthrough.
Structured tools unchanged.
**Acceptance:**
- Searching a person's name surfaces the person row even with no matching
  artifact text (end-to-end #137 repro closed).
- A name-exact graph hit is not buried below incidental artifact mentions
  (representation-guard test).
- No-key / provider-down degrades all arms to FTS-only with the existing
  `search_mode` notice; a graph-arm RPC error does not fail artifact
  results.
- Filter-only and artifact-only behaviours (date windows, `not_consumed`,
  provenance-subtype exclusions) are unchanged.
- As-built docs (`docs/architecture/architecture.md`, tool reference) are
  updated in this slice — the sync obligation lands with the shape change.

## Current-state sync (ADR-039 §2)

Design-only: this ADR records a decision about capabilities not yet
implemented and changes no as-built component, boundary, or flow, so
`architecture.md` is deliberately unchanged in this PR (the ADR-046
precedent). The sync obligation attaches to the implementation slices above —
explicitly to Slice 4, with Slices 1–3 syncing anything they change en route.

## Links

- Decision provenance: [#137](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/137)
  — Angus's Option-A decision comment, 2026-07-17.
- Builds on: [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md),
  [ADR-027](./ADR027_Graph_As_Projection_Source_For_Synthesis.md),
  [ADR-034](./ADR034_Lifecycle_Semantics.md)
- Pattern mirrored: migrations 044 (artifacts FTS), 051 (embedding + HNSW +
  hybrid RPC), 066 (ranked FTS RPC), 069 (`include_archived` opt-in, #140's
  convention), 071 (overload fix — the signature lesson);
  `packages/mcp-server/src/embeddings.ts` + `embeddings/backfill.ts`
  (embed-on-write + backfill, #427 / PR #515);
  `packages/mcp-server/src/tools/search.ts` (degradation semantics, #136 /
  #486).
- Related: #310 (dedup sweep — merge writes must re-embed), #140 (lifecycle
  convention).
