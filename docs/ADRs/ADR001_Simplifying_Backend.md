# ADR-001: Simplifying Backend by Removing Teams

**Status:** Accepted  
**Date:** 2025-12-24  
**Accepted-on-dev:** 2025-12-24  
**Deciders:** Architecture Team  
**Tags:** database, simplification, multi-tenancy

## Context

The current system includes a multi-tenant team-based architecture with the following components:

- **`teams` table** - Stores team/organization records with Stripe billing information
- **`team_members` table** - Associates users with teams and roles
- **`invitations` table** - Tracks team invitation workflows
- **Foreign key references** - `artifacts`, `entities`, and `activity_logs` tables reference `team_id`

### Current State

The system was originally designed to support team collaboration, but:
1. The team functionality is not actively used in the current product vision
2. It adds complexity to queries (requiring team context in RLS policies)
3. Billing has been moved to user-level subscriptions (`subscriptions` table)
4. The codebase complexity is increased without clear benefit

### Problem Statement

The team-based architecture adds unnecessary complexity:
- All queries must consider team context
- RLS policies must account for team membership
- Data isolation logic is more complex than needed
- Maintenance burden without clear product value

## Decision

**Remove team-based multi-tenancy and simplify to user-scoped data isolation.**

### Changes Required

1. **Remove team-related tables:**
   - Drop `teams` table
   - Drop `team_members` table
   - Drop `invitations` table

2. **Remove team references from existing tables:**
   - Remove `team_id` column from `artifacts` table
   - Remove `team_id` column from `entities` table
   - Remove `team_id` column from `activity_logs` table

3. **Update RLS policies:**
   - Simplify policies to use `user_id` only
   - Remove team membership checks from all policies

4. **Update application code:**
   - Remove team-related queries and logic
   - Simplify data access patterns to user-scoped only
   - Update API endpoints to remove team context

5. **Migrate existing data:**
   - Ensure all artifacts/entities are properly associated with `user_id`
   - Archive or migrate any team-level data if needed

## Consequences

### Positive

✅ **Simplified architecture** - Easier to understand and maintain  
✅ **Simpler queries** - No need to join team tables or check membership  
✅ **Faster development** - Less code to write and maintain  
✅ **Clearer data model** - Direct user-to-data relationships  
✅ **Easier RLS policies** - User-scoped policies are straightforward  
✅ **Reduced complexity** - Fewer tables and relationships to manage

### Negative

❌ **No team collaboration** - Cannot share artifacts/entities between users  
❌ **Migration effort** - Requires database migration and code updates  
❌ **Potential data loss** - Need careful migration of existing team data  
❌ **Breaking change** - Requires coordinated deployment

### Neutral

- Billing already moved to user-level (`subscriptions` table)
- Future team features can be re-added if needed (with proper design)
- Individual user accounts remain fully functional

## Implementation Plan

### Phase 1: Database Migration
1. Create migration to:
   - Remove `team_id` foreign keys from `artifacts`, `entities`, `activity_logs`
   - Drop `invitations` table
   - Drop `team_members` table
   - Drop `teams` table
   - Update any indexes or constraints

### Phase 2: Code Updates
1. Update Edge Functions to remove team context
2. Update Express server routes to remove team checks
3. Update Next.js app to remove team UI/logic
4. Update Mobile app to remove team features
5. Update RLS policies in Supabase

### Phase 3: Testing & Validation
1. Verify all user-scoped queries work correctly
2. Test RLS policies enforce user isolation
3. Validate no broken references remain
4. Test data migration preserved user data

### Phase 4: Documentation
1. Update `DATABASE_SCHEMA_SUMMARY.md`
2. Update architecture diagrams
3. Update API documentation
4. Update deployment guides

## Alternatives Considered

### Alternative 1: Keep Teams but Simplify
- **Pros:** Preserves future team features
- **Cons:** Maintains unnecessary complexity, unused features

### Alternative 2: Soft Delete Teams
- **Pros:** Can restore if needed
- **Cons:** Still maintains complexity, unclear when to remove

### Alternative 3: User-Level Teams (1:1)
- **Pros:** Minimal code changes
- **Cons:** Doesn't solve the complexity problem, misleading abstraction

## Notes

- This decision aligns with the current product focus on individual knowledge management
- Team collaboration can be re-added in the future if product requirements change
- The `subscriptions` table already supports user-level billing, so no billing migration needed
- All user data remains intact - only team relationships are removed

## References

- Database Schema: `supabase/DATABASE_SCHEMA_SUMMARY.md`
- Architecture Diagram: `docs/ARCHITECTURE_DIAGRAM.md`

