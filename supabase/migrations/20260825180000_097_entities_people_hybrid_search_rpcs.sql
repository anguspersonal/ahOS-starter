-- Migration 097: fts/hybrid search RPCs for entities and people (ADR-047 slice 3) (#552)
-- Depends on:  migration 095 (search_vector + embedding columns on public.entities, #550)
-- Blocks:      #553 (search_knowledge dual-query fan-out, slice 4)
-- Refs:        ADR-047 "Slice 3 — Graph hybrid-search RPCs", migrations 051/066
--              (the artifact RPCs this mirrors) and 069/071 (the overload trap
--              this migration is written to avoid from day one)
-- Date:        2026-08-25
--
-- WHAT THIS FILE DOES
-- Four read-only RPCs over public.entities, mirroring fts_search_artifacts /
-- hybrid_search_artifacts's rank logic and RRF fusion exactly:
--   * fts_search_entities    / fts_search_people    -- ts_rank_cd, FTS-only
--   * hybrid_search_entities / hybrid_search_people -- FTS union vector, RRF-fused
-- No tool wiring happens here -- that is slice 4 (#553). These RPCs are
-- unreachable from any surface until #553 fans out to them from
-- search_knowledge, exactly as migration 095's columns were inert until slice 2
-- (#551) started reading and writing them.
--
-- WHY FOUR FUNCTIONS, NOT TWO WITH A PARAMETER
-- Slice 4 fans out to three independent RPC arms -- artifacts, entities, people
-- -- and merges their results (ADR-047 "Slice 4"). Two of those arms read the
-- same physical table, so they must partition it or the merge would return the
-- same row twice: entities_* excludes entity_type = 'people'; people_* is
-- exactly that entity_type. This is a WHERE-clause split, not a schema split --
-- public.people (migration 077) is a view over these same rows, not a second
-- table (migration 095's header explains why there is only one physical
-- store). people.ts's own writers already query public.entities directly with
-- this same entity_type filter, not the view -- these RPCs follow that
-- established convention.
--
-- INCLUDE_ARCHIVED FROM DAY ONE (the 071 lesson)
-- Migration 069 added include_archived to the artifact RPCs via CREATE OR
-- REPLACE after they had already shipped without it. Adding a parameter
-- changes a function's signature, so Postgres created a SECOND overload rather
-- than replacing the first, and old-arity callers broke in production with
-- "function ... is not unique" (071 fixes it by dropping the stale overload).
-- These four functions ship with `include_archived boolean default false` in
-- their first and only signature, so there is no later migration that needs to
-- widen them and no overload to ever create.
--
-- THE #137 RECALL CASE (ADR-047 slice 3 acceptance criterion 3)
-- hybrid_search_people / fts_search_people query public.entities directly by
-- its own search_vector / embedding columns (migration 095) -- there is no
-- join to artifacts or artifact_entity_links anywhere in these functions. A
-- person row therefore matches on its own title / description / role /
-- organization / relationship text regardless of whether any artifact
-- mentions or links it, closing the "Sam has no linked artifacts" gap #137
-- named. Provable directly in SQL once this migration is applied, before any
-- tool wiring exists:
--   insert into public.entities (user_id, entity_type, title)
--     values ('<uid>', 'people', 'Sam Nobody');
--   select title from public.fts_search_people('Sam Nobody', '<uid>');
--   -- returns the row via ts_rank_cd alone; no artifact_entity_links row
--   -- exists for it and none is consulted.
--
-- GRANTS
-- None added. Postgres grants EXECUTE to PUBLIC by default for new functions,
-- the same as fts_search_artifacts / hybrid_search_artifacts (051 / 066),
-- which carry no explicit grant either (071's header confirms this for that
-- pair: "Grants on the surviving functions are identical").

create or replace function public.fts_search_entities(
  query_text       text,
  match_user_id    uuid,
  match_limit      int default 10,
  include_archived boolean default false
)
returns setof public.entities
language sql stable
as $$
  select e.*
  from public.entities e
  where e.user_id = match_user_id
    and e.entity_type <> 'people'
    and (include_archived or e.archived = false)
    and e.search_vector @@ websearch_to_tsquery('english', query_text)
  order by ts_rank_cd(e.search_vector, websearch_to_tsquery('english', query_text)) desc
  limit match_limit;
$$;

create or replace function public.fts_search_people(
  query_text       text,
  match_user_id    uuid,
  match_limit      int default 10,
  include_archived boolean default false
)
returns setof public.entities
language sql stable
as $$
  select e.*
  from public.entities e
  where e.user_id = match_user_id
    and e.entity_type = 'people'
    and (include_archived or e.archived = false)
    and e.search_vector @@ websearch_to_tsquery('english', query_text)
  order by ts_rank_cd(e.search_vector, websearch_to_tsquery('english', query_text)) desc
  limit match_limit;
$$;

create or replace function public.hybrid_search_entities(
  query_text       text,
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_limit      int   default 10,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int   default 50,
  include_archived boolean default false
)
returns setof public.entities
language sql stable
as $$
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

create or replace function public.hybrid_search_people(
  query_text       text,
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_limit      int   default 10,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int   default 50,
  include_archived boolean default false
)
returns setof public.entities
language sql stable
as $$
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

comment on function public.fts_search_entities is
  'ADR-047 Slice 3 / #552: FTS-only search over public.entities, excluding entity_type = ''people'' (see fts_search_people). Mirrors fts_search_artifacts (migration 066/069).';

comment on function public.fts_search_people is
  'ADR-047 Slice 3 / #552: FTS-only search over public.entities scoped to entity_type = ''people''. public.people (migration 077) is a view over these same rows; this RPC reads the physical table directly, matching people.ts''s own writers. Mirrors fts_search_artifacts (migration 066/069).';

comment on function public.hybrid_search_entities is
  'ADR-047 Slice 3 / #552: FTS+vector hybrid search over public.entities, excluding entity_type = ''people'' (see hybrid_search_people), fused by RRF. Mirrors hybrid_search_artifacts (migration 051/069).';

comment on function public.hybrid_search_people is
  'ADR-047 Slice 3 / #552: FTS+vector hybrid search over public.entities scoped to entity_type = ''people'', fused by RRF. No join to artifacts or artifact_entity_links -- a person with no linked artifacts still matches on their own title/description/role/organization/relationship text (closes #137). Mirrors hybrid_search_artifacts (migration 051/069).';
