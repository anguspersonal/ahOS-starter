-- Migration: Create system_jobs table
-- Date: 2025-12-26

-- Create system_jobs table
CREATE TABLE system_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    
    -- Job info
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'processing', 'completed', 'failed', 'cancelled'
    )),
    priority INTEGER DEFAULT 5,
    
    -- Job data
    payload JSONB NOT NULL,
    
    -- Retry logic
    max_retries INTEGER DEFAULT 3,
    current_attempt INTEGER DEFAULT 0,
    
    -- Scheduling
    scheduled_for TIMESTAMPTZ DEFAULT NOW(),
    last_attempt_at TIMESTAMPTZ,
    
    -- Error tracking
    error_log TEXT[],
    
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- Indexes for performance
CREATE INDEX idx_system_jobs_user_id ON system_jobs(user_id);
CREATE INDEX idx_system_jobs_status ON system_jobs(status);
CREATE INDEX idx_system_jobs_type ON system_jobs(type);
CREATE INDEX idx_system_jobs_scheduled_for ON system_jobs(scheduled_for);
CREATE INDEX idx_system_jobs_pending ON system_jobs(scheduled_for, status) 
    WHERE status IN ('pending', 'processing');

-- Auto-update trigger for updated_at
CREATE OR REPLACE FUNCTION update_system_jobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_system_jobs_updated_at
  BEFORE UPDATE ON system_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_system_jobs_updated_at();

-- Enable RLS
ALTER TABLE system_jobs ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Users can manage their own jobs
CREATE POLICY "Users can view own system_jobs"
ON system_jobs FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own system_jobs"
ON system_jobs FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own system_jobs"
ON system_jobs FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own system_jobs"
ON system_jobs FOR DELETE
USING (auth.uid() = user_id);

-- Service role full access
CREATE POLICY "Service role full access system_jobs"
ON system_jobs FOR ALL
USING (auth.jwt()->>'role' = 'service_role');

-- Migration complete: system_jobs table created with unified schema

