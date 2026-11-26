/**
 * Workflow monitoring helpers for Sentry Performance.
 * Centralizes span logic so the orchestrator does not touch the Sentry SDK directly.
 *
 * Unlike an HTTP request (see src/middleware/requestLogger.js, ported for #661),
 * a background workflow run has no Sentry auto-instrumentation to piggyback on --
 * there is no server framework wrapping "execute this workflow" the way Express
 * wraps a request. A hand-rolled root span per workflow run, with a child span
 * per step, is therefore still the right shape here; only the API underneath it
 * needed to change.
 *
 * This is a two-level tree, not a full one: step spans are created inactive
 * (`startInactiveSpan`, never made Sentry's ambient "active span") and are
 * leaves, by design matching the pre-port shape. Supabase queries, LLM calls,
 * or outbound HTTP a step performs internally do not nest under that step's
 * span -- making them active for a step's whole `await`-spanning duration is
 * a larger change than this port carries. If per-step attribution of that
 * inner work becomes worth having, it needs a deliberate follow-up, not an
 * incidental side effect of touching this file again.
 *
 * See issue #764: this module previously targeted the Sentry v7 API
 * (`Sentry.getCurrentHub()`, `Sentry.startTransaction()`, `.startChild()`,
 * `.setData()`), none of which exist on the installed @sentry/node@10 -- the
 * resulting TypeError was swallowed by this module's own availability check,
 * so workflow-level tracing silently did nothing regardless of SENTRY_DSN.
 * Same defect shape as #661 (requestLogger.js), fixed the same way there.
 *
 * Ported to the v10 span API:
 *   - `Sentry.startTransaction({...})`      -> `Sentry.startInactiveSpan({...})`
 *   - `transaction.startChild({...})`        -> `Sentry.withActiveSpan(parent, () =>
 *                                                Sentry.startInactiveSpan({...}))`
 *   - `span.setData(key, value)`             -> `span.setAttributes({ key: value })`
 *   - `span.setStatus('ok' | 'internal_error')` -> `span.setStatus({ code, message })`,
 *                                                where code is numeric (0=UNSET,
 *                                                1=OK, 2=ERROR per @sentry/core's
 *                                                SpanStatus type)
 *   - `span.finish()`                        -> `span.end()`
 *
 * `startInactiveSpan` returns a plain span object the caller ends manually --
 * no callback to wrap the workflow's async, multi-step control flow in, which
 * `Sentry.startSpan`/`startSpanManual` would require. Nesting a step span under
 * the workflow's root span without making the root span globally "active" for
 * the run's whole (long, async) lifetime uses `Sentry.withActiveSpan(root, () =>
 * Sentry.startInactiveSpan(...))`, which sets `root` active only for the
 * duration of that synchronous call. Verified empirically against the
 * installed SDK with a captured transport: the child span's `parent_span_id`
 * matches the root's `span_id` in the emitted envelope (see this module's test
 * suite).
 *
 * `startInactiveSpan` is also safe to call unconditionally: with no
 * `Sentry.init()` (no SENTRY_DSN) it returns a no-op `SentryNonRecordingSpan`
 * rather than throwing or returning null/undefined (verified against the
 * installed SDK). So nothing in this module re-derives "is tracing on?" from
 * env vars to decide whether to *attempt* a span -- that was the round-1 High
 * finding on #767's fix to requestLogger.js, and the same trap applies here:
 * `initSentry()` (src/utils/sentry.ts) defaults SENTRY_TRACES_SAMPLE_RATE when
 * it's unset, so a DSN-only config already traces in Sentry while an env-var
 * gate here would wrongly call it "off". Whether a span actually gets sent is
 * entirely Sentry's own sampling decision; this module always tries, and lets
 * `startInactiveSpan` no-op when there's nothing configured to record it.
 *
 * The one thing this module DOES gate is calling an API that might not exist
 * at all -- `hasSentrySpanApi()` below -- to distinguish "not configured"
 * (silent, normal) from "the SDK doesn't expose the span API this file needs"
 * (a real defect, warned once per process). Swallowing the latter as the
 * former is exactly how #764 (and #661 before it) went unnoticed.
 */

import * as Sentry from '@sentry/node';
import type { Span } from '@sentry/node';

let hasWarnedAboutMissingSentrySpanApi = false;

/**
 * Whether Sentry tracing *looks* configured, mirroring requestLogger.js's
 * `isSentryTracingConfigured()` exactly (same predicate) for consistency
 * between the two files. This exists ONLY to decide whether the
 * SDK-surface-missing warning below is worth emitting -- see
 * `warnOnceAboutMissingSentrySpanApi`. It must never gate whether this module
 * *attempts* to create a span (see the file header): that decision belongs to
 * Sentry alone, via whatever `startInactiveSpan` returns.
 *
 * Deliberately DSN-only, not `SENTRY_DSN && SENTRY_TRACES_SAMPLE_RATE > 0`:
 * `initSentry()` (src/utils/sentry.ts) defaults the sample rate to 0.1/1.0
 * when the env var is unset, so a DSN-only config -- the documented minimal
 * setup, and the shape #770's fix is likely to take -- already traces. A
 * sample-rate sub-check here would silently suppress this exact warning
 * under that config: the same env-var-re-derivation trap the file header
 * removes from the span path (the round-1 High on #767), found again one
 * function later in the diagnostic path during #764's own round-1 review.
 */
function isSentryTracingConfigured(): boolean {
  return !!process.env.SENTRY_DSN;
}

/** Whether the installed @sentry/node exposes the v10 span API this module depends on. */
function hasSentrySpanApi(): boolean {
  const SentryAny = Sentry as unknown as Record<string, unknown>;
  return typeof SentryAny.startInactiveSpan === 'function' && typeof SentryAny.withActiveSpan === 'function';
}

/**
 * Warn exactly once per process when tracing looks configured but the SDK
 * doesn't expose the span API this module needs. Gated on `isSentryTracingConfigured()`
 * purely to avoid warning on installs that never asked for Sentry at all
 * (matching prod as of #770: no SENTRY_* vars set, so this never fires there
 * today) -- not because the underlying defect only matters when configured.
 */
function warnOnceAboutMissingSentrySpanApi(): void {
  if (hasWarnedAboutMissingSentrySpanApi || !isSentryTracingConfigured()) {
    return;
  }
  hasWarnedAboutMissingSentrySpanApi = true;
  console.warn(
    '[workflowMonitoring] SENTRY_DSN is configured but the installed @sentry/node does not expose ' +
      'startInactiveSpan/withActiveSpan. Workflow performance monitoring is disabled -- check the installed @sentry/node version.'
  );
}

/** Numeric span status codes per @sentry/core's SpanStatus type (0=UNSET, 1=OK, 2=ERROR). */
const SPAN_STATUS_OK = 1 as const;
const SPAN_STATUS_ERROR = 2 as const;

/**
 * Only the ERROR branch's `message` reaches Sentry -- `getStatusMessage` in
 * @sentry/core hardcodes `'ok'` for any OK-coded span regardless of what's
 * passed (verified against
 * node_modules/@sentry/core/build/cjs/utils/spanUtils.js), so an OK-branch
 * message here would silently be discarded. The outcome itself isn't lost:
 * every caller already sets it as a `status`/`final_status` attribute
 * alongside this call.
 */
function toSpanStatus(outcome: string): { code: typeof SPAN_STATUS_OK | typeof SPAN_STATUS_ERROR; message?: string } {
  return outcome === 'failed' ? { code: SPAN_STATUS_ERROR, message: 'internal_error' } : { code: SPAN_STATUS_OK };
}

/** Start the root span for a workflow run. Returns null if Sentry's span API isn't available. */
export function startWorkflowTransaction(
  workflowId: string,
  userContext?: { userId?: string }
): Span | null {
  if (!hasSentrySpanApi()) {
    warnOnceAboutMissingSentrySpanApi();
    return null;
  }
  try {
    const span = Sentry.startInactiveSpan({
      name: `Workflow: ${workflowId}`,
      op: 'workflow.execute',
    });
    span.setAttributes({
      workflow_id: workflowId,
      ...(userContext?.userId ? { user_id: userContext.userId } : {}),
    });
    return span;
  } catch (error) {
    console.warn('[workflowMonitoring] Failed to start workflow span:', error);
    return null;
  }
}

/** Start a child span for one workflow step, nested under the workflow's root span. */
export function startStepSpan(
  workflowTransaction: Span | null,
  stepDef: { type: string; name: string; order: number }
): Span | null {
  if (!workflowTransaction) {
    return null;
  }
  try {
    const stepSpan = Sentry.withActiveSpan(workflowTransaction, () =>
      Sentry.startInactiveSpan({
        name: `${stepDef.type}: ${stepDef.name}`,
        op: 'workflow.step',
      })
    );
    stepSpan.setAttributes({
      step_type: stepDef.type,
      step_name: stepDef.name,
      step_order: stepDef.order,
    });
    return stepSpan;
  } catch (error) {
    console.warn(`[workflowMonitoring] Failed to start span for step ${stepDef.type}:`, error);
    return null;
  }
}

/** Record a step's outcome on its span (if any) and end it. Always returns timing/token totals. */
export function trackStepCompletion(
  stepType: string,
  stepStartTime: number,
  stepSpan: Span | null,
  tokensUsed?: number,
  status: 'completed' | 'failed' | 'skipped' | 'awaiting_user' = 'completed',
  error?: string
): { stepDuration: number; tokensUsed: number } {
  const stepDuration = Date.now() - stepStartTime;
  const tokens = tokensUsed || 0;

  if (stepSpan) {
    try {
      stepSpan.setAttributes({
        duration_ms: stepDuration,
        status,
        ...(tokens > 0 ? { tokens_used: tokens } : {}),
        ...(error ? { error } : {}),
      });
      stepSpan.setStatus(toSpanStatus(status));
      stepSpan.end();
    } catch (spanError) {
      console.warn(`[workflowMonitoring] Failed to finish span for step ${stepType}:`, spanError);
    }
  }

  return { stepDuration, tokensUsed: tokens };
}

/** End the workflow's root span on successful (or partial) completion. */
export function finishWorkflowTransaction(
  workflowTransaction: Span | null,
  data: {
    workflowExecutionTime: number;
    totalTokenUsage: number;
    completedStepsCount: number;
    skippedStepsCount: number;
    finalStatus: string;
  }
): void {
  if (!workflowTransaction) return;
  try {
    workflowTransaction.setAttributes({
      workflow_execution_time_ms: data.workflowExecutionTime,
      total_token_usage: data.totalTokenUsage,
      completed_steps: data.completedStepsCount,
      skipped_steps: data.skippedStepsCount,
      final_status: data.finalStatus,
    });
    workflowTransaction.setStatus(toSpanStatus(data.finalStatus));
    workflowTransaction.end();
  } catch (error) {
    console.warn('[workflowMonitoring] Failed to finish workflow span:', error);
  }
}

/** End the workflow's root span after an unhandled error. */
export function finishWorkflowTransactionOnError(
  workflowTransaction: Span | null,
  workflowExecutionTime: number,
  errorMessage: string
): void {
  if (!workflowTransaction) return;
  try {
    workflowTransaction.setAttributes({
      workflow_execution_time_ms: workflowExecutionTime,
      error: errorMessage,
    });
    workflowTransaction.setStatus({ code: SPAN_STATUS_ERROR, message: 'internal_error' });
    workflowTransaction.end();
  } catch (finishError) {
    console.warn('[workflowMonitoring] Failed to finish workflow span on error:', finishError);
  }
}
