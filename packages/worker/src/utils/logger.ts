/**
 * Logger utility for the worker
 * Provides structured logging with different log levels
 */

import * as Sentry from '@sentry/node';
import { captureException, captureMessage } from './sentry';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private logLevel: LogLevel;
  private enableSentry: boolean;

  constructor() {
    const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.logLevel = ['debug', 'info', 'warn', 'error'].includes(envLevel)
      ? envLevel
      : 'info';
    this.enableSentry = process.env.ENABLE_SENTRY_LOGGER === 'true';
  }

  /**
   * Check if Sentry is initialized
   * Checks if DSN is configured (simple heuristic)
   */
  private isSentryInitialized(): boolean {
    // Simple check: if DSN is configured, assume Sentry is initialized
    // The initSentry function handles graceful degradation
    return !!process.env.SENTRY_DSN;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private formatMessage(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: any): void {
    if (this.shouldLog('debug')) {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }

  info(message: string, meta?: any): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message, meta));
    }
  }

  warn(message: string, meta?: any): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message, meta));
    }
  }

  error(message: string, error?: Error | any, meta?: any): void {
    if (this.shouldLog('error')) {
      const errorMeta = error instanceof Error
        ? { error: error.message, stack: error.stack, ...meta }
        : { error, ...meta };
      console.error(this.formatMessage('error', message, errorMeta));

      // Send to Sentry if enabled and initialized (backward compatible - console logging always continues)
      if (this.enableSentry && this.isSentryInitialized()) {
        if (error instanceof Error) {
          captureException(error, {
            tags: { source: 'logger' },
            extra: { message, ...meta },
          });
        } else {
          captureMessage(message, 'error', {
            tags: { source: 'logger' },
            extra: { error, ...meta },
          });
        }
      }
    }
  }
}

// Export singleton instance
export const logger = new Logger();

export default logger;

