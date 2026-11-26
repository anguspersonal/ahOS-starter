-- Migration: Create user_edits table
-- Date: 2025-12-26

-- Create user_edits table
CREATE TABLE user_edits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- What was edited
    edit_type TEXT NOT NULL CHECK (edit_type IN (
        'entity_match_correction',
        'entity_creation_correction',
        'task_completion_correction',
        'task_priority_correction',
        'task_duration_correction',
        'intent_correction',
        'feedback_clarification_needed',
        'feedback_entity_disambiguation',
        'feedback_quality_rating'
    )),
    artifact_id UUID REFERENCES artifacts(id) ON DELETE SET NULL,
    entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    
    -- Before/after values
    original_value JSONB NOT NULL,
    corrected_value JSONB NOT NULL,
    
    -- Context
    confidence_before INTEGER,
    edit_metadata JSONB DEFAULT '{}'::jsonb,
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for user_edits
CREATE INDEX idx_user_edits_user_id ON user_edits(user_id);
CREATE INDEX idx_user_edits_edit_type ON user_edits(edit_type);
CREATE INDEX idx_user_edits_artifact_id ON user_edits(artifact_id);
CREATE INDEX idx_user_edits_entity_id ON user_edits(entity_id);
CREATE INDEX idx_user_edits_created_at ON user_edits(created_at DESC);

-- Enable RLS
ALTER TABLE user_edits ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can view their own edits
CREATE POLICY "Users can view own user_edits"
ON user_edits FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert their own edits
CREATE POLICY "Users can insert own user_edits"
ON user_edits FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can update their own edits (if needed)
CREATE POLICY "Users can update own user_edits"
ON user_edits FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Users can delete their own edits (if needed)
CREATE POLICY "Users can delete own user_edits"
ON user_edits FOR DELETE
USING (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY "Service role can manage user_edits"
ON user_edits
FOR ALL
USING (auth.jwt()->>'role' = 'service_role');

-- Migration complete: user_edits table created

