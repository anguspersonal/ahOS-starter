-- Migration: Create chat_threads and chat_messages tables
-- Purpose: Persist user chat threads and messages for AI chat feature

-- chat_threads: one per conversation, owned by user
CREATE TABLE chat_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_threads_user_id ON chat_threads(user_id);
CREATE INDEX idx_chat_threads_updated_at ON chat_threads(user_id, updated_at DESC);

ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own chat_threads"
ON chat_threads FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chat_threads"
ON chat_threads FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chat_threads"
ON chat_threads FOR UPDATE
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own chat_threads"
ON chat_threads FOR DELETE
USING (auth.uid() = user_id);

-- chat_messages: messages within a thread
CREATE TABLE chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_chat_messages_thread_id ON chat_messages(thread_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(thread_id, created_at);

ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

-- Allow access only to messages in threads owned by the user
CREATE POLICY "Users can view messages in own threads"
ON chat_messages FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM chat_threads t
        WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid()
    )
);

CREATE POLICY "Users can insert messages in own threads"
ON chat_messages FOR INSERT
WITH CHECK (
    EXISTS (
        SELECT 1 FROM chat_threads t
        WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid()
    )
);

CREATE POLICY "Users can update messages in own threads"
ON chat_messages FOR UPDATE
USING (
    EXISTS (
        SELECT 1 FROM chat_threads t
        WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid()
    )
)
WITH CHECK (
    EXISTS (
        SELECT 1 FROM chat_threads t
        WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid()
    )
);

CREATE POLICY "Users can delete messages in own threads"
ON chat_messages FOR DELETE
USING (
    EXISTS (
        SELECT 1 FROM chat_threads t
        WHERE t.id = chat_messages.thread_id AND t.user_id = auth.uid()
    )
);

-- Trigger to keep thread updated_at in sync
CREATE OR REPLACE FUNCTION chat_threads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE chat_threads SET updated_at = NOW() WHERE id = NEW.thread_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_messages_updated_at
    AFTER INSERT ON chat_messages
    FOR EACH ROW
    EXECUTE FUNCTION chat_threads_updated_at();
