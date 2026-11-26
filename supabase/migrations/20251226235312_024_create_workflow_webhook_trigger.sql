-- Migration: Create workflow webhook trigger
-- Date: 2025-12-26
-- Purpose: Set up webhook notification when workflows are created with 'pending' status

-- Enable HTTP extension for webhooks (if not already enabled)
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA extensions;

-- =============================================
-- WORKFLOW WEBHOOK FUNCTION
-- =============================================

CREATE OR REPLACE FUNCTION notify_workflow_created()
RETURNS trigger 
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    webhook_url text;
    webhook_secret text;
BEGIN
    -- Get worker URL from environment (set in Supabase dashboard)
    -- This should be set via: ALTER DATABASE postgres SET app.settings.worker_url = 'https://your-worker.railway.app';
    webhook_url := current_setting('app.settings.worker_url', true);
    webhook_secret := current_setting('app.settings.webhook_secret', true);
    
    -- Only send webhook if URL is configured
    IF webhook_url IS NOT NULL AND webhook_url != '' THEN
        PERFORM
            extensions.http_post(
                url := webhook_url || '/webhooks/workflow-created',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'X-Webhook-Secret', COALESCE(webhook_secret, '')
                ),
                body := jsonb_build_object(
                    'workflowId', NEW.id,
                    'userId', NEW.user_id,
                    'type', NEW.workflow_type,
                    'artifactId', NEW.source_artifact_id,
                    'timestamp', NOW()
                )::text
            );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- WORKFLOW WEBHOOK TRIGGER
-- =============================================

CREATE TRIGGER workflow_created_webhook
AFTER INSERT ON workflows
FOR EACH ROW
WHEN (NEW.status = 'pending')
EXECUTE FUNCTION notify_workflow_created();

-- Migration complete: Workflow webhook trigger created
-- Note: Configure app.settings.worker_url and app.settings.webhook_secret in Supabase dashboard
