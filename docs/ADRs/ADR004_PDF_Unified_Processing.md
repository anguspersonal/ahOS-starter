# ADR-004: Unified PDF Processing Endpoint

**Status:** Accepted  
**Date:** 2025-11-02 (backfilled)  
**Accepted-on-dev:** 2025-11-02  
**Deciders:** Architecture Team  
**Tags:** pdf-processing, api-design, simplification

## Context

Originally, PDF processing required multiple steps:
1. Call `/detect` endpoint to determine PDF type (scanned vs text)
2. Based on result, call either:
   - `/convert` endpoint for scanned PDFs (converts to images)
   - Future text extraction for text PDFs

This required:
- Multiple API calls from Edge Functions
- Complex routing logic in n8n workflows
- Separate endpoints to maintain

### Problem Statement

The two-step process added complexity:
- Edge Functions had to make multiple HTTP calls
- n8n workflows needed switch nodes to route based on type
- Error handling across multiple endpoints
- More code to maintain

## Decision

**Create a unified `/process` endpoint that automatically detects PDF type and processes accordingly in a single call.**

### Changes Made

1. **Unified endpoint:**
   - `POST /process?dpi=150` - Single endpoint for all PDF processing
   - Automatically detects PDF type using `pdftotext` and heuristics
   - Returns appropriate response format based on type

2. **Response format:**
   ```json
   // Text-based PDF
   {
     "type": "text",
     "text": "Extracted text content...",
     "page_count": 3,
     "is_scanned": false,
     "text_length": 1234
   }
   
   // Scanned PDF
   {
     "type": "images",
     "files": [
       {
         "name": "page_01.jpg",
         "contentType": "image/jpeg",
         "dataBase64": "..."
       }
     ],
     "page_count": 3,
     "is_scanned": true
   }
   ```

3. **Detection logic:**
   - Extracts text using `pdftotext`
   - Uses heuristics:
     - Substantial text (>500 chars) → Regular PDF
     - No text + large file size → Scanned PDF
     - Small file size → Regular PDF

4. **Legacy endpoints maintained:**
   - `/detect` - Still available for backwards compatibility
   - `/convert` - Still available for backwards compatibility

## Consequences

### Positive

✅ **Simplified workflows** - Single API call instead of multiple  
✅ **Better error handling** - One point of failure  
✅ **Cleaner Edge Functions** - Simpler code  
✅ **Easier n8n workflows** - No switch nodes needed  
✅ **Consistent response** - Standardized format

### Negative

❌ **Larger response** - Includes metadata in every response  
❌ **More complex endpoint** - Handles multiple responsibilities  
❌ **Legacy endpoints** - Still need to maintain for compatibility

### Neutral

- Detection logic is heuristic-based (may need tuning)
- Response format is flexible (can extend later)

## Implementation Details

### Detection Heuristics

```javascript
// Pseudo-code
const text = extractText(pdf);
const fileSize = getFileSize(pdf);

if (text.length > 500) {
  return { type: "text", text };
} else if (fileSize > threshold && text.length === 0) {
  return { type: "images", images: convertToImages(pdf) };
} else {
  return { type: "text", text }; // Default to text
}
```

### Edge Function Integration

```typescript
// Supabase Edge Function calls unified endpoint
const response = await fetch(`${SERVER_URL}/api/pdf/process`, {
  method: 'POST',
  body: pdfBuffer,
  headers: { 'X-PDF-Handler-Secret': secret }
});

const result = await response.json();
// Route based on result.type
```

## Alternatives Considered

### Alternative 1: Keep Separate Endpoints
- **Pros:** Clear separation of concerns
- **Cons:** More complex, multiple calls needed

### Alternative 2: Client-Side Detection
- **Pros:** Server only processes, doesn't detect
- **Cons:** Requires client to know PDF structure, less flexible

### Alternative 3: Two-Phase with Caching
- **Pros:** Can cache detection results
- **Cons:** Still requires multiple calls, adds cache complexity

## Notes

- This decision predates ADR-002 (consolidation into Express server)
- The unified endpoint was originally in the Cloud Run converter service
- Now implemented in `packages/worker/src/services/pdf/processor.js`
- Legacy endpoints remain for backwards compatibility

## References

- PDF Handler Refactor: `ZZarchive/docs_preDec2025/CONVERTER/PDF_HANDLER_REFACTOR.md`
- PDF Detection Architecture: `ZZarchive/docs_preDec2025/CONVERTER/PDF_DETECTION_ARCHITECTURE.md`
- Implementation: `packages/worker/src/services/pdf/processor.js`

