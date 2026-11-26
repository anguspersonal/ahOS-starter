# ADR-005: Edge Function Migration to Service Worker

**Status:** Accepted  
**Date:** 2025-01-XX  
**Deciders:** Architecture Team  
**Tags:** edge-functions, service-worker, migration, architecture

## Context

The system has adopted a new infrastructure with service workers (`packages/worker/`) that handles workflow orchestration. The service worker provides:

- **Workflow Orchestrator** - Executes workflow steps in sequence (upload → create artifact → analyze → organize → extract actions → create derived → finalize)
- **Express Server** - HTTP endpoints for client interactions
- **Direct Database Access** - Uses Supabase client library directly (no need for edge functions as intermediaries)

### Current State

The system currently has multiple Supabase Edge Functions that handle various operations:

1. **`create-artifact`** - Creates artifact records in database
2. **`create-workflow-run`** - Creates workflow run records
3. **`create-derived-artifact`** - Creates derived artifact records
4. **`process-immediate`** - Synchronous AI processing for "Capture and sort now" mode
5. **`check-duplicates`** - Detects potential duplicate artifacts
6. **`create-recommendation`** - Creates system decisions/recommendations
7. **`process-pdf`** - Standalone PDF processing (downloads from storage, calls worker endpoint)
8. **`pdfPageCount`** - Quick PDF page count utility

### Problem Statement

With the service worker infrastructure in place, many edge functions are redundant:

- **Workflow operations** - The orchestrator handles all workflow steps automatically, including artifact creation, derived artifact creation, etc.
- **Client-to-server communication** - Clients can call worker endpoints directly instead of going through edge functions
- **System operations** - System decisions are created by workflow steps directly using Supabase client, not by clients
- **Legacy code paths** - Some edge functions exist for legacy code paths that should be migrated to use workflows

The current architecture has unnecessary layers:
- Client → Edge Function → Worker → Database
- Should be: Client → Worker → Database (or Client → Worker → Orchestrator → Database)

## Decision

**Migrate all workflow-related operations to the service worker and deprecate/remove redundant edge functions.**

### Key Principles

1. **Preferred Pattern:** Use worker's `/api/upload` endpoint with `runOrchestrator: true`, which automatically handles all workflow steps
2. **No Client Endpoints for System Operations:** System decisions are created by workflow steps, not by clients
3. **Deprecate Legacy Code Paths:** Legacy code paths should be deprecated and removed as we move through the implementation plan
4. **Keep Edge Functions Only for Client-Facing, Low-Latency Needs:** Only keep edge functions that provide clear value (e.g., low-latency client-facing operations)

### Edge Functions to Remove

#### 1. `create-artifact`
- **Status:** ❌ **REMOVE** - Handled automatically by orchestrator step 1
- **Migration:** All uploads should use worker `/api/upload` with orchestrator
- **Legacy Support:** Only needed if legacy code paths exist that upload directly to Supabase Storage and need to create artifact separately

#### 2. `create-workflow-run`
- **Status:** ❌ **REMOVE** - Workflows created automatically by upload endpoint before calling orchestrator
- **Migration:** No endpoint needed - workflows are created automatically

#### 3. `create-derived-artifact`
- **Status:** ❌ **REMOVE** - Handled automatically by orchestrator step 5
- **Migration:** No endpoint needed - derived artifacts created automatically during workflow

#### 4. `process-immediate`
- **Status:** ❌ **REMOVE** - Use orchestrator with all steps enabled
- **Migration:** Use worker `/api/upload` with orchestrator (same as regular upload, just runs all steps)

#### 5. `check-duplicates`
- **Status:** ⚠️ **OPTIONAL** - Can be integrated into upload step or standalone validation
- **Migration Strategy:**
  - **Tier 1 (Free, Automatic):** Lightweight metadata check (filename similarity, file size, upload date) - run asynchronously after upload, non-blocking
  - **Tier 2 (Optional, Chargeable):** Hash-based check (SHA256) - user-initiated or scheduled background job
  - See Implementation Plan Section 2.9.1 for details

#### 6. `create-recommendation`
- **Status:** ❌ **REMOVE** - System decisions created by workflow steps directly using Supabase client
- **Migration:** No endpoint needed - workflow steps create decisions directly (already implemented in `createArtifact.ts`)
- **Note:** Web app's `createSystemDecision()` function is unused and should be removed

### Edge Functions to Deprecate (After Migration)

#### 7. `process-pdf`
- **Status:** ⚠️ **DEPRECATE** once all PDFs go through workflows
- **Current:** Edge function downloads PDF from Supabase Storage and calls worker `/api/pdf/process` endpoint
- **Purpose:** Standalone PDF processing (not part of workflow), client-facing with low latency
- **Deprecation Strategy:**
  1. Migrate all PDF uploads to use worker `/api/upload` with orchestrator
  2. Orchestrator calls worker's `/api/pdf/process` endpoint directly (no edge function needed)
  3. Once all PDF processing goes through workflows, mark edge function as deprecated
  4. Remove edge function after migration complete and legacy code paths removed

#### 8. `pdfPageCount`
- **Status:** ⚠️ **DEPRECATE** once all PDFs go through workflows
- **Current:** Quick PDF page count utility
- **Deprecation Strategy:**
  1. If page count needed, add to worker `/api/pdf/process` response or as separate worker endpoint
  2. Once all PDF processing goes through workflows, remove edge function
  3. Legacy code paths should be deprecated and removed as we move through implementation plan

## Consequences

### Positive

✅ **Simplified architecture** - Fewer layers, clearer data flow  
✅ **Better performance** - Direct client-to-worker communication, no edge function overhead  
✅ **Easier maintenance** - Single codebase for workflow logic (worker) instead of split between edge functions and worker  
✅ **Consistent patterns** - All operations go through orchestrator, making behavior predictable  
✅ **Reduced costs** - Fewer edge function invocations  
✅ **Better error handling** - Centralized error handling in worker  
✅ **Easier testing** - Test worker endpoints directly, no need to test edge functions separately

### Negative

❌ **Migration effort** - Requires updating all callers (web app, mobile app, scripts)  
❌ **Breaking changes** - Legacy code paths need to be updated or removed  
❌ **Temporary complexity** - During migration, both edge functions and worker endpoints may exist  
❌ **Loss of edge function benefits** - Edge functions provide low-latency for client-facing operations (but worker can be deployed to edge locations if needed)

### Neutral

- Edge functions can be re-added if needed for specific low-latency requirements
- Worker can be deployed to edge locations if latency becomes an issue
- Legacy code paths should be deprecated and removed as we move through implementation plan

## Implementation Plan

### Phase 1: Primary Migration (Update Upload Flows)
1. Update web app capture panel to use worker `/api/upload` with orchestrator
2. Update `/api/knowledge/capture` route to use worker upload (or deprecate if not needed)
3. Update mobile app to use worker upload
4. Verify all uploads go through orchestrator

### Phase 2: Remove Workflow-Related Edge Functions
1. Verify no callers exist for:
   - `create-artifact` (except legacy paths)
   - `create-workflow-run`
   - `create-derived-artifact`
   - `process-immediate`
   - `create-recommendation`
2. Remove edge functions from `supabase/functions/` directory
3. Update deployment scripts

### Phase 3: Integrate Duplicate Checking
1. Implement Tier 1 (lightweight metadata check) in upload step
2. Implement Tier 2 (hash-based check) as optional user-initiated endpoint or background job
3. Remove `check-duplicates` edge function

### Phase 4: Deprecate Legacy PDF Processing
1. Verify all PDF processing goes through workflows
2. Mark `process-pdf` edge function as deprecated
3. Remove all legacy code paths that call `process-pdf` directly
4. Remove `process-pdf` edge function
5. Mark `pdfPageCount` edge function as deprecated
6. Remove all legacy code paths that call `pdfPageCount` directly
7. Remove `pdfPageCount` edge function

### Phase 5: Cleanup
1. Update web app to remove unused functions (e.g., `createSystemDecision()`)
2. Update documentation (README.md, API docs)
3. Update deployment scripts
4. Verify no broken references remain

## Alternatives Considered

### Alternative 1: Keep Edge Functions as Thin Wrappers
- **Pros:** Maintains existing API, minimal migration effort
- **Cons:** Adds unnecessary layer, doesn't solve the problem, maintains complexity

### Alternative 2: Keep Edge Functions for Client-Facing Operations
- **Pros:** Low latency for client operations
- **Cons:** Worker can be deployed to edge locations if needed, edge functions add complexity

### Alternative 3: Gradual Migration (Keep Both)
- **Pros:** No breaking changes, gradual transition
- **Cons:** Maintains complexity longer, harder to test, confusing for developers

## Notes

- **Legacy Code Paths:** All legacy code paths should be deprecated and removed as we move through the implementation plan
- **System Decisions:** System decisions are created by the system (workflow steps), not by clients. Clients only read and resolve decisions.
- **Workflow Pattern:** The preferred pattern is to use worker `/api/upload` with `runOrchestrator: true`, which handles all workflow steps automatically.
- **Duplicate Checking:** Two-tier approach - lightweight (free, automatic) and hash-based (optional, chargeable).

## References

- Implementation Plan: `docs/Implementation_Plan.md` (Section 2.9.1)
- Worker Orchestrator: `packages/worker/src/workflows/orchestrator.ts`
- Edge Functions: `supabase/functions/`
- Worker Routes: `packages/worker/routes/`

