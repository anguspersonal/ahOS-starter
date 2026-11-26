// app.js (UPDATED)
// Load environment variables from .env file (if it exists)
// In Docker, environment variables are passed via Docker, not .env file
// dotenv.config() won't throw an error if .env doesn't exist
try {
  require('dotenv').config();
} catch (error) {
  // Ignore errors if .env file doesn't exist (normal in Docker)
  if (!error.message.includes('ENOENT')) {
    console.warn('[Worker] dotenv config warning:', error.message);
  }
}

// ⭐ Initialize Sentry before other middleware
// This must happen before error handler middleware is set up
const { initSentry } = require('./src/utils/sentry');
initSentry();

const express = require('express');
const cors = require('cors');
const path = require('path');
const indexRouter = require('./routes/index');
const pdfRouter = require('./routes/api/pdf');  // ⭐ NEW: PDF processing routes
const uploadRouter = require('./routes/api/upload');  // ⭐ NEW: File upload routes
const { errorHandler } = require('./src/middleware/errorHandler');  // ⭐ NEW
const { requestLogger } = require('./src/middleware/requestLogger'); // ⭐ NEW

// ⭐ NEW: Periodic dedup sweep (issue #396). Load compiled dist in prod, fall
// back to ts-node/src in dev — same pattern the routes use for TS modules.
// No-op unless KMS_DEDUP_SWEEP_ENABLED=true, so importing it is always safe.
let startDedupSweepScheduler = () => null;
try {
  ({ startDedupSweepScheduler } = require('./dist/schedule/dedupSweep'));
} catch (distErr) {
  try {
    require('ts-node/register');
    ({ startDedupSweepScheduler } = require('./src/schedule/dedupSweep'));
  } catch (srcErr) {
    console.error('[Worker] Failed to load dedup sweep scheduler:', srcErr.message);
  }
}

// ⭐ NEW: Exception-only alert evaluator (issue #573). ahOS's only outbound
// channel: it reads a small set of threshold conditions and emails on a
// CROSSING (never on a held condition, never a digest). No-op unless
// KMS_ALERT_EVALUATOR_ENABLED=true, so importing it is always safe.
let startAlertEvaluatorScheduler = () => null;
try {
  ({ startAlertEvaluatorScheduler } = require('./dist/schedule/alertEvaluator'));
} catch (distErr) {
  try {
    require('ts-node/register');
    ({ startAlertEvaluatorScheduler } = require('./src/schedule/alertEvaluator'));
  } catch (srcErr) {
    console.error('[Worker] Failed to load alert evaluator scheduler:', srcErr.message);
  }
}

// ⭐ NEW: Periodic batch learning analysis (issue #948). Gives
// runBatchLearningAnalysis (learning/analyze.ts) the caller it has never had,
// so its pattern analysers actually run against recent user_edits. No-op
// unless KMS_LEARNING_ANALYSIS_ENABLED=true, so importing it is always safe.
let startLearningAnalysisScheduler = () => null;
try {
  ({ startLearningAnalysisScheduler } = require('./dist/schedule/learningAnalysis'));
} catch (distErr) {
  try {
    require('ts-node/register');
    ({ startLearningAnalysisScheduler } = require('./src/schedule/learningAnalysis'));
  } catch (srcErr) {
    console.error('[Worker] Failed to load learning analysis scheduler:', srcErr.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// CORS configuration for cross-origin browser requests (local dev only by
// default — the web frontend was retired, ADR096). See src/utils/corsOrigins.js.
const { parseCorsOrigins } = require('./src/utils/corsOrigins');

const allowedOrigins = parseCorsOrigins(process.env.CORS_ORIGIN);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients (curl, server-to-server) with no Origin header
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-access-token',
    'x-webhook-secret',
    'x-client-platform',
  ],
};
app.use(cors(corsOptions));

// ⭐ ADD: Request logging
app.use(requestLogger);

// ⭐ ADD: Parse JSON bodies (for most routes)
app.use(express.json());

// ⭐ ADD: Parse raw binary for PDF endpoints (must be before PDF routes)
app.use('/api/pdf', express.raw({ type: 'application/pdf', limit: '50mb' }));

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// ⭐ ADD: API routes
app.use('/api/pdf', pdfRouter);  // ⭐ NEW: PDF processing endpoints
app.use('/api/upload', uploadRouter);  // ⭐ NEW: File upload endpoints

// ⭐ ADD: Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Original HTML routes
app.use('/', indexRouter);

// Catch-all route for handling 404 errors
app.use((req, res, next) => {
    res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
});

// ⭐ ADD: Error handler
app.use(errorHandler);

// Bind to 0.0.0.0 so the server is reachable from the host when running in Docker
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  console.log('[Worker] Registered routes:');
  console.log('  - /health');
  console.log('  - /api/pdf');
  console.log('  - /api/upload');
  // ⭐ NEW: Kick off the periodic dedup sweep (no-op unless KMS_DEDUP_SWEEP_ENABLED=true)
  try {
    startDedupSweepScheduler();
  } catch (e) {
    console.error('[Worker] Failed to start dedup sweep scheduler:', e.message);
  }
  // ⭐ NEW: Kick off the exception-only alert evaluator (no-op unless KMS_ALERT_EVALUATOR_ENABLED=true)
  try {
    startAlertEvaluatorScheduler();
  } catch (e) {
    console.error('[Worker] Failed to start alert evaluator scheduler:', e.message);
  }
  // ⭐ NEW: Kick off the periodic batch learning analysis (no-op unless KMS_LEARNING_ANALYSIS_ENABLED=true)
  try {
    startLearningAnalysisScheduler();
  } catch (e) {
    console.error('[Worker] Failed to start learning analysis scheduler:', e.message);
  }
  // Check for PDF processing dependency (poppler-utils); warn if missing
  try {
    const pdfProcessor = require('./src/services/pdf/processor');
    if (pdfProcessor.checkPopplerAvailable) {
      pdfProcessor.checkPopplerAvailable().catch(() => {});
    }
  } catch (e) {
    // Ignore if processor not found
  }
});