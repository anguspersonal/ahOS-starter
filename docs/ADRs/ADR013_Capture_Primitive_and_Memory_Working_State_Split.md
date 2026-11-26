# ADR-013: Capture Primitive + Memory vs Working-State Split (Supabase = knowledge, Notion = tasks/state)

**Status:** Accepted · Superseded in part by [ADR-050](./ADR050_One_Ritual_Per_Name_And_Synthesis_Marker_Vocabulary.md) (§7's consumption marker is renamed `consumed_by_state` → `synthesized`, and gains a sibling `synthesized_unattended`)
**Date:** 2026-06-06
**Accepted-on-dev:** 2026-06-06
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, capture, tasks, notion, integrations, simplification
**Builds on:** ADR-012 (Assemble around an MCP tool layer)

## Context

Two "capture" lineages exist and were starting to entangle:

1. **ahkms (this repo / ADR-012):** an *all-knowledge* store on Supabase. The durable
   unit is an `artifact`; the goal is **dump-and-ask** retrieval. Tasks/events tables
   (`user_tasks`, `events`) exist, but ADR-012 **defers/retires the web UI** that made
   them usable day-to-day.
2. **dotclaude `capture` skill (`anguspersonal/dotclaude`):** focused on capturing
   **agent conversations → Notion**, and a SOD/EOD skill that maintains a **living
   "state document"** for **project + task state tracking**. The unit of value is the
   conversation and the state doc; the backend is **Notion ("Work")**; the scope is
   projects/tasks/state, not all knowledge.

These differ on backend (Supabase vs Notion), unit (artifact vs conversation/state-doc),
and purpose (memory/retrieval vs PM/state-tracking). PR #17 wired a `create_task` tool
to **Notion**, which silently diverged from `docs/design/mcp-tool-layer.md` (line 55:
`create_task → user_tasks` in Supabase). That divergence — *where do tasks and state
actually live?* — was never an explicit decision. This ADR makes it one.

The governing constraint remains ADR-001/ADR-012's: for a single-user tool the only
equation that matters is **value ÷ maintenance**.

## Decision

### 1. A single capture primitive over Supabase artifacts

`capture` is one uniform, "dumb" write to the `artifacts` table, regardless of source.
Notes, links, files, **meeting transcripts, and agent conversations are all artifacts.**
Their kind is metadata (`content_subtype = 'transcript' | 'conversation' | 'note' | …`,
migration 036), not a separate pipeline. This gives every captured thing search,
lineage, and entity-linking for free, and keeps one front door.

Capture does **not** bake in enrichment. Deriving tasks/entities/summaries is a
separate, explicit step (see §3).

### 2. Memory vs working-state split (this is the core of the ADR)

- **Supabase / ahkms = memory** — *"what do I know?"* Artifacts, entities, lineage,
  retrieval (dump-and-ask). System of record for **knowledge**.
- **Notion / Work = working state** — *"what am I doing / what's the state?"* Tasks
  and the SOD/EOD state document. System of record for **tasks and project-state**.

Rationale for putting tasks/state in Notion rather than Supabase (Option B below):
the maintainer already works in Work daily, ADR-012 retires the Supabase task UI, and
a single-user calculus favours "use the surface that already exists" over "build/maintain
a second one." Knowledge retrieval is the net-new value ahkms adds; task UI is not.

### 3. Enrichment routes each derivation to the right store

After capture, an enrichment step (agent reasoning, per ADR-012) routes derivations:

- **knowledge** (entities, links, summaries) → Supabase.
- **actions / tasks** → Notion (the `create_task` integration from #17).
- **project-state** → the SOD/EOD **state document**, maintained as a derived artifact
  that reads from *both* stores (recent Supabase artifacts + Notion task state) and is
  written/kept in Notion for human browsing.

### 4. Programmatic vs agent capture: same primitive, different orchestration owner

`source_channel` records *how* an artifact arrived and decides who owns enrichment:

- **Agent-tool capture** (`source_channel='agent'`): the agent is in-loop, so it
  captures and **chains enrichment inline** (extract tasks → Notion, update state).
- **Programmatic capture** (`source_channel='programmatic'`, e.g. a meeting-bot
  transcript or a folder drop): no agent in-loop. Capture writes the artifact with
  `processing_status='pending'`; enrichment is **deferred** to a later agent pass (or
  deterministic rules). The capture path is identical — only the timing/owner differs.

### 5. Cross-store lineage link

Because truth is split, the artifact→task lineage is a stored reference, not a join:
the Notion page id is recorded on the originating artifact (and the artifact id on the
Notion page). This keeps *"what tasks came out of that meeting?"* answerable from the
memory side **without** making Notion the retrieval engine. Concretely: an
`external_ref` on `artifacts` (or a small `artifact_external_links` table) holding
`{ provider:'notion', kind:'task'|'state_doc', external_id }`.

### 6. Per-user wiring stays persisted, not hard-coded

Consistent with this session's earlier work: the Notion database ids live in
`user_integrations` (migration 046), the token in env (`NOTION_API_KEY`), and the
behaviour in shareable skills. No ids/secrets in the repo.

### 7. State-doc consumption: store "consumed" only, derive the rest

The SOD/EOD state document is a projection that folds artifacts in on a cadence, so the
generator must know which artifacts it has already absorbed — otherwise it re-ingests
everything or relies on a fuzzy "recent" window that misses backdated/out-of-order
captures and is not safe to re-run.

An artifact has three *conceptual* states with respect to the state doc — **n/a** (out
of scope), **pending** (in scope, not yet folded in), **consumed** (folded in). We
**store only the positive fact (`consumed`)** and **derive `pending`/`n/a`**:

- **Store:** consumption is recorded as a lineage link (§5 mechanism) with
  `kind='consumed_by_state'`, linking the artifact to the state-doc derived artifact.
  This is idempotent, survives out-of-order/backdated captures, makes EOD/SOD safely
  re-runnable, and doubles as provenance ("which artifacts informed today's state?").
- **Derive:** `pending` = matches the state-doc **scope predicate** AND has no
  `consumed_by_state` link; `n/a` = does not match the scope predicate. The scope
  predicate (e.g. transcript/conversation `content_subtype`, or linked-to-project, or
  spawned-a-task) is the single source of truth for relevance and is therefore always
  current. The EOD/SOD skill may still *present* all three buckets as a derived view so
  its "to fold in" inbox stays clean.

**Why not a stored `consumption_state` enum that includes `n/a`:** applicability is a
function of facts that change after capture (a note gets linked to a project later). An
eagerly-stamped `n/a` would go stale and commit us to re-evaluating/rewriting it on every
relevant change — precisely the drift-prone bookkeeping ADR-012/013 exist to avoid. It
also overloads concepts that are **orthogonal**: `processing_status`/`lifecycle_stage`
track *enrichment* (extracted/classified), not *incorporation into working-state*.

**Exception (cache, not truth):** if deciding scope ever becomes expensive (e.g. an LLM
judgement we don't want to re-run each pass), the scope result may be cached on the
artifact — but explicitly as an **invalidatable cache** (recomputed when entity links /
subtype / task-links change), never as the primary value. Given the scope predicate is
expected to be cheap structural facts, we do **not** add this cache now.

## Consequences

### Positive
- ✅ One capture path; transcripts and conversations become first-class memory with no
  new machinery.
- ✅ Tasks/state live where the maintainer already works — **no second UI to build or
  maintain**, lowest value÷maintenance cost.
- ✅ Clear seam: ahkms answers "what do I know?", Work answers "what am I doing?".
- ✅ #17 is ratified rather than reverted; it is the "actions → Notion" edge of this model.

### Negative
- ❌ **Truth is split across two stores.** Lineage is a stored link, not a SQL join;
  "all open tasks for project X" is a Notion query, not local SQL.
- ❌ Supabase `user_tasks`/`extractActions` machinery becomes **vestigial for tasks**
  (entities/artifacts unaffected).
- ❌ If retrieval should later "ask" across **tasks** too, Notion's API enters the search
  path. **Escape hatch:** mirror Notion → Supabase *read-only* for search at that point,
  without making Notion edits non-authoritative. Logged, not solved now.

### Neutral
- The split mirrors how the maintainer already thinks about the two systems; this ADR
  records reality more than it changes it.

## Alternatives Considered

- **A. Supabase SoR, Notion one-way mirror.** Single truth, tasks beside their source
  knowledge — but ADR-012 retires the Supabase task UI, so a mirror is needed anyway, and
  one-way push is backwards (tasks get completed in Notion, leaving Supabase stale).
  Rejected for added maintenance with no daily-use benefit.
- **C. Supabase SoR + two-way sync.** Most capable, but a sync engine (conflict
  resolution, reconciliation, sync-state) is exactly the bespoke, bug-generating
  machinery ADR-012 exists to delete. **Deferred as an optional future enhancement**
  (see below), not adopted now.
- **Fold everything into Notion (drop Supabase).** Loses the knowledge model, retrieval,
  and PARAMPS — the actual net-new value. Rejected.

## Future enhancements (not now)

- **Two-way task sync (Option C) — deferred, optional.** When moving/reconciling tasks
  across stores becomes worth it, add a push/two-way sync on top of B. Because B already
  records the cross-store lineage link (§5), this is an additive capability, not a redo:
  the link table becomes the sync anchor. Flip it on only when the value clears the
  maintenance cost.
- **Task-aware retrieval** — read-only mirror of Notion tasks into Supabase so
  `search_knowledge` can answer over tasks as well as knowledge (the escape hatch above).
- **Deferred programmatic enrichment pass** — the always-on agent host from ADR-012's
  future-enhancements section is what runs enrichment for `processing_status='pending'`
  programmatic captures.

## References
- ADR-012: `docs/ADRs/ADR012_Assemble_MCP_Tool_Layer.md`
- Tool layer scope (the `create_task → user_tasks` line this ADR supersedes):
  `docs/design/mcp-tool-layer.md`
- Per-user integration wiring: `supabase/migrations/20260606130000_046_add_user_integrations.sql`,
  `packages/mcp-server/src/integrations.ts`, `.claude/skills/create-task/`
- Capture primitive: `packages/mcp-server/src/tools/capture.ts`; `content_subtype`
  migration `supabase/migrations/20260122103001_036_add_content_subtype.sql`
