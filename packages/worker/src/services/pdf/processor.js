"use strict";

// PDF processing service using poppler-utils
// Handles PDF type detection, text extraction, and image conversion

const { spawn } = require("child_process");
const { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");

function parseQuery(url) {
  const q = {};
  const idx = url.indexOf("?");
  if (idx === -1) return q;
  for (const part of url.slice(idx + 1).split("&")) {
    const [k, v] = part.split("=");
    if (!k) continue;
    q[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return q;
}

function zeroPad(num, width) {
  const s = String(num);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

const POpplerMissingMessage =
  "poppler-utils is not installed (pdftotext/pdftoppm not found). " +
  "Run the worker via Docker (see packages/worker/Dockerfile) or install poppler-utils: " +
  "macOS: brew install poppler; Ubuntu/Debian: apt-get install poppler-utils; Windows: use Docker.";

function isPopplerMissing(err) {
  const msg = (err && err.message) || String(err);
  return msg.includes("ENOENT") && (msg.includes("pdftotext") || msg.includes("pdftoppm") || msg.includes("pdfinfo"));
}

function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        reject(new Error(`PDF processing failed: ${POpplerMissingMessage}`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Detect PDF type (scanned vs text-based)
 */
async function detectPdf(pdfBuffer, pdfPath, workDir) {
  const fileSize = pdfBuffer.length;

  // Get page count and metadata using pdfinfo
  let pageCount = 0;
  try {
    const info = await execCommand("pdfinfo", [pdfPath]);
    const pageMatch = info.stdout.match(/Pages:\s+(\d+)/i);
    if (pageMatch) {
      pageCount = parseInt(pageMatch[1], 10);
    }
  } catch {
    // Fallback: try pdftoppm to count pages
    try {
      await execCommand("pdftoppm", ["-l", "1", pdfPath, join(workDir, "test")]);
      pageCount = 1; // At least 1 page if conversion succeeded
    } catch {
      pageCount = 1; // Default assumption
    }
  }

  if (pageCount === 0) pageCount = 1; // Safety fallback

  // Extract text using pdftotext
  let hasText = false;
  let textLength = 0;
  try {
    const textPath = join(workDir, "extracted.txt");
    await execCommand("pdftotext", [pdfPath, textPath]);
    const extractedText = readFileSync(textPath, "utf8").trim();
    textLength = extractedText.length;
    // Consider it has text if we extract more than 100 non-whitespace characters
    hasText = extractedText.replace(/\s+/g, "").length > 100;
  } catch {
    hasText = false;
  }

  // Calculate size per page
  const sizePerPage = fileSize / pageCount;

  // Determine if scanned
  let isScanned = false;
  let confidence = "low";
  let detectionMethod = "";

  if (hasText && textLength > 500) {
    // Has substantial text -> regular PDF
    isScanned = false;
    confidence = "high";
    detectionMethod = "text_extraction";
  } else if (!hasText && sizePerPage > 400000) {
    // No text + large file size per page -> scanned
    isScanned = true;
    confidence = sizePerPage > 800000 ? "high" : "medium";
    detectionMethod = "file_size_no_text";
  } else if (sizePerPage < 50000) {
    // Very small per-page size likely means text-based
    isScanned = false;
    confidence = "medium";
    detectionMethod = "file_size_per_page";
  } else {
    // Ambiguous case - default to scanned if no text
    isScanned = !hasText;
    confidence = "low";
    detectionMethod = "heuristic_fallback";
  }

  return {
    is_scanned: isScanned,
    has_text: hasText,
    page_count: pageCount,
    file_size: fileSize,
    size_per_page: Math.round(sizePerPage),
    confidence: confidence,
    detection_method: detectionMethod,
    text_length: textLength,
  };
}

/**
 * Convert PDF to images
 */
async function convertPdfToImages(pdfPath, workDir, dpi = 150) {
  // pdftoppm -jpeg -r <dpi> input.pdf page
  const args = ["-jpeg", "-r", String(dpi), pdfPath, join(workDir, "page")];
  const child = spawn("pdftoppm", args);
  let stderr = "";

  return new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Conversion failed: ${stderr}`));
        return;
      }

      try {
        const files = readdirSync(workDir)
          .filter((f) => f.startsWith("page-") && f.endsWith(".jpg"))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const width = String(files.length).length < 2 ? 2 : String(files.length).length;
        const out = files.map((f, idx) => {
          const data = readFileSync(join(workDir, f));
          const name = `page_${zeroPad(idx + 1, width)}.jpg`;
          return {
            name,
            contentType: "image/jpeg",
            dataBase64: data.toString("base64"),
          };
        });
        resolve(out);
      } catch (err) {
        reject(err);
      }
    });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        reject(new Error(`PDF processing failed: ${POpplerMissingMessage}`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Process PDF: detect type and return text or images
 */
async function processPdf(pdfBuffer, pdfPath, workDir, dpi = 150) {
  const fileSize = pdfBuffer.length;

  // Get page count
  let pageCount = 0;
  try {
    const info = await execCommand("pdfinfo", [pdfPath]);
    const pageMatch = info.stdout.match(/Pages:\s+(\d+)/i);
    if (pageMatch) {
      pageCount = parseInt(pageMatch[1], 10);
    }
  } catch {
    pageCount = 1; // Default assumption
  }
  if (pageCount === 0) pageCount = 1;

  // Try to extract text (log failures so we can see why extraction yielded nothing)
  let extractedText = "";
  let textLength = 0;
  let hasText = false;
  let pdftotextError = null;
  try {
    const textPath = join(workDir, "extracted.txt");
    await execCommand("pdftotext", [pdfPath, textPath]);
    extractedText = readFileSync(textPath, "utf8").trim();
    textLength = extractedText.length;
    hasText = extractedText.replace(/\s+/g, "").length > 100;
  } catch (err) {
    pdftotextError = err;
    hasText = false;
    console.warn("[pdf/processor] pdftotext failed:", err && err.message ? err.message : String(err));
  }

  // Determine if scanned using heuristics
  const sizePerPage = fileSize / pageCount;
  let isScanned = false;

  if (hasText && textLength > 500) {
    isScanned = false; // Has substantial text -> regular PDF
  } else if (!hasText && sizePerPage > 400000) {
    isScanned = true; // No text + large file size -> scanned
  } else if (sizePerPage < 50000) {
    isScanned = false; // Very small per-page size -> text-based
  } else {
    isScanned = !hasText; // Default based on text presence
  }

  if (isScanned) {
    // Scanned PDF: Convert to images
    const files = await convertPdfToImages(pdfPath, workDir, dpi);
    return {
      type: "images",
      files: files,
      page_count: pageCount,
      is_scanned: true,
    };
  }

  // Text-based path: if we have no extracted text (pdftotext failed or PDF has no text),
  // fall back to image-based extraction so Vision can still get content
  const noText = !extractedText || extractedText.trim().length === 0;
  if (noText) {
    console.warn("[pdf/processor] No text from pdftotext; falling back to image extraction.", pdftotextError ? "Error: " + pdftotextError.message : "Extracted text was empty.");
    try {
      const files = await convertPdfToImages(pdfPath, workDir, dpi);
      return {
        type: "images",
        files: files,
        page_count: pageCount,
        is_scanned: true,
      };
    } catch (imgErr) {
      if (isPopplerMissing(imgErr)) {
        throw new Error(`PDF processing failed: ${POpplerMissingMessage}`);
      }
      const msg = (pdftotextError && pdftotextError.message) || (imgErr && imgErr.message) || "Unknown";
      throw new Error(`PDF processing failed: pdftotext yielded no text (${msg}); image fallback failed: ${imgErr && imgErr.message ? imgErr.message : imgErr}`);
    }
  }

  // Text-based PDF with extracted text
  return {
    type: "text",
    text: extractedText,
    page_count: pageCount,
    is_scanned: false,
    text_length: textLength,
  };
}

/**
 * Process PDF with temporary directory management
 */
async function processPdfWithCleanup(pdfBuffer, handler, options = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "pdf-"));
  const pdfPath = join(workDir, "input.pdf");

  try {
    writeFileSync(pdfPath, pdfBuffer);
    return await handler(pdfBuffer, pdfPath, workDir, options);
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check if poppler-utils (pdfinfo/pdftoppm) is available. Logs a warning if not.
 * Call at startup so users see a clear message when running without Docker.
 */
function checkPopplerAvailable() {
  const child = spawn("pdfinfo", ["-v"], { stdio: "ignore" });
  return new Promise((resolve) => {
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        console.warn("[Worker] PDF processing unavailable:", POpplerMissingMessage);
      }
      resolve(err && err.code === "ENOENT" ? false : true);
    });
    child.on("close", (code) => resolve(true));
  });
}

module.exports = {
  detectPdf: (pdfBuffer, pdfPath, workDir) => detectPdf(pdfBuffer, pdfPath, workDir),
  convertPdfToImages: (pdfPath, workDir, dpi) => convertPdfToImages(pdfPath, workDir, dpi),
  processPdf: (pdfBuffer, pdfPath, workDir, dpi) => processPdf(pdfBuffer, pdfPath, workDir, dpi),
  processPdfWithCleanup: (pdfBuffer, handler, options) => processPdfWithCleanup(pdfBuffer, handler, options),
  checkPopplerAvailable,
  parseQuery,
  isPopplerMissing,
  POpplerMissingMessage,
};

