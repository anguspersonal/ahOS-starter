/**
 * Unit tests for the error-handler middleware: Sentry capture, error context,
 * and the client response.
 *
 * Ported from src/middleware/__tests__/errorHandler.test.js, which had never
 * executed — jest.config.js `testMatch` only matches `*.test.ts`, so the .js
 * file was never discovered. It was also unrunnable as written: `transform`
 * only handles `^.+\.ts$`, so a .js test gets no transform, which means
 * babel-plugin-jest-hoist never runs and `jest.mock(...)` executes AFTER the
 * top-level `require`. The real @sentry/node and utils were captured, and the
 * mock assertions failed with "received value must be a mock or spy function".
 * Widening testMatch to .js would NOT have fixed that; porting to .ts does,
 * because ts-jest hoists.
 *
 * Every assertion below is carried over from the original — the middleware had
 * not drifted; only the harness was broken.
 */

import type { Request, Response, NextFunction } from 'express';

jest.mock('../../../src/utils/sentry', () => ({
  captureException: jest.fn(),
}));

jest.mock('../../../src/utils/alerts', () => ({
  sendAlert: jest.fn().mockResolvedValue(undefined),
}));

const { captureException } = require('../../../src/utils/sentry');
const { errorHandler } = require('../../../src/middleware/errorHandler');

type ErrorWithStatus = Error & { status?: number; statusCode?: number };

function createRes() {
  const res: Partial<Response> & { _status?: number; _json?: unknown } = {};
  res.status = ((code: number) => {
    res._status = code;
    return res as Response;
  }) as Response['status'];
  res.json = ((payload: unknown) => {
    res._json = payload;
    return res as Response;
  }) as Response['json'];
  return res as Response & { _status?: number; _json?: unknown };
}

describe('errorHandler middleware', () => {
  const originalEnv = process.env;
  let req: Request;
  let res: ReturnType<typeof createRes>;
  let next: NextFunction;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    req = {
      method: 'POST',
      path: '/api/workflows',
      headers: { 'x-request-id': 'req-123' },
      body: { workflowId: 'workflow-456', artifactId: 'artifact-789' },
      user: { id: 'user-123' },
    } as unknown as Request;

    res = createRes();
    next = jest.fn() as NextFunction;
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleErrorSpy.mockRestore();
  });

  function serverError(message = 'Test error'): ErrorWithStatus {
    const error = new Error(message) as ErrorWithStatus;
    error.status = 500;
    return error;
  }

  describe('Sentry capture', () => {
    it('captures unhandled errors with full context when Sentry is configured', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      const error = serverError();

      errorHandler(error, req, res, next);

      expect(captureException).toHaveBeenCalledWith(error, {
        tags: { endpoint: '/api/workflows', method: 'POST' },
        user: { id: 'user-123' },
        extra: {
          requestId: 'req-123',
          workflowId: 'workflow-456',
          artifactId: 'artifact-789',
        },
      });
    });

    it('falls back to x-correlation-id when x-request-id is absent', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      req.headers = { 'x-correlation-id': 'corr-123' };

      errorHandler(serverError(), req, res, next);

      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          extra: expect.objectContaining({ requestId: 'corr-123' }),
        }),
      );
    });

    it('handles a missing user without throwing', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      delete (req as Request & { user?: unknown }).user;

      errorHandler(serverError(), req, res, next);

      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ user: undefined }),
      );
    });

    it('does not capture when Sentry is not configured', () => {
      delete process.env.SENTRY_DSN;

      errorHandler(serverError(), req, res, next);

      expect(captureException).not.toHaveBeenCalled();
    });

    it('still answers the client when Sentry is not configured', () => {
      delete process.env.SENTRY_DSN;

      errorHandler(serverError(), req, res, next);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: { message: 'Test error' } });
    });
  });

  describe('client response', () => {
    it('sends the error status and message', () => {
      errorHandler(serverError(), req, res, next);

      expect(res._status).toBe(500);
      expect(res._json).toEqual({ error: { message: 'Test error' } });
    });

    it('includes the stack trace in development', () => {
      process.env.NODE_ENV = 'development';
      const error = serverError();
      error.stack = 'Error: Test error\n    at test.js:1:1';

      errorHandler(error, req, res, next);

      expect(res._json).toEqual({
        error: { message: 'Test error', stack: 'Error: Test error\n    at test.js:1:1' },
      });
    });

    it('omits the stack trace in production', () => {
      process.env.NODE_ENV = 'production';
      const error = serverError();
      error.stack = 'Error: Test error\n    at test.js:1:1';

      errorHandler(error, req, res, next);

      expect(res._json).toEqual({ error: { message: 'Test error' } });
    });

    it('defaults to 500 when no status is set', () => {
      errorHandler(new Error('Test error'), req, res, next);

      expect(res._status).toBe(500);
    });

    it('honours statusCode when status is absent', () => {
      const error = new Error('Test error') as ErrorWithStatus;
      error.statusCode = 404;

      errorHandler(error, req, res, next);

      expect(res._status).toBe(404);
    });

    it('defaults the message when the error carries none', () => {
      const error = new Error();
      delete (error as Partial<Error>).message;

      errorHandler(error, req, res, next);

      expect(res._json).toEqual({ error: { message: 'Internal Server Error' } });
    });
  });
});
