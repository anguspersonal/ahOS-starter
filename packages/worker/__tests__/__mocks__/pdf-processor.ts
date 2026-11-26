/**
 * Mock PDF processor
 * Provides mock functions for PDF processing
 */

// Mock PDF processing results
let mockPdfResult: any = null;
let shouldFail = false;
let pdfError: Error | null = null;

// Helper to reset mocks
export function resetPdfMocks() {
  mockPdfResult = null;
  shouldFail = false;
  pdfError = null;
}

// Helper to set mock PDF result (text-based)
export function setMockTextPdfResult(text: string, pageCount: number = 1) {
  mockPdfResult = {
    type: 'text',
    is_scanned: false,
    text,
    text_length: text.length,
    page_count: pageCount,
  };
  shouldFail = false;
  pdfError = null;
}

// Helper to set mock PDF result (scanned)
export function setMockScannedPdfResult(pageCount: number = 1) {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    dataBase64: `base64-page-${i + 1}`,
    contentType: 'image/jpeg',
  }));
  
  mockPdfResult = {
    type: 'images',
    is_scanned: true,
    files: pages,
    page_count: pageCount,
  };
  shouldFail = false;
  pdfError = null;
}

// Helper to simulate PDF processing failure
export function simulatePdfFailure(error: Error) {
  shouldFail = true;
  pdfError = error;
}

// Mock processPdf
export async function processPdf(
  buffer: Buffer,
  pdfPath: string,
  workDir: string,
  dpi: number = 150
): Promise<any> {
  if (shouldFail) {
    throw pdfError || new Error('Mock PDF processing error');
  }

  if (mockPdfResult) {
    return mockPdfResult;
  }

  // Default mock response (text-based)
  return {
    type: 'text',
    is_scanned: false,
    text: 'Mock PDF text content',
    text_length: 20,
    page_count: 1,
  };
}

// Mock processPdfWithCleanup
export async function processPdfWithCleanup(
  buffer: Buffer,
  processor: (buffer: Buffer, pdfPath: string, workDir: string) => Promise<any>
): Promise<string> {
  if (shouldFail) {
    throw pdfError || new Error('Mock PDF processing error');
  }

  if (mockPdfResult) {
    // For scanned PDFs, we need to call the processor function
    // which will then call processPdf and then Vision API for each page
    if (mockPdfResult.type === 'images' && mockPdfResult.is_scanned) {
      // Call the processor function - it will call processPdf (which returns mockPdfResult)
      // and then process each page with Vision API
      return await processor(buffer, 'mock.pdf', '/tmp');
    }
    if (mockPdfResult.type === 'text' && mockPdfResult.text) {
      return mockPdfResult.text;
    }
  }

  // Default mock response - call processor for text-based PDFs
  return await processor(buffer, 'mock.pdf', '/tmp');
}

module.exports = {
  processPdf,
  processPdfWithCleanup,
  resetPdfMocks,
  setMockTextPdfResult,
  setMockScannedPdfResult,
  simulatePdfFailure,
};

