# ADR-007: Unified Upload Architecture

**Status:** Accepted  
**Date:** 2025-12-27  
**Accepted-on-dev:** 2025-12-27  
**Deciders:** Architecture Team  
**Tags:** upload, storage, worker, architecture, rls

## Context

The system has multiple upload implementations across different packages:

### Current State

1. **Web Package** (`packages/web/`):
   - ❌ `app/api/knowledge/upload/route.ts` — **REMOVED** (legacy direct-to-Supabase route)
   - ✅ `app/api/knowledge/capture/route.ts` — Multi-format capture (proxies to worker)
   - ✅ `app/api/knowledge/reupload/route.ts` — Re-upload for existing artifacts
   - ✅ All uploads now go through `/api/knowledge/capture` → worker service
   - ✅ Worker handles storage, bucket selection, and retry logic

2. **Mobile Package** (`packages/mobile/`):
   - `app/services/artifacts/offlineQueue.ts` — Offline queue (MMKV storage, max 100 items)
   - `app/services/artifacts/syncService.ts` — Sync service for queued items
   - `app/services/artifacts/artifactService.ts` — Artifact creation via Edge Function
   - Uses `raw-inputs` bucket, date-based paths

3. **Worker Package** (`packages/worker/`):
   - No upload implementation yet
   - Planned in `packages/worker/src/workflows/steps/upload.ts`

### Problem Statement

The current architecture has several issues:

- **Code Duplication**: Upload logic exists in multiple places (web, mobile, potentially worker)
- **Inconsistent Storage**: Different buckets (`raw-inputs` vs planned `user-uploads`), different path structures
- **Security Concerns**: Public URLs used instead of signed URLs, no RLS enforcement
- **No Server-Side Retry**: Only client-side retry exists (mobile offline queue), no server-side retry for storage errors
- **Maintenance Burden**: Changes to upload logic require updates in multiple places

### Architecture Clarification: Client-Side vs Server-Side

**Important Distinction:**
- **Client-Side Offline**: Mobile device queues captures when device has no internet (handled by `offlineQueue.ts`)
- **Server-Side Retry**: Worker retries uploads that fail after reaching server (storage errors, network timeouts, etc.)

The worker cannot handle device offline state (the request never reaches the server). Mobile's `offlineQueue.ts` must stay in mobile for client-specific offline handling.

## Decision

**Unify all upload logic in the worker package and make web/mobile clients thin clients that call the worker API.**

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        TARGET ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   WEB CLIENT                      MOBILE CLIENT                     │
│   ┌─────────────┐                 ┌─────────────────────────┐       │
│   │ Thin Client │                 │ Thin Client             │       │
│   │ (No upload  │                 │ ┌─────────────────────┐ │       │
│   │  logic)     │                 │ │ Offline Queue       │ │       │
│   └──────┬──────┘                 │ │ (offlineQueue.ts)   │ │       │
│          │                        │ │ STAYS IN MOBILE     │ │       │
│          │                        │ └──────────┬──────────┘ │       │
│          │                        └────────────┼────────────┘       │
│          │                                     │                    │
│          │ Online                    Online    │ Sync when online   │
│          ▼                              ▼      ▼                    │
│   ┌─────────────────────────────────────────────────────────┐       │
│   │                    WORKER API                           │       │
│   │  executeUploadStep()                                    │       │
│   │  - user-uploads bucket (RLS-protected)                  │       │
│   │  - userId/timestamp_filename path                       │       │
│   │  - Server-side retry (3 attempts, exponential backoff)  │       │
│   │  - Signed URLs (not public URLs)                        │       │
│   │  - File validation (50MB, MIME types)                   │       │
│   │  - Workflow step tracking                               │       │
│   └─────────────────────────────────────────────────────────┘       │
│                              │                                      │
│                              ▼                                      │
│   ┌─────────────────────────────────────────────────────────┐       │
│   │              SUPABASE STORAGE                           │       │
│   │  Bucket: user-uploads                                   │       │
│   │  RLS: Users can only access their own folder            │       │
│   └─────────────────────────────────────────────────────────┘       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Decisions

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| **Worker** | Single source of truth for upload logic | Centralized, secure, maintainable |
| **Web** | Remove upload logic, call worker API | Thin client, no duplication |
| **Mobile** | Call worker API when online, local queue when offline | Keep existing offline support |
| **Bucket** | `user-uploads` (not `raw-inputs`) | RLS compatibility |
| **Path** | `userId/timestamp_filename` | User isolation for RLS |
| **Retry** | 3 attempts, exponential backoff (2s, 4s, 8s) | Server-side error recovery |
| **URLs** | Signed URLs only (not public URLs) | Security |

### Implementation Details

#### Storage Bucket

- **Bucket Name**: `user-uploads` (replaces `raw-inputs`)
- **Visibility**: Private with RLS policies
- **RLS Policies**: User-scoped (users can only access their own folder)
- **Access Control**: RLS enforced, not service role

#### File Path Structure

- **Pattern**: `userId/timestamp_filename` (replaces `YYYY/MM/DD/filename`)
- **User Isolation**: Explicit (enables RLS policies)
- **RLS Compatible**: Yes

#### Retry Logic

- **Server-Side Retry**: 3 attempts with exponential backoff (2s, 4s, 8s)
- **Client-Side Queue**: Mobile's `offlineQueue.ts` stays in mobile (handles device offline)

#### File Size Limits

- **Limit**: 50MB (standardized across all clients)

#### URL Generation

- **Public URLs**: Not used
- **Signed URLs**: Yes (for temporary access when needed)

## Consequences

### Positive

✅ **Centralized Logic** - Single source of truth for upload logic in worker  
✅ **Better Security** - RLS policies enforce user isolation, signed URLs instead of public  
✅ **Consistent Behavior** - All clients use same upload logic  
✅ **Easier Maintenance** - Changes to upload logic in one place  
✅ **Server-Side Retry** - Handles storage errors and network timeouts  
✅ **Better Error Handling** - Centralized error handling and user notifications  
✅ **RLS Compatible** - Path structure enables proper RLS policies

### Negative

❌ **Migration Effort** - Requires updating web and mobile clients  
❌ **Breaking Changes** - Bucket change, path change, no public URLs  
❌ **Temporary Complexity** - During migration, both old and new paths may exist  
❌ **Network Dependency** - Web client requires network (no offline support, unlike mobile)

### Neutral

- Mobile's offline queue remains in mobile (client-side offline support)
- Existing files in `raw-inputs` remain accessible (backward compatibility during migration)
- Worker can support both path structures if needed during migration

## Implementation Plan

### Phase 1: Worker Implementation

1. **Implement `executeUploadStep()`** in `packages/worker/src/workflows/steps/upload.ts`:
   - Use `user-uploads` bucket
   - Use `userId/timestamp_filename` path structure
   - Implement server-side retry (3 attempts, exponential backoff: 2s, 4s, 8s)
   - Use signed URLs (not public URLs)
   - Validate files (50MB, allowed MIME types)
   - Track workflow step progress
   - Create user notifications for failures

2. **Create worker API endpoint** for uploads:
   - Accept file + metadata from clients
   - Call `executeUploadStep()` internally
   - Return upload result (objectPath, metadata, or error)

3. **Update Implementation Plan**:
   - Remove `hasWiFi()` from worker (doesn't apply to server)
   - Clarify that offline support is client-side only

### Phase 2: Client Migration

1. **Web**:
   - Update to call worker API instead of local upload logic
   - Remove `upload/route.ts` and `capture/route.ts`
   - Update `reupload/route.ts` to use worker

2. **Mobile**:
   - Update `artifactService.ts` to call worker API
   - Update `syncService.ts` to call worker API for sync
   - Keep `offlineQueue.ts` as-is (client-side offline)

### Phase 3: Cleanup

1. Remove deprecated web endpoints
2. Archive old implementations
3. Update documentation

## What to Keep, Remove, and Implement

### Keep (Don't Remove)

| File | Package | Reason |
|------|---------|--------|
| `offlineQueue.ts` | Mobile | Client-side offline support (device-specific) |
| `syncService.ts` | Mobile | Sync service (update to call worker API) |
| Storage utilities | Mobile | MMKV storage for local queue |

### Remove (After Migration)

| File | Package | Reason | Status |
|------|---------|--------|--------|
| `upload/route.ts` | Web | Replaced by worker API | ✅ **REMOVED** |
| Upload logic in `api.ts` (`uploadFileToStorage()`) | Web | Replaced by worker API call | ✅ **REMOVED** |
| `capture/route.ts` | Web | **KEEP** - Proxies to worker API | ✅ **KEPT** (primary upload path) |

### Update (Migrate)

| File | Package | Change |
|------|---------|--------|
| `artifactService.ts` | Mobile | Call worker API instead of Edge Function |
| `syncService.ts` | Mobile | Call worker API for sync |
| `reupload/route.ts` | Web | Call worker API for re-uploads |

### Implement (New)

| File | Package | Purpose |
|------|---------|---------|
| `upload.ts` | Worker | `executeUploadStep()` with full upload logic |
| Upload API endpoint | Worker | HTTP endpoint for web/mobile clients |

## Migration Considerations

### Backward Compatibility

During migration:
- Keep existing endpoints working until clients are updated
- Worker can support both path structures if needed
- Existing files in `raw-inputs` remain accessible

### Breaking Changes

1. **Bucket Change**: New uploads go to `user-uploads`, not `raw-inputs`
2. **Path Change**: New uploads use `userId/timestamp_filename`, not date-based
3. **No Public URLs**: Clients must request signed URLs

### Testing Strategy

1. **Worker Tests**: Retry logic, validation, path generation
2. **Integration Tests**: Upload flow, RLS enforcement
3. **Client Tests**: Mobile offline queue, sync service
4. **E2E Tests**: Full upload workflow (web/mobile → worker → storage)

## Alternatives Considered

### Alternative 1: Keep Separate Implementations
- **Pros**: No migration effort
- **Cons**: Code duplication, inconsistent behavior, maintenance burden

### Alternative 2: Move Logic to Shared Package
- **Pros**: Single codebase
- **Cons**: Doesn't solve server-side retry, still need worker for workflow integration

### Alternative 3: Use Edge Functions for Upload
- **Pros**: Low latency, edge deployment
- **Cons**: Doesn't integrate with workflow orchestrator, adds another layer

## Notes

- **Client-Side vs Server-Side**: Client-side offline support (mobile's `offlineQueue.ts`) is different from server-side retry logic (worker's exponential backoff). Both are needed, but in different places.
- **Worker Responsibilities**: Server-side retry, file validation, upload to `user-uploads` bucket, signed URL generation, workflow step tracking, user notifications for failures
- **NOT Worker Responsibilities**: `hasWiFi()` (client-side), `saveToLocalStorage()` (client-side)
- **Mobile Responsibilities**: Detect offline state, queue locally when offline, sync when online

## References

- Implementation Plan: `docs/Implementation_Plan.md` (Section 2.1, Step 0: Upload)
- Step Documentation: `docs/Step00_Upload.md`
- Storage Migration: `supabase/migrations/20251226235145_023_create_storage_policies.sql`
- Worker Upload Step: `packages/worker/src/workflows/steps/upload.ts`
- Mobile Offline Queue: `packages/mobile/app/services/artifacts/offlineQueue.ts`
- Mobile Sync Service: `packages/mobile/app/services/artifacts/syncService.ts`

