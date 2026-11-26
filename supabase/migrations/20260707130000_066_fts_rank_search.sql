-- Ranking RPC for the full-text-only search fallback (issue #130). PostgREST can't
-- `.order()` a REST query by a computed expression like `ts_rank_cd(...)`, so the FTS-only
-- path (query present, no OpenAI embedding key) previously returned keyword matches in
-- arbitrary GIN heap order — a short artifact whose title *is* the query term could rank
-- below an incidental one-word mention in a much longer document. This mirrors the
-- structure of `hybrid_search_artifacts` (migration 051): rank by `ts_rank_cd` server-side
-- and return already-sorted rows, since the hybrid path only ranks when an OpenAI key is
-- configured.
create or replace function public.fts_search_artifacts(
  query_text    text,
  match_user_id uuid,
  match_limit   int default 10
)
returns setof public.artifacts
language sql stable
as $$
  select a.*
  from public.artifacts a
  where a.user_id = match_user_id and a.archived = false
    and a.search_vector @@ websearch_to_tsquery('english', query_text)
  order by ts_rank_cd(a.search_vector, websearch_to_tsquery('english', query_text)) desc
  limit match_limit;
$$;
