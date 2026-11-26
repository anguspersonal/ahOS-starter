-- Migration 071: fix fts/hybrid search-function overloads introduced by migration 069.
--
-- Migration 069 (#120 / PR #269) added an `include_archived` parameter to
-- `fts_search_artifacts` and `hybrid_search_artifacts` using CREATE OR REPLACE.
-- Because adding a parameter CHANGES the function signature, Postgres created a
-- SECOND overload of each function rather than replacing the original — leaving two
-- versions live. The new overloads' trailing parameters all have defaults, so an
-- old-arity call (e.g. the 3-arg `fts_search_artifacts(query_text, match_user_id,
-- match_limit)` that the deployed mcp-server sends) matches BOTH candidates and
-- fails with:
--     ERROR 42725: function fts_search_artifacts(...) is not unique
-- breaking keyword and hybrid search in production. (mcp-server unit tests mock the
-- Supabase client, so real function resolution was never exercised in CI.)
--
-- Fix: drop the original (pre-`include_archived`) overloads by explicit signature.
-- Old-arity callers then resolve unambiguously to the remaining functions, where
-- `include_archived` defaults to false — behaviourally identical to before 069.
-- Grants on the surviving functions are identical (anon/authenticated/service_role
-- have EXECUTE), so no re-grant is required.
--
-- Refs #120 / PR #269. Follow-up hardening tracked separately.

drop function if exists public.fts_search_artifacts(text, uuid, integer);
drop function if exists public.hybrid_search_artifacts(text, vector, uuid, integer, double precision, double precision, integer);
