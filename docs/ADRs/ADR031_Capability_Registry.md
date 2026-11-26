# ADR-031: Capability registry — capabilities are entities, hosted-or-indexed with a backup snapshot

- **Status:** Accepted
- **Date:** 2026-06-21
- **Accepted-on-dev:** 2026-06-21
- **Deciders:** Angus (solo maintainer)
- **Tags:** architecture, knowledge-management, skills, capabilities, registry, additive
- **Builds on:** [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md) (capability hosting), [ADR-006](./ADR006_UUID_Primary_Key_Standardization.md) (UUID PKs), [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md) (config in DB)
- **Amended by:** [ADR-112](./ADR112_Three_Ritual_Verbs_Prep_Sync_Reflect_And_Task_Anchored_Reconciliation.md) (all three canonical ahOS rituals `prep`, `sync`, and `reflect` are repo-authored under `.claude/skills/*` with `origin: kms-repo` and synced one-way to the capability registry; capability lookup strips `ahos/` and `ahkms/` namespace prefixes)

## Context and problem

ADR-019 decided that capabilities (skills / agents / commands) become first-class
registry nodes, and filed the build as a follow-up: *"capability node type +
capability registry (kind/surface/domain/scope; host-vs-index)."* This ADR is that
build-out — it commits the concrete data model and the v1 read/write surface, and
records the one place where it deliberately diverges from ADR-019.

Nothing models "what capabilities do I have, where do they live, and how do I get
the bytes" today. Skills live dispersed across the public `dotclaude` repo, the
local cowork set, and (increasingly) other vendors. There is no single register.

## Decision drivers

- **Additive over the substrate** (ADR-019 / ADR-016): ride `entities` (PARAMPS);
  do not introduce a parallel store or re-decide what the substrate already settled.
- **One register of every capability**, queryable by what it is and where it runs.
- **Don't lose skills to a vendor.** A skill whose canonical home is Claude/OpenAI
  should survive that vendor changing or deleting it.
- **Don't let the kms lie about ownership.** A copy of an externally-owned skill is
  a *snapshot*, never the source of truth (ADR-019's *"index, don't absorb"*).

## Considered options

### Option A — Standalone `user_skills` / `capabilities` table

- **Pros:** typed columns + CHECK constraints; clean read model.
- **Cons:** re-decides storage the substrate already settled — exactly the move
  ADR-019 says to *stop* on. Loses the free RLS/triggers/tags/relationships that
  every other node type gets. Splits skills from agents/commands.

### Option B (chosen) — A capability is an `entities` row, `entity_type='capability'`

- **Pros:** fully additive (ADR-019); inherits UUID PK (ADR-006), `created_at` /
  `updated_at` + trigger, `tags`, `archived`, owner-RLS, and `entity_relationships`
  edges. Surfaced through a `capabilities` view exactly like `people` / `resources`.
  Unifies skill/agent/command under one `kind` field (dissolves the overlap into
  tagging, per ADR-019).
- **Cons:** typed fields live in `properties` JSONB, validated by the MCP tool rather
  than by DB columns; correctness is enforced at the tool layer, not the schema.

## Decision

A capability is a row in `entities` with `entity_type='capability'`.

**Field model** (typed fields in `properties`):

| Field | Home | Values / notes |
|---|---|---|
| name | `entities.title` | unique per user (case-insensitive) |
| description | `entities.description` | |
| created / updated | `entities.created_at` / `updated_at` | trigger-maintained |
| `kind` | `properties.kind` | `skill \| agent \| command` |
| `surface` | `properties.surface` | **array** of `claude-code \| cowork \| chat \| api` |
| `storage_location` | `properties.storage_location` | `kms-db \| kms-repo \| claude \| openai` |
| `storage_url` | `properties.storage_url` | pointer to the canonical home |
| `body` | `properties.body` | the plain-text bytes (see amendment below) |
| `body_synced_at` | `properties.body_synced_at` | when `body` was last refreshed |

`storage_location` doubles as ADR-019's host-vs-index signal: `kms-*` ⇒ hosted, else
indexed. Hosted/indexed is **derived**, not a separate column.

**Deferred (reserved, not built):** ADR-019's `scope` (personal | work) — it is
binding-layer machinery and earns its place only once the serving/binding API exists
(ADR-019 §item 4, *"late-bind later"*). The word `scope` is reserved for that meaning
and must not be reused for subject area. A subject-area axis, if ever needed, uses
`tags`, not a new field. (The user's original "code/non-code" turned out to be
`surface`, not a subject domain.)

**Uniqueness:** a partial unique index enforces one capability per name per user:

```sql
CREATE UNIQUE INDEX capabilities_name_uniq
  ON entities (user_id, lower(title))
  WHERE entity_type = 'capability';
```

`user_id` is inherited and mandatory — capabilities ride the pooled multi-tenant
`entities` table (single-tenant *product*, multi-tenant *schema*), and the roadmap
(authenticated serving, ADR-019 §item 3) leans further into multi-tenancy, not away.

**Read/write surface (v1):** dedicated MCP tools `register_capability` and
`get_capabilities`, which Zod-validate the enums and the conditional rules below and
hide the entity plumbing. The generic `entities_*` tools remain a valid raw path.

**Validation contract** (enforced by `register_capability`):
- `kind`, `storage_location` ∈ their enums; `surface` a non-empty array of enum values.
- `storage_location = 'kms-db'` ⇒ `body` **required** (it is the source of truth),
  `storage_url` absent/null.
- `storage_location ≠ 'kms-db'` ⇒ `storage_url` **required** (the pointer), `body`
  optional (a snapshot).
- `body_synced_at` is set automatically whenever `body` is written.

## Amendment to ADR-019

ADR-019 §item 2 said *"index, don't absorb"* — the kms points to externally-owned
skills and holds **no** bytes for them. This ADR **softens that to "index + optional
backup snapshot"**: an indexed capability may carry a `body` copy, but it is
explicitly a snapshot (`storage_location` + `storage_url` remain the source of truth,
and `body_synced_at` exposes staleness). This buys disaster-recovery against a vendor
losing or changing a skill, without the kms claiming ownership. The anti-pattern
ADR-019 guarded against — the kms silently becoming a stale source of truth — is
prevented by the explicit `storage_location` / `body_synced_at` markers.

## Amendment (2026-09-05): hash derived on read, never stored

`get_capabilities({ name })` prints a freshness header before the body: `body_sha256`,
`body_synced_at` and `updated_at`. `body_sha256` is computed on read from the stored
`body` with the same canonical hash the repo manifest uses
(`packages/mcp-server/src/skill-sync/hash.ts`, byte-identical to
`scripts/check-skill-bodies.js` and to `body_sha256` in `.claude/skill-registry.json`),
so a surface can compare what it is running with what the registry holds. The hash is
never stored, so it cannot drift from the body. `include_body: false` returns the
header alone, a cheap probe for a skill to print an honest version line. No version
field exists and none is added; the git ref is a follow-up.

## Amendment (2026-09-25): schema refinements (twins, runtime surfaces, real scope)

Post-seeding grill (#344, resolved 2026-09-25 with Angus):

1. **`kind` becomes a set (`text[]` / jsonb array):**
   Capabilities that are both a Claude Code skill and an agent (`architect-senior-engineer`, `archiver`, `deep-thinking`, `pragmatist`, `repo-organizer`, `synthesiser`, `ui-ux`) are stored as one honest row with `kind: ['skill', 'agent']` rather than a primary kind plus `also:skill` tag.
   **Anti-drift rule:** a twin has exactly one body shared between its skill and agent personalities.
   Existing `also:skill` and `drift:twin-unsourced` tags are migrated into the column and removed from `tags`.

2. **`surface` becomes runtime (`claude-code | claude-synced | api`):**
   The shipped schema conflated execution runtime with client application. `surface` now represents execution runtime environments (`claude-code`, `claude-synced` [renamed from `cowork`], and `api`).
   An informational `clients` array (`chat, cowork, mobile, cursor, ide, terminal`) is added to record which client interfaces expose or consume the capability.

3. **External repo storage dropped:**
   A proposed `git` / `external-repo` storage location was dropped; dotclaude was deprecated in #566, so `storage_location` enum remains `kms-db | kms-repo | claude | openai`.

4. **`scope` promoted to a real field:**
   Now that bindings exist (`binding_*` tools, ADR-019 §item 4), ADR-031's reserved `scope` is promoted to a real field in `properties` (`global | personal | work | ahLtd`). Existing `scope:{global|personal|work|ahLtd}` tags are migrated into `properties.scope` and removed from `tags`.

5. **Migration & Views:**
   Migration `supabase/migrations/20260925200000_114_capability_registry_refinements.sql` migrates existing rows and replaces the `public.capabilities` view to project `kind` (jsonb array), `surface` (jsonb array), `clients` (jsonb array), and `scope` (text).

## Consequences

- **Good:** one register of every capability; additive (no new store); skills are
  recoverable even when owned by a vendor; unifies skill/agent/command; inherits the
  substrate's RLS/triggers/tags/edges; twins are honest single rows with no body drift.
- **Cost / bad:** typed-field correctness lives in the MCP tool, not in DB columns;
  the dual-role `body` means readers must check `storage_location` before trusting it
  as authoritative.
- **Follow-up (→ GitHub Issues):**
  1. Seed/backfill existing skills (`capture`, `dos-hl`, …) into the registry.
  2. ADR-019 §item 3 authenticated serving API (fetch / call / install) — consumes
     this registry.
  3. ADR-019 §item 4 bindings table + `(scope, name)` resolution — fulfilled (#62 / #1062).

## Links

- Builds on: [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md) (and amends its "index, don't absorb")
- Builds on: [ADR-006](./ADR006_UUID_Primary_Key_Standardization.md), [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md)
- Migrations: `supabase/migrations/20260621160000_056_capability_registry.sql`, `supabase/migrations/20260925200000_114_capability_registry_refinements.sql`
