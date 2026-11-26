/**
 * Property tests for Logger Integration
 * 
 * Property 4: Logger Backward Compatibility
 * Validates: Requirements 6.1, 6.4
 * 
 * For any existing logger call:
 * - Existing logger calls SHALL continue to work unchanged
 * - Console logging SHALL continue regardless of Sentry configuration
 * - Sentry integration SHALL be additive (does not replace console logging)
 * 
 * Property 8: Log Retention Policy
 * Validates: Requirements 3.5
 * 
 * For any log entry:
 * - Debug logs SHALL be marked for 7-day retention
 * - Info logs SHALL be marked for 30-day retention
 * - Warn/error logs SHALL be marked for 90-day retention
 * 
 * Note: Actual retention is managed by Railway, but logs must be properly categorized
 */

import { logger } from '../logger';
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
  };
});

jest.mock('../sentry', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { captureException, captureMessage } from '../sentry';

describe('Logger Property Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleDebugSpy: jest.SpyInstance;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Clear all mocks
    jest.clearAllMocks();
    // Spy on console methods
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    // Restore console methods
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  /**
   * Property 4: Logger Backward Compatibility
   * 
   * Validates: Requirements 6.1, 6.4
   * 
   * For any existing logger call:
   * - Existing logger calls SHALL continue to work unchanged
   * - Console logging SHALL continue regardless of Sentry configuration
   * - Sentry integration SHALL be additive (does not replace console logging)
   */
  describe('Property 4: Logger Backward Compatibility', () => {
    it('should continue console logging when Sentry is disabled', () => {
      process.env.ENABLE_SENTRY_LOGGER = 'false';
      delete process.env.SENTRY_DSN;

      logger.error('Test error message', new Error('Test error'));

      // Console logging should still occur
      expect(consoleErrorSpy).toHaveBeenCalled();
      // Sentry should not be called
      expect(captureException).not.toHaveBeenCalled();
    });

    it('should continue console logging when Sentry is enabled but not initialized', () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      delete process.env.SENTRY_DSN;

      logger.error('Test error message', new Error('Test error'));

      // Console logging should still occur
      expect(consoleErrorSpy).toHaveBeenCalled();
      // Sentry should not be called (not initialized)
      expect(captureException).not.toHaveBeenCalled();
    });

    it('should log to both console and Sentry when enabled', () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://test@example.com/123';

      const error = new Error('Test error');
      logger.error('Test error message', error);

      // Console logging should occur
      expect(consoleErrorSpy).toHaveBeenCalled();
      // Sentry should also be called
      expect(captureException).toHaveBeenCalledWith(error, expect.objectContaining({
        tags: { source: 'logger' },
      }));
    });

    it('should maintain existing logger API for all log levels', () => {
      // Test all log levels work unchanged
      logger.debug('Debug message', { meta: 'data' });
      logger.info('Info message', { meta: 'data' });
      logger.warn('Warn message', { meta: 'data' });
      logger.error('Error message', new Error('Error'), { meta: 'data' });

      // All should log to console
      expect(consoleDebugSpy).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should handle non-Error objects in error method', () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://test@example.com/123';

      logger.error('Test error message', 'String error', { meta: 'data' });

      // Console logging should occur
      expect(consoleErrorSpy).toHaveBeenCalled();
      // Should use captureMessage for non-Error objects
      expect(captureMessage).toHaveBeenCalledWith(
        'Test error message',
        'error',
        expect.objectContaining({
          tags: { source: 'logger' },
        })
      );
    });

    it('should include metadata in Sentry events', () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://test@example.com/123';

      const error = new Error('Test error');
      const meta = { userId: '123', requestId: '456' };
      logger.error('Test error message', error, meta);

      expect(captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          tags: { source: 'logger' },
          extra: expect.objectContaining(meta),
        })
      );
    });

    it('should respect LOG_LEVEL configuration', () => {
      process.env.LOG_LEVEL = 'warn';
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://test@example.com/123';

      // Reload logger to pick up new LOG_LEVEL
      jest.resetModules();
      const { logger: newLogger } = require('../logger');

      newLogger.debug('Debug message');
      newLogger.info('Info message');
      newLogger.warn('Warn message');
      newLogger.error('Error message', new Error('Error'));

      // Debug and info should not log
      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      // Warn and error should log
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should work with various error types', () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://test@example.com/123';

      const errorTypes = [
        new Error('Standard error'),
        new TypeError('Type error'),
        new ReferenceError('Reference error'),
        'String error',
        { message: 'Object error' },
        null,
        undefined,
      ];

      errorTypes.forEach((error) => {
        jest.clearAllMocks();
        logger.error('Test message', error);
        expect(consoleErrorSpy).toHaveBeenCalled();
      });
    });
  });

  /**
   * Property 8: Log Retention Policy
   * 
   * Validates: Requirements 3.5
   * 
   * For any log entry:
   * - Debug logs SHALL be marked for 7-day retention
   * - Info logs SHALL be marked for 30-day retention
   * - Warn/error logs SHALL be marked for 90-day retention
   * 
   * Note: Actual retention is managed by Railway, but logs must be properly categorized
   * by log level to enable retention policy application.
   */
  describe('Property 8: Log Retention Policy', () => {
    // Helper function to extract log level from formatted message
    const extractLogLevel = (formattedMessage: string): string | null => {
      const match = formattedMessage.match(/\[.*?\] \[(DEBUG|INFO|WARN|ERROR)\]/);
      return match ? match[1] : null;
    };

    // Helper function to determine retention category
    const getRetentionCategory = (level: string): number => {
      switch (level) {
        case 'DEBUG':
          return 7; // 7 days
        case 'INFO':
          return 30; // 30 days
        case 'WARN':
        case 'ERROR':
          return 90; // 90 days
        default:
          throw new Error(`Unknown log level: ${level}`);
      }
    };

    it('should categorize debug logs for 7-day retention', () => {
      process.env.LOG_LEVEL = 'debug';

      // Reload logger to pick up new LOG_LEVEL
      jest.resetModules();
      const { logger: newLogger } = require('../logger');

      const message = 'Debug message';
      newLogger.debug(message);

      expect(consoleDebugSpy).toHaveBeenCalled();
      const logCall = consoleDebugSpy.mock.calls[0][0];
      const level = extractLogLevel(logCall);
      
      expect(level).toBe('DEBUG');
      expect(getRetentionCategory(level!)).toBe(7);
    });

    it('should categorize info logs for 30-day retention', () => {
      process.env.LOG_LEVEL = 'info';

      // Reload logger to pick up new LOG_LEVEL
      jest.resetModules();
      const { logger: newLogger } = require('../logger');

      const message = 'Info message';
      newLogger.info(message);

      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      const level = extractLogLevel(logCall);
      
      expect(level).toBe('INFO');
      expect(getRetentionCategory(level!)).toBe(30);
    });

    it('should categorize warn logs for 90-day retention', () => {
      process.env.LOG_LEVEL = 'warn';

      // Reload logger to pick up new LOG_LEVEL
      jest.resetModules();
      const { logger: newLogger } = require('../logger');

      const message = 'Warn message';
      newLogger.warn(message);

      expect(consoleWarnSpy).toHaveBeenCalled();
      const logCall = consoleWarnSpy.mock.calls[0][0];
      const level = extractLogLevel(logCall);
      
      expect(level).toBe('WARN');
      expect(getRetentionCategory(level!)).toBe(90);
    });

    it('should categorize error logs for 90-day retention', () => {
      process.env.LOG_LEVEL = 'error';

      // Reload logger to pick up new LOG_LEVEL
      jest.resetModules();
      const { logger: newLogger } = require('../logger');

      const message = 'Error message';
      newLogger.error(message, new Error('Test error'));

      expect(consoleErrorSpy).toHaveBeenCalled();
      const logCall = consoleErrorSpy.mock.calls[0][0];
      const level = extractLogLevel(logCall);
      
      expect(level).toBe('ERROR');
      expect(getRetentionCategory(level!)).toBe(90);
    });

    it('should properly categorize logs with various messages and metadata', () => {
      process.env.LOG_LEVEL = 'debug';

      // Reload logger to pick up new LOG_LEVEL
      jest.resetModules();
      const { logger: newLogger } = require('../logger');

      // Test with fast-check generated scenarios
      const logScenarios = fc.sample(
        fc.record({
          level: fc.constantFrom('debug', 'info', 'warn', 'error' as const),
          message: fc.string({ minLength: 1, maxLength: 100 }),
          metadata: fc.option(
            fc.record({
              key: fc.string(),
              value: fc.oneof(fc.string(), fc.integer(), fc.boolean()),
            }),
            { nil: undefined }
          ),
        }),
        { numRuns: 20 }
      );

      logScenarios.forEach((scenario) => {
        jest.clearAllMocks();

        const { level, message, metadata } = scenario;
        const metaObj = metadata ? { [metadata.key]: metadata.value } : undefined;

        switch (level) {
          case 'debug':
            newLogger.debug(message, metaObj);
            expect(consoleDebugSpy).toHaveBeenCalled();
            break;
          case 'info':
            newLogger.info(message, metaObj);
            expect(consoleLogSpy).toHaveBeenCalled();
            break;
          case 'warn':
            newLogger.warn(message, metaObj);
            expect(consoleWarnSpy).toHaveBeenCalled();
            break;
          case 'error':
            newLogger.error(message, new Error('Test error'), metaObj);
            expect(consoleErrorSpy).toHaveBeenCalled();
            break;
        }

        // Verify log format and retention category
        const spy = level === 'debug' ? consoleDebugSpy :
                   level === 'info' ? consoleLogSpy :
                   level === 'warn' ? consoleWarnSpy : consoleErrorSpy;
        
        const logCall = spy.mock.calls[0][0];
        const extractedLevel = extractLogLevel(logCall);
        const expectedLevel = level.toUpperCase();
        
        expect(extractedLevel).toBe(expectedLevel);
        
        const retentionDays = getRetentionCategory(extractedLevel!);
        if (level === 'debug') {
          expect(retentionDays).toBe(7);
        } else if (level === 'info') {
          expect(retentionDays).toBe(30);
        } else {
          expect(retentionDays).toBe(90);
        }
      });
    });

    it('should format logs with ISO 8601 timestamp for retention tracking', () => {
      process.env.LOG_LEVEL = 'info';

      // Reload logger to pick up new LOG_LEVEL
      jest.resetModules();
      const { logger: newLogger } = require('../logger');

      const beforeTime = new Date().toISOString();
      newLogger.info('Test message');
      const afterTime = new Date().toISOString();

      expect(consoleLogSpy).toHaveBeenCalled();
      const logCall = consoleLogSpy.mock.calls[0][0];
      
      // Extract timestamp from log format: [timestamp] [LEVEL] message
      const timestampMatch = logCall.match(/\[([^\]]+)\]/);
      expect(timestampMatch).not.toBeNull();
      
      const timestamp = timestampMatch![1];
      // Verify ISO 8601 format (e.g., 2025-01-25T10:30:00.000Z)
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      
      // Verify timestamp is within reasonable range
      const logTime = new Date(timestamp);
      const before = new Date(beforeTime);
      const after = new Date(afterTime);
      
      expect(logTime.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000); // Allow 1s margin
      expect(logTime.getTime()).toBeLessThanOrEqual(after.getTime() + 1000); // Allow 1s margin
    });
  });
});
