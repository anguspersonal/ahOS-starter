# ADR-016: Discover & Index as a First-Class Capability (Additive, Not a Re-architecture)

**Status:** Accepted
**Date:** 2026-06-08
**Accepted-on-dev:** 2026-06-08
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, knowledge-management, discovery, indexing, enrichment, capability-axes, additive

> **Branch note.** ADR-013, ADR-014, and `docs/architecture/capability-axes.md` currently live on
> the unmerged `docs/knowledge-capability-architecture` branch, not on `Dev`. This ADR is written
> to be **self-contained** on the `knowledge-graph` branch and carries, in one place, three things
> that should be **back-ported** when the design branches reconcile (see *Back-port delta* at the
> end): (1) the new axis, (2) the two-cadence enrichment model, (3) the ADR-014 reframing.

---

## Update — 2026-07-13 (#53): Slice 3 (scheduling) landed

All three implementation slices of this ADR have now shipped: `discover` (Slice 1),
`enrich_next` (Slice 2, both `docs/design/mcp-tool-layer.md`), and the scheduled
discover→enrich cadence (Slice 3, #53 — `packages/mcp-server/src/schedule/`,
gated behind `KMS_SCHEDULER_ENABLED`). Status moves from Proposed to **Accepted**
on that basis.

One narrowing: Slice 3's discover cadence is **Google-Drive-only** for now — Notion
has no workspace-listing/search capability in the current MCP tool layer
(`packages/mcp-server/src/notion.ts` only exposes a single fixed-database query), so
scheduled Notion discovery is deferred to #339. This is a scope narrowing of the
*scheduling* mechanism, not a reversal of the axis itself — the decision above
(discover & index as a capability, the two-cadence model, the centralise-the-map
reframing) is unchanged and still the reference for future connectors.

---

## Update — 2026-07-26 (#339): Notion discover cadence landed

The narrowing above is resolved: scheduled Notion discovery has shipped
(`packages/mcp-server/src/schedule/notionDiscoverCadence.ts`), listing each
configured Notion workspace (`notion_work`, `notion_personal`) via `/v1/search`
and registering pointers exactly as Slice 3 does for Drive — same `artifacts`
registry-mode model, same discover-cadence tool layer, no new store.

One deviation from the original plan, recorded here because it's an
architecture-adjacent call: rather than a **separate `notion_discover` lock +
interval**, Notion runs under the **existing shared `"discover"` lock/interval**
alongside Drive (`schedule/discoverCadence.ts`, Drive then Notion, sequentially).
A new lock key needs a seeded `scheduler_locks` row and a widened `scheduler_runs`
cadence CHECK constraint (exactly what migration `076` had to do to add the
`dedup` cadence) — reusing `"discover"` needed neither. Single-flight correctness
is preserved (one lock, one winner); per-connector error attribution is preserved
(`gdrive` and `notion` each record their own `scheduler_runs` row via `connector`).
The only cost is the shared lock being held for both connectors' combined
duration rather than Drive's alone — immaterial at current estate size, revisit
if either connector's listing grows large enough to matter against the 30-minute
stale-lock timeout in `schedule/lock.ts`.

---

## The binding constraint (read this first)

**This is an addition to the existing system. It is NOT a re-architecture, and it must not become
one.**

This is recorded as a first-class constraint because the failure mode is *known and recurring*:
"build a personal knowledge index" is an idea the owner has had **more than once**, and the
gravitational pull each time is to **start over** — new store, new schema, new orchestration, new
stack. Almost everyone who thinks about this problem fixates on the *store* ("dump everything into
one place") and ends up rebuilding the substrate. **We have already built the substrate.** The
substrate is not the gap. Restarting it would be the most expensive possible way to make no
progress.

Therefore:

- **What exists stays.** Supabase/Postgres, the `artifacts` + `entities` (PARAMPS) +
  `entity_relationships` model, the Phase-0 MCP tool layer (`capture`, `search_knowledge`,
  `get_artifact`, `extract_text`), FTS (migration 044), the embeddings design
  (`docs/design/embeddings.md`), and the agent-interface-first direction (ADR-012/013) are the
  **foundation we build on**, not things to revisit.
- **We add parts; we do not replace parts.** Everything below attaches to the existing model and
  tool layer. No table is rebuilt. No new orchestration engine is introduced (in particular: **no
  n8n** — that orchestration pattern is not part of the current architecture; agent-driven tool
  composition supersedes it per ADR-012/013).
- **The test for any work under this ADR:** *"Does this add a new capability onto the existing
  substrate, or is it quietly re-deciding something the substrate already decided?"* If the
  latter, stop.

---

## Context

The driving question for this whole project — *"I don't know what I know"* — has a part the
current system does **not** address.

Everything the system does today is **push-capture**: knowledge enters because the user *dumped it
in* (`/capture`, upload, the capture skill). Even the "Knowledge Registry, Not Knowledge Store"
principle (`docs/design/architecture/SYSTEM_PHILOSOPHY.md`) is about holding *pointers* to external
content the user **chose to register**. Nothing in the system proactively goes out and **inventories
the estate** — it does not crawl Notion, Google Drive, Gmail, Slack, GitHub, or Calendar to record
*what exists and where it lives*.

The consequence: the "central brain" only ever contains the **sliver** the user remembered to
capture. For a tool whose entire premise is *"ask questions about my knowledge,"* that is the
difference between asking about *what I filed* and asking about *what I have*.

This ADR was prompted by a "Personal Knowledge Infrastructure" thought-exercise (a generic,
greenfield design). Most of that brief describes things this project **already has or has already
decided better** (registry-not-store; Supabase + pgvector; hybrid FTS+vector retrieval; an agent
access layer; relationships as relational rows, not a triplestore). Re-adopting its greenfield
phasing would be exactly the re-architecture trap above. **Two ideas from it are genuinely new to
this project, and this ADR adopts only those two**, plus the reframing they force on ADR-014.

## Decision

Adopt two additive capabilities and one reframing.

### 1. New capability axis: **Discover & Index**

A capability — distinct from `Capture` — that **proactively inventories the knowledge estate** and
records *what exists and where it lives*, without the user pushing each item in.

- **What it produces:** lightweight **metadata records / pointers** for items discovered in
  external systems (Notion pages, Drive files, Gmail threads, Slack messages, GitHub repos/issues,
  Calendar events) — title, source, external id, location, owner, timestamps, content-hash — and
  keeps that map **incrementally** up to date (new / changed / deleted).
- **What it does NOT do:** it does **not** pull content into the store, and it does **not** enrich.
  It writes pointers. This is deliberately the *cheap, frequent* layer.
- **Where it lands in the model:** it **reuses the existing substrate**. A discovered item is an
  `artifacts` row in **registry/pointer mode** (per the registry-not-store principle), distinguished
  by `source_channel` and a "discovered, not captured, not extracted" lifecycle position. **No new
  store, no parallel schema.** (Open implementation question, deliberately deferred: whether the
  pointer is best modelled as a lifecycle stage on `artifacts` or a thin companion table — to be
  resolved at build time, not here. The *axis* is the decision; the table layout is not.)
- **Connectors already exist as a session reality:** the MCP servers this work would ride on
  (Notion, Google Drive, Gmail, Calendar, Slack, Dex/CRM, GitHub) are already wired. The plumbing
  is present; only the **discovery loop** is missing.
- **Boundary vs Capture:** Capture is *user-initiated acceptance + echo* of one thing. Discover &
  Index is *system-initiated inventory* of many things the user never handed over.

### 2. Two-cadence enrichment model

Separate the **cheap, frequent** layer from the **expensive, selective** layer, explicitly, as an
operating pattern:

| Layer | Cadence | Cost | Does |
|---|---|---|---|
| **Discover / re-index** | Frequent (hourly/daily, incremental) | Cheap | Refresh the metadata map: new / changed / deleted pointers. No content, no LLM. |
| **Enrich** | Slow / selective (e.g. nightly, N items) | Expensive | Extract text, embed, resolve entities, build links — on a *budgeted, prioritised* subset (recently-modified + high-priority + backlog). |

- This is **not** a new engine. It maps onto the **already-anticipated** "always-on agent / Agent
  SDK host triggered by a schedule" noted as the deferred automation path in
  `docs/design/mcp-tool-layer.md`, and onto the unbuilt `Monitor & Trigger` capability. Enrichment
  itself is the **existing** `extract_text` + embeddings + entity-resolution capabilities, just
  invoked on a **budget over a queue** instead of synchronously per capture.
- **Why it matters:** discovery will surface far more than can be enriched eagerly. A selective,
  budgeted enrichment pass is what keeps the cheap layer cheap and lets the graph **become richer
  over time** rather than demanding everything be processed at once.

### 3. Reframing of ADR-014's open question (centralisation)

ADR-014's central open question is: *"Is centralisation actually sacred, or is 'dispersed but it
works' acceptable?"*

**Reframing adopted here:** **Centralise the *map*, disperse the *content*.**

- The non-negotiable is a **single, complete index** of the estate — one place that knows what you
  have and where it is. The **content** can stay where it lives (Drive, Notion, Gmail, …).
- This is not a new principle; it *is* "Knowledge Registry, Not Knowledge Store," now sharpened:
  the registry's value depends on being **complete**, and completeness depends on **Discover &
  Index** — not only on what the user remembered to capture.
- **Implication for ADR-014:** if centralisation is the non-negotiable that justifies the project,
  then **discovery is arguably required to honour it**, not optional. Dispersion of *content* is
  acceptable; dispersion (or incompleteness) of the *index* is the defect the project exists to
  remove. This dissolves the "centralise vs. dispersed-but-works" dilemma into a third answer that
  is consistent with everything already built.

## Consequences

### Positive
- Closes the gap between *"what I filed"* and *"what I have"* without disturbing the substrate.
- Reuses existing connectors, existing store, existing enrichment capabilities — **maximum reuse,
  minimum new surface.**
- Gives the unbuilt `Monitor & Trigger` axis a concrete first job (the discovery/re-index loop).
- Provides a principled, recorded answer to ADR-014's centralisation question.

### Negative / risks
- **Volume.** Discovery can surface thousands of items; the metadata map and the FTS/embedding
  index must tolerate registry-mode rows that may never be enriched. (Mitigated by the two-cadence
  budget; embeddings are gated on extraction already — see `docs/design/embeddings.md`.)
- **Connector auth & privacy.** Crawling private systems raises the same "private-but-portable"
  concerns already tracked in `docs/design/skills-portability-and-private-data.md`. Discovery must
  respect that constraint, not bypass it.
- **Scope creep into re-architecture.** The single largest risk is this ADR being used to justify
  rebuilding the store. The *binding constraint* section exists to prevent exactly that.

### Neutral
- Data model and stack are **unchanged**; this is additive capability, consistent with ADR-012/013
  (substrate + tools + agent) and the registry-not-store principle.

## Explicitly out of scope (the re-architecture trap)

- ❌ A new knowledge store, a new schema "designed properly this time," or a triplestore/RDF layer.
- ❌ Re-introducing n8n or any standalone orchestration engine (superseded by agent-driven tool
  composition in ADR-012/013).
- ❌ Switching the reasoning/extraction provider (Claude stays; OpenAI remains embeddings-only by
  prior decision).
- ❌ Eager, process-everything enrichment of the whole estate.

## Back-port delta (apply when the design branches reconcile)

When `docs/knowledge-capability-architecture` merges (carrying ADR-014 and
`docs/architecture/capability-axes.md`), fold the following in rather than leaving them only here:

1. **`docs/architecture/capability-axes.md`** — add **Discover & Index** to the capability set as a
   sibling of `Capture`, with the boundary stated above (system-initiated inventory of many vs.
   user-initiated acceptance of one). In the dominance table, mark its target owner as **Repo /
   future host over repo** (it is a substrate-side, scheduled capability — every unbuilt capability
   has landed on the repo side, and this is consistent). Note the two-cadence split: *re-index*
   sits with `Monitor & Trigger`; *enrich* is the existing `Enrich` capability invoked on a budget.

2. **`docs/architecture/historical/ADR-draft-reconciling-repo-and-skills.md`** — under the centralisation open question,
   record the resolution: *centralise the map, disperse the content; completeness of the index is
   the non-negotiable, and Discover & Index is what delivers it.* This strengthens (does not change)
   the existing "repo = substrate / skills = operating layer" leaning.

3. **No code or schema changes are implied by this ADR.** Build-time decisions (pointer table vs.
   lifecycle stage; per-connector discovery cadence; enrichment budget/priority policy) are
   deliberately deferred to their own design docs.

## References

- ADR-012 (assemble around tool layer): `docs/ADRs/ADR012_Assemble_MCP_Tool_Layer.md`
- ADR-013 (agent-interface-first pivot): `docs/architecture/historical/ADR-draft-pivot-from-web-ui-first.md` *(historical draft)*
- ADR-014 (repo vs. skills reconciliation): `docs/architecture/historical/ADR-draft-reconciling-repo-and-skills.md` *(historical draft)*
- Capability taxonomy: `docs/architecture/capability-axes.md` *(WIP branch)*
- Registry-not-store principle: `docs/design/architecture/SYSTEM_PHILOSOPHY.md`
- MCP tool layer scope: `docs/design/mcp-tool-layer.md`
- Embeddings & hybrid retrieval: `docs/design/embeddings.md` *(WIP branch)*
- Private-but-portable access: `docs/design/skills-portability-and-private-data.md` *(WIP branch)*
