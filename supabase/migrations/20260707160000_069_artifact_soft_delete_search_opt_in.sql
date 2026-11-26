-- Refs #120: artifact soft-delete for the MCP.
--
-- Investigation found the soft-delete mechanism itself already shipped: `artifacts`
-- already has `archived boolean default false` / `archived_at timestamptz` /
-- `archived_reason text` (live since the `remote_schema.sql` baseline; audited by
-- migration 041's edit-log trigger), a partial index `idx_artifacts_archived
-- WHERE (archived = false)` already exists, the `artifact_delete` MCP tool
-- already soft-deletes by default (PR #248, closing the related #140), restore
-- already works via `artifact_update` (archived: false), and both search RPCs
-- (`fts_search_artifacts` migration 066, `hybrid_search_artifacts` migration 051)
-- already hard-filter `archived = false` in every branch.
--
-- The one real gap: that `archived = false` filter is unconditional, so
-- search_knowledge has no `include_archived` opt-in — unlike the entities_query /
-- people_query convention, which both support one. This migration adds an
-- `include_archived` parameter (default false) to both RPCs, preserving their
-- existing positional signature prefix, return type (`setof public.artifacts`),
-- and default (unfiltered-callers see identical behavior to before this migration).
create or replace function public.fts_search_artifacts(
  query_text       text,
  match_user_id    uuid,
  match_limit      int default 10,
  include_archived boolean default false
)
returns setof public.artifacts
language sql stable
as $$
  select a.*
  from public.artifacts a
  where a.user_id = match_user_id
    and (include_archived or a.archived = false)
    and a.search_vector @@ websearch_to_tsquery('english', query_text)
  order by ts_rank_cd(a.search_vector, websearch_to_tsquery('english', query_text)) desc
  limit match_limit;
$$;

create or replace function public.hybrid_search_artifacts(
  query_text       text,
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_limit      int   default 10,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int   default 50,
  include_archived boolean default false
)
returns setof public.artifacts
language sql stable
as $$
with fts as (
  select id,
         row_number() over (
           order by ts_rank_cd(search_vector,
                               websearch_to_tsquery('english', query_text)) desc
         ) as rank_ix
  from public.artifacts
  where user_id = match_user_id
    and (include_archived or archived = false)
    and search_vector @@ websearch_to_tsquery('english', query_text)
  limit least(match_limit, 30) * 2
),
semantic as (
  select id,
         row_number() over (order by embedding <=> query_embedding) as rank_ix
  from public.artifacts
  where user_id = match_user_id
    and (include_archived or archived = false)
    and embedding is not null
  order by embedding <=> query_embedding
  limit least(match_limit, 30) * 2
)
select a.*
from public.artifacts a
join (
  select coalesce(fts.id, semantic.id) as id,
         coalesce(1.0 / (rrf_k + fts.rank_ix), 0.0) * full_text_weight +
         coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0) * semantic_weight as score
  from fts
  full outer join semantic on fts.id = semantic.id
) ranked on ranked.id = a.id
order by ranked.score desc
limit match_limit;
$$;
