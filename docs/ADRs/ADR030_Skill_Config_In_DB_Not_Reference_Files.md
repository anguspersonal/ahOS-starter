# ADR-030: Skill configuration belongs in the database, not bundled reference files

**Status:** Accepted
**Date:** 2026-06-21
**Accepted-on-dev:** 2026-06-21
**Deciders:** Angus (solo maintainer)
**Tags:** architecture, skills, configuration, dos
**Builds on:** ADR-013 (capture primitive), ADR-018 (unified capture surface), ADR-019 (capability hosting)

## Context

Skills have been bundled with `references/REFERENCE.md` files that store
per-user, per-workspace configuration: taxonomy values, priority definitions,
tone rules, DB schema property names, and cap limits. The pattern emerged as
a convenience during initial skill development.

ADR-018 explicitly stated the goal: "Shareable skill files. No Notion IDs, no
per-user taxonomies, no workspace gates in the skill text." The Notion IDs
moved to `user_integrations` as planned. The taxonomies, tone, and schema
definitions did not — they ended up in `references/REFERENCE.md`, which is a
thin workaround of the same problem.

Reference files have the same structural weaknesses as baking config into the
skill file:

1. **Static** — updating requires editing a file, syncing dotclaude, and
   restarting Claude Code. There is no runtime path.
2. **Vendor/user-locked** — sharing a skill means sharing your taxonomy. A skill
   with a bundled reference file cannot be adopted without first stripping the
   user-specific content.
3. **Duplicates the DB** — `user_preferences.dos_hl_config` and
   `user_integrations` already exist for exactly this purpose. Having both a DB
   row and a file means two sources of truth that can drift.
4. **Not tool-accessible** — agents cannot read or update a bundled file via MCP.
   The DB is the correct surface for anything an agent needs to inspect or change.

## Decision

**No reference files.** All per-user, per-workspace configuration is stored in
the database and fetched at runtime via MCP tools. Skill files contain only
universal procedure.

### Where each type of content belongs

| Content type | Destination | How fetched |
|---|---|---|
| User-specific config (taxonomy, priorities, tone, cap rules, schema) | `user_preferences` JSONB blob (e.g. `dos_hl_config`) | `get_dos_hl_config` |
| External system IDs (Notion DB ids, data source ids) | `user_integrations` | `get_notion_config` |
| Universal procedure (step ordering, retry logic, Notion API write patterns) | `SKILL.md` | Read at skill load time |
| Validated enums the MCP must enforce | Hardcoded in MCP tool schema | Zod schema in tool file |

### What "universal procedure" means

Content belongs in `SKILL.md` only if it is true for **all** users of the skill
regardless of their workspace, vendor, or preferences. The Notion MCP write
patterns (multi-select as JSON-encoded string array, date as `date:X:start`,
checkbox as `__YES__`/`__NO__`) qualify: they reflect how the claude.ai Notion
MCP works, not anything user-specific. Tone rules, taxonomy values, and cap
numbers do not qualify.

### Consequences for `references/` directories

`references/notion-integration.example.json` may remain as a setup example
document for humans configuring `user_integrations` — it is not read by the
skill at runtime and contains no config that needs to be accurate at execution
time.

`REFERENCE.md` files are deleted. Any content they held is migrated to the DB
(for user-specific config) or to `SKILL.md` (for universal procedure).

## Consequences

### Positive

- Skills are shareable without stripping user-specific content
- Config is updatable at runtime via MCP tools — no file edit, no restart
- Single source of truth: the DB is authoritative; no file/DB drift
- Agents can inspect and modify config via `update_user_preferences` and the
  dedicated config tools

### Negative

- Requires DB migration for each new config field
- Skill setup requires a populated DB row (migration seed handles this; the MCP
  tool falls back to empty defaults)

### Neutral

- This does not change the capture primitive or the synthesis consumer model
- The `references/notion-integration.example.json` setup guide is retained as a
  human-readable example document, not a runtime dependency

## Implementation

First applied to `dos-hl` (migration 055 extends `dos_hl_config` with `types`,
`tone`, `state_doc_rules`, and `daily_log_schema`; `SKILL.md` updated to call
`get_dos_hl_config` instead of reading `REFERENCE.md`; `REFERENCE.md` deleted).
Sibling consumers (`dos-personal`, `dos-infra`) should follow the same pattern
and never introduce reference files.

### Outstanding — not yet migrated

The rollout is phased. As of 2026-07-07 two sibling consumers still bundle and
read `references/REFERENCE.md` at runtime, in known deviation from this
decision:

- **`dos-infra`** — `.claude/skills/dos-infra/SKILL.md` Setup step 1 reads
  `references/REFERENCE.md` (type/domain taxonomies, sink-selection rules,
  output shapes).
- **`dos-personal`** — `.claude/skills/dos-personal/SKILL.md` Setup step 1 and
  Step 4 read `references/REFERENCE.md` (type/domain taxonomies, personal
  log/output template).

They are outstanding because the dos-hl pattern is more than a config
migration: it pairs the `user_preferences.dos_hl_config` JSONB column with a
dedicated MCP tool (`packages/mcp-server/src/tools/getDosHlConfig.ts` plus its
typed loader, registered in `server.ts`). No `get_dos_infra_config` /
`get_dos_personal_config` equivalents exist, and `get_user_preferences` prints
a fixed set of JSONB blobs, so a new config column would be invisible to the
skills without new server code. Migrating these two therefore needs an MCP
server change (new tools + loaders + tests + deploy) alongside the migration,
not a migration alone.

Until that lands, the two `REFERENCE.md` files remain the working config
source for these skills. Do not extend them with new content; new config for
these skills should force the DB migration rather than grow the files.

## Addendum (2026-09-25): #648 tone-layer grill resolution

#648 asked four open questions about whether a durable tone rule is an atom, a
config row, or an entity (and how it stays small, gets consumed, and keeps
provenance). Resolved in an out-of-band grill with Angus, implemented in PR
#1168 / migration 113:

- **Shape: config blob, not atom or entity.** Confirms this ADR's original
  choice — `dos_hl_config.tone` becomes `dos_config.tone` (global, not
  Work-scoped) and gains a hard cap (`MAX_HANDSHAKE_TONE_RULES = 12` in
  `server.ts`) enforced at handshake build time with a `console.warn` if a
  future edit pushes the array past it. That answers #648's "how is it kept
  small" question for this slice: a cap, not decay or a core/extras split.
- **Provenance: SQL-comment-level only, not queryable.** Migration 113's
  header names the six source atom ids inline; there is no `rule → atom`
  column or table. This is a deliberate narrowing, not an oversight — #648
  job 4 (a rule "points back to the atom... so it can be revised") is only
  partially met. A future revision that wants to programmatically find "which
  rule came from atom X" still has to grep migration history.
- **Precedence/conflict (#648 job 3) is explicitly deferred**, not addressed
  by this slice. `tone` (global) and `artefact_registers` (per-audience,
  unchanged) can still contradict each other; nothing here adjudicates.
- **Notion "Personal Style" sync (#648 open question 3) is untouched** — this
  slice does not subsume or mirror it.

This addendum exists because the PR that closed #648 recorded the resolution
only in its own body, which the round-1 QA review on #1168 flagged as an
architecture decision without an ADR home (this repo's own rule: "current
state → `docs/`, _why_ → `docs/ADRs/`"). Full provenance linkage and
precedence rules remain open follow-up work, not committed to a specific PR.

## Links

- Builds on: [ADR-018](./ADR018_Unified_Capture_Surface_Synthesis_Time_Interpretation.md)
- Builds on: [ADR-019](./ADR019_Capability_Hosting_And_Binding_Layer.md)
- Related: [ADR-023](./ADR023_Sibling_Read_Side_Consumers_For_Personal_And_Infra.md) — sibling consumers should follow this pattern
- Addendum trigger: [#648](https://github.com/anguspersonal/ahOS/issues/648) — durable tone layer; resolved via PR #1168 / migration 113
