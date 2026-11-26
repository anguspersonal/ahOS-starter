-- Migration: Remove get_review_backlog RPC function
-- Date: 2025-12-31
-- Description: Removes the get_review_backlog RPC function as it has been replaced by the worker endpoint
-- This aligns with ADR-005 architecture decision (Client → Worker → Database)

-- Drop the RPC function
DROP FUNCTION IF EXISTS public.get_review_backlog(uuid, boolean) CASCADE;

