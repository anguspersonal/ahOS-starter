# ADR-017: Knowledge-Grounded Correspondence as an Isolated Edge over the Knowledge Core

> **Numbering note.** 013–016 are taken (ADR-013 agent-interface-first pivot; ADR-014 repo↔skills
> reconciliation; ADR-016 Discover & Index). This is **ADR-017**. Several of those live on the
> unmerged `docs/knowledge-capability-architecture` branch, so the references below may point at
> files not yet on this branch.

**Status:** Accepted
**Date:** 2026-06-09
**Accepted-on-dev:** 2026-06-09
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, correspondence, connectors, rag, skill, boundary

## Context

The genuinely novel asset in this repo is the **knowledge foundation** — ingestion,
the PARAMPS/entities model, lineage, and (per ADR-012) the MCP retrieval/tool layer
that turns "dump-and-ask" into real RAG. None of that is commodity.

A natural next step makes that asset *useful* rather than merely *novel*: use the
knowledge, via RAG, to **manage correspondence** — drafting and sending posts and
messages across channels (Gmail, LinkedIn post, X post, Instagram post/DM, WhatsApp),
grounded in what the graph knows about the contact, the history, and the user's own
projects. Connector feasibility and cost are researched in
`docs/research/social-connectors-feasibility.md` (summary: every target action except
LinkedIn DM is reachable for ~$0–5/month via a rented aggregator such as Composio; LinkedIn
DM has no compliant cheap path and is excluded).

### The tension

- **Pro:** the novel ingestion/knowledge logic is centralized and gets *extended* across
  many connectors — one knowledge core, many channels. This is leverage.
- **Con:** a posting/messaging "content pipeline" is a crowded, commodity market. Bolting
  one onto a clean knowledge system risks **muddling the novel core with red-ocean
  plumbing** — diluting the asset and the team's focus.

### The decisive reframe

The con is a **coupling and positioning** problem, not a **location** problem. The harm
is not "this code lives in the repo"; the harm is "commodity pipeline logic reaches into,
and starts to define, the knowledge core." That specific harm is preventable with one
boundary. This is the same instinct as ADR-012's **"build your opinions, rent your
mechanics"**: the knowledge layer is the opinion; connectors and posting are mechanics to
rent and quarantine.

## Decision

**Add knowledge-grounded correspondence to this repo, but as an isolated `correspondence`
edge that consumes the knowledge core only through the MCP/retrieval contract — never by
reaching into the graph, the store, or the worker internals.**

Concretely:

1. **PROTECT the core.** `packages/shared` (knowledge types/graph), `packages/worker`
   (ingestion/extraction/entity-linking), and `packages/mcp-server` (retrieval/tools per
   ADR-012) stay pure. They gain **no** awareness of channels, connectors, or posting.
2. **EXPOSE a contract.** The MCP tool layer is the seam: "give me grounded context for
   this contact / thread / topic" is a retrieval call. Correspondence is a *client* of
   that contract, exactly as Claude Desktop is in ADR-012.
3. **ISOLATE the edge as a skill over thin send-tools.** Split the edge along its natural
   seam (mirroring ADR-014's "skills = operating layer, repo = substrate they write into"):
   - A correspondence **skill** (operating layer) owns the judgment — when to write, which
     channel, retrieving grounded context, drafting in house style, and requiring human
     preview/approval before anything goes out. Editable opinion, run inside the agent loop
     (ADR-013).
   - A thin substrate of **send-tools** (MCP) — `send_email`, `post_linkedin`,
     `send_whatsapp`, … — owns the irreversible mechanics: typed, idempotent sends,
     credential handling, rate-limiting, and append-only provenance. Headless-callable.

   The skill *composes* the send-tools and the retrieval tools; neither owns the other's
   concerns. Together they hold **no novel knowledge logic** and are **deletable** — if
   removed, the knowledge system still stands on its own.
4. **RENT the mechanics.** Behind the send-tools, connectors are thin adapters over a rented
   aggregator (Composio free tier) — not bespoke per-platform clients, and not a standalone
   orchestration engine (agent-driven tool composition supersedes that, per ADR-012/013/016).
   This absorbs OAuth, API churn (e.g. X's pricing flips), and Meta app-review toil away from
   the core.
5. **POSITION as "knowledge-grounded correspondence," not "content generation."** The
   moat is the graph informing *what* and *how* to reply/post; the connectors are
   interchangeable plumbing. This naming discipline keeps effort on retrieval quality.

### The boundary rule (the load-bearing constraint)

> The correspondence edge (skill + send-tools) may **read** the knowledge core only through
> the MCP/retrieval contract — never by querying the graph directly or embedding entity/graph
> logic. Its only **write** back is append-only provenance (what was sent, when, grounded on
> which artifacts) through a defined tool. **Test:** delete the skill and its send-tools and
> the knowledge system must still build and run unchanged.

This single constraint is what converts the con from "muddle" into "isolated, optional
extension."

## Consequences

### Positive

✅ **Pro captured** — novel ingestion/knowledge logic is centralized and extended across
every connector through one contract.
✅ **Con neutralized** — the commodity pipeline is quarantined behind an interface and
stays deletable; it cannot dilute or redefine the core.
✅ **Consistent with existing direction** — extends ADR-012's tool layer and ADR-013's
agent-interface-first pivot (correspondence is just another MCP client, not a web feature),
and `SYSTEM_PHILOSOPHY.md` ("registry, not store; external systems do their thing, we own
the knowledge graph"). Channels are more external systems. It also *consumes* — rather than
duplicates — the estate map that ADR-016 (Discover & Index) builds.
✅ **Cheap to run** — ~$0–5/month using rented mechanics (see research doc).
✅ **Reversible** — the edge can be removed or spun into a separate repo later with no
core surgery, because the contract already isolates it.

### Negative

❌ **Focus risk** — connector maintenance (OAuth, API/pricing churn, Meta app review ~2–4
weeks) can starve the novel core of attention. Mitigation: keep connectors thin (rent via
Composio), treat them as replaceable.
❌ **Positioning risk** — if marketed as "content generation," the product competes in a
red ocean and the moat is invisible. Mitigation: the naming discipline in decision #5.
❌ **A new surface to maintain**, however thin — RAG-compose prompts and the contract
shape need care.

### Neutral

- **LinkedIn DM is out of scope** for now: no compliant cheap/open-source route
  (unofficial Voyager libs violate ToS and get accounts banned in ~3–7 days). LinkedIn
  stays post-only; DMs are handled manually. Revisit only if an official/affordable path
  appears.
- The data model is unchanged by this ADR; correspondence reads context and writes
  outbound actions, it does not restructure the graph.

## Implementation Plan (sketch)

- **Phase 0:** define the retrieval contract shape for correspondence ("grounded context
  for contact/thread/topic") on top of the ADR-012 MCP layer. No connectors yet.
- **Phase 1:** one channel end-to-end as a vertical slice — **Gmail send** (free, lowest
  friction) — the correspondence skill calling the retrieval contract + a `send_email` tool.
- **Phase 2:** add free/cheap post channels — LinkedIn post, X post (link-free to control
  cost), Instagram post (after Meta app review), WhatsApp reply-in-window — each a new
  send-tool the same skill composes.
- **Phase 3:** enforce the boundary rule in CI (lint/dep-cruiser: the skill and send-tools may
  not import core internals or query the graph; the only store write is the provenance path).

## Alternatives Considered

### Alternative 1: Separate repo / service from day one
- **Pros:** maximal isolation of the commodity pipeline.
- **Cons:** premature for a solo maintainer; loses monorepo ergonomics and shared types;
  the boundary rule already delivers the isolation that matters. Reversible into this later.
- **Rejected for now**, but the contract makes it a no-surgery move if focus demands it.

### Alternative 2: Build correspondence logic directly into the core (no boundary)
- **Pros:** fastest to wire up.
- **Cons:** exactly the con the user named — commodity logic bleeds into and redefines the
  novel asset; not deletable; dilutes positioning. **Rejected.**

### Alternative 3: Don't build it; keep a pure knowledge tool
- **Pros:** zero added surface or focus risk.
- **Cons:** leaves the asset *novel but not useful*; correspondence is the bridge that
  realizes the value. **Rejected**, though the boundary rule keeps this option open (the
  edge is deletable).

## Notes

- General rule reaffirmed (`docs/design/design-principles.md`): **build your opinions, rent
  your mechanics.** Knowledge graph = opinion; connectors/posting = mechanics.
- The litmus test for the whole decision: *can the correspondence edge be deleted with the
  knowledge system unaffected?* If yes, the boundary is honored.
- Housing follows ADR-014's split: the judgment is a **skill** (operating layer); the
  irreversible send + credentials + provenance are **substrate send-tools**. The exact tool
  packaging (one module vs. per-channel) is a build-time detail, not an architectural one.

## References

- ADR-012 (assemble around MCP tool layer): `docs/ADRs/ADR012_Assemble_MCP_Tool_Layer.md`
- ADR-013 (agent-interface-first pivot): `docs/architecture/historical/ADR-draft-pivot-from-web-ui-first.md` *(WIP branch)*
- ADR-014 (repo ↔ skills reconciliation): `docs/architecture/historical/ADR-draft-reconciling-repo-and-skills.md` *(WIP branch)*
- ADR-016 (Discover & Index axis): `docs/ADRs/ADR016_Discover_And_Index_Axis.md`
- Tool-layer scope & seams: `docs/design/mcp-tool-layer.md`
- Design principles (build-vs-rent): `docs/design/design-principles.md`
- System philosophy (registry, not store): `docs/design/architecture/SYSTEM_PHILOSOPHY.md`
- Connector feasibility & cost research: `docs/research/social-connectors-feasibility.md`
