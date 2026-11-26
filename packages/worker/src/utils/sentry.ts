/**
 * Sentry initialization utility for the worker service
 * Provides error tracking and performance monitoring via Sentry SDK
 */

import * as Sentry from '@sentry/node';

/**
 * Clean surrounding quotes and whitespace from a DSN string.
 */
export function sanitizeSentryDSN(raw: string | undefined): string {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  return raw.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Validate Sentry DSN format
 * 
 * A valid Sentry DSN should be in the format: https://<key>@<host>/<project_id>
 * 
 * @param dsn - The DSN string to validate
 * @returns true if DSN format is valid, false otherwise
 */
function isValidSentryDSN(dsn: string): boolean {
  if (!dsn || typeof dsn !== 'string') {
    return false;
  }
  const cleaned = sanitizeSentryDSN(dsn);
  // Sentry DSN format: https://<key>@<host>/<project_id>
  // Accepts lowercase/uppercase hex or alphanumeric keys, ports, and prefixes
  const dsnPattern = /^https:\/\/[a-zA-Z0-9]+(:[a-zA-Z0-9]+)?@[a-z0-9.-]+(:[0-9]+)?(\/[^\s]*)?\/[0-9]+$/;
  return dsnPattern.test(cleaned);
}

/**
 * Validate and log warnings for optional environment variables
 */
function validateOptionalEnvVars(): void {
  // Check for optional alert configuration
  if (!process.env.RESEND_API_KEY) {
    console.warn('[Sentry] RESEND_API_KEY not configured - email alerts via Resend will be disabled');
  }
  
  if (!process.env.SENTRY_ALERT_EMAIL) {
    console.warn('[Sentry] SENTRY_ALERT_EMAIL not configured - Sentry email notifications may not be enabled');
  }
}

/**
 * Initialize Sentry SDK with configuration from environment variables
 * 
 * Configuration:
 * - SENTRY_DSN: Sentry Data Source Name (required if monitoring enabled)
 * - SENTRY_ENVIRONMENT: Environment name (default: 'development')
 * - SENTRY_SAMPLE_RATE: Error sampling rate (default: 0.1 for production, 1.0 for development)
 * - SENTRY_TRACES_SAMPLE_RATE: Performance tracing sampling rate (default: 0.1 for production, 1.0 for development)
 * 
 * Features:
 * - Graceful degradation: Returns early with warning if SENTRY_DSN is not configured
 * - Error filtering: Filters out 404 errors, network timeouts, CORS errors, and health endpoint errors
 * - HTTP tracing: Configures HTTP tracing integration for performance monitoring
 * - Environment variable validation: Validates DSN format and logs warnings for missing optional variables
 */
export function initSentry(): void {
  const rawDsn = process.env.SENTRY_DSN;
  
  // Graceful degradation: return early if DSN is not configured
  if (!rawDsn) {
    console.warn('[Sentry] SENTRY_DSN not configured, monitoring disabled');
    // Still validate optional variables to warn about missing configuration
    validateOptionalEnvVars();
    return;
  }

  const dsn = sanitizeSentryDSN(rawDsn);
  
  // Validate DSN format
  if (!isValidSentryDSN(dsn)) {
    console.error('[Sentry] Invalid SENTRY_DSN format. Expected format: https://<key>@<host>/<project_id>');
    console.error('[Sentry] Monitoring disabled due to invalid configuration');
    validateOptionalEnvVars();
    return;
  }
  
  // Validate optional environment variables and log warnings
  validateOptionalEnvVars();

  const environment = process.env.SENTRY_ENVIRONMENT || 'development';
  const isProduction = environment === 'production';
  
  // Configure sampling rates based on environment or env vars
  const sampleRate = parseFloat(
    process.env.SENTRY_SAMPLE_RATE || (isProduction ? '0.1' : '1.0')
  );
  const tracesSampleRate = parseFloat(
    process.env.SENTRY_TRACES_SAMPLE_RATE || (isProduction ? '0.1' : '1.0')
  );

  try {
    Sentry.init({
      dsn,
      environment,
      sampleRate,
      tracesSampleRate,
      beforeSend(event, hint) {
        // Filter out known/noisy errors
        
        // Filter health endpoint errors
        if (event.request?.url?.includes('/health')) {
          return null;
        }
        
        // Filter 404 errors
        if (event.exception?.values?.[0]?.value?.includes('404')) {
          return null;
        }
        
        // Filter network timeout errors
        if (event.exception?.values?.[0]?.type === 'NetworkError' ||
            event.exception?.values?.[0]?.value?.includes('timeout') ||
            event.exception?.values?.[0]?.value?.includes('ETIMEDOUT')) {
          return null;
        }
        
        // Filter CORS errors
        if (event.exception?.values?.[0]?.value?.includes('CORS') ||
            event.exception?.values?.[0]?.value?.includes('cors')) {
          return null;
        }
        
        return event;
      },
      // HTTP tracing is automatically enabled when tracesSampleRate is set in v10+
    });
  } catch (error) {
    console.error('[Sentry] Initialization error:', error);
  }
}

/**
 * Capture an exception and send it to Sentry
 * 
 * @param error - The error to capture
 * @param context - Optional context to include with the error (tags, user, extra)
 */
export function captureException(
  error: Error,
  context?: {
    tags?: Record<string, string>;
    user?: { id?: string; email?: string; username?: string };
    extra?: Record<string, any>;
  }
): void {
  Sentry.captureException(error, context);
}

/**
 * Capture a message and send it to Sentry
 * 
 * @param message - The message to capture
 * @param level - The severity level (default: 'info')
 * @param context - Optional context to include with the message (tags, user, extra)
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
  context?: {
    tags?: Record<string, string>;
    user?: { id?: string; email?: string; username?: string };
    extra?: Record<string, any>;
  }
): void {
  if (context) {
    Sentry.withScope((scope) => {
      if (context.tags) {
        Object.entries(context.tags).forEach(([key, value]) => {
          scope.setTag(key, value);
        });
      }
      if (context.user) {
        scope.setUser(context.user);
      }
      if (context.extra) {
        scope.setExtras(context.extra);
      }
      scope.setLevel(level);
      Sentry.captureMessage(message);
    });
  } else {
    Sentry.captureMessage(message, level);
  }
}

/**
 * Set user context for Sentry events
 * 
 * @param user - User information (id, email, username)
 */
export function setUser(user: { id?: string; email?: string; username?: string }): void {
  Sentry.setUser(user);
}

/**
 * Set additional context for Sentry events
 * 
 * @param key - Context key
 * @param context - Context data
 */
export function setContext(key: string, context: Record<string, any>): void {
  Sentry.setContext(key, context);
}
