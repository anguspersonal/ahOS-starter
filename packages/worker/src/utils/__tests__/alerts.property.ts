/**
 * Property tests for Alert Delivery
 * 
 * Property 7: Alert Delivery
 * Validates: Requirements 4.1, 4.2, 4.8
 * 
 * For any critical error:
 * - Critical errors SHALL trigger immediate alerts
 * - Alerts SHALL be sent to configured email address
 * - Resend SHALL be used if configured, otherwise Sentry email SHALL be used
 * - Alert deduplication SHALL prevent duplicate alerts within 10-minute window
 */

import { sendAlert, configureAlerts } from '../alerts';
import * as fc from 'fast-check';
import { Resend } from 'resend';

// Mock Resend
jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => ({
      emails: {
        send: jest.fn().mockResolvedValue({ id: 'test-email-id' }),
      },
    })),
  };
});

describe('Alert Property Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Clear all mocks
    jest.clearAllMocks();
    // Spy on console methods
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    // Restore console methods
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    // Reset alert configuration
    configureAlerts({
      email: 'owner@example.com',
      resendApiKey: undefined,
      sentryAlertEmail: undefined,
    });
  });

  /**
   * Property 7: Alert Delivery
   * 
   * Validates: Requirements 4.1, 4.2, 4.8
   * 
   * For any critical error:
   * - Critical errors SHALL trigger immediate alerts
   * - Alerts SHALL be sent to configured email address
   * - Resend SHALL be used if configured, otherwise Sentry email SHALL be used
   */
  describe('Property 7: Alert Delivery', () => {
    it('should send critical alerts immediately', async () => {
      // Configure Resend
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const subject = 'Test Critical Alert';
      const message = 'This is a critical error that requires immediate attention';
      const context = {
        errorType: 'Database Connection Failure',
        affectedService: 'Worker Service',
        userImpact: 'Users cannot access the service',
        suggestedAction: 'Check database connection',
      };

      await sendAlert('critical', subject, message, context);

      // Verify Resend was called
      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      expect(ResendMock).toHaveBeenCalledWith('test-resend-key');
      
      const resendInstance = ResendMock.mock.results[0].value;
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@example.com',
          subject,
          html: expect.stringContaining(message),
          text: expect.stringContaining(message),
        })
      );
    });

    it('should send alerts to configured email address', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'custom-alert@example.com';

      await sendAlert('critical', 'Test Subject', 'Test Message');

      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      const resendInstance = ResendMock.mock.results[0].value;
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'custom-alert@example.com',
        })
      );
    });

    it('should use Resend if RESEND_API_KEY is configured', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      await sendAlert('critical', 'Test Subject', 'Test Message');

      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      expect(ResendMock).toHaveBeenCalled();
      
      const resendInstance = ResendMock.mock.results[0].value;
      expect(resendInstance.emails.send).toHaveBeenCalled();
    });

    it('should fall back to Sentry email if Resend is not configured', async () => {
      delete process.env.RESEND_API_KEY;
      process.env.SENTRY_ALERT_EMAIL = 'sentry-alert@example.com';
      process.env.ALERT_EMAIL = 'test@example.com';

      await sendAlert('critical', 'Test Subject', 'Test Message');

      // Should log that Sentry email should be used
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Alerts] Alert should be sent via Sentry email notifications')
      );
    });

    it('should include context in alert email', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const context = {
        errorType: 'Database Connection Failure',
        affectedService: 'Worker Service',
        userImpact: 'Users cannot access the service',
        suggestedAction: 'Check database connection',
        stackTrace: 'Error: Connection failed\n  at connect()',
      };

      await sendAlert('critical', 'Test Subject', 'Test Message', context);

      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      const resendInstance = ResendMock.mock.results[0].value;
      const sendCall = resendInstance.emails.send.mock.calls[0][0];
      
      // Verify context is included in email body
      expect(sendCall.html).toContain('Database Connection Failure');
      expect(sendCall.html).toContain('Worker Service');
      expect(sendCall.html).toContain('Users cannot access the service');
      expect(sendCall.html).toContain('Check database connection');
      expect(sendCall.html).toContain('Connection failed');
    });

    it('should handle alert failures gracefully', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      // Mock Resend to throw an error
      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      const mockResendInstance = {
        emails: {
          send: jest.fn().mockRejectedValue(new Error('Resend API error')),
        },
      };
      ResendMock.mockImplementation(() => mockResendInstance as any);

      // Should not throw, just log error
      await expect(sendAlert('critical', 'Test Subject', 'Test Message')).resolves.not.toThrow();
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Alerts] Error sending alert'),
        expect.any(Error)
      );
    });

    it('should deduplicate alerts within 10-minute window', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const subject = 'Test Subject';
      const message = 'Duplicate alert test';

      // Send first alert
      await sendAlert('critical', subject, message);
      
      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      const resendInstance = ResendMock.mock.results[0].value;
      const firstCallCount = resendInstance.emails.send.mock.calls.length;

      // Send duplicate alert immediately (within dedupe window)
      await sendAlert('critical', subject, message);
      
      // Should not send again (deduplicated)
      expect(resendInstance.emails.send.mock.calls.length).toBe(firstCallCount);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Alerts] Alert deduplicated')
      );
    });

    it('should allow alerts after deduplication window expires', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const subject = 'Test Subject';
      const message = 'Alert after window test';

      // Mock Date.now to control time
      const originalNow = Date.now;
      let currentTime = 1000000;
      Date.now = jest.fn(() => currentTime);

      // Send first alert
      await sendAlert('critical', subject, message);
      
      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      const resendInstance = ResendMock.mock.results[0].value;
      const firstCallCount = resendInstance.emails.send.mock.calls.length;

      // Advance time beyond dedupe window (10 minutes = 600000ms)
      currentTime += 600001;

      // Send alert after window expires
      await sendAlert('critical', subject, message);
      
      // Should send again (window expired)
      expect(resendInstance.emails.send.mock.calls.length).toBe(firstCallCount + 1);

      // Restore Date.now
      Date.now = originalNow;
    });

    it('should use default email if ALERT_EMAIL is not configured', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      delete process.env.ALERT_EMAIL;

      await sendAlert('critical', 'Test Subject', 'Test Message');

      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      const resendInstance = ResendMock.mock.results[0].value;
      expect(resendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@example.com', // Default email
        })
      );
    });

    it('should support both critical and warning alert types', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      await sendAlert('critical', 'Critical Subject', 'Critical Message');
      await sendAlert('warning', 'Warning Subject', 'Warning Message');

      const ResendMock = Resend as jest.MockedClass<typeof Resend>;
      const resendInstance = ResendMock.mock.results[0].value;
      expect(resendInstance.emails.send).toHaveBeenCalledTimes(2);
      
      // Verify critical alert
      expect(resendInstance.emails.send.mock.calls[0][0].subject).toBe('Critical Subject');
      expect(resendInstance.emails.send.mock.calls[0][0].html).toContain('🔴 CRITICAL');
      
      // Verify warning alert
      expect(resendInstance.emails.send.mock.calls[1][0].subject).toBe('Warning Subject');
      expect(resendInstance.emails.send.mock.calls[1][0].html).toContain('🟡 WARNING');
    });

    it('should handle property-based alert scenarios', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      // Use fast-check to generate various alert scenarios
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('critical', 'warning'),
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.string({ minLength: 1, maxLength: 500 }),
          fc.option(fc.record({
            errorType: fc.string(),
            affectedService: fc.string(),
            userImpact: fc.string(),
          }), { nil: undefined }),
          async (type, subject, message, context) => {
            // Should not throw for any valid input
            await expect(
              sendAlert(type as 'critical' | 'warning', subject, message, context || undefined)
            ).resolves.not.toThrow();
          }
        ),
        { numRuns: 10 }
      );
    });
  });
});
