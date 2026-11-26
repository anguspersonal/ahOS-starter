/**
 * Unit tests for Sentry initialization utility
 * Tests initialization, configuration, and graceful degradation
 */

import { initSentry, captureException, captureMessage } from '../sentry';
import * as Sentry from '@sentry/node';

// Mock Sentry SDK
jest.mock('@sentry/node', () => {
  const mockClient = {
    getOptions: jest.fn(),
  };
  const mockHub = {
    getClient: jest.fn(() => mockClient),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = {
        setTag: jest.fn(),
        setUser: jest.fn(),
        setExtras: jest.fn(),
        setLevel: jest.fn(),
      };
      callback(scope);
    }),
  };
  return {
    init: jest.fn(),
    getCurrentHub: jest.fn(() => mockHub),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = {
        setTag: jest.fn(),
        setUser: jest.fn(),
        setExtras: jest.fn(),
        setLevel: jest.fn(),
      };
      callback(scope);
    }),
    setUser: jest.fn(),
    setContext: jest.fn(),
  };
});

describe('Sentry Initialization', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Clear all mocks
    jest.clearAllMocks();
    // Spy on console methods
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('Initialization with valid DSN', () => {
    it('should initialize Sentry with valid DSN and environment variables', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'test';
      process.env.SENTRY_SAMPLE_RATE = '0.5';
      process.env.SENTRY_TRACES_SAMPLE_RATE = '0.3';

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://abc123@example.com/123',
          environment: 'test',
          sampleRate: 0.5,
          tracesSampleRate: 0.3,
          beforeSend: expect.any(Function),
        })
      );
    });

    it('should use default environment when SENTRY_ENVIRONMENT is not set', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      delete process.env.SENTRY_ENVIRONMENT;

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: 'development',
        })
      );
    });

    it('should use default sampling rates for development environment', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'development';
      delete process.env.SENTRY_SAMPLE_RATE;
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          sampleRate: 1.0,
          tracesSampleRate: 1.0,
        })
      );
    });

    it('should use default sampling rates for production environment', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'production';
      delete process.env.SENTRY_SAMPLE_RATE;
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          sampleRate: 0.1,
          tracesSampleRate: 0.1,
        })
      );
    });
  });

  describe('Initialization failure when DSN is missing', () => {
    it('should gracefully degrade when DSN is not configured', () => {
      delete process.env.SENTRY_DSN;

      initSentry();

      expect(Sentry.init).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Sentry] SENTRY_DSN not configured, monitoring disabled'
      );
    });

    it('should still validate optional environment variables when DSN is missing', () => {
      delete process.env.SENTRY_DSN;
      delete process.env.RESEND_API_KEY;
      delete process.env.SENTRY_ALERT_EMAIL;

      initSentry();

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Sentry] RESEND_API_KEY not configured - email alerts via Resend will be disabled'
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Sentry] SENTRY_ALERT_EMAIL not configured - Sentry email notifications may not be enabled'
      );
    });
  });

  describe('Sampling rate configuration', () => {
    it('should use production sampling rates when environment is production', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'production';

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          sampleRate: 0.1,
          tracesSampleRate: 0.1,
        })
      );
    });

    it('should use development sampling rates when environment is development', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'development';

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          sampleRate: 1.0,
          tracesSampleRate: 1.0,
        })
      );
    });

    it('should use custom sampling rates from environment variables', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'production';
      process.env.SENTRY_SAMPLE_RATE = '0.25';
      process.env.SENTRY_TRACES_SAMPLE_RATE = '0.15';

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          sampleRate: 0.25,
          tracesSampleRate: 0.15,
        })
      );
    });
  });

  describe('beforeSend hook filtering logic', () => {
    let beforeSendHook: ((event: any, hint: any) => any) | undefined;

    beforeEach(() => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      initSentry();
      // Extract the beforeSend hook from the init call
      const initCall = (Sentry.init as jest.Mock).mock.calls[0];
      beforeSendHook = initCall[0].beforeSend;
    });

    it('should filter health endpoint errors', () => {
      const event = {
        request: { url: 'https://example.com/health' },
      };
      const result = beforeSendHook!(event, {});
      expect(result).toBeNull();
    });

    it('should filter 404 errors', () => {
      const event = {
        exception: {
          values: [{ value: '404 Not Found' }],
        },
      };
      const result = beforeSendHook!(event, {});
      expect(result).toBeNull();
    });

    it('should filter network timeout errors', () => {
      const event1 = {
        exception: {
          values: [{ type: 'NetworkError' }],
        },
      };
      const event2 = {
        exception: {
          values: [{ value: 'Request timeout' }],
        },
      };
      const event3 = {
        exception: {
          values: [{ value: 'ETIMEDOUT connection timeout' }],
        },
      };

      expect(beforeSendHook!(event1, {})).toBeNull();
      expect(beforeSendHook!(event2, {})).toBeNull();
      expect(beforeSendHook!(event3, {})).toBeNull();
    });

    it('should filter CORS errors', () => {
      const event1 = {
        exception: {
          values: [{ value: 'CORS error: Access denied' }],
        },
      };
      const event2 = {
        exception: {
          values: [{ value: 'cors policy violation' }],
        },
      };

      expect(beforeSendHook!(event1, {})).toBeNull();
      expect(beforeSendHook!(event2, {})).toBeNull();
    });

    it('should allow other errors through', () => {
      const event = {
        exception: {
          values: [{ value: 'Database connection failed' }],
        },
      };
      const result = beforeSendHook!(event, {});
      expect(result).toBe(event);
    });
  });

  describe('Graceful degradation when Sentry is not configured', () => {
    it('should not throw errors when capturing exceptions without initialization', () => {
      delete process.env.SENTRY_DSN;
      initSentry();

      const error = new Error('Test error');
      expect(() => captureException(error)).not.toThrow();
    });

    it('should not throw errors when capturing messages without initialization', () => {
      delete process.env.SENTRY_DSN;
      initSentry();

      expect(() => captureMessage('Test message')).not.toThrow();
    });
  });

  describe('Environment variable validation', () => {
    it('should validate DSN format and reject invalid DSN', () => {
      process.env.SENTRY_DSN = 'invalid-dsn';
      initSentry();

      expect(Sentry.init).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Sentry] Invalid SENTRY_DSN format. Expected format: https://<key>@<host>/<project_id>'
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Sentry] Monitoring disabled due to invalid configuration'
      );
    });

    it('should accept valid DSN format', () => {
      process.env.SENTRY_DSN = 'https://abc123def456@example.com/789';
      initSentry();

      expect(Sentry.init).toHaveBeenCalled();
    });

    it('should accept quoted or uppercase DSN formats', () => {
      process.env.SENTRY_DSN = '"https://ABC123DEF456@example.com/789"';
      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://ABC123DEF456@example.com/789',
        })
      );
    });

    it('should log warnings for missing optional environment variables', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      delete process.env.RESEND_API_KEY;
      delete process.env.SENTRY_ALERT_EMAIL;

      initSentry();

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Sentry] RESEND_API_KEY not configured - email alerts via Resend will be disabled'
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Sentry] SENTRY_ALERT_EMAIL not configured - Sentry email notifications may not be enabled'
      );
    });

    it('should not log warnings when optional environment variables are set', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.RESEND_API_KEY = 'test-key';
      process.env.SENTRY_ALERT_EMAIL = 'test@example.com';

      initSentry();

      expect(consoleWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('RESEND_API_KEY not configured')
      );
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('SENTRY_ALERT_EMAIL not configured')
      );
    });

    it('should apply default values when variables are missing', () => {
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      delete process.env.SENTRY_ENVIRONMENT;
      delete process.env.SENTRY_SAMPLE_RATE;
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;

      initSentry();

      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          environment: 'development',
          sampleRate: 1.0,
          tracesSampleRate: 1.0,
        })
      );
    });
  });
});
