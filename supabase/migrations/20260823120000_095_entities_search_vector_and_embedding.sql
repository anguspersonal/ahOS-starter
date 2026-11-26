-- Migration 095: FTS + embedding columns on entities (ADR-047 slice 1) (#550)
-- Issue: #550 (slice 1 of 4) — blocks #551 (embed-on-write) and #552 (hybrid RPCs)
-- Refs:  #137 (the "Sam" repro this chain closes), ADR-047 §1,
--        migrations 044 (artifacts FTS) / 051 (artifacts embedding) — the pattern
--        mirrored here, migration 077 (the current public.people view), #800 (why
--        this file makes no atomicity claim)
-- Date:  2026-08-23
--
-- WHAT THIS FILE DOES
-- Adds to public.entities, mirroring the proven artifacts stack:
--   * search_vector — generated always, stored, tsvector, GIN-indexed (as 044)
--   * embedding    — vector(1536), nullable, HNSW cosine-indexed (as 051)
-- No RPCs and no code changes. Both columns are inert until slice 2 (#551,
-- embed-on-write) and slice 3 (#552, hybrid_search_entities / _people) read them.
-- Nullable `embedding` is load-bearing, not laziness: a row without one still
-- participates in FTS, and `embedding IS NULL` IS the backfill work queue — the same
-- contract artifacts have had since #427 / PR #515.
--
--
-- WHY ONLY `entities`, WHEN #550 SAYS "BOTH entities AND people"
-- Because public.people is NOT A TABLE. It is a view over
-- `entities WHERE entity_type = 'people'`, defined in migration 011, redefined in
-- 027 and last in 077. ADR-047 §1 specifies a people column set (name/bio/role/
-- organization/relationship) as though people were its own table; it is not, and the
-- ADR predates nobody checking. There is exactly one physical store behind both
-- surfaces, so one set of columns on `entities` serves both — adding anything to a
-- view is not possible, and a second physical store is not what the ADR wants.
--
-- The view's own field names map straight onto the composition below:
-- people.name IS entities.title, people.bio IS entities.description, and role /
-- organization / relationship are `properties ->> …` extractions the view already
-- performs. So the single tsvector below satisfies BOTH of the ADR's field lists.
--
-- The view is deliberately NOT redefined to expose these columns. It could be
-- (CREATE OR REPLACE VIEW may append), but every `select('*')` against `people`
-- would then drag a 1536-dimension vector per row for no gain: slices 2 and 3 read
-- and write the physical `entities` table, which is where the columns are.
--
--
-- FIELD COMPOSITION, AND THE TWO THINGS DELIBERATELY LEFT OUT
-- Included: title, description, and the three scalar `properties` keys the people
-- view surfaces (role, organization, relationship). Each is immutable-extractable —
-- `->>` is IMMUTABLE, which a generated column requires.
--
-- `entity_type` is excluded. #550's summary line says "kind", but ADR-047 §1 — which
-- that line defers to for composition — lists only title + description + selected
-- scalar properties. Following the ADR: entity_type is already an exact-filterable
-- column served by the structured lookups (entities_query), so folding it into the
-- tsvector would make every "concept"/"people" query match its entire class. Recall
-- noise, no new reach.
--
-- `properties -> 'aliases'` is excluded because it is a jsonb ARRAY (see the merge
-- path in packages/worker/src/workflows/resume.ts, which writes
-- `aliases: Array.from(aliasSet)`), not a scalar. Flattening it to text inside a
-- generated column needs a function call that is not IMMUTABLE-safe here. #550 said
-- "aliases-if-extractable"; they are not, so this is the "if" resolving to no.
--
--
-- NO TRANSACTION CLAIM IS MADE HERE (#800)
-- Sibling migrations state that `supabase db push` runs each file in one
-- transaction. The 093 push disproved the usable form of that claim: its
-- `SET LOCAL lock_timeout` emitted WARNING 25P01 and did nothing. Whether the
-- statements were nonetheless atomic is genuinely unknown (#800), so this file
-- neither asserts atomicity nor adds a bare `SET LOCAL` that would silently no-op.
--
-- This file does not need atomicity. Every statement is `IF NOT EXISTS`-guarded, so
-- a partial application is simply re-runnable — idempotency is the real safety
-- property here, and it does not depend on an unsettled question.
--
-- The precise boundary of that guarantee, since this file leans on it: the guards
-- protect against RE-RUNNING THIS FILE. They do not verify that an existing column
-- of the same name has the definition below — `ADD COLUMN IF NOT EXISTS` accepts a
-- differently-generated `search_vector` silently and reports success. Nothing else
-- creates these columns today, so the case is theoretical; it is written down
-- because "idempotent" is doing load-bearing work in this header and should not be
-- read as "self-verifying". An explicit
-- BEGIN/COMMIT is deliberately NOT used: #800 proposes it as the fix but has not yet
-- run the branch-database experiment that would confirm it composes with the CLI's
-- own history bookkeeping, and a migration is the wrong place to debut an untested
-- pattern.
--
--
-- LOCK AND COST NOTE
-- Adding a STORED generated column rewrites the table and takes ACCESS EXCLUSIVE for
-- the duration. `entities` is a single-user graph table (orders of magnitude smaller
-- than the 153k-row artifacts table of #746), so the rewrite is short — but it is not
-- free, and it is the reason this is its own migration rather than a rider on another.
--
-- Consequence worth knowing: `select('*')` against entities now returns a tsvector
-- and a 1536-float vector per row. Several callers still do that
-- (packages/worker/src/workflows/steps/organizeEntities.ts,
-- packages/worker/src/workflows/resume.ts, packages/web/utils/knowledge/api.ts).
-- None of them write the row back wholesale — verified: every write names its
-- columns, so the generated column breaks no deployed writer — but they will each
-- pull more bytes than they need until they move to explicit column lists, the way
-- ARTIFACT_LIST_COLUMNS already does for artifacts.

alter table public.entities
	add column if not exists search_vector tsvector
	generated always as (
		to_tsvector(
			'english',
			coalesce(title, '') || ' ' ||
			coalesce(description, '') || ' ' ||
			coalesce(properties ->> 'role', '') || ' ' ||
			coalesce(properties ->> 'organization', '') || ' ' ||
			coalesce(properties ->> 'relationship', '')
		)
	) stored;

alter table public.entities
	add column if not exists embedding vector(1536);

create index if not exists entities_search_vector_idx
	on public.entities
	using gin (search_vector);

create index if not exists entities_embedding_idx
	on public.entities
	using hnsw (embedding vector_cosine_ops);

comment on column public.entities.search_vector is
	'ADR-047 §1 / #550: generated FTS vector over title, description and the scalar people-facing properties (role, organization, relationship) the public.people view surfaces. Serves entity AND person search — people is a view over this table, not a table of its own. Mirrors artifacts.search_vector (migration 044).';

comment on column public.entities.embedding is
	'ADR-047 §1 / #550: nullable 1536-d embedding, HNSW cosine-indexed. NULL means "not embedded yet" and is the backfill work queue (same contract as artifacts.embedding, migration 051 / PR #515). Populated by slice 2 (#551).';
