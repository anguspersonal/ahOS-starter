/**
 * Alert utility for sending critical and warning alerts
 * Supports Resend email service and Sentry email notifications
 *
 * ## `sendAlert` reports delivery (#573 review round 1, H1)
 *
 * Every failure path here used to end in a `console.warn`/`console.error` and a
 * bare `return`, so a caller could not tell "delivered" from "silently dropped".
 * That is fine for fire-and-forget error reporting, but the exception-alert
 * evaluator (`src/schedule/alertEvaluator.ts`) *disarms a condition* once it
 * believes an alert went out — and `ritual_silent` only re-arms when the ritual
 * runs, which is the very thing the email exists to prompt. One undelivered
 * email would therefore be lost forever while the DB claimed it fired.
 *
 * So `sendAlert` now returns an `AlertDeliveryResult`. Only a Resend send that
 * the API actually accepted counts as `delivered: true`. Fire-and-forget callers
 * may keep ignoring the return value.
 */

import { Resend } from 'resend';

/**
 * Alert configuration interface
 */
export interface AlertConfig {
  /** Email address to send alerts to (default: owner@example.com) */
  email: string;
  /** Optional Resend API key for email alerts */
  resendApiKey?: string;
  /** Optional Sentry alert email configuration (configured in Sentry dashboard) */
  sentryAlertEmail?: string;
  /** RFC 5322 From header for Resend sends (see DEFAULT_ALERT_FROM). */
  fromEmail?: string;
}

/** Why an alert was not delivered. */
export type AlertDeliveryFailure =
  /** Neither RESEND_API_KEY nor SENTRY_ALERT_EMAIL is set. */
  | 'not_configured'
  /** Resend was reached but rejected or errored (bad key, unverified sender, …). */
  | 'resend_failed'
  /**
   * Resend is unconfigured and only SENTRY_ALERT_EMAIL is set. `sendViaSentry`
   * writes console lines; it does not itself deliver mail (Sentry's email rules
   * fire off captured events, and nothing here captures one). A caller that
   * disarms on delivery must not treat this as a send.
   */
  | 'sentry_console_only'
  /** Unexpected throw inside sendAlert. */
  | 'error';

/**
 * Outcome of a `sendAlert` call. `delivered` is the only field a caller needs
 * to decide whether it may record the alert as having gone out.
 */
export interface AlertDeliveryResult {
  delivered: boolean;
  /** How it went out. `deduped` = an identical message went out <10 min ago. */
  channel: 'resend' | 'deduped' | 'none';
  reason?: AlertDeliveryFailure;
  detail?: string;
}

/**
 * Default Resend `from`.
 *
 * The previous value, `alerts@example.com`, is not a domain Resend can have
 * verified, so every send would have been rejected — and, because the SDK
 * returns `{ data, error }` rather than throwing, rejected *silently*.
 *
 * `onboarding@example.com` is Resend's built-in sender: it needs no domain
 * verification, but it can only deliver to the address that owns the Resend
 * account. That is exactly this single-owner system's shape, so it is a default
 * that can actually work. Override with `ALERT_FROM_EMAIL` once a real sending
 * domain is verified.
 */
export const DEFAULT_ALERT_FROM = 'ahOS Alerts <onboarding@example.com>';

/**
 * Alert deduplication entry
 */
interface AlertDedupeEntry {
  /** Alert key (error type + message hash) */
  key: string;
  /** Timestamp when alert was sent */
  timestamp: number;
  /** Number of times this alert was triggered */
  count: number;
}

/**
 * In-memory alert deduplication store
 * Groups similar alerts within 10-minute time window
 */
const alertDedupeStore: Map<string, AlertDedupeEntry> = new Map();

/**
 * Deduplication time window in milliseconds (10 minutes)
 */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Current alert configuration (can be overridden via configureAlerts)
 */
let alertConfig: AlertConfig | null = null;

/**
 * Resend client instance (initialized if RESEND_API_KEY is configured)
 */
let resendClient: Resend | null = null;

/**
 * Initialize Resend client if API key is configured
 */
function initResendClient(): void {
  const apiKey = process.env.RESEND_API_KEY || alertConfig?.resendApiKey;
  if (apiKey) {
    try {
      resendClient = new Resend(apiKey);
    } catch (error) {
      console.error('[Alerts] Failed to initialize Resend client:', error);
      resendClient = null;
    }
  }
}

/**
 * Get alert configuration from environment variables or configured values
 */
function getAlertConfig(): AlertConfig {
  if (alertConfig) {
    return alertConfig;
  }

  return {
    email: process.env.ALERT_EMAIL || 'owner@example.com',
    resendApiKey: process.env.RESEND_API_KEY,
    sentryAlertEmail: process.env.SENTRY_ALERT_EMAIL,
    fromEmail: process.env.ALERT_FROM_EMAIL || DEFAULT_ALERT_FROM,
  };
}

/**
 * Whether any delivery method is configured at all. Used by the alert
 * evaluator's scheduler to complain loudly at start-up rather than discovering
 * it one crossing at a time.
 */
export function isAlertDeliveryConfigured(): boolean {
  const config = getAlertConfig();
  return Boolean(config.resendApiKey || process.env.RESEND_API_KEY);
}

/**
 * Generate a deduplication key from alert type and message
 * @param type - Alert type ('critical' | 'warning')
 * @param message - Alert message
 * @returns Deduplication key
 */
function generateDedupeKey(type: string, message: string): string {
  // Create a simple hash of the message (for deduplication)
  // In production, you might want a more sophisticated hashing algorithm
  const messageHash = message
    .split('')
    .reduce((acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) | 0, 0)
    .toString(36);
  return `${type}:${messageHash}`;
}

/**
 * Check if alert should be sent (deduplication check)
 * @param key - Deduplication key
 * @returns true if alert should be sent, false if it should be deduplicated
 */
function shouldSendAlert(key: string): boolean {
  const now = Date.now();
  const entry = alertDedupeStore.get(key);

  if (!entry) {
    // New alert, should send
    return true;
  }

  // Check if entry is within time window
  const timeSinceLastAlert = now - entry.timestamp;
  if (timeSinceLastAlert > DEDUPE_WINDOW_MS) {
    // Outside time window, should send
    return true;
  }

  // Within time window, deduplicate
  entry.count += 1;
  return false;
}

/**
 * Record that an alert was sent
 * @param key - Deduplication key
 */
function recordAlertSent(key: string): void {
  const now = Date.now();
  alertDedupeStore.set(key, {
    key,
    timestamp: now,
    count: 1,
  });

  // Clean up old entries (older than 2x the dedupe window)
  const cleanupThreshold = now - (2 * DEDUPE_WINDOW_MS);
  for (const [entryKey, entry] of alertDedupeStore.entries()) {
    if (entry.timestamp < cleanupThreshold) {
      alertDedupeStore.delete(entryKey);
    }
  }
}

/**
 * Escape text destined for the HTML body. Alert copy is now built from
 * caller-supplied values (`artifacts.surface` flows into the alert evaluator's
 * subject and message), so the template must not take it raw. Blast radius is
 * nil today — the mail is self-addressed in a single-owner system — but this is
 * the first path that pipes user-controlled text into it. (#573 review, L7.)
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format alert context into email body
 * @param type - Alert type
 * @param message - Alert message
 * @param context - Alert context
 * @returns Formatted email body (HTML and text)
 */
function formatAlertEmail(
  type: 'critical' | 'warning',
  message: string,
  context?: Record<string, any>
): { html: string; text: string } {
  const timestamp = new Date().toISOString();
  const severity = type === 'critical' ? '🔴 CRITICAL' : '🟡 WARNING';
  
  const contextItems: string[] = [];
  if (context) {
    if (context.errorType) contextItems.push(`Error Type: ${context.errorType}`);
    if (context.affectedService) contextItems.push(`Affected Service: ${context.affectedService}`);
    if (context.userImpact) contextItems.push(`User Impact: ${context.userImpact}`);
    if (context.suggestedAction) contextItems.push(`Suggested Action: ${context.suggestedAction}`);
    if (context.stackTrace) contextItems.push(`Stack Trace:\n${context.stackTrace}`);
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: ${type === 'critical' ? '#d32f2f' : '#f57c00'};">
        ${severity} Alert
      </h2>
      <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <p style="margin: 0; font-size: 16px;"><strong>Message:</strong></p>
        <p style="margin: 10px 0; font-size: 14px;">${escapeHtml(message)}</p>
      </div>
      ${contextItems.length > 0 ? `
        <div style="margin: 20px 0;">
          <h3 style="color: #333;">Context:</h3>
          <ul style="list-style-type: none; padding: 0;">
            ${contextItems.map(item => `<li style="margin: 10px 0; padding: 10px; background-color: #fff; border-left: 3px solid ${type === 'critical' ? '#d32f2f' : '#f57c00'};"><pre style="margin: 0; white-space: pre-wrap;">${escapeHtml(item)}</pre></li>`).join('')}
          </ul>
        </div>
      ` : ''}
      <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 12px;">
        <p>Timestamp: ${timestamp}</p>
        <p>Service: Worker Service</p>
      </div>
    </div>
  `;

  const text = `
${severity} ALERT

Message:
${message}

${contextItems.length > 0 ? `Context:\n${contextItems.join('\n\n')}\n\n` : ''}
Timestamp: ${timestamp}
Service: Worker Service
  `.trim();

  return { html, text };
}

/**
 * Send alert via Resend email service
 * @param config - Alert configuration
 * @param type - Alert type
 * @param subject - Alert subject
 * @param message - Alert message
 * @param context - Alert context
 */
async function sendViaResend(
  config: AlertConfig,
  type: 'critical' | 'warning',
  subject: string,
  message: string,
  context?: Record<string, any>
): Promise<void> {
  if (!resendClient) {
    initResendClient();
  }

  if (!resendClient) {
    throw new Error('Resend client not initialized. RESEND_API_KEY may not be configured.');
  }

  const { html, text } = formatAlertEmail(type, message, context);

  try {
    const response = await resendClient.emails.send({
      from: config.fromEmail || DEFAULT_ALERT_FROM,
      to: config.email,
      subject,
      html,
      text,
    });
    // The Resend SDK resolves with `{ data, error }` — it does NOT throw on an
    // API-level rejection. Awaiting it and moving on therefore reported success
    // for every rejected send (bad key, unverified sending domain, suppressed
    // recipient). That is the mechanism that would have made #573's alerts
    // vanish silently, so the error field is now load-bearing.
    const apiError = (response as { error?: { message?: string; name?: string } | null })?.error;
    if (apiError) {
      throw new Error(
        `Resend rejected the send: ${apiError.name ?? 'error'}: ${apiError.message ?? 'unknown'}`,
      );
    }
    console.log(`[Alerts] Alert sent via Resend to ${config.email}`);
  } catch (error) {
    console.error('[Alerts] Failed to send alert via Resend:', error);
    throw error;
  }
}

/**
 * Send alert via Sentry email notifications
 * Note: Sentry email notifications are configured in the Sentry dashboard, not via code.
 * This function logs that an alert should be sent, but actual email delivery
 * is handled by Sentry's alert rules configured in the dashboard.
 * @param type - Alert type
 * @param subject - Alert subject
 * @param message - Alert message
 * @param context - Alert context
 */
async function sendViaSentry(
  type: 'critical' | 'warning',
  subject: string,
  message: string,
  context?: Record<string, any>
): Promise<void> {
  // Sentry email notifications are configured in the dashboard
  // We log that an alert should be sent, but actual delivery is handled by Sentry
  console.log(`[Alerts] Alert should be sent via Sentry email notifications`);
  console.log(`[Alerts] Type: ${type}, Subject: ${subject}`);
  console.log(`[Alerts] Message: ${message}`);
  if (context) {
    console.log(`[Alerts] Context:`, JSON.stringify(context, null, 2));
  }
  console.log(`[Alerts] Note: Configure Sentry alert rules in the Sentry dashboard to receive email notifications`);
}

/**
 * Send an alert (critical or warning)
 *
 * Sends alerts via Resend if RESEND_API_KEY is configured,
 * otherwise relies on Sentry email notifications (configured in Sentry dashboard).
 *
 * Never throws — a mail failure must not wedge its caller. It **does** report
 * the outcome: `delivered` is true only when Resend accepted the message (or an
 * identical one went out inside the dedupe window). Callers that record an alert
 * as sent — notably the exception-alert evaluator, which disarms a condition on
 * the strength of it — must branch on that flag.
 *
 * @param type - Alert type ('critical' | 'warning')
 * @param subject - Alert subject
 * @param message - Alert message
 * @param context - Optional alert context (error type, stack trace, affected service, etc.)
 * @returns Whether the alert was actually delivered, and by which channel
 */
export async function sendAlert(
  type: 'critical' | 'warning',
  subject: string,
  message: string,
  context?: Record<string, any>
): Promise<AlertDeliveryResult> {
  try {
    const config = getAlertConfig();

    // Check deduplication
    const dedupeKey = generateDedupeKey(type, message);
    if (!shouldSendAlert(dedupeKey)) {
      const entry = alertDedupeStore.get(dedupeKey);
      console.log(
        `[Alerts] Alert deduplicated (key: ${dedupeKey}, count: ${entry?.count || 1}, time since last: ${Date.now() - (entry?.timestamp || 0)}ms)`
      );
      // An identical message went out minutes ago: the recipient has it.
      return { delivered: true, channel: 'deduped' };
    }

    // Try to send via Resend first if configured
    if (config.resendApiKey || process.env.RESEND_API_KEY) {
      try {
        await sendViaResend(config, type, subject, message, context);
        recordAlertSent(dedupeKey);
        return { delivered: true, channel: 'resend' };
      } catch (error) {
        console.error('[Alerts] Failed to send via Resend, falling back to Sentry:', error);
        // Fall through to Sentry — but a Sentry fallback is console output, not
        // delivery, so the result below still reports this send as failed.
        const detail = error instanceof Error ? error.message : String(error);
        if (config.sentryAlertEmail || process.env.SENTRY_ALERT_EMAIL) {
          await sendViaSentry(type, subject, message, context);
        }
        return { delivered: false, channel: 'none', reason: 'resend_failed', detail };
      }
    }

    // Fall back to Sentry email notifications (configured in dashboard)
    if (config.sentryAlertEmail || process.env.SENTRY_ALERT_EMAIL) {
      await sendViaSentry(type, subject, message, context);
      // Deliberately NOT recorded as sent (#573 review round 2, G1). Recording it
      // arms the dedupe window, so a second identical sendAlert inside 10 minutes
      // would short-circuit to `{ delivered: true, channel: 'deduped' }` — and the
      // evaluator disarms on that flag. Nothing was delivered, so recording it
      // here reintroduces H1 through the very door the comment below names. Only a
      // channel that actually delivered may seed the dedupe store.
      return {
        delivered: false,
        channel: 'none',
        reason: 'sentry_console_only',
        detail:
          'SENTRY_ALERT_EMAIL is set but sendViaSentry only writes console lines; set RESEND_API_KEY for real delivery.',
      };
    }

    // If neither is configured, log a warning
    console.warn(
      `[Alerts] No alert delivery method configured. ` +
      `Set RESEND_API_KEY or SENTRY_ALERT_EMAIL to enable alerts. ` +
      `Alert details: ${type} - ${subject} - ${message}`
    );
    return { delivered: false, channel: 'none', reason: 'not_configured' };
  } catch (error) {
    // Handle errors gracefully - don't throw, just log
    console.error('[Alerts] Error sending alert:', error);
    return {
      delivered: false,
      channel: 'none',
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Configure alert settings (optional, for future use)
 * 
 * @param config - Alert configuration
 */
export function configureAlerts(config: AlertConfig): void {
  alertConfig = config;
  
  // Reinitialize Resend client if API key changed
  if (config.resendApiKey) {
    initResendClient();
  }
  
  console.log('[Alerts] Alert configuration updated');
}
