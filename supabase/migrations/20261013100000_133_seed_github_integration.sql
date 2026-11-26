-- Migration 133: Seed user_integrations row for GitHub integration (ADR-106 / #1729).
-- Allows automated fault reporting via github_issue_create for unattended ritual runs.
-- Auth is via GITHUB_TOKEN_ISSUES env var — no secrets here.

SET statement_timeout = '15s';

INSERT INTO public.user_integrations (user_id, provider, routing, status, enabled, config)
SELECT
    id,
    'github',
    'native',
    'connected',
    true,
    jsonb_build_object(
        'issue_repos', jsonb_build_array('anguspersonal/ahOS'),
        'default_repo', 'anguspersonal/ahOS'
    )
FROM auth.users
ON CONFLICT (user_id, provider) DO UPDATE
SET config = user_integrations.config || EXCLUDED.config;
