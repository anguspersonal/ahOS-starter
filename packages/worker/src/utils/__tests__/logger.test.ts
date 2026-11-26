/**
 * Unit tests for logger integration with Sentry
 * Tests logger methods, Sentry integration, and backward compatibility
 */

// Mock Sentry utilities
jest.mock('../sentry', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Import logger after mocks are set up
// We need to dynamically import to reset the singleton
let logger: any;
let captureException: any;
let captureMessage: any;

describe('Logger Integration', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleDebugSpy: jest.SpyInstance;

  // Helper function to reload logger with current environment
  const reloadLogger = async () => {
    jest.resetModules();
    // Re-import the mocked sentry functions after resetModules
    const sentryModule = await import('../sentry');
    captureException = sentryModule.captureException;
    captureMessage = sentryModule.captureMessage;
    const loggerModule = await import('../logger');
    logger = loggerModule.logger;
  };

  beforeEach(async () => {
    // Save original environment
    originalEnv = { ...process.env };
    // Clear all mocks
    jest.clearAllMocks();
    // Reset modules and load logger with default environment
    jest.resetModules();
    // Re-import the mocked sentry functions after resetModules
    const sentryModule = await import('../sentry');
    captureException = sentryModule.captureException;
    captureMessage = sentryModule.captureMessage;
    const loggerModule = await import('../logger');
    logger = loggerModule.logger;
    // Spy on console methods
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    jest.resetModules();
  });

  describe('logger.error() with Sentry enabled', () => {
    it('should send Error objects to Sentry when ENABLE_SENTRY_LOGGER=true', async () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const error = new Error('Test error');
      const meta = { userId: '123', requestId: 'req-456' };

      logger.error('Error message', error, meta);

      expect(captureException).toHaveBeenCalledWith(error, {
        tags: { source: 'logger' },
        extra: { message: 'Error message', ...meta },
      });
    });

    it('should send non-Error values to Sentry as messages when ENABLE_SENTRY_LOGGER=true', async () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const errorValue = 'String error';
      const meta = { userId: '123' };

      logger.error('Error message', errorValue, meta);

      expect(captureMessage).toHaveBeenCalledWith('Error message', 'error', {
        tags: { source: 'logger' },
        extra: { error: errorValue, ...meta },
      });
    });

    it('should include error context (user ID, request ID) in Sentry events when available', async () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const error = new Error('Test error');
      const meta = {
        userId: 'user-123',
        requestId: 'req-456',
        workflowId: 'workflow-789',
      };

      logger.error('Error message', error, meta);

      expect(captureException).toHaveBeenCalledWith(error, {
        tags: { source: 'logger' },
        extra: {
          message: 'Error message',
          userId: 'user-123',
          requestId: 'req-456',
          workflowId: 'workflow-789',
        },
      });
    });
  });

  describe('logger.error() with Sentry disabled', () => {
    it('should not send to Sentry when ENABLE_SENTRY_LOGGER=false', async () => {
      process.env.ENABLE_SENTRY_LOGGER = 'false';
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const error = new Error('Test error');
      logger.error('Error message', error);

      expect(captureException).not.toHaveBeenCalled();
      expect(captureMessage).not.toHaveBeenCalled();
    });

    it('should still log to console when Sentry is disabled', async () => {
      process.env.ENABLE_SENTRY_LOGGER = 'false';
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const error = new Error('Test error');
      logger.error('Error message', error);

      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Backward compatibility', () => {
    it('should continue to work with existing logger calls', async () => {
      process.env.LOG_LEVEL = 'info';
      await reloadLogger();

      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');

      expect(consoleLogSpy).toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('should log to console regardless of Sentry configuration', async () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const error = new Error('Test error');
      logger.error('Error message', error);

      // Should log to console
      expect(consoleErrorSpy).toHaveBeenCalled();
      // Should also send to Sentry
      expect(captureException).toHaveBeenCalled();
    });

    it('should log to console even when Sentry is not configured', async () => {
      delete process.env.SENTRY_DSN;
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const error = new Error('Test error');
      logger.error('Error message', error);

      // Should log to console
      expect(consoleErrorSpy).toHaveBeenCalled();
      // Should not send to Sentry (Sentry not initialized)
      expect(captureException).not.toHaveBeenCalled();
    });
  });

  describe('Console logging continues regardless of Sentry configuration', () => {
    it('should log debug messages to console', async () => {
      process.env.LOG_LEVEL = 'debug';
      await reloadLogger();
      logger.debug('Debug message', { meta: 'data' });
      expect(consoleDebugSpy).toHaveBeenCalled();
    });

    it('should log info messages to console', async () => {
      process.env.LOG_LEVEL = 'info';
      await reloadLogger();
      logger.info('Info message', { meta: 'data' });
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it('should log warn messages to console', async () => {
      process.env.LOG_LEVEL = 'warn';
      await reloadLogger();
      logger.warn('Warning message', { meta: 'data' });
      expect(consoleWarnSpy).toHaveBeenCalled();
    });

    it('should log error messages to console even when Sentry is enabled', async () => {
      process.env.ENABLE_SENTRY_LOGGER = 'true';
      process.env.SENTRY_DSN = 'https://abc123@example.com/123';
      process.env.LOG_LEVEL = 'error';
      await reloadLogger();

      const error = new Error('Test error');
      logger.error('Error message', error);

      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Log level filtering', () => {
    it('should respect LOG_LEVEL environment variable', async () => {
      process.env.LOG_LEVEL = 'warn';
      await reloadLogger();

      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });
});
