# ADR-002: Consolidating PDF Converter Service into Express Server

**Status:** Accepted  
**Date:** 2025-12-24  
**Accepted-on-dev:** 2025-12-24  
**Deciders:** Architecture Team  
**Tags:** pdf-processing, consolidation, express-server, docker

## Context

The system originally had a standalone PDF processing service (`converter/`) deployed as a separate Cloud Run service. This service handled:
- PDF type detection (scanned vs text-based)
- Text extraction using `pdftotext`
- Image conversion using `pdftoppm` (poppler-utils)
- Unified `/process` endpoint that auto-detects and processes PDFs

### Current State

The PDF processing service was:
- Deployed separately on Cloud Run
- Required separate Docker image with poppler-utils
- Called by Supabase Edge Functions (`process-pdf`)
- Managed separately from the main Express server

### Problem Statement

Maintaining a separate service added complexity:
- Separate deployment pipeline
- Separate Docker image to maintain
- Additional infrastructure costs
- More complex environment variable management
- Code duplication potential between services

## Decision

**Consolidate the PDF converter service into the Express server as a new route and service module.**

### Changes Made

1. **Moved PDF processing logic:**
   - `converter/server.js` → `packages/worker/src/services/pdf/processor.js`
   - Core processing functions extracted into reusable service module

2. **Created Express routes:**
   - `packages/worker/routes/api/pdf.js` - New route handler
   - Endpoints: `/api/pdf/process`, `/api/pdf/detect`, `/api/pdf/convert`
   - Maintains backward compatibility with existing Edge Function calls

3. **Updated Express app:**
   - `packages/worker/app.js` - Added raw body parser for PDF binary data
   - Mounted PDF routes at `/api/pdf`

4. **Consolidated Dockerfile:**
   - `converter/Dockerfile` → `packages/worker/Dockerfile`
   - Includes poppler-utils installation
   - Single deployment target for all server functionality

5. **Updated Edge Function:**
   - `supabase/functions/process-pdf/index.ts` - Now calls `SERVER_URL/api/pdf/process`
   - Changed from `PDF_HANDLER_URL` to `SERVER_URL` environment variable

6. **Archived old service:**
   - Moved `converter/` directory to `archive/converter-deprecated/`
   - Preserved for reference and rollback if needed

## Consequences

### Positive

✅ **Simplified deployment** - Single Docker image for Express server  
✅ **Reduced infrastructure** - One service instead of two  
✅ **Easier maintenance** - PDF processing code alongside workflow code  
✅ **Better code organization** - Service module pattern in `src/services/pdf/`  
✅ **Cost reduction** - Fewer Cloud Run instances to manage  
✅ **Unified logging** - All server operations in one place

### Negative

❌ **Larger Docker image** - Includes poppler-utils dependencies  
❌ **Single point of failure** - PDF processing tied to main server  
❌ **Resource contention** - PDF processing competes with workflow execution  
❌ **Migration effort** - Required updating Edge Functions and environment variables

### Neutral

- Backward compatibility maintained via same API contract
- Edge Functions still act as proxy layer (can be optimized later)
- PDF processing remains isolated as a service module

## Implementation Details

### Service Module Structure

```
packages/worker/
├── src/services/pdf/
│   └── processor.js          # Core PDF processing logic
├── routes/api/
│   └── pdf.js                # Express route handlers
└── Dockerfile                # Includes poppler-utils
```

### API Endpoints

- **POST `/api/pdf/process`** - Unified processing (detects type, returns text or images)
- **POST `/api/pdf/detect`** - Legacy type detection endpoint
- **POST `/api/pdf/convert`** - Legacy conversion endpoint

### Authentication

- Uses shared secret via `X-PDF-Handler-Secret` or `X-Converter-Secret` header
- Environment variable: `PDF_HANDLER_SECRET` or `CONVERTER_SHARED_SECRET`

### Docker Requirements

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils
```

## Alternatives Considered

### Alternative 1: Keep Separate Service
- **Pros:** Isolation, independent scaling
- **Cons:** More complexity, higher costs, maintenance burden

### Alternative 2: Move to Edge Functions
- **Pros:** No separate service needed
- **Cons:** poppler-utils not available in Deno Edge Functions, timeout limits

### Alternative 3: Use External PDF Service
- **Pros:** No maintenance, managed service
- **Cons:** Cost, vendor lock-in, less control

## Notes

- The unified `/process` endpoint maintains the same response format as before
- Edge Functions continue to proxy requests (can optimize to direct client calls later)
- Old converter service preserved in `archive/converter-deprecated/` for reference
- Migration was seamless due to maintaining API contract

## References

- Architecture Diagram: `docs/ARCHITECTURE_DIAGRAM.md`
- Migration Notes: `archive/converter-deprecated/MIGRATION_NOTES.md`
- PDF Processing: `packages/worker/src/services/pdf/processor.js`

