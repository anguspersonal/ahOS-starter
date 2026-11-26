# ADR-012: Assemble Around an MCP Tool Layer (Agent Orchestration over a Durable Store)

**Status:** Accepted
**Date:** 2026-05-27
**Accepted-on-dev:** 2026-05-27
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, simplification, agent, mcp, retrieval, worker

## Context

This is a single-user personal knowledge-management tool. Its job, stated plainly
by the owner, is: **"dump things in and ask questions about my knowledge."**

The codebase today is large and the maintenance burden is real:

- **`packages/worker` — ~31.8k LOC, 98 files.** A standalone Node/Express service
  (Docker → Railway) whose core is a fixed **7-step state machine** in
  `src/workflows/orchestrator.ts` (810 lines): `upload → createArtifact → analyze →
  organizeEntities → extractActions → createDerived → finalize`, persisted to
  `workflow_steps` with retry / skip / `awaiting_user` pause+resume logic. This
  hand-built orchestration is the primary source of the reliability problems.
- **`packages/web` — ~37k LOC, 177 files.** A Next.js App Router frontend: 32 pages,
  50 components (PARAMPS nav, tasks, events, inbox, review/notifications, chat).
- **`supabase` — 33 migrations.** The data store and model: `artifacts`, `entities`
  (the PARAMPS taxonomy), `entity_relationships`, `artifact_entity_links`,
  `derived_artifacts`, `user_tasks`, `events`, `system_decisions` (review queue),
  plus workflow/job bookkeeping tables.

### The decisive finding

The **"ask" side does not really exist yet.** Search (`packages/web/utils/knowledge/api.ts`)
is `ILIKE` substring matching only. There are **no embeddings**, **no full-text
(`tsvector`) search**, and the chat feature
(`packages/web/app/api/chat/threads/[id]/messages/route.ts`) sends history to Claude
with **no retrieval against the knowledge store** — `@mentions` are a UI affordance,
not server-side context injection. The single most-wanted capability is the one the
current architecture never built.

### Problem statement

For a one-user tool the only equation that matters is **value ÷ maintenance**. Today
we carry a 70k-LOC, two-service system with a bespoke orchestration engine that
generates bugs — and the headline feature (retrieval/Q&A) is missing. The complexity
is not buying the value.

## Decision

**Assemble the system around an MCP tool layer, with an agent (Claude via the Agent
SDK) as the orchestrator over the existing durable Postgres store. Optimize the whole
design for "dump-and-ask."**

Concretely:

1. **KEEP** the asset: the Supabase store and the PARAMPS / entities / lineage data
   model (tightened, not rebuilt).
2. **WRAP** the store's discrete operations as MCP tools/skills (capture, extract,
   entity CRUD, task/event creation, retrieval, approval). The clean seams already
   exist — the 7 orchestrator steps and the exported functions inside `analyze.ts`,
   `organizeEntities.ts`, `extractActions.ts`, and the read functions in
   `utils/knowledge/api.ts`.
3. **REPLACE** the hand-built 7-step state machine with **agent orchestration**: the
   agent decides which tools to call and in what order; Postgres remains the durable
   substrate for state. Classification (intent/PARAMPS) becomes the agent's own
   reasoning rather than a bespoke pipeline step.
4. **RETIRE** the worker's orchestration engine (`orchestrator.ts`, `resume.ts`,
   `activeWorkflows.ts`, the workflow webhook trigger) and the bookkeeping it requires.
5. **DEFER** the custom frontend. Because the use case is "dump-and-ask," the daily
   interface can be a chat/agent surface (Claude Desktop/web pointed at the MCP server,
   or a thin chat UI). The 32-page PARAMPS browse UI is not the value and need not be
   maintained to ship the core experience. Specific views can be rebuilt later on top
   of the clean tool layer if missed.
6. **INVEST** in the one net-new capability that "ask" actually needs: real retrieval
   (full-text and/or vector search). See `docs/design/mcp-tool-layer.md`.

The detailed tool inventory, seam mapping, and phased plan live in
**`docs/design/mcp-tool-layer.md`**.

## Consequences

### Positive

✅ **Reliability problems are deleted, not debugged** — retiring the orchestrator
removes the code that generates the bugs.
✅ **Far less code to maintain** — a tool server + a schema instead of a bespoke
two-service pipeline. Leverage, not a second job.
✅ **The headline feature finally gets built** — retrieval/RAG is the explicit focus,
directly serving "ask questions about my knowledge."
✅ **No-regret first step** — the tool layer is the engine for "assemble," the
foundation if we ever resume custom building, and a near-total loss-avoider if we
"pause." It serves all futures.
✅ **Incremental and reversible** — the MCP layer can stand up alongside the existing
app; nothing is deleted until the new path feels good.

### Negative

❌ **Loss of the bespoke browse UX** (PARAMPS nav, tasks/events pages, review drawer)
as a daily interface, unless/until selectively rebuilt.
❌ **Retrieval is net-new work**, not a wrap of existing behavior — it carries a real
(small) cost decision (FTS vs. embeddings; see open decision below).
❌ **Migration effort** — operations must be re-exposed as tools and the agent loop
stood up.

### Neutral

- The data model and the user's data are preserved; this is an orchestration and
  interface change, not a data rebuild.
- ADR-001 already set precedent for removing complexity that doesn't earn its keep for
  a single-user tool; this continues that direction.
- The worker code is not deleted by this ADR — it is superseded incrementally as tools
  replace each step.

## Implementation Plan

Detailed in `docs/design/mcp-tool-layer.md`. Summary:

- **Phase 0 (empirical):** stand up a minimal MCP server over the existing store and
  use it from Claude for ~2 weeks alongside the old app. Let lived experience confirm
  the altitude before deleting anything.
- **Phase 1 (dump-and-ask MVP):** the capture tool (`upload` + `createArtifact`),
  `extract_text`, and **real `search_knowledge`** (the net-new investment).
- **Phase 2 (enrichment as tools):** entity find/create/link, `create_task`,
  `create_event` — wrapping existing worker functions, now agent-orchestrated.
- **Phase 3 (retire):** decommission the orchestrator state machine and its webhook
  trigger once the agent path covers the flow.
- **Phase 4 (interface):** decide whether the chat/agent surface is sufficient or a few
  thin views get rebuilt on the tool layer.

## Alternatives Considered

### Alternative 1: Pause (use off-the-shelf — Claude Projects, Notion)
- **Pros:** zero maintenance.
- **Cons:** loses the custom data model and automated capture→enrichment; the honest
  test was "would I miss it in two weeks?" — the owner expects to. Rejected, but the
  Phase 0 trial de-risks this by testing it empirically.

### Alternative 2: Keep building the custom app
- **Pros:** preserves the bespoke browse UX.
- **Cons:** highest maintenance, lowest value/maintenance ratio for one user; does not
  by itself fix the missing retrieval. Rejected as the default; specific views may be
  rebuilt later on the tool layer.

### Alternative 3: Assemble (chosen)
- **Pros:** keeps the asset, deletes the liability, builds the missing feature, and is
  reversible/incremental.
- **Cons:** loses the custom UI as a daily surface; retrieval is net-new.

## Notes

- The "which interface do I want to live in?" test resolved to *"I mostly want to dump
  things in and ask questions"* — which is what tips the frontend from "keep" to
  "defer."
- The 7 orchestrator steps map almost 1:1 to tool candidates, so wrapping is low-risk
  mechanical work, not redesign.
- Classification/PARAMPS assignment shifts from a pipeline step to agent reasoning,
  which removes the `analyze.ts` intent-taxonomy machinery over time.
- The general rule behind this decision is recorded in
  `docs/design/design-principles.md`: **build your opinions, rent your mechanics** — the
  only novel parts are the data model and the workflow *steps* (your judgment); the
  orchestrator, host, storage, and model are all commodity to be rented.
- The Phase 0 agent host is **Claude Desktop**. A standalone Agent SDK host is a
  deferred enhancement for *automation* only, added once the manual process is proven —
  see `docs/design/mcp-tool-layer.md` → Future enhancements.

## References

- Design principles (build-vs-rent test): `docs/design/design-principles.md`
- Tool-layer scope & seam mapping: `docs/design/mcp-tool-layer.md`
- Worker orchestrator: `packages/worker/src/workflows/orchestrator.ts`
- Worker steps: `packages/worker/src/workflows/steps/*.ts`
- Read/query layer: `packages/web/utils/knowledge/api.ts`
- Chat (no-RAG gap): `packages/web/app/api/chat/threads/[id]/messages/route.ts`
- Schema: `supabase/migrations/`, `supabase/DATABASE_SCHEMA_SUMMARY.md`
- Prior simplification precedent: `docs/ADRs/ADR001_Simplifying_Backend.md`
