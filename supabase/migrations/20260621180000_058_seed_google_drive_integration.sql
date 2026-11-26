-- 058: seed a user_integrations row for Google Drive for all existing users.
-- Auth is via GOOGLE_REFRESH_TOKEN env var — no secrets here. The row acts as a
-- feature flag so get_integrations surfaces 'google_drive'.
INSERT INTO user_integrations (user_id, provider, config, enabled)
SELECT id, 'google_drive', '{}'::jsonb, true
FROM auth.users
ON CONFLICT (user_id, provider) DO NOTHING;
