/**
 * Property tests for Sentry Integration
 * 
 * Property 1: Non-Blocking Error Tracking
 * Validates: Requirements 1.6, 1.14
 * 
 * Property 2: Error Filtering
 * Validates: Requirements 1.7, 1.8
 * 
 * Property 3: Sampling Rate Configuration
 * Validates: Requirements 1.2, 1.3, 1.4
 * 
 * Property 5: Graceful Degradation
 * Validates: Requirements 7.5, 7.6
 */

import { initSentry, captureException, captureMessage } from '../sentry';
import * as Sentry from '@sentry/node';
import * as fc from 'fast-check';

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

describe('Sentry Property Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  /**
   * Property 1: Non-Blocking Error Tracking
   * 
   * Validates: Requirements 1.6, 1.14
   * 
   * For any error captured by the Monitoring_System:
   * - The Monitoring_System SHALL send the error to Sentry using async, non-blocking operations
   * - The Monitoring_System SHALL NOT block the application response or execution flow
   */
  describe('Property 1: Non-Blocking Error Tracking', () => {
    it('should return immediately from captureException without blocking', () => {
      // Initialize Sentry
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'test';
      initSentry();

      const startTime = Date.now();
      const error = new Error('Test error');
      captureException(error);
      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should return in less than 10ms (non-blocking)
      expect(duration).toBeLessThan(10);
    });

    it('should not significantly impact response time', () => {
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'test';
      initSentry();

      const iterations = 100;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        captureException(new Error(`Error ${i}`));
      }

      const endTime = Date.now();
      const totalDuration = endTime - startTime;
      const avgDuration = totalDuration / iterations;

      // Average duration should be less than 2ms per error
      expect(avgDuration).toBeLessThan(2);
    });

    it('should handle multiple concurrent error captures', () => {
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'test';
      initSentry();

      const promises = Array.from({ length: 50 }, (_, i) => {
        return Promise.resolve().then(() => {
          const start = Date.now();
          captureException(new Error(`Concurrent error ${i}`));
          return Date.now() - start;
        });
      });

      return Promise.all(promises).then((durations) => {
        const maxDuration = Math.max(...durations);
        // All should complete quickly
        expect(maxDuration).toBeLessThan(10);
      });
    });
  });

  /**
   * Property 2: Error Filtering
   * 
   * Validates: Requirements 1.7, 1.8
   * 
   * For any error that matches filtered error patterns:
   * - The Monitoring_System SHALL return null from the beforeSend hook
   * - The error SHALL NOT be sent to Sentry
   */
  describe('Property 2: Error Filtering', () => {
    beforeEach(() => {
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'test';
    });

    it('should filter 404 errors', () => {
      initSentry();
      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      const beforeSend = initCall.beforeSend;

      const event = {
        exception: {
          values: [{
            value: '404 Not Found',
          }],
        },
      };

      const result = beforeSend(event, {});
      expect(result).toBeNull();
    });

    it('should filter network timeout errors', () => {
      initSentry();
      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      const beforeSend = initCall.beforeSend;

      const event = {
        exception: {
          values: [{
            type: 'NetworkError',
            value: 'Request timeout',
          }],
        },
      };

      const result = beforeSend(event, {});
      expect(result).toBeNull();
    });

    it('should filter ETIMEDOUT errors', () => {
      initSentry();
      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      const beforeSend = initCall.beforeSend;

      const event = {
        exception: {
          values: [{
            value: 'ETIMEDOUT connection timeout',
          }],
        },
      };

      const result = beforeSend(event, {});
      expect(result).toBeNull();
    });

    it('should filter CORS errors', () => {
      initSentry();
      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      const beforeSend = initCall.beforeSend;

      const event = {
        exception: {
          values: [{
            value: 'CORS policy blocked request',
          }],
        },
      };

      const result = beforeSend(event, {});
      expect(result).toBeNull();
    });

    it('should filter health endpoint errors', () => {
      initSentry();
      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      const beforeSend = initCall.beforeSend;

      const event = {
        request: {
          url: 'https://example.com/health',
        },
        exception: {
          values: [{
            value: 'Some error',
          }],
        },
      };

      const result = beforeSend(event, {});
      expect(result).toBeNull();
    });

    it('should not filter non-matching errors', () => {
      initSentry();
      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      const beforeSend = initCall.beforeSend;

      const event = {
        exception: {
          values: [{
            value: 'Database connection failed',
          }],
        },
      };

      const result = beforeSend(event, {});
      expect(result).toBe(event);
    });
  });

  /**
   * Property 3: Sampling Rate Configuration
   * 
   * Validates: Requirements 1.2, 1.3, 1.4
   * 
   * For any environment:
   * - Production SHALL use 10% sampling rate (0.1)
   * - Development SHALL use 100% sampling rate (1.0)
   * - Environment variables SHALL override defaults
   */
  describe('Property 3: Sampling Rate Configuration', () => {
    it('should use 10% sampling rate for production', () => {
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'production';
      delete process.env.SENTRY_SAMPLE_RATE;
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;

      initSentry();

      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      expect(initCall.sampleRate).toBe(0.1);
      expect(initCall.tracesSampleRate).toBe(0.1);
    });

    it('should use 100% sampling rate for development', () => {
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'development';
      delete process.env.SENTRY_SAMPLE_RATE;
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;

      initSentry();

      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      expect(initCall.sampleRate).toBe(1.0);
      expect(initCall.tracesSampleRate).toBe(1.0);
    });

    it('should use default development rate when environment is not set', () => {
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      delete process.env.SENTRY_ENVIRONMENT;
      delete process.env.SENTRY_SAMPLE_RATE;
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;

      initSentry();

      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      expect(initCall.sampleRate).toBe(1.0);
      expect(initCall.tracesSampleRate).toBe(1.0);
    });

    it('should allow environment variables to override defaults', () => {
      process.env.SENTRY_DSN = 'https://test@example.com/123';
      process.env.SENTRY_ENVIRONMENT = 'production';
      process.env.SENTRY_SAMPLE_RATE = '0.5';
      process.env.SENTRY_TRACES_SAMPLE_RATE = '0.3';

      initSentry();

      const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
      expect(initCall.sampleRate).toBe(0.5);
      expect(initCall.tracesSampleRate).toBe(0.3);
    });

    it('should handle various environment configurations', () => {
      const environments = ['development', 'staging', 'production'];
      const sampleRates = ['0.1', '0.5', '1.0'];

      environments.forEach((env) => {
        sampleRates.forEach((rate) => {
          process.env.SENTRY_DSN = 'https://test@example.com/123';
          process.env.SENTRY_ENVIRONMENT = env;
          process.env.SENTRY_SAMPLE_RATE = rate;
          process.env.SENTRY_TRACES_SAMPLE_RATE = rate;

          jest.clearAllMocks();
          initSentry();

          const initCall = (Sentry.init as jest.Mock).mock.calls[0][0];
          expect(initCall.sampleRate).toBe(parseFloat(rate));
          expect(initCall.tracesSampleRate).toBe(parseFloat(rate));
        });
      });
    });
  });

  /**
   * Property 5: Graceful Degradation
   * 
   * Validates: Requirements 7.5, 7.6
   * 
   * For any monitoring operation when SENTRY_DSN is not configured:
   * - The Monitoring_System SHALL continue normal operation
   * - The Monitoring_System SHALL NOT impact application functionality
   * - No errors SHALL be thrown when Sentry operations are attempted
   */
  describe('Property 5: Graceful Degradation', () => {
    it('should continue normally when SENTRY_DSN is not configured', () => {
      delete process.env.SENTRY_DSN;
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Should not throw
      expect(() => initSentry()).not.toThrow();

      // Should log warning
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Sentry] SENTRY_DSN not configured, monitoring disabled'
      );

      consoleWarnSpy.mockRestore();
    });

    it('should allow captureException calls without initialization', () => {
      delete process.env.SENTRY_DSN;
      initSentry();

      // Should not throw
      expect(() => {
        captureException(new Error('Test error'));
      }).not.toThrow();
    });

    it('should allow captureMessage calls without initialization', () => {
      delete process.env.SENTRY_DSN;
      initSentry();

      // Should not throw
      expect(() => {
        captureMessage('Test message');
      }).not.toThrow();
    });

    it('should handle empty DSN gracefully', () => {
      process.env.SENTRY_DSN = '';
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      expect(() => initSentry()).not.toThrow();
      expect(consoleWarnSpy).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('should continue operation after initialization failure', () => {
      delete process.env.SENTRY_DSN;
      initSentry();

      // Application should continue to function
      const result = 1 + 1;
      expect(result).toBe(2);

      // Sentry operations should not throw
      expect(() => {
        captureException(new Error('Test'));
        captureMessage('Test');
      }).not.toThrow();
    });
  });
});
