// CORS allowlist for the worker's Express app (app.js).
//
// Only local dev origins by default: the Vercel web frontend
// (kms.example.com) was retired on 16 Sep 2026 — see ADR096 — and no other
// browser client calls the worker. Override with a comma-separated
// CORS_ORIGIN, e.g. CORS_ORIGIN="https://app.example,http://localhost:3000".

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'http://localhost:3000',
  'http://localhost:3001',
]);

function parseCorsOrigins(envValue) {
  if (!envValue || typeof envValue !== 'string') return [...DEFAULT_ALLOWED_ORIGINS];
  return envValue
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

module.exports = { DEFAULT_ALLOWED_ORIGINS, parseCorsOrigins };
