# ADR-019: Capability Hosting, Authenticated Serving, and the Binding Layer

**Status:** Accepted
**Date:** 2026-06-15
**Accepted-on-dev:** 2026-06-15
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, knowledge-management, skills, capabilities, auth, portability, bindings, additive

> **Terminology note.** "Capability" in this ADR means an **invocable operating-layer
> artifact** — a skill, agent, command, or prompt that gets run. This is *not* the
> "capability **axis**" sense of [`capability-axes.md`](../architecture/capability-axes.md)
> (Capture, Store, Retrieve, …), which are functional dimensions. Where ambiguity matters
> below, this sense is called a **capability artifact**.

> **Numbering note** (cf. ADR-016's branch note). Numbers 013–015 are double-booked across
> the live index and the unmerged `docs/knowledge-capability-architecture` branch
> (`ADR013_Pivot…`, `ADR014_Reconciling…`, and capability-axes.md's intended `015 = Capability
> Taxonomy`). **018 is reserved for a forthcoming ADR**; this one takes **019**. It does not
> attempt to resolve the 013–015 collision — that is a branch-reconciliation task.

---

## Additive, not a re-architecture (read this first)

Per ADR-016's binding constraint: **this adds a capability-hosting + serving + binding layer
*onto* the existing substrate. It rebuilds nothing.** It attaches to what already exists —
`entities` (PARAMPS), `user_integrations`, `artifacts`, and the Phase-0 MCP tool layer. No
store is replaced; no schema is "redesigned properly this time." The test for any work under
this ADR is the same as ADR-016's: *does it add a capability onto the substrate, or quietly
re-decide something the substrate already decided?* If the latter, stop.

## Context and problem

The system already is, by stated philosophy, a **registry of where knowledge lives and how to
access it** ("Knowledge Registry, Not Knowledge Store"; ADR-016). It holds the *knowledge*
side of that map. It does **not** yet model the **capability** side — the skills/agents that
are *how you act* — even though "how to act" is the same shape as "how to access."

Today capabilities live in **`dotclaude`**, split awkwardly to manage privacy
(`docs/design/skills-portability-and-private-data.md`):

- `dotclaude/skills` is **public** so skills can be web-fetched into any environment (Claude
  Code, Cowork, Chat, Cursor, mobile).
- `dotclaude/cowork-skills` is **local-only** because it carries private data — Notion DB IDs,
  user IDs, routing tables, Dex/CRM refs, the Work/personal destination maps.

This crude split has a cost the open-problem doc already named: it **blocks cross-environment
reuse for exactly the highest-value skills** (`capture`, `dos-hl`), and it imposes a standing
**de-privatization tax** — every skill that touches private data must be scrubbed or withheld.
Meanwhile ADR-014's reconciliation left two items open: the **composing surface** and the
**per-capability home**; and the capability-axes dominance pass concluded the repo's
distinctive role is *"the auth'd private backend that anonymous skill-logic calls into."*

This ADR resolves that cluster.

## Decision drivers

- **End the de-privatization treadmill.** Stop maintaining a public, cowork-excluded split and
  scrubbing private refs out of shareable logic.
- **Enable cross-environment reuse of the most-used skills** (`capture`, `dos-hl`) — the thing
  the current split blocks.
- **One source of truth for reference values** (DRY): a Notion DB ID referenced by many skills
  is defined once, not copied into each.
- **Context-scoped resolution** (personal vs Work): the integration list pairs
  personal/Work at every turn (notion, gmail, drive), so one skill body should serve both
  identities without duplication.
- **Keep secrets where they belong** — non-secret IDs in the DB, tokens in env (the existing
  `user_integrations` rule).
- **Do not rebuild the substrate** (ADR-016 constraint); **do not fight Claude's cowork sync.**

## Considered options

### Option A — Status quo: public `dotclaude/skills` + local-only `cowork-skills`

- **Pros:** zero build; works today.
- **Cons:** permanent de-privatization tax; blocks reuse of the highest-value skills; private
  *data* never reachable cross-environment; two homes; no register of "all my capabilities."

### Option B — Make everything public; scrub all private refs out of every skill

- **Pros:** simple distribution (web-fetch everything).
- **Cons:** the scrubbing tax becomes permanent and total; leak risk; and it **doesn't solve
  the real problem** — skills still can't reach private *data* across environments.

### Option C — Separate private-config service the public skills call (auth proxy over config only)

- **Pros:** minimal change to where skills are homed.
- **Cons:** the repo *already is* the private backend; a separate config service duplicates it.
  Leaves two systems and misses the "single home / one register" goal.

### Option D (chosen) — The kms as the authenticated private home + serving layer for capabilities, with a binding layer for private config

- **Pros:** ends the treadmill; one source of truth for reference values; context-scoped
  (personal/Work) from one skill body; **additive** (rides the existing substrate); realizes
  the capability-axes conclusion (repo = auth'd private backend). Replaces "public repo
  web-fetch" with "authenticated serve from any environment."
- **Cons:** requires an **auth/HTTP surface** on the MCP server (stdio-only today); a migration
  of owned skills into the kms; and a new bindings concept to build and keep correct.

## Decision

Adopt **Option D**. Concretely, four additive parts:

1. **Capabilities are first-class registry nodes.** Model each capability artifact
   (skill / agent / command) with *where it lives*, *how to invoke it*, and typed metadata —
   `kind` (skill | agent | command), `surface` (claude-code | cowork | api), `domain`, `scope`.
   This dissolves the current agents/skills/coding-skills overlap into **tagging**, not folder
   surgery.
2. **Registry, not store — applied to capabilities.** The kms **hosts the bytes** for the
   skills it *owns* (the non-cowork skills migrating off public `dotclaude`), and **indexes /
   points to** skills it does not host (the Claude-synced **cowork** set — *index, don't
   absorb*). The map is complete; the bytes need not all live here.
3. **Authenticated serving API.** Give the MCP server (`ahkms`, stdio-only today) an
   **authenticated surface** that lets any environment **fetch / call / install** capabilities.
   This **replaces** the public-repo web-fetch mechanism; the private backend serves the
   anonymous logic over auth.
4. **Binding layer = a modularity split, not a privacy split.** A skill references a resource by
   **name** (`{{notion.inbox_db}}`); the concrete value is defined once and **resolved at serve
   time** by `(scope, name)`. Resolution is **context-scoped** (personal | work) so one skill
   body serves both identities.
   - A **binding is a named pointer into the registry**, not a copy of the value — it points at
     an existing `user_integrations` config value or an `entities` property. One source of truth
     is preserved.
   - Bindings live in a **dedicated table** (config/plumbing), *outside* the knowledge graph, so
     graph reads don't surface wiring.
   - **Secrets never resolve through a binding.** A `{{…}}` ref expands only to an identifier /
     path / handle; tokens stay in env and the serving runtime holds credentials. (Distinct from
     the `secure` PARAMPS type, which is sensitive *knowledge*, not auth material.)
   - **Resolution timing:** **bake-at-serve** for v1 (the API substitutes values and returns a
     concrete skill for the scope); **late-bind** later, once `ahkms` is itself the executor. A
     missing binding **fails loud** (returns the manifest of required bindings) — never
     silent-empty substitution.

## Consequences

- **Good:** closes `skills-portability-and-private-data.md` and ADR-014's two open items;
  highest-value skills become reusable across environments without leaking private data; one
  register of every capability; reference values defined once and scoped per identity; entirely
  additive over the existing substrate.
- **Cost / bad:** an auth/HTTP surface must be built on a stdio-only server; owned skills must be
  migrated off public `dotclaude`; the binding layer is new machinery to build and validate.
  Until the serving API + binding resolution exist, **skills are not physically migrated** — the
  public `dotclaude` web-fetch stays the interim mechanism (no premature relocation of the
  de-privatization pain).
- **Follow-up (→ GitHub Issues, per the planning rule):**
  1. Authenticated serving API on `ahkms` (fetch / call / install from any environment).
  2. `capability` node type + capability registry (kind/surface/domain/scope; host-vs-index).
  3. `bindings` table + scoped `(scope, name)` resolution; bake-at-serve; secrets-stay-in-env
     invariant; fail-loud on missing. **Landed (#62, migration 074):** `entity_type='domain'`
     scope axis (work/personal), `user_integrations.domain_entity_id`, the `bindings` table,
     the `resolve_capability` bake-at-serve tool + `create/list/update/delete_binding` CRUD. The
     secrets invariant is *structural* — `integration_config` bindings read only
     `user_integrations.config` by `json_path`, so `credential_ref`/tokens are unreachable by
     construction, not by a runtime blocklist.
  4. Rationalise cowork-skills vs claude-code skills (and the agents / skills /
     coding-skills-in-cowork taxonomy overlap).
- **Doc hygiene:** on acceptance, mark `skills-portability-and-private-data.md` **Resolved by
  ADR-019**, and record in ADR-014 that the composing-surface + per-home items are resolved here.
  (Those files are left unedited by this draft.)

## Links

- Resolves: [`docs/design/skills-portability-and-private-data.md`](../design/skills-portability-and-private-data.md)
- Resolves (open items): [ADR-014](../architecture/historical/ADR-draft-reconciling-repo-and-skills.md) *(WIP branch)*
- Builds on: [ADR-016](./ADR016_Discover_And_Index_Axis.md) (centralise the map),
  [ADR-012](./ADR012_Assemble_MCP_Tool_Layer.md) (tool layer),
  [ADR-013](../architecture/historical/ADR-draft-pivot-from-web-ui-first.md) (agent-interface-first) *(WIP branch)*
- Taxonomy: [`docs/architecture/capability-axes.md`](../architecture/capability-axes.md)
  (dominance pass: repo = auth'd private backend)
- Registry-not-store principle: [`docs/design/architecture/SYSTEM_PHILOSOPHY.md`](../design/architecture/SYSTEM_PHILOSOPHY.md)
