-- Migration: Add atomic token increment function
-- Fixes race condition in token usage tracking by using atomic database increment

CREATE OR REPLACE FUNCTION increment_workflow_tokens(
  p_workflow_id UUID,
  p_tokens INTEGER
) RETURNS VOID AS $$
BEGIN
  UPDATE workflows
  SET tokens_used = COALESCE(tokens_used, 0) + p_tokens
  WHERE id = p_workflow_id;
END;
$$ LANGUAGE plpgsql;

-- Add comment for documentation
COMMENT ON FUNCTION increment_workflow_tokens(UUID, INTEGER) IS 
  'Atomically increments tokens_used for a workflow. Prevents race conditions when multiple steps update tokens concurrently.';
