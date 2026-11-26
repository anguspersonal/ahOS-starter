-- Migration: Create system_learning table
-- Date: 2025-12-26

-- Create system_learning table
CREATE TABLE system_learning (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- What was learned
    learning_type TEXT NOT NULL CHECK (learning_type IN (
        'entity_matching_preference',
        'entity_creation_preference',
        'task_priority_pattern',
        'task_duration_estimate',
        'intent_classification_hint',
        'entity_context_pattern',
        'disambiguation_preference',
        'threshold_preference'
    )),
    pattern TEXT NOT NULL,
    
    -- Pattern data
    pattern_data JSONB NOT NULL,
    
    -- Confidence & frequency
    confidence DECIMAL(3,2) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    observation_count INTEGER DEFAULT 1,
    success_count INTEGER DEFAULT 0,
    failure_count INTEGER DEFAULT 0,
    
    -- Metadata
    learned_from_edits UUID[] DEFAULT '{}',
    last_observed_at TIMESTAMPTZ DEFAULT NOW(),
    archived BOOLEAN DEFAULT false,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for system_learning
CREATE INDEX idx_system_learning_user_id ON system_learning(user_id);
CREATE INDEX idx_system_learning_learning_type ON system_learning(learning_type);
CREATE INDEX idx_system_learning_confidence ON system_learning(confidence);
CREATE INDEX idx_system_learning_pattern ON system_learning(pattern);
CREATE INDEX idx_system_learning_archived ON system_learning(archived);

-- Auto-update trigger for updated_at
CREATE OR REPLACE FUNCTION update_system_learning_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_system_learning_updated_at
  BEFORE UPDATE ON system_learning
  FOR EACH ROW
  EXECUTE FUNCTION update_system_learning_updated_at();

-- Enable RLS
ALTER TABLE system_learning ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can view their own learning records
CREATE POLICY "Users can view own system_learning"
ON system_learning FOR SELECT
USING (auth.uid() = user_id);

-- Users can insert their own learning records
CREATE POLICY "Users can insert own system_learning"
ON system_learning FOR INSERT
WITH CHECK (auth.uid() = user_id);

-- Users can update their own learning records
CREATE POLICY "Users can update own system_learning"
ON system_learning FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Users can delete their own learning records
CREATE POLICY "Users can delete own system_learning"
ON system_learning FOR DELETE
USING (auth.uid() = user_id);

-- Service role can manage all learning records
CREATE POLICY "Service role can manage system_learning"
ON system_learning
FOR ALL
USING (auth.jwt()->>'role' = 'service_role');

-- Migration complete: system_learning table created

