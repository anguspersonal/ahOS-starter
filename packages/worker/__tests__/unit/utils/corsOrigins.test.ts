/**
 * CORS allowlist for the worker's Express app (#1089).
 *
 * The Vercel web frontend at kms.example.com was retired on 16 Sep 2026
 * (ADR096), so its origin must not linger in the default allowlist: a stale
 * entry documents a deployment that no longer exists and would silently
 * re-trust that domain if it were ever re-pointed elsewhere.
 */
const { DEFAULT_ALLOWED_ORIGINS, parseCorsOrigins } = require('../../../src/utils/corsOrigins');

describe('corsOrigins', () => {
  it('does not carry the retired web frontend origin by default', () => {
    expect(DEFAULT_ALLOWED_ORIGINS).not.toContain('https://kms.example.com');
  });

  it('keeps the local dev origins by default', () => {
    expect(DEFAULT_ALLOWED_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
  });

  it('falls back to the defaults when CORS_ORIGIN is unset or empty', () => {
    expect(parseCorsOrigins(undefined)).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(parseCorsOrigins('')).toEqual(DEFAULT_ALLOWED_ORIGINS);
  });

  it('splits a comma-separated CORS_ORIGIN, trimming blanks', () => {
    expect(parseCorsOrigins(' https://a.example , ,http://localhost:3000 ')).toEqual([
      'https://a.example',
      'http://localhost:3000',
    ]);
  });

  it('returns a copy, so callers cannot mutate the defaults', () => {
    const origins = parseCorsOrigins(undefined);
    origins.push('https://evil.example');
    expect(DEFAULT_ALLOWED_ORIGINS).not.toContain('https://evil.example');
  });
});
