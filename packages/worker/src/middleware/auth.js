// Authentication middleware

const { supabase } = require('../db/client');

/**
 * Verify authentication token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: error?.message || 'Invalid token' });
    }

    req.user = data.user;
    req.accessToken = token;

    return next();
  } catch (err) {
    console.error('[Auth] Token verification error:', err);
    return res.status(401).json({ error: 'Token verification failed' });
  }
}

/**
 * Verify API key
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function verifyApiKey(req, res, next) {
  const configuredKey = process.env.WORKER_API_KEY || process.env.API_KEY;

  // If no API key is configured, don't block requests.
  if (!configuredKey) return next();

  const providedKey =
    (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : null) ||
    (typeof req.headers['x-access-token'] === 'string' ? req.headers['x-access-token'] : null);

  if (!providedKey || providedKey !== configuredKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  return next();
}

module.exports = {
  authenticate,
  verifyApiKey,
};

