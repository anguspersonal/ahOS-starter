/**
 * Unit tests for workflowMonitoring.ts: the hand-rolled Sentry span helpers
 * the orchestrator uses to trace a workflow run (root span) and each of its
 * steps (child spans).
 *
 * ## Issue #764
 *
 * This module targeted the Sentry v7 API (`Sentry.getCurrentHub()`,
 * `Sentry.startTransaction()`, `.startChild()`, `.setData()`), none of which
 * exist on the installed @sentry/node@10 -- the resulting TypeError was
 * swallowed by the module's own availability check, so workflow-level tracing
 * silently did nothing. Same shape as #661 (requestLogger.js), same fix
 * approach: port to the v10 span API and test against the *real* installed
 * SDK. No `jest.mock('@sentry/node', ...)` anywhere below -- a mock that
 * invents its dependency's surface (as a hypothetical mock of
 * `startTransaction`/`getCurrentHub` would) cannot detect that surface being
 * gone, which is the exact way this defect went unnoticed. The one test that
 * needs to simulate a regressed SDK deletes a real function from the real,
 * required-actual module instead.
 *
 * Unlike requestLogger.js, there is no Sentry auto-instrumentation for a
 * background workflow run to piggyback on, so this module still hand-rolls a
 * root span with per-step child spans -- just on `Sentry.startInactiveSpan` /
 * `Sentry.withActiveSpan` instead of the removed `startTransaction` /
 * `.startChild()`.
 */

import * as Sentry from '@sentry/node';

import {
  startWorkflowTransaction,
  startStepSpan,
  trackStepCompletion,
  finishWorkflowTransaction,
  finishWorkflowTransactionOnError,
} from '../../../src/workflows/workflowMonitoring';

/** Minimal shape of the envelope Sentry's transport receives, enough to find a transaction item. */
type CapturedEnvelope = [unknown, Array<[{ type?: string }, Record<string, any>]>];

function findTransactionEvent(
  envelopes: CapturedEnvelope[],
  op: string,
): Record<string, any> | undefined {
  for (const [, items] of envelopes) {
    const transactionItem = items.find(
      ([itemHeader, itemBody]) =>
        itemHeader.type === 'transaction' && itemBody?.contexts?.trace?.op === op,
    );
    if (transactionItem) {
      return transactionItem[1];
    }
  }
  return undefined;
}

describe('workflowMonitoring', () => {
  const originalEnv = process.env;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  describe('installed SDK shape', () => {
    it('still exposes neither v7 entry point on the installed SDK', () => {
      // Regression guard: if this ever starts failing, either the SDK grew
      // these back or something is mocking them -- re-check whether the
      // v10 span API below is still the right shape.
      expect((Sentry as Record<string, unknown>).startTransaction).toBeUndefined();
      expect((Sentry as Record<string, unknown>).getCurrentHub).toBeUndefined();
    });

    it('exposes the v10 span API this module depends on', () => {
      expect(typeof Sentry.startInactiveSpan).toBe('function');
      expect(typeof Sentry.withActiveSpan).toBe('function');
    });
  });

  describe('when Sentry is not configured (no SENTRY_DSN)', () => {
    beforeEach(() => {
      delete process.env.SENTRY_DSN;
    });

    it('runs a full workflow lifecycle without throwing or warning', () => {
      expect(() => {
        const transaction = startWorkflowTransaction('wf-1', { userId: 'user-1' });
        const stepSpan = startStepSpan(transaction, { type: 'analyze', name: 'Analyze', order: 2 });
        trackStepCompletion('analyze', Date.now(), stepSpan, 10, 'completed');
        finishWorkflowTransaction(transaction, {
          workflowExecutionTime: 100,
          totalTokenUsage: 10,
          completedStepsCount: 1,
          skippedStepsCount: 0,
          finalStatus: 'completed',
        });
      }).not.toThrow();

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('runs the error path without throwing or warning', () => {
      expect(() => {
        const transaction = startWorkflowTransaction('wf-err', undefined);
        finishWorkflowTransactionOnError(transaction, 50, 'boom');
      }).not.toThrow();

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('SDK surface missing', () => {
    /** Real module, `startInactiveSpan` deleted -- a regressed SDK, not an invented mock. */
    function mockSentryWithoutSpanApi() {
      jest.resetModules();
      jest.doMock('@sentry/node', () => {
        const actualSentry = jest.requireActual<typeof Sentry>('@sentry/node');
        const withoutSpanApi: Record<string, unknown> = { ...actualSentry };
        delete withoutSpanApi.startInactiveSpan;
        return withoutSpanApi;
      });
    }

    afterEach(() => {
      jest.dontMock('@sentry/node');
      jest.resetModules();
    });

    it('warns once, distinctly, when tracing is configured but the SDK lacks the span API', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_TRACES_SAMPLE_RATE = '1.0';
      mockSentryWithoutSpanApi();

      const {
        startWorkflowTransaction: freshStart,
      } = require('../../../src/workflows/workflowMonitoring');

      const transaction1 = freshStart('wf-a');
      const transaction2 = freshStart('wf-b');

      expect(transaction1).toBeNull();
      expect(transaction2).toBeNull();

      const surfaceWarnings = consoleWarnSpy.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('does not expose'),
      );
      // Once per process, not once per workflow run.
      expect(surfaceWarnings).toHaveLength(1);
    });

    // Regression test for QA round-1 Medium on PR #782: the warn-once gate
    // (`isSentryTracingConfigured`) originally required
    // SENTRY_TRACES_SAMPLE_RATE > 0 in addition to a DSN, but initSentry()
    // (src/utils/sentry.ts) defaults that rate when it's unset -- so a
    // DSN-only config, the documented minimal setup, was silently treated
    // as "not configured" and this warning never fired even though tracing
    // itself was genuinely on. This is the exact production shape #770's fix
    // is likely to take.
    it('warns about a missing span API even with a DSN-only config (no explicit sample rate)', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;
      mockSentryWithoutSpanApi();

      const {
        startWorkflowTransaction: freshStart,
      } = require('../../../src/workflows/workflowMonitoring');

      const transaction = freshStart('wf-dsn-only');
      expect(transaction).toBeNull();

      const surfaceWarnings = consoleWarnSpy.mock.calls.filter(
        ([message]) => typeof message === 'string' && message.includes('does not expose'),
      );
      expect(surfaceWarnings).toHaveLength(1);
    });

    it('stays silent about a missing SDK surface when tracing was never configured', () => {
      delete process.env.SENTRY_DSN;
      mockSentryWithoutSpanApi();

      const {
        startWorkflowTransaction: freshStart,
        startStepSpan: freshStartStep,
        trackStepCompletion: freshTrackCompletion,
        finishWorkflowTransaction: freshFinish,
      } = require('../../../src/workflows/workflowMonitoring');

      expect(() => {
        const transaction = freshStart('wf-c');
        const stepSpan = freshStartStep(transaction, { type: 'upload', name: 'Upload', order: 0 });
        freshTrackCompletion('upload', Date.now(), stepSpan);
        freshFinish(transaction, {
          workflowExecutionTime: 10,
          totalTokenUsage: 0,
          completedStepsCount: 1,
          skippedStepsCount: 0,
          finalStatus: 'completed',
        });
      }).not.toThrow();

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  // ── Against a live Sentry client (real @sentry/node, captured transport) ──
  //
  // The tests above never initialize Sentry, so `startInactiveSpan` always
  // returns a no-op `SentryNonRecordingSpan` -- proving "doesn't throw" but not
  // "produces a real span tree". This block initializes Sentry for real with a
  // transport that hands envelopes back to the test, and proves a workflow run
  // produces one root `workflow.execute` span whose child `workflow.step` spans
  // carry the right attributes and are actually nested under it (parent_span_id
  // matches the root's span_id) -- the level a mock cannot reach, and the level
  // at which #764 would have failed the moment the module called an API the
  // installed SDK didn't have.
  describe('against a live Sentry client (real @sentry/node, no mocking)', () => {
    let capturedEnvelopes: CapturedEnvelope[];

    beforeAll(() => {
      Sentry.init({
        dsn: 'https://abc123@example.com/000000',
        tracesSampleRate: 1.0,
        transport: () =>
          ({
            send: (envelope: CapturedEnvelope) => {
              capturedEnvelopes.push(envelope);
              return Promise.resolve({});
            },
            flush: () => Promise.resolve(true),
          }) as any,
      });
    });

    beforeEach(() => {
      capturedEnvelopes = [];
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_TRACES_SAMPLE_RATE = '1.0';
    });

    it('produces a root span with per-step child spans and attributes', async () => {
      const transaction = startWorkflowTransaction('wf-live', { userId: 'user-live' });
      expect(transaction).not.toBeNull();

      const analyzeStart = Date.now();
      const analyzeSpan = startStepSpan(transaction, { type: 'analyze', name: 'AI Content Analysis', order: 2 });
      trackStepCompletion('analyze', analyzeStart, analyzeSpan, 42, 'completed');

      const uploadStart = Date.now();
      const uploadSpan = startStepSpan(transaction, { type: 'upload', name: 'Upload File', order: 0 });
      trackStepCompletion('upload', uploadStart, uploadSpan, 0, 'failed', 'disk full');

      finishWorkflowTransaction(transaction, {
        workflowExecutionTime: 250,
        totalTokenUsage: 42,
        completedStepsCount: 1,
        skippedStepsCount: 1,
        finalStatus: 'partial',
      });

      await Sentry.flush(1000);

      const transactionEvent = findTransactionEvent(capturedEnvelopes, 'workflow.execute');
      expect(transactionEvent).toBeDefined();

      const rootData = transactionEvent?.contexts?.trace?.data ?? {};
      expect(rootData.workflow_id).toBe('wf-live');
      expect(rootData.user_id).toBe('user-live');
      expect(rootData.workflow_execution_time_ms).toBe(250);
      expect(rootData.total_token_usage).toBe(42);
      expect(rootData.completed_steps).toBe(1);
      expect(rootData.skipped_steps).toBe(1);
      expect(rootData.final_status).toBe('partial');
      // 'partial' isn't a failure -- the root span's own status stays OK.
      expect(transactionEvent?.contexts?.trace?.status).toBe('ok');

      const rootSpanId = transactionEvent?.contexts?.trace?.span_id;
      expect(rootSpanId).toEqual(expect.any(String));

      const stepSpans: Array<Record<string, any>> = transactionEvent?.spans ?? [];
      expect(stepSpans).toHaveLength(2);

      // Nesting: every step span is a genuine child of the workflow's root span.
      for (const span of stepSpans) {
        expect(span.parent_span_id).toBe(rootSpanId);
        expect(span.op).toBe('workflow.step');
      }

      const analyzeEvent = stepSpans.find((s) => s.data.step_type === 'analyze');
      expect(analyzeEvent?.data).toMatchObject({
        step_name: 'AI Content Analysis',
        step_order: 2,
        status: 'completed',
        tokens_used: 42,
      });
      expect(analyzeEvent?.data.duration_ms).toEqual(expect.any(Number));
      expect(analyzeEvent?.status).toBe('ok');

      const uploadEvent = stepSpans.find((s) => s.data.step_type === 'upload');
      expect(uploadEvent?.data).toMatchObject({
        step_name: 'Upload File',
        step_order: 0,
        status: 'failed',
        error: 'disk full',
      });
      expect(uploadEvent?.status).toBe('internal_error');
    });

    it('marks the root span as an error and records the error message on unhandled failure', async () => {
      const transaction = startWorkflowTransaction('wf-live-error');
      finishWorkflowTransactionOnError(transaction, 75, 'orchestrator exploded');

      await Sentry.flush(1000);

      const transactionEvent = findTransactionEvent(capturedEnvelopes, 'workflow.execute');
      expect(transactionEvent).toBeDefined();
      expect(transactionEvent?.contexts?.trace?.status).toBe('internal_error');

      const rootData = transactionEvent?.contexts?.trace?.data ?? {};
      expect(rootData.workflow_execution_time_ms).toBe(75);
      expect(rootData.error).toBe('orchestrator exploded');
    });
  });
});
