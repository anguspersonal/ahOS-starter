// Request validation middleware

/**
 * Validate request body against schema
 * @param {Object} schema - Validation schema
 * @returns {Function} Express middleware
 */
function validate(schema) {
  return (req, res, next) => {
    // TODO: Implement validation logic (e.g., using Joi or zod)
    next();
  };
}

/**
 * Validate workflow configuration
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function validateWorkflow(req, res, next) {
  // TODO: Implement workflow validation
  next();
}

module.exports = {
  validate,
  validateWorkflow,
};

