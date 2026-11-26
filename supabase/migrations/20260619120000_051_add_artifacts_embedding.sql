-- Embedding column (nullable — rows without an embedding still participate in FTS)
alter table public.artifacts
  add column if not exists embedding vector(1536);

-- Cosine HNSW index (correct as the store grows; harmless at current size)
create index if not exists artifacts_embedding_idx
  on public.artifacts
  using hnsw (embedding vector_cosine_ops);

-- Hybrid search RPC (FTS + vector, fused with RRF)
create or replace function public.hybrid_search_artifacts(
  query_text       text,
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_limit      int   default 10,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int   default 50
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
  where user_id = match_user_id and archived = false
    and search_vector @@ websearch_to_tsquery('english', query_text)
  limit least(match_limit, 30) * 2
),
semantic as (
  select id,
         row_number() over (order by embedding <=> query_embedding) as rank_ix
  from public.artifacts
  where user_id = match_user_id and archived = false and embedding is not null
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
