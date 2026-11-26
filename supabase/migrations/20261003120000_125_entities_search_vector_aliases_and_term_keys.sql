-- Migration 125: entities search_vector includes aliases and term keys (#1153)
-- Issue: #1153
-- ADR: ADR-047 §1, ADR-092
-- Depends on: migration 095 (search_vector on entities), migration 097 (hybrid search RPCs), migration 110 (entities.aliases text[])
-- Date: 2026-10-03
--
-- search_knowledge's entity arm uses entities.search_vector (migration 095),
-- which was generated over title, description, and three scalar properties
-- keys (role, organization, relationship). It did not see:
--   1. entities.aliases text[] (migration 110)
--   2. term properties (properties.expansion, properties.context)
--
-- This migration:
--   1. Introduces public.immutable_array_to_string(text[], text) as an IMMUTABLE
--      wrapper around array_to_string, allowing a stored generated column to
--      flatten the aliases text[] array safely.
--   2. Rebuilds public.entities.search_vector to include:
--      title, description, properties.{role, organization, relationship, expansion, context},
--      and immutable_array_to_string(aliases, ' ').
--   3. Recreates the entities_search_vector_idx GIN index.
--   4. Re-declares the four search RPCs (fts_search_entities, fts_search_people,
--      hybrid_search_entities, hybrid_search_people) with DROP FUNCTION then
--      CREATE, preserving identical caller signatures.

SET statement_timeout = '5min';

-- 1. Immutable array flatten helper for text[] in generated columns
CREATE OR REPLACE FUNCTION public.immutable_array_to_string(arr text[], sep text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(array_to_string(arr, sep), '');
$$;

COMMENT ON FUNCTION public.immutable_array_to_string(text[], text) IS
  'IMMUTABLE wrapper around array_to_string for text[] only, safe for generated always stored columns (#1153).';

-- 2. Drop existing dependent search RPCs explicitly (versioned by DROP+CREATE)
DROP FUNCTION IF EXISTS public.fts_search_entities(text, uuid, int, boolean);
DROP FUNCTION IF EXISTS public.fts_search_people(text, uuid, int, boolean);
DROP FUNCTION IF EXISTS public.hybrid_search_entities(text, vector, uuid, int, float, float, int, boolean);
DROP FUNCTION IF EXISTS public.hybrid_search_people(text, vector, uuid, int, float, float, int, boolean);

-- 3. Rebuild search_vector on public.entities
ALTER TABLE public.entities DROP COLUMN IF EXISTS search_vector;

ALTER TABLE public.entities
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(properties ->> 'role', '') || ' ' ||
      coalesce(properties ->> 'organization', '') || ' ' ||
      coalesce(properties ->> 'relationship', '') || ' ' ||
      coalesce(properties ->> 'expansion', '') || ' ' ||
      coalesce(properties ->> 'context', '') || ' ' ||
      coalesce(public.immutable_array_to_string(aliases, ' '), '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS entities_search_vector_idx
  ON public.entities
  USING gin (search_vector);

COMMENT ON COLUMN public.entities.search_vector IS
  'ADR-047 §1 / #550, ADR-092 / #1153: generated FTS vector over title, description, scalar people-facing properties (role, organization, relationship), term keys (properties.expansion, properties.context), and aliases (via immutable_array_to_string). Serves entity AND person search — people is a view over this table, not a table of its own. Mirrors artifacts.search_vector (migration 044).';

-- 4. Recreate the four search RPCs
CREATE OR REPLACE FUNCTION public.fts_search_entities(
  query_text       text,
  match_user_id    uuid,
  match_limit      int default 10,
  include_archived boolean default false
)
RETURNS setof public.entities
LANGUAGE sql STABLE
AS $$
  select e.*
  from public.entities e
  where e.user_id = match_user_id
    and e.entity_type <> 'people'
    and (include_archived or e.archived = false)
    and e.search_vector @@ websearch_to_tsquery('english', query_text)
  order by ts_rank_cd(e.search_vector, websearch_to_tsquery('english', query_text)) desc
  limit match_limit;
$$;

COMMENT ON FUNCTION public.fts_search_entities(text, uuid, int, boolean) IS
  'FTS keyword search over non-person entities. Mirrors fts_search_artifacts (migration 066/069/071). ADR-047 §3, #1153.';

CREATE OR REPLACE FUNCTION public.fts_search_people(
  query_text       text,
  match_user_id    uuid,
  match_limit      int default 10,
  include_archived boolean default false
)
RETURNS setof public.entities
LANGUAGE sql STABLE
AS $$
  select e.*
  from public.entities e
  where e.user_id = match_user_id
    and e.entity_type = 'people'
    and (include_archived or e.archived = false)
    and e.search_vector @@ websearch_to_tsquery('english', query_text)
  order by ts_rank_cd(e.search_vector, websearch_to_tsquery('english', query_text)) desc
  limit match_limit;
$$;

COMMENT ON FUNCTION public.fts_search_people(text, uuid, int, boolean) IS
  'FTS keyword search over person entities (entity_type = ''people''). ADR-047 §3, #1153.';

CREATE OR REPLACE FUNCTION public.hybrid_search_entities(
  query_text       text,
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_limit      int   default 10,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int   default 50,
  include_archived boolean default false
)
RETURNS setof public.entities
LANGUAGE sql STABLE
AS $$
with fts as (
  select id,
         row_number() over (
           order by ts_rank_cd(search_vector,
                               websearch_to_tsquery('english', query_text)) desc
         ) as rank_ix
  from public.entities
  where user_id = match_user_id
    and entity_type <> 'people'
    and (include_archived or archived = false)
    and search_vector @@ websearch_to_tsquery('english', query_text)
  limit least(match_limit, 30) * 2
),
semantic as (
  select id,
         row_number() over (order by embedding <=> query_embedding) as rank_ix
  from public.entities
  where user_id = match_user_id
    and entity_type <> 'people'
    and (include_archived or archived = false)
    and embedding is not null
  order by embedding <=> query_embedding
  limit least(match_limit, 30) * 2
)
select e.*
from public.entities e
join (
  select coalesce(fts.id, semantic.id) as id,
         coalesce(1.0 / (rrf_k + fts.rank_ix), 0.0) * full_text_weight +
         coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight as score
  from fts
  full outer join semantic on fts.id = semantic.id
) ranked on ranked.id = e.id
order by ranked.score desc
limit match_limit;
$$;

COMMENT ON FUNCTION public.hybrid_search_entities(text, vector, uuid, int, float, float, int, boolean) IS
  'Hybrid RRF search over non-person entities. Mirrors hybrid_search_artifacts (migration 051/069/071). ADR-047 §3, #1153.';

CREATE OR REPLACE FUNCTION public.hybrid_search_people(
  query_text       text,
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_limit      int   default 10,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int   default 50,
  include_archived boolean default false
)
RETURNS setof public.entities
LANGUAGE sql STABLE
AS $$
with fts as (
  select id,
         row_number() over (
           order by ts_rank_cd(search_vector,
                               websearch_to_tsquery('english', query_text)) desc
         ) as rank_ix
  from public.entities
  where user_id = match_user_id
    and entity_type = 'people'
    and (include_archived or archived = false)
    and search_vector @@ websearch_to_tsquery('english', query_text)
  limit least(match_limit, 30) * 2
),
semantic as (
  select id,
         row_number() over (order by embedding <=> query_embedding) as rank_ix
  from public.entities
  where user_id = match_user_id
    and entity_type = 'people'
    and (include_archived or archived = false)
    and embedding is not null
  order by embedding <=> query_embedding
  limit least(match_limit, 30) * 2
)
select e.*
from public.entities e
join (
  select coalesce(fts.id, semantic.id) as id,
         coalesce(1.0 / (rrf_k + fts.rank_ix), 0.0) * full_text_weight +
         coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight as score
  from fts
  full outer join semantic on fts.id = semantic.id
) ranked on ranked.id = e.id
order by ranked.score desc
limit match_limit;
$$;

COMMENT ON FUNCTION public.hybrid_search_people(text, vector, uuid, int, float, float, int, boolean) IS
  'Hybrid RRF search over person entities (entity_type = ''people''). ADR-047 §3, #1153.';
