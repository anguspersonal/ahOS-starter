-- Migration: Create storage RLS policies for user-uploads bucket
-- Date: 2025-12-26
-- Purpose: Set up Row Level Security policies for storage.objects to allow users to manage their own files

-- =============================================
-- STORAGE POLICIES FOR user-uploads BUCKET
-- =============================================

-- Users can upload to their own folder
-- Files must be in a folder named with the user's UUID
CREATE POLICY "Users can upload to own folder"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'user-uploads' 
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Users can view own files
CREATE POLICY "Users can view own files"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'user-uploads' 
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Users can update own files
CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE
USING (
    bucket_id = 'user-uploads' 
    AND auth.uid()::text = (storage.foldername(name))[1]
)
WITH CHECK (
    bucket_id = 'user-uploads' 
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Users can delete own files
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
USING (
    bucket_id = 'user-uploads' 
    AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Service role full access (for worker/backend operations)
CREATE POLICY "Service role full access storage"
ON storage.objects FOR ALL
USING (auth.jwt() ->> 'role' = 'service_role');

-- Migration complete: Storage RLS policies created for user-uploads bucket

