-- Migration 150: prevent gdrive timeout in document_duplicate_clusters and exclude OS junk titles
-- Issues:  #2099 (document_duplicates gdrive timeout, OS junk exclusion, bounded exact_src)
-- Refs:    ADR-052 (derived at read, nothing stored), ADR-069 (copies stay separate atoms),
--          migration 119 (document_title_key, idx_artifacts_discovered_title_key, document_duplicate_clusters)
-- Date:    2026-11-07
--
-- WHAT THIS FILE DOES
--   1. Replaces `public.document_title_key(p_title text)` (same signature) so macOS
--      AppleDouble resource forks (`^\._`), `.DS_Store`, and bare `untitled` normalise
--      to `NULL`, preventing non-document OS/placeholder files from forming version
--      families.
--   2. Reindexes `public.idx_artifacts_discovered_title_key` so stored expression keys
--      reflect the updated `document_title_key` body.
--   3. Replaces `public.document_duplicate_clusters(...)` (same signature) to fix three
--      timeout vectors:
--        a. Evaluates connector filtering against `source_channel || ''` so the planner
--           filters `source_channel` from `idx_artifacts_discovered_title_key`'s INCLUDE
--           payload as an Index-Only Scan rather than choosing
--           `idx_artifacts_user_channel_source (user_id, source_channel, source)` and
--           performing ~150k heap fetches when `p_connector = 'gdrive'`.
--        b. Includes `and public.document_title_key(a.title) is not null` in the `p_query`
--           seed scan so it uses `idx_artifacts_discovered_title_key` as an Index-Only Scan.
--        c. Bounds per-md5 heap reads in `exact_src` via `CROSS JOIN LATERAL (... ORDER BY
--           a.originated_at DESC NULLS LAST, a.id LIMIT c_family_read)` while computing
--           the true exact cluster size (`exact_counts`) from `idx_artifacts_discovered_md5`.

SET statement_timeout = '30min';

-- 1. Update version-family title normaliser ----------------------------------------

create or replace function public.document_title_key(p_title text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_title is null or btrim(lower(p_title)) ~ '^\._' then null
    else (
      select case
        when k = '' or k ~ '^(?:ds store|untitled)$' then null
        else k
      end
      from (
        select btrim(regexp_replace(
          ' ' || regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(btrim(lower(p_title)), '^(copy of\s+)+', ''),
                '(\s+[0-9]+)?(\s*\([0-9]+\))*(-v[0-9]{14})?(\.[a-z0-9]{1,5})?$', ''),
              '([a-z])(?=[0-9])|([0-9])(?=[a-z])', '\1\2 ', 'g'),
            '[^[:alnum:]]+', ' ', 'g') || ' ',
          ' (?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|(?:19|20)[0-9]{2}|[0-9]{2})(?= )',
          '', 'g')) as k
      ) norm
    )
  end
$$;

comment on function public.document_title_key(text) is
  'Version-family key for a document title (#1217, #2099): lower-case; reject macOS AppleDouble resource forks (^\._); strip leading "copy of", trailing " n" / " (n)" copy counters, -vYYYYMMDDHHMMSS backup suffixes and the file extension; split letter/digit runs; collapse punctuation; drop month and 2/4-digit year tokens. Null when nothing is left or when the key is OS/placeholder junk ("ds store", "untitled"). Stored by idx_artifacts_discovered_title_key: changing this body requires a REINDEX of that index in the same migration. Mirrored by packages/mcp-server/src/tools/documentTitleKey.ts. Migrations 119, 150.';

-- 2. Rebuild the expression index on the updated immutable function ----------------

REINDEX INDEX public.idx_artifacts_discovered_title_key;

-- 3. Update document_duplicate_clusters to stay index-only and bound exact_src -----

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
  -- Members read (and ranked) per family or exact hash; see the header.
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
  -- A. The owner's identity (ADR-024; user_preferences.identity, migration 053).
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
  -- `a.source_channel || '' = v_channel` evaluates on the INCLUDE column of
  -- idx_artifacts_discovered_title_key without matching idx_artifacts_user_channel_source.
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
        and (v_channel is null or a.source_channel || '' = v_channel)
        and (v_archived or a.archived = false)
        and public.document_title_key(a.title) is not null
      group by 1
      having count(*) >= v_min
      order by count(*) desc, 1
      limit v_limit
    ) f;
  else
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
      and (v_channel is null or a.source_channel || '' = v_channel)
      and (v_archived or a.archived = false)
      and public.document_title_key(a.title) is not null
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
        and (v_channel is null or a.source_channel || '' = v_channel)
        and (v_archived or a.archived = false)
        and public.document_title_key(a.title) = any (v_seed_keys)
      group by 1
      having count(*) >= v_min
      order by count(*) desc, 1
      limit v_limit
    ) f;
  end if;

  -- C. Members, exact clusters, ranking. Only this statement reads the heap: the
  -- picked family members, the matching titles, and the bounded exact clusters they lead to.
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
        and (v_channel is null or a.source_channel || '' = v_channel)
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
  exact_counts as materialized (
    select
      a.processing_metadata #>> '{discovery,content_hash}' as ckey,
      count(*)::int as n_members
    from public.artifacts a
    where a.user_id = p_user_id
      and a.source_channel like 'discovered\_%'
      and (a.processing_metadata #>> '{discovery,content_hash}') ~ '^[0-9a-f]{32}$'
      and (a.processing_metadata #>> '{discovery,content_hash}') = any (array(select an.h from anchors an))
      and (v_channel is null or a.source_channel || '' = v_channel)
      and (v_archived or a.archived = false)
    group by 1
    having count(*) >= v_min
  ),
  exact_src as materialized (
    select
      ec.ckey,
      p.id, p.title, p.created_at, p.archived, p.archived_reason, p.lifecycle_stage,
      p.source_channel, p.source, p.storage_bucket, p.storage_url,
      p.disc
    from exact_counts ec
    cross join lateral (
      select
        a.id, a.title, a.created_at, a.archived, a.archived_reason, a.lifecycle_stage,
        a.source_channel, a.source, a.storage_bucket, a.storage_url,
        a.processing_metadata -> 'discovery' as disc
      from public.artifacts a
      where a.user_id = p_user_id
        and a.source_channel like 'discovered\_%'
        and (a.processing_metadata #>> '{discovery,content_hash}') ~ '^[0-9a-f]{32}$'
        and (a.processing_metadata #>> '{discovery,content_hash}') = ec.ckey
        and (v_channel is null or a.source_channel || '' = v_channel)
        and (v_archived or a.archived = false)
      order by a.originated_at desc nulls last, a.id
      limit c_family_read
    ) p
  ),
  -- Every cluster that qualifies, with its true size: an exact cluster's is its
  -- count from idx_artifacts_discovered_md5; a family's is its index count from phase B.
  cluster_sizes as (
    select 'exact'::text as kind, ec.ckey, ec.n_members
    from exact_counts ec
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
  'Duplicate report over discovered pointers (#1217, #2099), derived at read (ADR-052): kind exact = same discovery md5 (never the empty-content md5); kind version_family = same document_title_key. With p_query, the clusters a matching title belongs to, whole (SQLSTATE 54000 when more than 2000 titles match); without it, every family, plus the exact clusters the members read for them belong to. Families are counted from idx_artifacts_discovered_title_key alone (including when p_connector filters source_channel via the index INCLUDE payload and when p_query seeds matching titles), and at most 100 members per family or exact hash are read and ranked (ranked_members says how many). At most 50 clusters and 10 members each (member_count is the true size); member_rank 1 is the suggested canonical (newest source modification, then owned-by-self, then enriched). Read by the document_duplicates MCP tool. Migrations 119, 150.';
