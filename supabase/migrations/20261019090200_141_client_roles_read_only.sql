-- Migration 141: revoke client-role write privileges on public tables
-- Issue: #1450 (browser roles keep SELECT only on public tables, enforced by a client-writes guard)
-- Refs:  ADR-100 §2 (unified action wrapper; every mutation flows through /api/actions) ·
--        migration 094 (#522 — revoked client writes on scheduler_locks and scheduler_runs) ·
--        migration 121 (#1227 — enabled RLS and revoked client access on six system tables)
--
-- Browser roles (`anon` and `authenticated`) keep SELECT under RLS on `public`
-- tables, while INSERT, UPDATE, DELETE and TRUNCATE are revoked on every
-- existing `public` table and on default table privileges for role `postgres`
-- in `public`. It grants nothing, drops no policy and leaves `service_role`
-- alone.

SET statement_timeout = '15s';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon, authenticated;
