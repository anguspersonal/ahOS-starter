// routes/api/pdf.js
// PDF processing endpoints (consolidated from converter service)

const express = require("express");
const router = express.Router();
const pdfProcessor = require("../../src/services/pdf/processor");

const SHARED_SECRET = process.env.PDF_HANDLER_SECRET || process.env.CONVERTER_SHARED_SECRET || "";

/**
 * Validate PDF handler secret (if configured)
 */
function validatePdfAuth(req) {
  if (SHARED_SECRET) {
    // Support both old and new header names for backwards compatibility
    const headerSecret = req.headers["x-pdf-handler-secret"] || req.headers["x-converter-secret"];
    return headerSecret === SHARED_SECRET;
  }
  return true;
}

/**
 * POST /api/pdf/process
 * Unified PDF processing endpoint
 * Automatically detects PDF type and returns text or images
 */
router.post("/process", async (req, res) => {
  try {
    // Validate content type
    const contentType = req.headers["content-type"] || "";
    if (!contentType.startsWith("application/pdf")) {
      return res.status(400).json({ error: "Content-Type must be application/pdf" });
    }

    // Optional shared-secret validation
    if (!validatePdfAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Get PDF buffer (Express raw middleware provides Buffer for application/pdf)
    const pdfBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'binary');

    // Parse query params
    const dpi = Math.max(72, parseInt(req.query.dpi || "150", 10) || 150);

    // Process PDF
    const result = await pdfProcessor.processPdfWithCleanup(
      pdfBuffer,
      async (buffer, path, workDir) => {
        return await pdfProcessor.processPdf(buffer, path, workDir, dpi);
      },
      { dpi }
    );

    res.json(result);
  } catch (err) {
    console.error("PDF processing error:", err);
    res.status(500).json({ error: "Processing failed", details: err.message });
  }
});

/**
 * POST /api/pdf/detect
 * Legacy endpoint: Detect PDF type without processing
 */
router.post("/detect", async (req, res) => {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.startsWith("application/pdf")) {
      return res.status(400).json({ error: "Content-Type must be application/pdf" });
    }

    if (!validatePdfAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const pdfBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'binary');

    const result = await pdfProcessor.processPdfWithCleanup(
      pdfBuffer,
      async (buffer, path, workDir) => {
        return await pdfProcessor.detectPdf(buffer, path, workDir);
      }
    );

    res.json(result);
  } catch (err) {
    console.error("PDF detection error:", err);
    res.status(500).json({ error: "Detection failed", details: err.message });
  }
});

/**
 * POST /api/pdf/convert
 * Legacy endpoint: Convert PDF to images
 */
router.post("/convert", async (req, res) => {
  try {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.startsWith("application/pdf")) {
      return res.status(400).json({ error: "Content-Type must be application/pdf" });
    }

    if (!validatePdfAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const pdfBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'binary');
    const dpi = Math.max(72, parseInt(req.query.dpi || "150", 10) || 150);
    const format = (req.query.format || "jpeg").toLowerCase();

    if (format !== "jpeg" && format !== "jpg") {
      return res.status(400).json({ error: "Only format=jpeg supported" });
    }

    const result = await pdfProcessor.processPdfWithCleanup(
      pdfBuffer,
      async (buffer, path, workDir) => {
        const files = await pdfProcessor.convertPdfToImages(path, workDir, dpi);
        return { files };
      },
      { dpi }
    );

    res.json(result);
  } catch (err) {
    console.error("PDF conversion error:", err);
    res.status(500).json({ error: "Conversion failed", details: err.message });
  }
});

module.exports = router;

