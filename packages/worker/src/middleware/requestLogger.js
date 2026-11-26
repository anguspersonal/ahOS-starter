// Request logging middleware with performance tracking.
//
// Performance tracking piggybacks on Sentry's own automatic HTTP
// instrumentation rather than opening a hand-rolled transaction.
// @sentry/node's Http integration patches `http.Server.prototype.emit` when
// `Sentry.init()` runs -- a prototype mutation, so it applies retroactively
// to every server `http`/`express` creates afterwards regardless of whether
// `express` was required before or after `Sentry.init()` ran (verified
// against @opentelemetry/instrumentation-http's source; the http.server span
// below does not depend on init/require ordering). It opens a root
// `http.server` span for every incoming request when tracing is configured,
// and ends that span from the response's `'close'` event -- which Node fires
// after `'finish'` on a normal response -- so `Sentry.getActiveSpan()`,
// called from this middleware's `res.on('finish')` handler, deterministically
// finds it still open.
//
// A hand-rolled transaction here would just be a disconnected duplicate of a
// span Sentry already made, so this file only annotates the existing one --
// and it does so unconditionally on the SDK exposing the right API, not on
// re-deriving "is tracing on?" from env vars (see `hasSentryTracingApi` and
// `requestLogger` below): `annotateActiveSpan` is a no-op whenever
// `Sentry.getActiveSpan()` has nothing to annotate, so there is nothing to
// gate. Whether a span exists at all is entirely Sentry's own call.
//
// See issue #661: this file previously targeted the Sentry v7 API
// (`Sentry.getCurrentHub()`, `Sentry.startTransaction()`), which does not
// exist on v10 -- the resulting TypeError was swallowed by this module's own
// availability check, so performance monitoring silently did nothing.

const Sentry = require('@sentry/node');

let hasWarnedAboutMissingSentryTracingApi = false;

/**
 * Whether Sentry performance tracing *looks* configured. This exists ONLY to
 * decide whether a missing-SDK-surface warning is worth emitting -- see
 * `requestLogger` below. It must never gate whether this middleware *tries*
 * to annotate a span: `initSentry()` (src/utils/sentry.ts) defaults
 * SENTRY_TRACES_SAMPLE_RATE (0.1 prod / 1.0 dev) when it's unset, so a
 * DSN-only config already traces in Sentry while a re-derived check would
 * wrongly call it "not configured" and silently contribute nothing -- the
 * same silent-failure shape issue #661 was about, on a different gate.
 *
 * Deliberately DSN-only, not `SENTRY_DSN && SENTRY_TRACES_SAMPLE_RATE > 0`:
 * an earlier version of this predicate included the sample-rate sub-check
 * and, for the reason above, silently suppressed the SDK-surface-missing
 * warning under a DSN-only config -- the same env-var-re-derivation trap
 * this comment already warns about, found one function later during #764's
 * round-1 review (workflowMonitoring.ts mirrors this predicate; fixed there
 * in the same PR).
 */
function isSentryTracingConfigured() {
  return !!process.env.SENTRY_DSN;
}

/** Whether the installed @sentry/node exposes the v10 span API this middleware calls. */
function hasSentryTracingApi() {
  return typeof Sentry.getActiveSpan === 'function' && typeof Sentry.setHttpStatus === 'function';
}

/**
 * Warn exactly once per process when tracing is configured but the SDK
 * doesn't expose the API this file needs -- a real defect (wrong SDK
 * version, or a breaking upgrade), never swallowed as "disabled". Fires on
 * whichever request first reaches it, not at process startup: this runs from
 * inside `res.on('finish')`, so it's mid-traffic, not mid-boot. (A
 * removed-API TypeError, silently caught and treated as "not configured", is
 * exactly how issue #661 stayed invisible.)
 */
function warnOnceAboutMissingSentryTracingApi() {
  if (hasWarnedAboutMissingSentryTracingApi) {
    return;
  }
  hasWarnedAboutMissingSentryTracingApi = true;
  console.warn(
    '[RequestLogger] SENTRY_DSN is configured but the installed @sentry/node does not expose ' +
      'getActiveSpan/setHttpStatus. Performance monitoring is disabled -- check the installed ' +
      '@sentry/node version.',
  );
}

/** Attach request-level detail to Sentry's own auto-instrumented span for this request, if any. */
function annotateActiveSpan({ statusCode, durationMs, requestId, userId }) {
  const span = Sentry.getActiveSpan();
  if (!span) {
    return;
  }
  try {
    Sentry.setHttpStatus(span, statusCode);
    span.setAttributes({
      'request.duration_ms': durationMs,
      ...(requestId ? { 'request.id': requestId } : {}),
      ...(userId ? { 'user.id': userId } : {}),
    });
  } catch (error) {
    // Gracefully handle errors - don't block request processing
    console.warn('[RequestLogger] Failed to annotate Sentry span:', error.message);
  }
}

function requestLogger(req, res, next) {
  const start = Date.now();

  // Attach a simple request id for correlation if the caller didn't supply one.
  const requestId =
    (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id']) ||
    (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
    null;

  res.on('finish', () => {
    const durationMs = Date.now() - start;

    // Keep noisy endpoints quieter.
    const isHealth = req.path === '/health';
    if (isHealth) {
      return;
    }

    // Log request with all required fields
    console.log('[Request]', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      userId: req.user?.id || null,
      ip: req.ip,
    });

    // Annotate Sentry's own span for this request, if there is one. Whether
    // one exists is Sentry's call (DSN, sample rate, sampler) -- this only
    // decides whether the CAPABILITY to annotate is even there, and warns
    // once if tracing is configured but that capability is missing.
    if (hasSentryTracingApi()) {
      annotateActiveSpan({
        statusCode: res.statusCode,
        durationMs,
        requestId,
        userId: req.user?.id || null,
      });
    } else if (isSentryTracingConfigured()) {
      warnOnceAboutMissingSentryTracingApi();
    }

    // Log slow requests (> 5000ms threshold) with warning level
    const slowThreshold = 5000; // 5 seconds
    if (durationMs > slowThreshold) {
      console.warn('[Slow Request]', {
        path: req.originalUrl,
        durationMs,
        method: req.method,
        userId: req.user?.id || null,
        requestId,
      });
    }
  });

  // No `res.on('error')` handler: it looked like the natural place to mark a
  // span as errored, but by the time a regular `'error'` listener runs here,
  // @opentelemetry/instrumentation-http has already ended the span --
  // `_onServerResponseError` runs on `response.on(events.errorMonitor, ...)`,
  // which Node fires before regular `'error'` listeners, and OTel's own
  // handler sets the error status before ending it. A handler here would be
  // provably inert: `span.setStatus()` on an already-ended span is a
  // silent no-op. Consistent with the header above -- don't duplicate what
  // Sentry's own instrumentation already owns.

  next();
}

module.exports = { requestLogger };
