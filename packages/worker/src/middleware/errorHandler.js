// src/middleware/errorHandler.js
// Express error handling middleware

const { captureException } = require('../utils/sentry');
const Sentry = require('@sentry/node');
const { sendAlert } = require('../utils/alerts');

/**
 * Check if Sentry is initialized
 * Checks if DSN is configured (simple heuristic)
 * @returns {boolean} True if Sentry is initialized
 */
function isSentryInitialized() {
  // Simple check: if DSN is configured, assume Sentry is initialized
  // The initSentry function handles graceful degradation
  return !!process.env.SENTRY_DSN;
}

/**
 * Determine if error is critical and should trigger an alert
 * @param {Error} err - Error object
 * @param {number} status - HTTP status code
 * @returns {boolean} True if error is critical
 */
function isCriticalError(err, status) {
  // Unhandled exceptions (status 500, no specific error type)
  if (status === 500 && !err.type) {
    return true;
  }

  // Database connection failures
  const dbKeywords = ['database', 'connection', 'postgres', 'supabase', 'sql', 'query failed'];
  const errorMessage = (err.message || '').toLowerCase();
  if (dbKeywords.some(keyword => errorMessage.includes(keyword))) {
    return true;
  }

  // Service crashes (process exit errors)
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    return true;
  }

  // Authentication failures (status 401, 403) - these are critical security issues
  if (status === 401 || status === 403) {
    return true;
  }

  // Workflow execution failures after retries
  // Check error context for workflow/retry info
  if (err.workflowId && err.retryCount && err.retryCount > 0) {
    return true;
  }

  return false;
}

/**
 * Get error type description for alert context
 * @param {Error} err - Error object
 * @param {number} status - HTTP status code
 * @returns {string} Error type description
 */
function getErrorType(err, status) {
  if (status === 500 && !err.type) {
    return 'Unhandled Exception';
  }

  const errorMessage = (err.message || '').toLowerCase();
  if (['database', 'connection', 'postgres', 'supabase', 'sql'].some(keyword => errorMessage.includes(keyword))) {
    return 'Database Connection Failure';
  }

  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    return 'Service Crash / Network Failure';
  }

  if (status === 401) {
    return 'Authentication Failure (401)';
  }

  if (status === 403) {
    return 'Authorization Failure (403)';
  }

  if (err.workflowId && err.retryCount && err.retryCount > 0) {
    return 'Workflow Execution Failure After Retries';
  }

  return 'Unknown Error';
}

/**
 * Get affected service from request
 * @param {Object} req - Express request object
 * @returns {string} Affected service name
 */
function getAffectedService(req) {
  // Extract service name from path
  const path = req.path || '';
  if (path.includes('/api/workflows')) {
    return 'Workflow Service';
  }
  if (path.includes('/api/pdf')) {
    return 'PDF Processing Service';
  }
  if (path.includes('/api/upload')) {
    return 'Upload Service';
  }
  if (path.includes('/api/review')) {
    return 'Review Service';
  }
  if (path.includes('/webhooks')) {
    return 'Webhook Service';
  }
  return 'Worker Service';
}

/**
 * Get user impact description
 * @param {number} status - HTTP status code
 * @param {Object} req - Express request object
 * @returns {string} User impact description
 */
function getUserImpact(status, req) {
  if (status === 401 || status === 403) {
    return 'Users cannot authenticate or access resources';
  }
  if (status === 500) {
    return 'Users may experience service unavailability or errors';
  }
  if (req.path && req.path.includes('/api/workflows')) {
    return 'Workflow execution may fail, affecting user productivity';
  }
  return 'Service functionality may be degraded';
}

/**
 * Get suggested action for error
 * @param {Error} err - Error object
 * @param {number} status - HTTP status code
 * @returns {string} Suggested action
 */
function getSuggestedAction(err, status) {
  const errorMessage = (err.message || '').toLowerCase();
  
  if (['database', 'connection', 'postgres', 'supabase'].some(keyword => errorMessage.includes(keyword))) {
    return 'Check database connection and credentials. Verify Supabase service status.';
  }
  
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    return 'Check service availability and network connectivity.';
  }
  
  if (status === 401 || status === 403) {
    return 'Review authentication/authorization configuration and user permissions.';
  }
  
  if (err.workflowId) {
    return 'Review workflow configuration and retry logic. Check workflow step execution logs.';
  }
  
  return 'Review error logs and stack trace for root cause.';
}

/**
 * Error handler middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function errorHandler(err, req, res, next) {
  console.error('Error:', err);
  
  // Default error status and message
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  
  // Capture error to Sentry before sending response (non-blocking)
  if (isSentryInitialized()) {
    const requestId = req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
    const workflowId = req.body?.workflowId || null;
    const artifactId = req.body?.artifactId || null;
    
    captureException(err, {
      tags: {
        endpoint: req.path,
        method: req.method,
      },
      user: req.user ? { id: req.user.id } : undefined,
      extra: {
        requestId,
        workflowId,
        artifactId,
      },
    });
  }
  
  // Send critical alerts (non-blocking, wrapped in try-catch)
  if (isCriticalError(err, status)) {
    const errorType = getErrorType(err, status);
    const affectedService = getAffectedService(req);
    const userImpact = getUserImpact(status, req);
    const suggestedAction = getSuggestedAction(err, status);
    
    const subject = `[${affectedService}] ${errorType}: ${message.substring(0, 100)}`;
    
    const context = {
      errorType,
      affectedService,
      userImpact,
      suggestedAction,
      stackTrace: err.stack || null,
      statusCode: status,
      endpoint: req.path || 'unknown',
      method: req.method || 'unknown',
      requestId: req.headers['x-request-id'] || req.headers['x-correlation-id'] || null,
      workflowId: req.body?.workflowId || null,
      artifactId: req.body?.artifactId || null,
      userId: req.user?.id || null,
    };
    
    // Send alert asynchronously, don't block error response
    sendAlert('critical', subject, message, context).catch((alertError) => {
      console.error('[ErrorHandler] Failed to send alert:', alertError);
      // Don't throw - alert failures should not block error response
    });
  }
  
  // Send error response
  res.status(status).json({
    error: {
      message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    }
  });
}

module.exports = { errorHandler };

