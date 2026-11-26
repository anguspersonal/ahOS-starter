// Utility functions

/**
 * Format error response
 * @param {Error} error - Error object
 * @returns {Object} Formatted error response
 */
function formatError(error) {
  return {
    error: error.message || 'An error occurred',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Log with timestamp
 * @param {string} message - Log message
 * @param {string} level - Log level (info, warn, error)
 */
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

module.exports = {
  formatError,
  log,
};

