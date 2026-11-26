# ADR-092: Terms are entities, aliases are a column, and the hot tier rides the handshake

- **Status:** Accepted
- **Created:** 2026-09-25
- **Accepted-on-dev:** 2026-09-25
- **Deciders:** Angus (solo maintainer; grilled on #1023, 2026-09-25)
- **Tags:** memory, graph, mcp-server, instructions
- **Builds on:** [ADR-047](./ADR047_Graph_Search_Entities_People_FTS_Embeddings.md) (entity search; why `properties.aliases` could not enter `search_vector`),
  [ADR-030](./ADR030_Skill_Config_In_DB_Not_Reference_Files.md) (config, tone included, lives in the DB)

## Context and problem

A request like "chase logicrays re the IP assignment" or "ask todd to do the PSR for
oracle" carries three kinds of shorthand: a nickname, an acronym, and a codename that
collides with a company name. Without a decode it cannot be acted on. ahOS holds the
answers (the graph has the people, the agency, the contract) but every lookup is an MCP
round trip, and in practice nothing calls `people_match` on four tokens of a one-line
request. Two gaps made it worse: acronyms and internal terms had no home at all, and
aliases existed only as a jsonb array in `properties.aliases`, written by the worker's
merge path and read by no MCP matcher.

Anthropic's `memory-management` skill solves this with two tiers: a small file that is
always loaded (the "hot 30") and a deep store behind it. ahOS already ships one block of
text to every surface on every connection without a tool call: the MCP handshake
`instructions`, which already carry the capability fallback and the owner's tone rules
(#819). That channel is the hot tier's natural home. **The hot tier is a cache for
willingness, not speed**: an agent decodes what is already in front of it.

## Decision drivers

- The decode has to happen without a tool call, on every surface, with no paste.
- Terms need to reach `search_knowledge`, embeddings, provenance links and
  `entity_neighbourhood` like everything else.
- One shape for aliases, readable by the matchers.
- The handshake is paid on every connection, so the tier must be bounded.
- Code ships before the owner pushes migrations; nothing may break in that window.

## Considered options

### Terms: a separate glossary table vs a new entity kind

A glossary table (term, expansion, context) is the plugin's shape, but it would need its
own search, embedding and linking paths. **Chosen: `entity_type = 'term'`**, with
`properties.expansion` and `properties.context`. It inherits everything entities have,
and a term can be related to the project or person it belongs to. It is unrelated to the
ontology grounding rows of migration 081 (ADR-037), which stay `concept` with
`properties.type = 'ahos_concept_term'`.

### Aliases: keep the jsonb array vs a real column

**Chosen: `aliases text[] NOT NULL DEFAULT '{}'` on `entities`**, GIN-indexed and
projected through the `people` view (which is a view over `entities`, so one column
serves both). A backfill (migration 111) copies the jsonb arrays in, as a union.
Readers take the union of both shapes (`packages/mcp-server/src/aliases.ts`) until the
merge writer stops producing the jsonb copy.

### Hot-tier selection: frequency-driven vs hand-curated

An automatic tier that promotes the wrong thirty is worse than no tier. **Chosen:
hand-curated `hot boolean`**, set through `people_update` / `entities_update`.
Promote-on-use and demote-on-stale are deferred until the curated tier has been used for
a few weeks.

## Decision

1. **Schema (migration 110):** `entities.aliases text[]` (GIN), `entities.hot boolean`
   (partial index on the live hot rows), `'term'` added to `entities_entity_type_check`,
   and the `people` view re-projected with both columns appended. Migration 111 copies
   `properties->'aliases'` into the column.
2. **Matchers read aliases:** `people_match` scores an exact alias like an exact name
   (60) and a partial alias just below a partial name (30); `people_query` and
   `entities_query` match on aliases and show them (`aka:`) and the `hot` flag.
3. **Writes:** `people_*` and `entities_*` accept `aliases` (replaces the list,
   normalised: trimmed, deduped case-insensitively) and `hot`. Both are sent only when a
   caller sets them.
4. **The hot tier is a generated section of the handshake instructions**, after the tone
   rules, built by `renderHotTier` in `packages/mcp-server/src/hotTier.ts` and loaded per
   session by `loadHotTier` (as `loadToneRules` is). Two tables, `Name | Aliases |
   Gloss`: people first, then terms and every other hot entity. The gloss says what the
   row *is*: a person's role and organisation, a term's expansion and context, any other
   entity's kind plus its description's first line. That last case is what lets
   "logicrays" land on the agency entity, which is neither a person nor a term. A preamble
   line tells the agent that one `entity_neighbourhood({ title_contains })` call goes a
   hop deeper, which is the acceptance path: hot tier plus one call.
5. **Hard cap of 100 lines** for the whole section, enforced by the builder: when both
   tables overflow they split the budget evenly, a final line says how many rows were
   omitted, and a warning is logged.

### The deploy window

The mcp-server deploys before the owner pushes migrations 110/111. So every read that
names the new columns retries without them on Postgres `42703` / PostgREST `PGRST204`,
`loadHotTier` degrades to no tier on any error (as `loadToneRules` does), and writes only
name the new columns when a caller supplies them. `aliases` and `hot` are deliberately
**not** added to `BaseEntity` / `ENTITY_LIST_COLUMNS` in `@ahkms/shared` yet: the web
and worker read entities through that list, and a column the database lacks would fail
every such read. That step belongs to the follow-up that lands after the migration.

## Consequences

- **Good:** shorthand in a request decodes with no tool call, on every surface. Terms
  have a home that search already reaches. Aliases have one first-class shape, and
  `people_match` finds a person by their nickname.
- **Cost:** every connection pays for the tier; the 100-line cap bounds it. The scheduled
  migration-drift check (Check B, `entities_entity_type_check` vs `GraphEntityType`) will
  report `term` as drift until migration 110 is pushed.
- **Not yet:** the worker's merge path still writes `properties.aliases` (addressed in #1152);
  the tier is surfaced in the health read via `ahos_doctor`'s travels family (#1155);
  frequency-driven promotion (deferred in #1154).
  (Note: `search_knowledge` matching on `aliases` and term expansions was resolved in #1153
  via migration 125's `immutable_array_to_string` immutable wrapper).
- **Relationship to #1025:** this shares the instruction builder, not the delivery.
  #1025 concerns the claude.ai custom-instructions paste, which the handshake cannot
  replace.

## Links

- Issue: [#1023](https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/issues/1023)
- Code: `packages/mcp-server/src/hotTier.ts`, `packages/mcp-server/src/aliases.ts`,
  `buildInstructions` in `packages/mcp-server/src/server.ts`
- Migrations: `supabase/migrations/20260925170000_110_entities_aliases_hot_and_term_type.sql`,
  `supabase/migrations/20260925171000_111_backfill_entities_aliases.sql`
