/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  // Source wins over compiled output when both exist. Jest's DEFAULT order puts
  // 'js' first, which silently bound the suite to `dist/` — see #650.
  //
  // Two files under src/ are CommonJS shims that shadow a .ts sibling
  // (utils/alerts.js, utils/sentry.js). Each does `require('../../dist/...')`
  // with a `require('./x.ts')` fallback, and they exist for a real reason:
  // app.js and the plain-JS middleware are CommonJS and cannot import a .ts
  // module, so at runtime `require('./src/utils/sentry')` has to land on
  // something Node can parse. Do NOT delete them — production depends on them.
  //
  // But under test that indirection is a trap: with a stale `dist/` present the
  // suite runs against months-old compiled code and fails with a plausible
  // TypeError in production source (observed: `isAlertDeliveryConfigured is not
  // a function`, from a dist dated 12 Jul). CI never saw it because a fresh
  // checkout has no dist/, so the shim fell through to source. Putting 'ts'
  // first makes tests resolve alerts.ts / sentry.ts directly, bypassing both
  // the shim and dist, while leaving Node's own runtime resolution untouched.
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  testTimeout: 30000,
  // Bound our share of the cores so the repo-wide parallel run (web +
  // mcp-server + worker at once) does not oversubscribe and starve the
  // wall-clock-bound web suite into timeouts — see #513 and the matching
  // note in packages/web/vitest.config.ts.
  maxWorkers: '25%',
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      }
    }]
  }
};

