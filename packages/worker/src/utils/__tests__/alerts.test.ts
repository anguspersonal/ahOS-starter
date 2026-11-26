/**
 * Unit tests for alert configuration utility
 * Tests alert sending via Resend, Sentry email, deduplication, and alert context
 */

import { Resend } from 'resend';

// Mock Resend - create a mock instance that we can track
const mockResendInstance = {
  emails: {
    send: jest.fn().mockResolvedValue({ id: 'email-id' }),
  },
};

jest.mock('resend', () => {
  return {
    Resend: jest.fn().mockImplementation(() => mockResendInstance),
  };
});

// Import after mocks are set up
let sendAlert: any;
let configureAlerts: any;

describe('Alert Configuration', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    // Save original environment
    originalEnv = { ...process.env };
    // Clear all mocks
    jest.clearAllMocks();
    // Reset Resend mock instance
    mockResendInstance.emails.send.mockClear();
    mockResendInstance.emails.send.mockResolvedValue({ id: 'email-id' });
    // Reset module to clear resendClient state
    jest.resetModules();
    // Re-import Resend after resetModules to get fresh mock reference
    const { Resend: ResendMock } = await import('resend');
    // Reset and set up Resend constructor mock
    (ResendMock as jest.Mock).mockClear();
    (ResendMock as jest.Mock).mockImplementation(() => mockResendInstance);
    const alertsModule = await import('../alerts');
    sendAlert = alertsModule.sendAlert;
    configureAlerts = alertsModule.configureAlerts;
    // Spy on console methods
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('Alert sending via Resend', () => {
    it('should send alert via Resend when RESEND_API_KEY is configured', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const context = {
        errorType: 'Database Connection Failure',
        affectedService: 'Worker Service',
        userImpact: 'Users may experience service unavailability',
        suggestedAction: 'Check database connection',
        stackTrace: 'Error stack trace',
        statusCode: 500,
        endpoint: '/api/workflows',
        method: 'POST',
        requestId: 'req-123',
        workflowId: 'workflow-456',
        artifactId: 'artifact-789',
        userId: 'user-123',
      };

      await sendAlert('critical', 'Test Alert', 'Test message', context);

      // Resend should be called when initResendClient is called
      // Re-import Resend to get the current mock after resetModules
      const { Resend: ResendMock } = await import('resend');
      const ResendConstructor = ResendMock as jest.Mock;
      // initResendClient is called inside sendViaResend, which is called by sendAlert
      expect(ResendConstructor).toHaveBeenCalledWith('test-resend-key');
      expect(mockResendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          // Was `alerts@example.com` — not a domain Resend can verify, so
          // every send would have been rejected (#573 review round 1, H1).
          from: 'ahOS Alerts <onboarding@example.com>',
          to: 'test@example.com',
          subject: 'Test Alert',
          html: expect.stringContaining('Test message'),
          text: expect.stringContaining('Test message'),
        })
      );
    });

    it('should include alert context in email body', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const context = {
        errorType: 'Database Connection Failure',
        affectedService: 'Worker Service',
        userImpact: 'Users may experience service unavailability',
        suggestedAction: 'Check database connection',
        stackTrace: 'Error stack trace',
      };

      await sendAlert('critical', 'Test Alert', 'Test message', context);

      const sendCall = mockResendInstance.emails.send.mock.calls[0][0];

      expect(sendCall.html).toContain('Database Connection Failure');
      expect(sendCall.html).toContain('Worker Service');
      expect(sendCall.html).toContain('Users may experience service unavailability');
      expect(sendCall.html).toContain('Check database connection');
      expect(sendCall.html).toContain('Error stack trace');
    });
  });

  describe('Alert sending via Sentry email', () => {
    it('should log alert via Sentry email when Resend is not configured', async () => {
      delete process.env.RESEND_API_KEY;
      process.env.SENTRY_ALERT_EMAIL = 'sentry@example.com';

      const context = {
        errorType: 'Test Error',
        affectedService: 'Worker Service',
      };

      await sendAlert('warning', 'Test Alert', 'Test message', context);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Alerts] Alert should be sent via Sentry email notifications'
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Alerts] Type: warning, Subject: Test Alert'
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Alerts] Message: Test message'
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Alerts] Context:',
        expect.any(String)
      );
    });

    it('should fall back to Sentry email when Resend fails', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';
      process.env.SENTRY_ALERT_EMAIL = 'sentry@example.com';

      // Make Resend send fail
      mockResendInstance.emails.send.mockRejectedValueOnce(new Error('Resend failed'));

      await sendAlert('critical', 'Test Alert', 'Test message');

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Alerts] Failed to send via Resend, falling back to Sentry:',
        expect.any(Error)
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Alerts] Alert should be sent via Sentry email notifications'
      );
    });
  });

  describe('Alert deduplication', () => {
    it('should deduplicate same error within 10 minutes', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const message = 'Test error message';

      // Send first alert
      await sendAlert('critical', 'Test Alert', message);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Alerts] Alert sent via Resend')
      );

      // Clear console logs
      consoleLogSpy.mockClear();

      // Send duplicate alert within 10 minutes
      await sendAlert('critical', 'Test Alert', message);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Alerts] Alert deduplicated')
      );

      // Resend should only be called once
      expect(mockResendInstance.emails.send).toHaveBeenCalledTimes(1);
    });

    it('should send alert again after 10 minutes', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const message = 'Test error message';

      // Send first alert
      await sendAlert('critical', 'Test Alert', message);

      // Mock time to be 11 minutes later
      const originalNow = Date.now;
      Date.now = jest.fn(() => originalNow() + 11 * 60 * 1000);

      // Send alert again
      await sendAlert('critical', 'Test Alert', message);

      // Resend should be called twice
      expect(mockResendInstance.emails.send).toHaveBeenCalledTimes(2);

      // Restore Date.now
      Date.now = originalNow;
    });
  });

  describe('Alert context includes required fields', () => {
    it('should include error type, message, stack trace, affected service, timestamp', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const context = {
        errorType: 'Database Connection Failure',
        affectedService: 'Worker Service',
        userImpact: 'Users may experience service unavailability',
        suggestedAction: 'Check database connection',
        stackTrace: 'Error: Database connection failed\n    at test.js:1:1',
        statusCode: 500,
        endpoint: '/api/workflows',
        method: 'POST',
        requestId: 'req-123',
        workflowId: 'workflow-456',
        artifactId: 'artifact-789',
        userId: 'user-123',
      };

      await sendAlert('critical', 'Test Alert', 'Test message', context);

      const sendCall = mockResendInstance.emails.send.mock.calls[0][0];

      // Check HTML contains all context fields
      expect(sendCall.html).toContain('Database Connection Failure');
      expect(sendCall.html).toContain('Worker Service');
      expect(sendCall.html).toContain('Users may experience service unavailability');
      expect(sendCall.html).toContain('Check database connection');
      expect(sendCall.html).toContain('Error: Database connection failed');
      expect(sendCall.html).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO timestamp
    });
  });

  // ── Delivery reporting (#573 review round 1, H1) ─────────────────────────
  //
  // The alert evaluator disarms a condition once it believes an alert went out,
  // and `ritual_silent` re-arms only when the ritual runs — which is what the
  // email exists to prompt. So "the call returned" must NOT read as "delivered".

  describe('delivery reporting', () => {
    it('reports delivered:true only when Resend accepted the send', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      const result = await sendAlert('warning', 'Test Alert', 'Test message');

      expect(result).toEqual({ delivered: true, channel: 'resend' });
    });

    it('reports delivered:false when no delivery method is configured', async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.SENTRY_ALERT_EMAIL;
      jest.resetModules();
      const alertsModule = await import('../alerts');

      const result = await alertsModule.sendAlert('warning', 'Test Alert', 'Test message');

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('not_configured');
    });

    it('reports delivered:false when Resend REJECTS without throwing', async () => {
      // The SDK resolves `{ data, error }` rather than throwing, so an
      // unverified sending domain or bad key used to look exactly like success.
      // This is the case that would have made the alert vanish silently.
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';
      mockResendInstance.emails.send.mockResolvedValueOnce({
        data: null,
        error: { name: 'validation_error', message: 'The worker.service domain is not verified' },
      });

      const result = await sendAlert('warning', 'Test Alert', 'Test message');

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('resend_failed');
      expect(result.detail).toContain('not verified');
    });

    it('reports delivered:false when only Sentry is configured, because that path sends nothing', async () => {
      delete process.env.RESEND_API_KEY;
      process.env.SENTRY_ALERT_EMAIL = 'sentry@example.com';
      jest.resetModules();
      const alertsModule = await import('../alerts');

      const result = await alertsModule.sendAlert('warning', 'Test Alert', 'Test message');

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('sentry_console_only');
    });

    it('does NOT seed the dedupe window from the Sentry-only path (review round 2, G1)', async () => {
      // H1's "second door": the Sentry path delivers nothing, so recording it as
      // sent would make an identical follow-up return `{ delivered: true,
      // channel: 'deduped' }` — and the evaluator disarms on that flag, losing
      // the alert with nothing delivered.
      delete process.env.RESEND_API_KEY;
      process.env.SENTRY_ALERT_EMAIL = 'sentry@example.com';
      jest.resetModules();
      const alertsModule = await import('../alerts');

      const first = await alertsModule.sendAlert('warning', 'Test Alert', 'Same message');
      const second = await alertsModule.sendAlert('warning', 'Test Alert', 'Same message');

      expect(first.reason).toBe('sentry_console_only');
      // The second call must NOT be short-circuited into a "delivered" dedupe hit.
      expect(second.delivered).toBe(false);
      expect(second.channel).not.toBe('deduped');
      expect(second.reason).toBe('sentry_console_only');
    });

    it('treats a dedupe hit as delivered — the recipient already has the message', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      await sendAlert('warning', 'Test Alert', 'Same message');
      const result = await sendAlert('warning', 'Test Alert', 'Same message');

      expect(result).toEqual({ delivered: true, channel: 'deduped' });
    });

    it('honours ALERT_FROM_EMAIL so a verified sending domain can be configured', async () => {
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';
      process.env.ALERT_FROM_EMAIL = 'ahOS <alerts@example.com>';

      await sendAlert('warning', 'Test Alert', 'Test message');

      expect(mockResendInstance.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'ahOS <alerts@example.com>' })
      );
    });
  });

  describe('HTML escaping', () => {
    it('escapes caller-supplied text in the HTML body', async () => {
      // `artifacts.surface` reaches the alert copy from `capture`, so this is
      // the first path piping user-controlled text into the template (L7).
      process.env.RESEND_API_KEY = 'test-resend-key';
      process.env.ALERT_EMAIL = 'test@example.com';

      await sendAlert('warning', 'Test Alert', 'surface "<img src=x onerror=alert(1)>" is silent');

      const sendCall = mockResendInstance.emails.send.mock.calls[0][0];
      expect(sendCall.html).not.toContain('<img src=x');
      expect(sendCall.html).toContain('&lt;img src=x');
      // The plain-text part is unaffected.
      expect(sendCall.text).toContain('<img src=x onerror=alert(1)>');
    });
  });

  describe('No alert delivery method configured', () => {
    it('should log warning when neither Resend nor Sentry email is configured', async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.SENTRY_ALERT_EMAIL;
      // Reset module to ensure resendClient is not initialized
      jest.resetModules();
      const alertsModule = await import('../alerts');
      await alertsModule.sendAlert('critical', 'Test Alert', 'Test message');

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Alerts] No alert delivery method configured')
      );
    });
  });

  describe('configureAlerts function', () => {
    it('should update alert configuration', () => {
      configureAlerts({
        email: 'new@example.com',
        resendApiKey: 'new-key',
        sentryAlertEmail: 'sentry@example.com',
      });

      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[Alerts] Alert configuration updated'
      );
    });
  });
});
