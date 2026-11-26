/**
 * Unit tests for the request-logger middleware: request logging, health-endpoint
 * exclusion, slow-request warnings, and Sentry performance tracking.
 *
 * Ported from src/middleware/__tests__/requestLogger.test.js, which had never
 * executed (jest.config.js `testMatch` is `*.test.ts` only) and could not have,
 * as written: `transform` handles `^.+\.ts$` only, so a .js test is never
 * transformed, `jest.mock` is never hoisted, and the top-level
 * `require('@sentry/node')` captured the REAL SDK. The mock assertions then
 * threw inside a `setTimeout`, so `done()` never fired and five tests reported
 * as 30-second timeouts rather than failures.
 *
 * ## What changed beyond the port
 *
 * The original drove `res.on('finish')` by racing real timers: the fake `res`
 * scheduled the handler with `setTimeout(cb, 0)` and each test asserted from
 * inside its own `setTimeout(..., 50)`. Two consequences, both observed:
 *
 *   1. Deferred `console.log('[Request]')` calls fired AFTER the test that
 *      caused them finished, landing in the NEXT test's spy — jest reported
 *      "Cannot log after tests are done". The health-endpoint test then saw a
 *      leaked '[Request]' log from a previous test and failed.
 *   2. An assertion that throws inside a timer callback never reaches `done()`,
 *      so every genuine failure surfaced as an opaque 30s timeout.
 *
 * The `finish` handler is now captured and invoked synchronously, so each test
 * is self-contained and a failed assertion reports as a failure. `Date.now` is
 * stubbed for the slow-request case, which also removes ~7s of real sleeping.
 *
 * ## Issue #661: the Sentry block below was characterisation, now it's a fix
 *
 * requestLogger.js targeted the Sentry v7 API (`Sentry.getCurrentHub()`,
 * `Sentry.startTransaction()`), which the installed @sentry/node@10 does not
 * expose. The resulting TypeError was swallowed by the module's own
 * availability check, so performance monitoring silently did nothing. The
 * "Sentry performance tracking (currently inert)" block used to pin that
 * defect down; now that the middleware has been ported to the v10 span API,
 * this block proves the port actually works.
 *
 * Deliberately NOT done here: `jest.mock('@sentry/node', ...)`. A mock that
 * invents its dependency's surface (as the original, never-run test suite
 * did for `startTransaction`/`getCurrentHub`) cannot detect that surface
 * disappearing — that is the exact shape of bug this issue was about. Every
 * test below either runs against the real, installed SDK, or -- for the one
 * case that needs to simulate a regressed SDK -- deletes a real function
 * from the real module rather than fabricating one that never existed.
 *
 * ## Round-1 QA fix: the env-var gate re-derived "is tracing on?" and drifted
 *
 * The first version of this fix gated span annotation on
 * `SENTRY_DSN && SENTRY_TRACES_SAMPLE_RATE > 0`, re-parsed from env. But
 * `initSentry()` (src/utils/sentry.ts) defaults `SENTRY_TRACES_SAMPLE_RATE`
 * to 0.1/1.0 when it's unset, so a DSN-only config -- the documented minimal
 * setup -- traced in Sentry while that gate silently called it "not
 * configured" and annotated nothing, with no warning either. The
 * "DSN only, no explicit sample rate" test below pins that down: it is the
 * regression test for the exact production config this bug would have hit.
 * The fix no longer gates on env vars at all for the annotation attempt --
 * only `Sentry.getActiveSpan()` (Sentry's own answer) decides whether there's
 * anything to annotate; the env-var check now exists solely to decide
 * whether a missing-SDK-surface warning is worth emitting.
 */

import type { Request, Response, NextFunction } from 'express';
import * as fc from 'fast-check';
import express from 'express';
import request from 'supertest';

import * as Sentry from '@sentry/node';

const { requestLogger } = require('../../../src/middleware/requestLogger');

const SLOW_THRESHOLD_MS = 5000;

/** Minimal shape of the envelope Sentry's transport receives, enough to find a transaction item. */
type CapturedEnvelope = [unknown, Array<[{ type?: string }, Record<string, any>]>];

/**
 * Finds the `http.server` root transaction -- the one this middleware
 * annotates -- rather than just the first transaction item in the envelope
 * list. Picking "first" would also match an `http.client` transaction if one
 * ever appeared (e.g. from an outbound call an app under test makes), which
 * is a different span with different data; asserting against the wrong one
 * would either pass on the wrong evidence or fail for the wrong reason.
 */
function findTransactionEvent(envelopes: CapturedEnvelope[]): Record<string, any> | undefined {
  for (const [, items] of envelopes) {
    const transactionItem = items.find(
      ([itemHeader, itemBody]) =>
        itemHeader.type === 'transaction' && itemBody?.contexts?.trace?.op === 'http.server',
    );
    if (transactionItem) {
      return transactionItem[1];
    }
  }
  return undefined;
}

/** A fake response that hands back its own lifecycle handlers to the test. */
function createRes(statusCode = 200) {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const res = {
    statusCode,
    on: jest.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = cb;
    }),
  };
  return {
    res: res as unknown as Response,
    /** Fire the handler Express would fire when the response completes. */
    finish: () => handlers.finish?.(),
  };
}

function createReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    path: '/api/workflows',
    originalUrl: '/api/workflows',
    headers: { 'x-request-id': 'req-123' },
    user: { id: 'user-123' },
    ip: '127.0.0.1',
    ...overrides,
  } as unknown as Request;
}

describe('requestLogger middleware', () => {
  const originalEnv = process.env;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let next: NextFunction;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    next = jest.fn() as NextFunction;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  /** Enable Sentry performance monitoring for the tests that need a transaction. */
  function enableTracing() {
    process.env.SENTRY_DSN = 'https://abc123@example.com/123';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '1.0';
  }

  describe('request logging', () => {
    it('logs every required field', () => {
      const { res, finish } = createRes();
      requestLogger(createReq(), res, next);
      finish();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Request]',
        expect.objectContaining({
          requestId: 'req-123',
          method: 'POST',
          path: '/api/workflows',
          status: 200,
          durationMs: expect.any(Number),
          userId: 'user-123',
          ip: '127.0.0.1',
        }),
      );
    });

    it('falls back to x-correlation-id when x-request-id is absent', () => {
      const { res, finish } = createRes();
      requestLogger(createReq({ headers: { 'x-correlation-id': 'corr-123' } }), res, next);
      finish();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Request]',
        expect.objectContaining({ requestId: 'corr-123' }),
      );
    });

    it('logs a null requestId when neither header is present', () => {
      const { res, finish } = createRes();
      requestLogger(createReq({ headers: {} }), res, next);
      finish();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Request]',
        expect.objectContaining({ requestId: null }),
      );
    });

    it('logs a null userId when the request is unauthenticated', () => {
      const { res, finish } = createRes();
      requestLogger(createReq({ user: undefined }), res, next);
      finish();

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Request]',
        expect.objectContaining({ userId: null }),
      );
    });

    it('calls next() to continue the chain', () => {
      const { res } = createRes();
      requestLogger(createReq(), res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('health endpoint', () => {
    it('is excluded from logging', () => {
      const { res, finish } = createRes();
      requestLogger(createReq({ path: '/health', originalUrl: '/health' }), res, next);
      finish();

      expect(consoleLogSpy).not.toHaveBeenCalledWith('[Request]', expect.anything());
    });

    // No Sentry teardown to assert here: the middleware no longer owns a span's
    // lifecycle (see the tracing block below) -- Sentry's own auto-instrumentation
    // opens and closes the request span regardless of what this middleware does.
    // What matters, and is asserted, is that the health path stays silent.
  });

  describe('slow requests', () => {
    /** Advance the clock between middleware entry and response finish. */
    function withElapsed(ms: number, run: () => void) {
      const base = Date.now();
      let call = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? base : base + ms));
      run();
    }

    it('warns above the 5s threshold', () => {
      const { res, finish } = createRes();
      withElapsed(SLOW_THRESHOLD_MS + 1000, () => {
        requestLogger(createReq(), res, next);
        finish();
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Slow Request]',
        expect.objectContaining({
          path: '/api/workflows',
          durationMs: SLOW_THRESHOLD_MS + 1000,
          method: 'POST',
        }),
      );
    });

    it('stays quiet below the threshold', () => {
      const { res, finish } = createRes();
      withElapsed(10, () => {
        requestLogger(createReq(), res, next);
        finish();
      });

      expect(consoleWarnSpy).not.toHaveBeenCalledWith('[Slow Request]', expect.anything());
    });
  });

  // ── Sentry performance tracking: ported to the v10 span API (#661) ──────
  //
  // requestLogger.js used to target the Sentry v7 API: `Sentry.getCurrentHub()`
  // in isSentryPerformanceMonitoringAvailable(), then `Sentry.startTransaction()`.
  // The installed SDK is @sentry/node@10, where both are `undefined`. The
  // resulting TypeError was swallowed by the availability check's own
  // `catch { return false }`, so no transaction was ever opened -- no log
  // line, no warning, no Sentry error. This block used to characterise that
  // silence; it now proves the replacement actually works.
  //
  // There is no longer a single `isSentryPerformanceMonitoringAvailable()`
  // gate. Annotation is attempted whenever `hasSentryTracingApi()` says the
  // SDK has the right shape -- `annotateActiveSpan` itself no-ops when
  // `Sentry.getActiveSpan()` has nothing to annotate, so nothing needs to
  // gate the attempt. `isSentryTracingConfigured()` (the env-var re-read)
  // survives only to decide whether the SDK-surface-missing warning fires.
  // There's also no `res.on('error')` handler any more -- see the header of
  // requestLogger.js for why it was provably inert.
  describe('Sentry performance tracking (v10 span API)', () => {
    it('still exposes neither v7 entry point on the installed SDK', () => {
      // Regression guard: if this ever starts failing, either the SDK grew
      // these back or something is mocking them -- either way, re-check
      // whether the code below still needs its v10 shape.
      expect((Sentry as Record<string, unknown>).startTransaction).toBeUndefined();
      expect((Sentry as Record<string, unknown>).getCurrentHub).toBeUndefined();
    });

    it('exposes the v10 span API this middleware depends on', () => {
      expect(typeof Sentry.getActiveSpan).toBe('function');
      expect(typeof Sentry.setHttpStatus).toBe('function');
    });

    it('does not throw or warn when Sentry is not configured (no active span to annotate)', () => {
      // Against the fake req/res harness there's never a real active span --
      // annotateActiveSpan is still called (the SDK has the right API), it
      // just no-ops. What matters here is that nothing throws or warns.
      delete process.env.SENTRY_DSN;
      const { res, finish } = createRes();

      expect(() => {
        requestLogger(createReq(), res, next);
        finish();
      }).not.toThrow();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('does not throw or warn when tracesSampleRate is 0', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_TRACES_SAMPLE_RATE = '0';
      const { res, finish } = createRes();

      expect(() => {
        requestLogger(createReq(), res, next);
        finish();
      }).not.toThrow();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('warns once, distinctly, when tracing is configured but the SDK lacks the required span API', () => {
      // Simulates an SDK regressed below what this file depends on, by
      // requiring a fresh copy of the middleware against a plain object that
      // carries every REAL export of @sentry/node except `getActiveSpan` --
      // not by mocking a replacement into existence for a capability that
      // never existed (the anti-pattern issue #661 called out). This is what
      // the availability check must stop swallowing: "not configured" and
      // "the API I need is gone" must not look the same.
      enableTracing();
      jest.resetModules();
      jest.doMock('@sentry/node', () => {
        const actualSentry = jest.requireActual<typeof Sentry>('@sentry/node');
        const withoutActiveSpan: Record<string, unknown> = { ...actualSentry };
        delete withoutActiveSpan.getActiveSpan;
        return withoutActiveSpan;
      });

      try {
        const { requestLogger: freshRequestLogger } = require('../../../src/middleware/requestLogger');

        const { res: res1, finish: finish1 } = createRes();
        freshRequestLogger(createReq(), res1, next);
        finish1();

        const { res: res2, finish: finish2 } = createRes();
        freshRequestLogger(createReq(), res2, next);
        finish2();

        const surfaceWarnings = consoleWarnSpy.mock.calls.filter(
          ([message]) => typeof message === 'string' && message.includes('does not expose'),
        );
        // Once per process, not once per request.
        expect(surfaceWarnings).toHaveLength(1);
        // Still doesn't break the request the middleware is protecting.
        expect(consoleLogSpy).toHaveBeenCalledTimes(2);
      } finally {
        jest.dontMock('@sentry/node');
        jest.resetModules();
      }
    });

    // Regression test for issue #787 (round-2 QA on #764/PR #782): the
    // predicate above went DSN-only, but this warning's text still told an
    // operator to go check SENTRY_TRACES_SAMPLE_RATE -- a variable it no
    // longer consults. `.includes('does not expose')` above would not have
    // caught a drift in the parenthetical, so this test pins the actual text.
    it('names only SENTRY_DSN in the missing-span-API warning, matching the DSN-only predicate', () => {
      enableTracing();
      jest.resetModules();
      jest.doMock('@sentry/node', () => {
        const actualSentry = jest.requireActual<typeof Sentry>('@sentry/node');
        const withoutActiveSpan: Record<string, unknown> = { ...actualSentry };
        delete withoutActiveSpan.getActiveSpan;
        return withoutActiveSpan;
      });

      try {
        const { requestLogger: freshRequestLogger } = require('../../../src/middleware/requestLogger');
        const { res, finish } = createRes();
        freshRequestLogger(createReq(), res, next);
        finish();

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('[RequestLogger] SENTRY_DSN is configured but the installed @sentry/node'),
        );
        const [warnedMessage] = consoleWarnSpy.mock.calls.find(
          ([message]) => typeof message === 'string' && message.includes('does not expose'),
        )!;
        expect(warnedMessage).not.toContain('SENTRY_TRACES_SAMPLE_RATE');
      } finally {
        jest.dontMock('@sentry/node');
        jest.resetModules();
      }
    });

    // Regression test for QA round-1 Medium on #764/PR #782, which found the
    // identical residual trap in workflowMonitoring.ts's copy of this exact
    // predicate: the warn-once gate originally required
    // SENTRY_TRACES_SAMPLE_RATE > 0 in addition to a DSN, but initSentry()
    // defaults that rate when it's unset -- so a DSN-only config, the
    // documented minimal setup, was silently treated as "not configured" and
    // this warning never fired even though tracing itself was genuinely on.
    it('warns about a missing span API even with a DSN-only config (no explicit sample rate)', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;
      jest.resetModules();
      jest.doMock('@sentry/node', () => {
        const actualSentry = jest.requireActual<typeof Sentry>('@sentry/node');
        const withoutActiveSpan: Record<string, unknown> = { ...actualSentry };
        delete withoutActiveSpan.getActiveSpan;
        return withoutActiveSpan;
      });

      try {
        const { requestLogger: freshRequestLogger } = require('../../../src/middleware/requestLogger');
        const { res, finish } = createRes();
        freshRequestLogger(createReq(), res, next);
        finish();

        const surfaceWarnings = consoleWarnSpy.mock.calls.filter(
          ([message]) => typeof message === 'string' && message.includes('does not expose'),
        );
        expect(surfaceWarnings).toHaveLength(1);
      } finally {
        jest.dontMock('@sentry/node');
        jest.resetModules();
      }
    });

    it('stays silent about a missing SDK surface when tracing was never configured', () => {
      // The mirror image of the test above: the same regressed SDK (real
      // module, `getActiveSpan` deleted) must NOT warn when nobody asked for
      // tracing in the first place. Without this, "not configured" and "SDK
      // surface missing" would only be distinguishable in one direction.
      delete process.env.SENTRY_DSN;
      jest.resetModules();
      jest.doMock('@sentry/node', () => {
        const actualSentry = jest.requireActual<typeof Sentry>('@sentry/node');
        const withoutActiveSpan: Record<string, unknown> = { ...actualSentry };
        delete withoutActiveSpan.getActiveSpan;
        return withoutActiveSpan;
      });

      try {
        const { requestLogger: freshRequestLogger } = require('../../../src/middleware/requestLogger');
        const { res, finish } = createRes();
        freshRequestLogger(createReq(), res, next);
        finish();

        expect(consoleWarnSpy).not.toHaveBeenCalled();
      } finally {
        jest.dontMock('@sentry/node');
        jest.resetModules();
      }
    });

    // The tests above exercise requestLogger() directly against fake req/res
    // objects, which never puts a real Sentry span into scope -- there's no
    // real incoming HTTP request for Sentry's own instrumentation to attach
    // one to. This block instead sends a real request through a real Express
    // app with Sentry actually initialized, so `Sentry.getActiveSpan()` finds
    // the same auto-instrumented span production would create, and asserts
    // the middleware's calls into the v10 API (`setHttpStatus`,
    // `span.setAttributes`) land on it. This is the level a mock cannot
    // reach: it is what would have caught #661, because it fails the moment
    // the middleware calls an API the installed SDK doesn't have.
    describe('against a live request (real @sentry/node, no mocking)', () => {
      let capturedEnvelopes: CapturedEnvelope[];

      beforeAll(() => {
        Sentry.init({
          dsn: 'https://abc123@example.com/000000',
          tracesSampleRate: 1.0,
          // Swap the network transport for one that hands envelopes back to
          // the test instead of sending them anywhere.
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
        enableTracing();
      });

      it('annotates the real auto-instrumented span with request detail', async () => {
        const app = express();
        app.use(requestLogger);
        app.get('/api/workflows', (_req, res) => {
          res.status(201).json({ ok: true });
        });

        await request(app).get('/api/workflows').set('x-request-id', 'req-abc').expect(201);
        await Sentry.flush(1000);

        const transactionEvent = findTransactionEvent(capturedEnvelopes);
        expect(transactionEvent).toBeDefined();

        const traceData = transactionEvent?.contexts?.trace?.data ?? {};
        expect(traceData['http.response.status_code']).toBe(201);
        expect(traceData['request.duration_ms']).toEqual(expect.any(Number));
        expect(traceData['request.id']).toBe('req-abc');
      });

      // Regression test for the round-1 High finding: the middleware's own
      // gate re-derived "is tracing on?" from SENTRY_DSN + SENTRY_TRACES_SAMPLE_RATE,
      // but initSentry() (src/utils/sentry.ts:83-85) defaults the sample rate
      // to 0.1/1.0 when it's unset -- so "DSN only", the documented minimal
      // config, traces in Sentry while the old gate silently called it "not
      // configured" and annotated nothing. This test simulates exactly that
      // shape: Sentry itself is already initialized and sampling (the
      // `beforeAll` above), but `process.env.SENTRY_TRACES_SAMPLE_RATE` is
      // unset when the request happens, matching production where
      // `initSentry()` resolves the rate once at boot and nothing re-reads
      // the env var afterwards.
      it('annotates the span even when SENTRY_TRACES_SAMPLE_RATE is unset (DSN-only config)', async () => {
        process.env.SENTRY_DSN = 'https://abc123@example.com/123';
        delete process.env.SENTRY_TRACES_SAMPLE_RATE;

        const app = express();
        app.use(requestLogger);
        app.get('/api/workflows', (_req, res) => {
          res.status(201).json({ ok: true });
        });

        await request(app).get('/api/workflows').set('x-request-id', 'req-dsn-only').expect(201);
        await Sentry.flush(1000);

        const transactionEvent = findTransactionEvent(capturedEnvelopes);
        expect(transactionEvent).toBeDefined();

        const traceData = transactionEvent?.contexts?.trace?.data ?? {};
        expect(traceData['request.duration_ms']).toEqual(expect.any(Number));
        expect(traceData['request.id']).toBe('req-dsn-only');
      });

      it('does not annotate anything for the health endpoint', async () => {
        const app = express();
        app.use(requestLogger);
        app.get('/health', (_req, res) => res.status(200).json({ status: 'healthy' }));

        await request(app).get('/health').expect(200);
        await Sentry.flush(1000);

        // The span still exists (Sentry's own instrumentation always opens
        // one) -- what we assert is that requestLogger contributed nothing
        // to it, matching the health-endpoint silence asserted above for logs.
        // `toBeDefined()` matters here as much as the emptiness check below:
        // without it, a transaction that never arrives at all (flush timing,
        // sampling, an envelope-ordering change) would leave `traceData` as
        // `{}` and the assertion below would pass while proving nothing.
        const transactionEvent = findTransactionEvent(capturedEnvelopes);
        expect(transactionEvent).toBeDefined();

        const traceData = transactionEvent?.contexts?.trace?.data ?? {};
        expect(traceData['request.duration_ms']).toBeUndefined();
      });
    });
  });

  // Carried over from src/middleware/__tests__/requestLogger.property.ts, which was
  // also never discovered (named `.property.ts`, and testMatch wants `*.test.ts`).
  // That file's own property asserted `duration < 20ms` around a 10ms sleep — a
  // flaky clock measurement, not a property of the middleware — and its "Property 6:
  // Performance Overhead Limit" cases measured Sentry work that never happens. What
  // IS a property is that the middleware handles arbitrary requests uniformly.
  describe('properties over arbitrary requests', () => {
    it('never throws, always calls next, and logs exactly one line per non-health request', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH'),
          fc.string({ minLength: 1, maxLength: 100 }).filter((p) => p !== '/health'),
          fc.integer({ min: 200, max: 599 }),
          fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          (method, path, statusCode, requestId) => {
            consoleLogSpy.mockClear();
            const { res, finish } = createRes(statusCode);
            const localNext = jest.fn() as NextFunction;

            expect(() => {
              requestLogger(
                createReq({
                  method,
                  path,
                  originalUrl: path,
                  headers: requestId ? { 'x-request-id': requestId } : {},
                }),
                res,
                localNext,
              );
              finish();
            }).not.toThrow();

            expect(localNext).toHaveBeenCalledTimes(1);
            expect(consoleLogSpy).toHaveBeenCalledTimes(1);
            expect(consoleLogSpy).toHaveBeenCalledWith(
              '[Request]',
              expect.objectContaining({
                method,
                path,
                status: statusCode,
                requestId: requestId ?? null,
              }),
            );
          },
        ),
        { numRuns: 50 },
      );
    });

    it('stays silent for /health whatever the method or status', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('GET', 'POST', 'PUT', 'DELETE', 'PATCH'),
          fc.integer({ min: 200, max: 599 }),
          (method, statusCode) => {
            consoleLogSpy.mockClear();
            const { res, finish } = createRes(statusCode);
            requestLogger(
              createReq({ method, path: '/health', originalUrl: '/health' }),
              res,
              jest.fn() as NextFunction,
            );
            finish();

            expect(consoleLogSpy).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
