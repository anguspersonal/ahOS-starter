-- Migration 121: Enable Row Level Security (RLS) on internal system tables
-- Closes #1227 and #790
-- Secures six public tables that had RLS disabled:
--   scheduler_runs, scheduler_locks, workflow_steps,
--   training_examples, discovered_patterns, teams
-- Access is restricted to service_role only (PostgREST anon and authenticated access revoked).

SET statement_timeout = '15s';

-- 1. Drop inert policies on workflow_steps from migration 013
DROP POLICY IF EXISTS "Users can view own workflow steps" ON public.workflow_steps;
DROP POLICY IF EXISTS "Users can insert own workflow steps" ON public.workflow_steps;
DROP POLICY IF EXISTS "Users can update own workflow steps" ON public.workflow_steps;
DROP POLICY IF EXISTS "Users can delete own workflow steps" ON public.workflow_steps;

-- 2. Enable Row Level Security on all six tables
ALTER TABLE public.scheduler_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduler_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discovered_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;

-- 3. Revoke all access from anon and authenticated roles
REVOKE ALL ON TABLE public.scheduler_runs FROM anon, authenticated;
REVOKE ALL ON TABLE public.scheduler_locks FROM anon, authenticated;
REVOKE ALL ON TABLE public.workflow_steps FROM anon, authenticated;
REVOKE ALL ON TABLE public.training_examples FROM anon, authenticated;
REVOKE ALL ON TABLE public.discovered_patterns FROM anon, authenticated;
REVOKE ALL ON TABLE public.teams FROM anon, authenticated;

-- 4. Explicitly ensure service_role has full access
GRANT ALL ON TABLE public.scheduler_runs TO service_role;
GRANT ALL ON TABLE public.scheduler_locks TO service_role;
GRANT ALL ON TABLE public.workflow_steps TO service_role;
GRANT ALL ON TABLE public.training_examples TO service_role;
GRANT ALL ON TABLE public.discovered_patterns TO service_role;
GRANT ALL ON TABLE public.teams TO service_role;

-- 5. Add explanatory table comments
COMMENT ON TABLE public.scheduler_runs IS 'Internal scheduler run history. RLS enabled, service-role only access.';
COMMENT ON TABLE public.scheduler_locks IS 'Internal scheduler locks. RLS enabled, service-role only access.';
COMMENT ON TABLE public.workflow_steps IS 'Internal workflow execution steps. RLS enabled, service-role only access.';
COMMENT ON TABLE public.training_examples IS 'Internal system learning training examples. RLS enabled, service-role only access.';
COMMENT ON TABLE public.discovered_patterns IS 'Internal system learning discovered patterns. RLS enabled, service-role only access.';
COMMENT ON TABLE public.teams IS 'Teams table. RLS enabled, service-role only access.';
