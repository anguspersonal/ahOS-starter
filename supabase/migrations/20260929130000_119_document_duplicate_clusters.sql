-- Migration 119: document retrieval RPCs -- a tag filter inside the artifact search
-- RPCs, a derived duplicate/version-family report over the pointer index, and the
-- title search document_resolve falls back to.
-- Issues:  #1213 (knowledge_search `tags`), #1217 (document_duplicates),
--          #1230 (document_resolve); parent #1238
-- Refs:    ADR-047 §4 (fused search: add filters, do not fork it), ADR-052 (derived at
--          read, nothing stored), ADR-069 (copies stay separate atoms; grouping only),
--          migrations 069/071 (the overload trap), 097 (house RPC pattern), 107 (a
--          covering index is how a read of the wide artifacts table stays off the heap)
-- Date:    2026-09-29
--
-- WHAT THIS FILE DOES
--   1. fts_search_artifacts / hybrid_search_artifacts gain one trailing parameter,
--      `filter_tags text[] default null`: when set, only artifacts whose `tags`
--      contain ALL of them are ranked, and the filter runs BEFORE each arm's
--      `limit least(match_limit, 30) * 2`, so a tagged match can no longer be
--      crowded out of the 120-row ceiling by untagged rows and then post-filtered
--      away in JS (the audit's F2 finding, search.ts). The semantic arm cannot get
--      there by adding a predicate: its `order by embedding <=> q limit n` is served
--      by the HNSW index, which returns its nearest ~ef_search rows of the WHOLE
--      store and only then filters, so a selective tag would leave it empty. With
--      tags it ranks the tagged set itself, by exact distance (see the function).
--      Without tags both bodies are migration 069's, unchanged.
--   2. document_title_key(text): the version-family key -- an IMMUTABLE title
--      normaliser, mirrored in packages/mcp-server/src/tools/documentTitleKey.ts.
--   3. Two partial indexes over discovered pointers: the title key (covering, so a
--      whole-index family count never touches the heap) and the Drive md5.
--   4. document_duplicate_clusters(...): exact copies (same Drive md5) and version
--      families (same title key), each cluster's members ranked so member 1 is the
--      suggested canonical.
--   5. document_title_candidates(...): the any-of-these-words title search over the
--      same pointer index, which document_resolve lists untracked candidates from.
--
-- SIGNATURE CHANGE, DONE AS DROP + CREATE (AGENTS.md; the 069/071 lesson)
-- Adding a parameter changes a function's signature, so `CREATE OR REPLACE` alone
-- would leave the old one live as a second overload and make every old-arity call
-- ambiguous (42725). Each search RPC is therefore dropped by its exact current
-- signature (069's, as 071 left it) and created again, so each name resolves to
-- exactly one overload. Backward compatible with the deployed mcp-server: it calls
-- both RPCs through PostgREST with named arguments and never passes `filter_tags`,
-- which defaults to null -- the unfiltered read it has always had. The new
-- mcp-server sends `filter_tags` only when a caller supplies `tags`, so it keeps
-- working against a database this file has not reached yet, except for that one
-- new option.
--
-- HOUSE PATTERN FOR THE NEW RPCS (migration 097)
-- SECURITY INVOKER (the default) with an explicit `user_id = p_user_id` filter, as
-- every search RPC here; no explicit grants, same as 051/066/097. No function-level
-- statement_timeout either: none of the neighbouring RPCs sets one, and a SET on a
-- function cannot lengthen the statement that calls it.
--
-- WHAT THE DUPLICATE REPORT READS, AND WHY IT STAYS OFF THE HEAP
-- `artifacts` holds ~157k rows, nearly all discovered pointers, and its heap is wide
-- (bodies, search vectors, embeddings): a plain scan of it outran the 8s role
-- timeout (docs/guides/SUPABASE_MIGRATION_HISTORY_RUNBOOK.md, "A small row count
-- does not mean a small scan"), and migration 107 records PostgREST reads of it
-- failing with 57014. So nothing below scans that heap, and nothing normalises a
-- title at read:
--   * the family key is computed once per row, at write, into
--     idx_artifacts_discovered_title_key, whose INCLUDE list carries every other
--     column a family count, a title match or a member pick reads (id, title,
--     archived, source_channel, originated_at), so all three run as index-only
--     scans;
--   * the heap is read for a bounded set of rows only: per reported family, its
--     100 most recently originated members (every member of an ordinary family --
--     a document with more than 100 versions is a naming pattern such as
--     "Screenshot ... at ...", and the output says when a family was ranked on a
--     subset); with `p_query`, the matching titles, at most 2000 of them (a query
--     broader than that is refused with SQLSTATE 54000, "narrow it"); and the
--     members of the exact clusters those rows lead to;
--   * an exact cluster's members are found through idx_artifacts_discovered_md5.
-- Which exact clusters a run reports follows from that. With `p_query`: those a
-- matching title belongs to. Without it: those a member read for a reported family
-- belongs to. Grouping every md5 in the index would need each pointer's discovery
-- envelope, which lives only in the heap -- the one scan this file exists to avoid
-- -- so a byte-identical copy of a document with no version family surfaces when its
-- title is queried, not in a full run. The tool's output and guide say so.
--
-- BEFORE `db push` (the runbook's rule: EXPLAIN against production row counts first)
-- The PR body carries the statements. In short: create document_title_key and the two
-- indexes from the SQL editor (the indexes CONCURRENTLY; this file's IF NOT EXISTS
-- then no-ops), EXPLAIN (ANALYZE, BUFFERS) the family count and the query run's title
-- match, and check both are Index Only Scans on idx_artifacts_discovered_title_key
-- with few heap fetches. If the planner declines the index, stop and rework the read.
--
-- OUTPUT BOUND
-- At most 10 members per cluster and 50 clusters, i.e. 500 rows, under PostgREST's
-- 1000-row response cap, so the cap never truncates silently; `member_count`
-- carries each cluster's true size so the caller can print "+N more".
--
-- A session-level `SET` (AGENTS.md: never the transaction-local form). 30 minutes,
-- as migration 107, because each of the two index builds below reads the whole
-- table once. NOT CONCURRENTLY for 107's reason: `db push` runs this file as one
-- implicit transaction block. A plain build holds a SHARE lock (writes to artifacts
-- wait, reads do not) while it runs.

SET statement_timeout = '30min';

-- 1. The artifact search RPCs, with the tag filter ---------------------------------

drop function if exists public.fts_search_artifacts(text, uuid, integer, boolean);

create or replace function public.fts_search_artifacts(
  query_text       text,
  match_user_id    uuid,
  match_limit      int default 10,
  include_archived boolean default false,
  filter_tags      text[] default null
)
returns setof public.artifacts
language sql stable
as $$
  select a.*
  from public.artifacts a
  where a.user_id = match_user_id
    and (include_archived or a.archived = false)
    and (filter_tags is null or a.tags @> filter_tags)
    and a.search_vector @@ websearch_to_tsquery('english', query_text)
  order by ts_rank_cd(a.search_vector, websearch_to_tsquery('english', query_text)) desc
  limit match_limit;
$$;

drop function if exists public.hybrid_search_artifacts(text, vector, uuid, integer, double precision, double precision, integer, boolean);

-- The semantic arm is two branches, each gated on `filter_tags` alone. A predicate
-- on parameters only is a pseudoconstant: the planner evaluates it once, as a gate
-- above its branch, so the untagged branch keeps 069's plan (HNSW order-by-limit)
-- and the tagged one never runs without tags. With tags, `tagged` collects the
-- tagged rows first (the GIN index on tags) and the branch orders that set by exact
-- distance: a CTE scan cannot use HNSW, so every tagged row is a candidate. Tags
-- name small, hand-kept sets (`doc:cv`, `golden`), so the exact ranking is cheap.
create or replace function public.hybrid_search_artifacts(
  query_text       text,
  query_embedding  vector(1536),
  match_user_id    uuid,
  match_limit      int   default 10,
  full_text_weight float default 1.0,
  semantic_weight  float default 1.0,
  rrf_k            int   default 50,
  include_archived boolean default false,
  filter_tags      text[] default null
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
    and (filter_tags is null or tags @> filter_tags)
    and search_vector @@ websearch_to_tsquery('english', query_text)
  limit least(match_limit, 30) * 2
),
tagged as materialized (
  select id, embedding
  from public.artifacts
  where filter_tags is not null
    and user_id = match_user_id
    and (include_archived or archived = false)
    and tags @> filter_tags
    and embedding is not null
),
semantic as (
  (
    select id,
           row_number() over (order by embedding <=> query_embedding) as rank_ix
    from public.artifacts
    where filter_tags is null
      and user_id = match_user_id
      and (include_archived or archived = false)
      and embedding is not null
    order by embedding <=> query_embedding
    limit least(match_limit, 30) * 2
  )
  union all
  (
    select id,
           row_number() over (order by embedding <=> query_embedding) as rank_ix
    from tagged
    order by embedding <=> query_embedding
    limit least(match_limit, 30) * 2
  )
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

comment on function public.fts_search_artifacts is
  'FTS-only artifact search ranked by ts_rank_cd (migrations 066/069). filter_tags (migration 119, #1213): when set, only artifacts whose tags contain ALL of them are ranked, filtered before the limit.';

comment on function public.hybrid_search_artifacts is
  'FTS + vector artifact search fused by RRF (migrations 051/069); each arm is capped at least(match_limit, 30) * 2 rows. filter_tags (migration 119, #1213): when set, only artifacts whose tags contain ALL of them are ranked: the FTS arm filters before its cap, and the semantic arm ranks the tagged set by exact distance rather than through the HNSW index, which would filter only after its nearest-neighbour cut.';

-- 2. The version-family key --------------------------------------------------------
--
-- Steps, in order: lower-case and trim; strip a leading "copy of " (repeated);
-- strip the tail in one anchored pass -- a trailing " n" copy counter, then any
-- " (n)" counters, then a MultCloud-style "-vYYYYMMDDHHMMSS" backup suffix, then a
-- file extension (e.g. "cv feb 23 (3).docx" loses " 23 (3).docx"); split letter/
-- digit runs ("oct2022" -> "oct 2022"); turn every run of non-alphanumerics into
-- one space; drop month names (short and full) and 2- and 4-digit year tokens;
-- trim. Returns null when nothing is left, so an all-date title joins no family.
--
-- `[[:alnum:]]` follows the database's character classification: non-ASCII letters
-- ("résumé") count as letters under a UTF-8 locale, and the TypeScript mirror
-- assumes so. The PR body carries the one-line check to run against production.
--
-- idx_artifacts_discovered_title_key below stores this function's result. Postgres
-- does not rebuild an index when a function it calls is replaced, so any change to
-- this body must `REINDEX INDEX public.idx_artifacts_discovered_title_key` in the
-- same migration, or family lookups silently read keys the old body computed.

create or replace function public.document_title_key(p_title text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(btrim(regexp_replace(
    ' ' || regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(btrim(lower(p_title)), '^(copy of\s+)+', ''),
          '(\s+[0-9]+)?(\s*\([0-9]+\))*(-v[0-9]{14})?(\.[a-z0-9]{1,5})?$', ''),
        '([a-z])(?=[0-9])|([0-9])(?=[a-z])', '\1\2 ', 'g'),
      '[^[:alnum:]]+', ' ', 'g') || ' ',
    ' (?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|(?:19|20)[0-9]{2}|[0-9]{2})(?= )',
    '', 'g')), '')
$$;

comment on function public.document_title_key(text) is
  'Version-family key for a document title (#1217): lower-case; strip leading "copy of", trailing " n" / " (n)" copy counters, -vYYYYMMDDHHMMSS backup suffixes and the file extension; split letter/digit runs; collapse punctuation; drop month and 2/4-digit year tokens. Null when nothing is left. Stored by idx_artifacts_discovered_title_key: changing this body requires a REINDEX of that index in the same migration. Mirrored by packages/mcp-server/src/tools/documentTitleKey.ts. Migration 119.';

-- 3. The pointer-index indexes -----------------------------------------------------
--
-- Both are partial on discovered pointers (`source_channel LIKE 'discovered\_%'`),
-- the document index: captured atoms, Slack and email rows are not documents. Every
-- query meant to use one repeats its predicate verbatim, which is how the planner
-- proves the partial index applies.
--
-- The title-key index's `octet_length(title) <= 1000` bounds its entries: a btree
-- entry holds at most ~2.7 kB, this one carries the title twice (the key is never
-- longer than the title), and an oversized entry would fail the pointer's INSERT.
-- A longer "title" is not a file name; such a row joins no family and is not a
-- title-search candidate, and that is the only effect.

create index if not exists idx_artifacts_discovered_title_key
  on public.artifacts (user_id, public.document_title_key(title))
  include (id, title, archived, source_channel, originated_at)
  where source_channel like 'discovered\_%' and octet_length(title) <= 1000;

comment on index public.idx_artifacts_discovered_title_key is
  'Version-family key (document_title_key) per discovered pointer, covering id/title/archived/source_channel/originated_at so document_duplicate_clusters and document_title_candidates run as index-only scans instead of reading the wide artifacts heap. REINDEX whenever document_title_key changes. Migration 119.';

create index if not exists idx_artifacts_discovered_md5
  on public.artifacts (user_id, (processing_metadata #>> '{discovery,content_hash}'))
  where source_channel like 'discovered\_%'
    and (processing_metadata #>> '{discovery,content_hash}') ~ '^[0-9a-f]{32}$';

comment on index public.idx_artifacts_discovered_md5 is
  'Drive md5 per discovered pointer (only where content_hash is a real md5; Drive stores modifiedTime there for Google-native files), so document_duplicate_clusters finds an exact cluster''s members by lookup. Migration 119.';

-- 4. The duplicate report ----------------------------------------------------------
--
-- PL/pgSQL rather than SQL so each phase is planned for the call it serves (the
-- query run and the full run have different access paths), and so the phases hand
-- each other small arrays instead of re-reading rows:
--   A. the owner's identity signals, for the owned-by-self tie-break;
--   B. which families to report -- every family (full run) or those of the titles
--      that match `p_query` -- counted from the title-key index alone, largest
--      first, at most `p_limit`;
--   C. one statement that picks each family's members to read (index-only), reads
--      them, derives the exact clusters (anchored as the header explains), ranks
--      everything and returns the rows.
-- `ranked_members` is how many of a cluster's members were read and ranked: all of
-- them, except in a family larger than the per-family read (100), where it says the
-- suggested canonical is the newest of the 100 most recently originated.

create or replace function public.document_duplicate_clusters(
  p_user_id          uuid,
  p_query            text    default null,
  p_connector        text    default null,
  p_min_cluster      int     default 2,
  p_limit            int     default 20,
  p_include_archived boolean default false
)
returns table (
  cluster_kind       text,
  cluster_key        text,
  cluster_rank       integer,
  member_count       integer,
  ranked_members     integer,
  distinct_contents  integer,
  unhashed_members   integer,
  member_rank        integer,
  artifact_id        text,
  title              text,
  link               text,
  connector          text,
  external_id        text,
  source_created_at  text,
  source_modified_at text,
  owner              text,
  owner_email        text,
  content_hash       text,
  content_hash_kind  text,
  owned_by_self      boolean,
  enriched           boolean,
  lifecycle_stage    text,
  archived           boolean,
  archived_reason    text
)
language plpgsql
stable
as $$
#variable_conflict use_column
declare
  -- Members read (and ranked) per family; see the header.
  c_family_read  constant int := 100;
  -- Matching titles a query run may read for their md5s; see the header.
  c_seed_cap     constant int := 2000;
  v_min          int     := greatest(coalesce(p_min_cluster, 2), 2);
  v_limit        int     := least(greatest(coalesce(p_limit, 20), 1), 50);
  -- Null when no connector was asked for, so `v_channel is null or ...` passes all.
  v_channel      text    := 'discovered_' || p_connector;
  v_archived     boolean := coalesce(p_include_archived, false);
  v_pattern      text;
  v_emails       text[];
  v_display_name text;
  v_seed_count   int     := 0;
  v_seed_ids     uuid[]  := '{}';
  v_seed_keys    text[]  := '{}';
  v_family_keys  text[]  := '{}';
  v_family_sizes int[]   := '{}';
begin
  -- A. The owner's identity (ADR-024; user_preferences.identity, migration 053). A
  -- pointer's owner is only ever a Drive display name or email, so these are the two
  -- things to compare against.
  select coalesce(array_agg(lower(btrim(e.email))), '{}')
    into v_emails
  from public.user_preferences up
  cross join lateral jsonb_array_elements_text(
    case when jsonb_typeof(up.identity -> 'emails') = 'array'
         then up.identity -> 'emails' else '[]'::jsonb end
  ) as e(email)
  where up.user_id = p_user_id;

  select lower(nullif(btrim(up.identity ->> 'display_name'), ''))
    into v_display_name
  from public.user_preferences up
  where up.user_id = p_user_id
  limit 1;

  -- B. The families to report, from the title-key index alone.
  if p_query is null then
    select coalesce(array_agg(f.family_key order by f.n desc, f.family_key), '{}'),
           coalesce(array_agg(f.n::int order by f.n desc, f.family_key), '{}')
      into v_family_keys, v_family_sizes
    from (
      select public.document_title_key(a.title) as family_key, count(*) as n
      from public.artifacts a
      where a.user_id = p_user_id
        and a.source_channel like 'discovered\_%'
        and octet_length(a.title) <= 1000
        and (v_channel is null or a.source_channel = v_channel)
        and (v_archived or a.archived = false)
        and public.document_title_key(a.title) is not null
      group by 1
      having count(*) >= v_min
      order by count(*) desc, 1
      limit v_limit
    ) f;
  else
    -- The clusters reported are the ones a matching title belongs to, whole: a
    -- renamed byte-identical copy or a differently dated version is still a member
    -- even though its own title does not match.
    v_pattern := '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

    select count(*)::int,
           coalesce(array_agg(a.id), '{}'),
           coalesce(array_agg(distinct public.document_title_key(a.title))
                      filter (where public.document_title_key(a.title) is not null), '{}')
      into v_seed_count, v_seed_ids, v_seed_keys
    from public.artifacts a
    where a.user_id = p_user_id
      and a.source_channel like 'discovered\_%'
      and octet_length(a.title) <= 1000
      and (v_channel is null or a.source_channel = v_channel)
      and (v_archived or a.archived = false)
      and a.title ilike v_pattern;

    if v_seed_count > c_seed_cap then
      raise exception 'document_duplicate_clusters: "%" matches % document titles, more than the % a query run reads',
        p_query, v_seed_count, c_seed_cap
        using errcode = '54000',
              hint = 'Narrow the query (a longer title fragment) or pass p_connector.';
    end if;

    select coalesce(array_agg(f.family_key order by f.n desc, f.family_key), '{}'),
           coalesce(array_agg(f.n::int order by f.n desc, f.family_key), '{}')
      into v_family_keys, v_family_sizes
    from (
      select public.document_title_key(a.title) as family_key, count(*) as n
      from public.artifacts a
      where a.user_id = p_user_id
        and a.source_channel like 'discovered\_%'
        and octet_length(a.title) <= 1000
        and (v_channel is null or a.source_channel = v_channel)
        and (v_archived or a.archived = false)
        and public.document_title_key(a.title) = any (v_seed_keys)
      group by 1
      having count(*) >= v_min
      order by count(*) desc, 1
      limit v_limit
    ) f;
  end if;

  -- C. Members, exact clusters, ranking. Only this statement reads the heap: the
  -- picked family members, the matching titles, and the exact clusters they lead to.
  return query
  with
  fam_keys as (
    select k.fkey, k.fsize
    from unnest(v_family_keys, v_family_sizes) as k(fkey, fsize)
  ),
  -- Per family, the members to read: all of them up to c_family_read, most
  -- recently originated first (index-only: originated_at is on the index).
  fam_pick as materialized (
    select fk.fkey, p.id
    from fam_keys fk
    cross join lateral (
      select a.id
      from public.artifacts a
      where a.user_id = p_user_id
        and a.source_channel like 'discovered\_%'
        and octet_length(a.title) <= 1000
        and (v_channel is null or a.source_channel = v_channel)
        and (v_archived or a.archived = false)
        and public.document_title_key(a.title) = fk.fkey
      order by a.originated_at desc nulls last, a.id
      limit c_family_read
    ) p
  ),
  fam_src as materialized (
    select
      fp.fkey as ckey,
      a.id, a.title, a.created_at, a.archived, a.archived_reason, a.lifecycle_stage,
      a.source_channel, a.source, a.storage_bucket, a.storage_url,
      a.processing_metadata -> 'discovery' as disc
    from fam_pick fp
    join public.artifacts a on a.id = fp.id
  ),
  -- The md5s whose exact clusters to report: with p_query, the matching titles'
  -- own; without it, those of the members read above. Never the md5 of empty
  -- content, which every zero-byte file shares, whatever it is.
  anchors as (
    select distinct x.h
    from (
      select a.processing_metadata #>> '{discovery,content_hash}' as h
      from public.artifacts a
      where p_query is not null
        and a.id = any (v_seed_ids)
      union all
      select f.disc ->> 'content_hash'
      from fam_src f
      where p_query is null
    ) x
    where x.h ~ '^[0-9a-f]{32}$'
      and x.h <> 'd41d8cd98f00b204e9800998ecf8427e'
  ),
  exact_src as materialized (
    select
      a.processing_metadata #>> '{discovery,content_hash}' as ckey,
      a.id, a.title, a.created_at, a.archived, a.archived_reason, a.lifecycle_stage,
      a.source_channel, a.source, a.storage_bucket, a.storage_url,
      a.processing_metadata -> 'discovery' as disc
    from public.artifacts a
    where a.user_id = p_user_id
      and a.source_channel like 'discovered\_%'
      and (a.processing_metadata #>> '{discovery,content_hash}') ~ '^[0-9a-f]{32}$'
      and (a.processing_metadata #>> '{discovery,content_hash}') = any (array(select an.h from anchors an))
      and (v_channel is null or a.source_channel = v_channel)
      and (v_archived or a.archived = false)
  ),
  -- Every cluster that qualifies, with its true size: an exact cluster's is what was
  -- read (all of it); a family's is its index count from phase B.
  cluster_sizes as (
    select 'exact'::text as kind, e.ckey, count(*)::int as n_members
    from exact_src e
    group by e.ckey
    having count(*) >= v_min
    union all
    select 'version_family'::text, f.ckey, fk.fsize
    from fam_src f
    join fam_keys fk on fk.fkey = f.ckey
    group by f.ckey, fk.fsize
    -- A family that is one byte-identical set is already reported, whole, as an
    -- exact cluster (its md5 is an anchor); listing it twice would only double the
    -- proposal. Only decidable when every member was read, and never for the md5
    -- of empty content, which is not reported.
    having not (
      count(*) = fk.fsize
      and count(*) filter (where (f.disc ->> 'content_hash') ~ '^[0-9a-f]{32}$') = count(*)
      and count(distinct f.disc ->> 'content_hash') = 1
      and min(f.disc ->> 'content_hash') <> 'd41d8cd98f00b204e9800998ecf8427e'
    )
  ),
  members_raw as (
    select 'exact'::text as kind, e.*
    from exact_src e
    union all
    select 'version_family'::text as kind, f.*
    from fam_src f
  ),
  members as (
    select
      m.kind,
      m.ckey,
      m.id,
      m.title,
      m.created_at,
      m.archived,
      m.archived_reason,
      m.lifecycle_stage,
      coalesce(m.disc ->> 'connector', substr(m.source_channel, 12)) as m_connector,
      coalesce(m.disc ->> 'external_id', m.source)                   as m_external_id,
      m.disc ->> 'source_created_at'                                 as m_source_created_at,
      m.disc ->> 'source_modified_at'                                as m_source_modified_at,
      -- ISO strings from the connector APIs; the first 19 characters order them
      -- without a cast that one malformed value could turn into an error.
      left(m.disc ->> 'source_modified_at', 19)                      as modified_sort,
      m.disc ->> 'owner'                                             as m_owner,
      m.disc ->> 'owner_email'                                       as m_owner_email,
      m.disc ->> 'content_hash'                                      as m_content_hash,
      -- Drive stores md5Checksum ?? modifiedTime and Notion last_edited_time under the
      -- same key, so only a real md5 is evidence of identical bytes.
      case
        when m.disc ->> 'content_hash' ~ '^[0-9a-f]{32}$' then 'md5'
        when m.disc ->> 'content_hash' is not null then 'modified_time'
      end                                                            as m_content_hash_kind,
      coalesce(
        nullif(m.disc ->> 'url', ''),
        case when m.storage_bucket = 'external' and m.storage_url not like 'discovered://%'
             then m.storage_url end
      )                                                              as m_link,
      -- Same set as vocab.ts UNENRICHED_STAGES.
      coalesce(m.lifecycle_stage not in ('discovered', 'failed'), false) as m_enriched,
      (
        coalesce(lower(btrim(m.disc ->> 'owner_email')) = any (v_emails), false)
        or coalesce(lower(btrim(m.disc ->> 'owner')) = v_display_name, false)
      )                                                              as m_owned_by_self,
      cs.n_members
    from members_raw m
    join cluster_sizes cs on cs.kind = m.kind and cs.ckey = m.ckey
  ),
  summary as (
    select
      m.kind,
      m.ckey,
      m.n_members,
      count(*)::int                                                                       as n_ranked,
      (count(distinct m.m_content_hash) filter (where m.m_content_hash_kind = 'md5'))::int as n_distinct,
      (count(*) filter (where m.m_content_hash_kind is distinct from 'md5'))::int         as n_unhashed,
      max(m.modified_sort)                                                                as newest
    from members m
    group by m.kind, m.ckey, m.n_members
  ),
  top_clusters as (
    select
      s.*,
      (row_number() over (
        order by s.n_members desc, s.newest desc nulls last, s.kind, s.ckey
      ))::int as c_rank
    from summary s
    order by c_rank
    limit v_limit
  ),
  -- Member 1 is the suggested canonical: the most recent source modification; ties
  -- broken by owned-by-self, then enriched, then the earliest-registered pointer.
  ranked as (
    select
      m.*,
      (row_number() over (
        partition by m.kind, m.ckey
        order by m.modified_sort desc nulls last, m.m_owned_by_self desc, m.m_enriched desc,
                 m.created_at, m.id
      ))::int as m_rank
    from members m
    join top_clusters t on t.kind = m.kind and t.ckey = m.ckey
  )
  select
    r.kind,
    r.ckey,
    t.c_rank,
    t.n_members,
    t.n_ranked,
    t.n_distinct,
    t.n_unhashed,
    r.m_rank,
    r.id::text,
    r.title,
    r.m_link,
    r.m_connector,
    r.m_external_id,
    r.m_source_created_at,
    r.m_source_modified_at,
    r.m_owner,
    r.m_owner_email,
    r.m_content_hash,
    r.m_content_hash_kind,
    r.m_owned_by_self,
    r.m_enriched,
    r.lifecycle_stage,
    r.archived,
    r.archived_reason
  from ranked r
  join top_clusters t on t.kind = r.kind and t.ckey = r.ckey
  where r.m_rank <= 10
  order by t.c_rank, r.m_rank;
end;
$$;

comment on function public.document_duplicate_clusters(uuid, text, text, integer, integer, boolean) is
  'Duplicate report over discovered pointers (#1217), derived at read (ADR-052): kind exact = same discovery md5 (never the empty-content md5); kind version_family = same document_title_key. With p_query, the clusters a matching title belongs to, whole (SQLSTATE 54000 when more than 2000 titles match); without it, every family, plus the exact clusters the members read for them belong to. Families are counted from idx_artifacts_discovered_title_key alone, and at most 100 members per family are read and ranked (ranked_members says how many). At most 50 clusters and 10 members each (member_count is the true size); member_rank 1 is the suggested canonical (newest source modification, then owned-by-self, then enriched). Read by the document_duplicates MCP tool. Migration 119.';

-- 5. The untracked-candidate title search ------------------------------------------
--
-- document_resolve's fallback (#1230): "get my CV" with nothing tracked lists the
-- documents an owner could track. A title search, not full-text search: the
-- 'english' parser reads "Angus Hally CV.pdf" as the host name `cv.pdf` and
-- "Angus_Hally_CV.docx" as one file token, so a tsquery for `cv` misses exactly the
-- file names this is for. The caller passes the words to look for, stopwords and
-- phrasing already dropped ("get my CV" -> {cv}); a title matches when it contains
-- any of them. Titles matching more of the words, then as whole words, come first.
-- A term carrying punctuation or space is ignored, so no term can act as a LIKE or
-- regex metacharacter. The match runs over the title-key index (index-only: id,
-- title, archived and source_channel are all on it); the heap is read for the
-- returned rows only.

create or replace function public.document_title_candidates(
  p_user_id uuid,
  p_terms   text[],
  p_limit   int default 10
)
returns setof public.artifacts
language sql
stable
as $$
  with terms as (
    select distinct lower(u.t) as term
    from unnest(p_terms) as u(t)
    where u.t <> '' and u.t !~ '[[:punct:][:space:]]'
  ),
  hits as materialized (
    select a.id, a.title
    from public.artifacts a
    where a.user_id = p_user_id
      and a.source_channel like 'discovered\_%'
      and octet_length(a.title) <= 1000
      and a.archived = false
      and exists (select 1 from terms t where a.title ilike '%' || t.term || '%')
  ),
  picked as (
    select
      h.id,
      h.title,
      (select count(*) from terms t where h.title ilike '%' || t.term || '%') as matched,
      (select count(*) from terms t
        where lower(h.title) ~ ('(^|[^[:alnum:]])' || t.term || '([^[:alnum:]]|$)')) as whole_words
    from hits h
    order by matched desc, whole_words desc, h.title, h.id
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
  )
  select a.*
  from picked p
  join public.artifacts a on a.id = p.id
  order by p.matched desc, p.whole_words desc, p.title, p.id;
$$;

comment on function public.document_title_candidates(uuid, text[], integer) is
  'Discovered pointers (archived excluded) whose title contains any of p_terms, case-insensitively; more words matched, then whole-word matches, first; at most p_limit (max 50). The untracked-candidate list of the document_resolve MCP tool (#1230). Index-only over idx_artifacts_discovered_title_key. Migration 119.';
