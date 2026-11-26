# ADR008: Type Organization Standardization

## Status
**Accepted** - December 2024

## Context

During codebase analysis, significant duplication of TypeScript types and interfaces was discovered across packages:

1. **Web package duplicates:**
   - `packages/web/types/knowledge.ts` (422 lines) - Duplicate of `packages/shared/src/types/knowledge.ts`
   - `packages/web/types/entities.ts` (96 lines) - Duplicate of `packages/shared/src/types/entities.ts`
   - `UserMode` type duplicated in `packages/web/types/navigation.ts`

2. **Worker package duplicates:**
   - `SystemDecision` interface duplicated in `packages/worker/src/workflows/steps/types.ts` (simpler version, missing fields)
   - Worker package not using `@ahkms/shared` despite having it as a dependency

3. **Impact:**
   - Maintenance burden: Changes to domain types require updates in multiple places
   - Type drift: Duplicate types can diverge over time, causing inconsistencies
   - Confusion: Developers unsure which types to use
   - No clear guidelines for when to add types to shared vs keep local

### Root Cause

The shared package (`@ahkms/shared`) was created to hold domain types, but:
- Web package maintained legacy duplicate files that were never removed
- Worker package defined its own versions instead of using shared types
- No documentation or guidelines existed for type organization

## Decision

**Standardize on `@ahkms/shared` for all domain types. Keep package-specific types local.**

### Implementation

1. **Remove duplicate types from web package:**
   - Delete `packages/web/types/knowledge.ts`
   - Delete `packages/web/types/entities.ts`
   - Remove `UserMode` from `packages/web/types/navigation.ts` (use shared version)

2. **Migrate worker package to use shared types:**
   - Replace worker's `SystemDecision` with shared version
   - Keep worker's `Entity` type (workflow-specific, documented as different from `BaseEntity`)
   - Update all imports to use `@ahkms/shared`

3. **Create documentation:**
   - ADR008 (this document)
   - `docs/TYPE_ORGANIZATION_GUIDE.md` - Evergreen guide for developers
   - `packages/shared/README.md` - Package documentation

4. **Add enforcement:**
   - Script to detect duplicate type definitions
   - ESLint rules (optional, future enhancement)

### Type Organization Principles

**Shared Types (`@ahkms/shared`):**
- Domain types used across multiple packages
- Core business entities: `Artifact`, `SystemDecision`, `UserTask`, `EventItem`
- PARAMPS entity types: `ProjectEntity`, `AreaEntity`, `ResourceEntity`, etc.
- Enums: `LifecycleStage`, `ProcessingStatus`, `DecisionType`, `UserMode`, etc.
- Search and relation types: `GlobalSearchResults`, `EntityWithRelations`

**Package-Specific Types (keep local):**
- Workflow execution types: `WorkflowStep`, `UploadResult`, `OrganizeResult`
- UI-specific types: `NavigationItem`, `PARAMPSItem`
- Platform-specific types: Mobile API types, Stripe integration types
- Validation types: Form validation, entry validation

## Rationale

### Why Shared Types?

1. **Single Source of Truth** - Domain types defined once, used everywhere
2. **Type Safety** - TypeScript ensures consistency across packages
3. **Maintainability** - Changes propagate automatically
4. **Discoverability** - Developers know where to find domain types
5. **Reduced Duplication** - Eliminates ~500+ lines of duplicate code

### Why Keep Some Types Local?

1. **Workflow Execution Types** - Internal to worker, not part of domain model
2. **UI Types** - Web-specific, not relevant to other packages
3. **Platform Types** - Mobile/Stripe types are platform-specific
4. **Separation of Concerns** - Domain types vs implementation details

### Why Not Everything Shared?

- Over-sharing creates unnecessary dependencies
- Package-specific types should remain local for clarity
- Not all types are part of the domain model

## Consequences

### Positive

- Eliminated ~500+ lines of duplicate code
- Single source of truth for domain types
- Clearer type organization guidelines
- Better developer experience (know where to find types)
- Reduced risk of type drift
- Improved maintainability

### Negative

- Migration requires updating imports across packages
- Need to verify type compatibility (especially `SystemDecision` with optional fields)
- Initial effort to consolidate types

### Migration Required

1. **Web Package:**
   - Update `UserModeContext.tsx` to import `UserMode` from `@ahkms/shared`
   - Delete duplicate type files
   - Verify no build errors

2. **Worker Package:**
   - Update `packages/worker/src/workflows/steps/types.ts` to use shared `SystemDecision`
   - Update `OrganizeResult.notificationsCreated` to reference shared type
   - Verify database schema compatibility (description field is nullable in DB, optional in shared type)
   - Update code to handle optional fields when reading from database
   - Consider enum migration (follow-up): worker uses strings, shared uses enums

3. **Documentation:**
   - Create `TYPE_ORGANIZATION_GUIDE.md`
   - Create `packages/shared/README.md`
   - Update `docs/README.md` with references

### Type Compatibility Notes

**SystemDecision Migration:**
- Database schema: `description` is nullable (`TEXT` without `NOT NULL`)
- Shared type: `description?: string | null` (optional) ✅ Compatible
- Worker type: `description: string` (required) - Needs update to handle optional
- Worker uses `Partial<SystemDecision>` for creation, which is safe
- Worker's `OrganizeResult.notificationsCreated: SystemDecision[]` will use shared type after migration

**Enum vs String Types:**
- Worker currently uses `string` for `decision_type`, `stage`, `status`, `review_type`
- Shared uses enum types: `DecisionType`, `ProcessingStage`, `DecisionStatus`, `ReviewType`
- Migration to enums can be a follow-up task for better type safety

## Related

- `docs/TYPE_ORGANIZATION_GUIDE.md` - Evergreen guide for type organization
- `packages/shared/README.md` - Shared package documentation
- `docs/TYPES_AND_INTERFACES_ANALYSIS.md` - Original analysis (superseded by this ADR and guide)
- Migration: Type consolidation implementation (see plan)

