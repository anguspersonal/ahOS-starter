-- 057: seed a user_integrations row for Dex CRM for all existing users.
-- Auth is via DEX_API_KEY env var — no secrets here. The row acts as a feature
-- flag so get_integrations surfaces 'dex' and future tools can read default_tag_ids.
INSERT INTO user_integrations (user_id, provider, config, enabled)
SELECT id, 'dex', '{"default_tag_ids":[]}'::jsonb, true
FROM auth.users
ON CONFLICT (user_id, provider) DO NOTHING;
