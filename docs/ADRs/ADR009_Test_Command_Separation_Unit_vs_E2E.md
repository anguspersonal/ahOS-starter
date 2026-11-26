# ADR009: Separate Unit Tests From E2E Tests in Default `npm test`

## Status
**Accepted** - 2026-01-19
**Accepted-on-dev:** 2026-01-19

## Context

This repo is a monorepo using Turborepo. The root `npm test` runs `turbo run test`, which in turn executes each package’s `test` script.

The web app (`packages/web`) includes both:
- **Unit tests** (Vitest)
- **End-to-end (E2E) tests** (Playwright)

Historically, `packages/web` ran E2E tests as part of its default `npm test`. In a monorepo, that means the root `npm test` implicitly required:
- a running Next.js server (or a Playwright `webServer` definition)
- environment variables sufficient for booting the app
- stable UI selectors / routes across environments

This created reliability and developer-experience issues:
- **Flaky failures** when the server is not running or not ready (e.g. `page.goto` connection errors).
- **Slow feedback** for code changes unrelated to the web frontend UI.
- **Harder CI composition** because unit tests and E2E tests have different runtime requirements (browsers, server lifecycle, env, optional seed data).

## Decision

**Keep `npm test` fast and deterministic by running unit tests only.**

For the web package:
- `packages/web` default **`npm test` runs unit tests** (Vitest) only.
- E2E tests remain available via an explicit command: **`npm run test:e2e`**.

E2E runs are treated as a separate concern:
- run explicitly by developers when validating UI flows
- run in CI as a dedicated job/step where server + browser dependencies are expected

## Rationale

- **Determinism**: unit tests do not require a live web server or browser.
- **Speed**: unit tests provide fast iteration, especially in monorepo workflows.
- **Separation of concerns**: E2E is valuable, but it has different setup requirements and failure modes.
- **CI ergonomics**: it is easier to schedule E2E separately (and to allow targeted retries) without blocking all packages’ tests.

## Consequences

### Positive
- Faster `npm test` locally and in CI for most changes.
- Fewer monorepo-wide failures due to E2E/environment constraints.
- Clearer developer intent: E2E is run when you mean to validate end-to-end flows.

### Negative / Trade-offs
- E2E is no longer automatically exercised by running `npm test` in `packages/web`.
  - Mitigation: CI should still run `npm run test:e2e` in a separate step/job.

## How to Run

### Web unit tests
From repo root:
- `npm run test --workspace=@ahkms/web`

From `packages/web`:
- `npm test`

### Web E2E tests (Playwright)
From repo root:
- `npm run test:e2e --workspace=@ahkms/web`

From `packages/web`:
- `npm run test:e2e`

### Running against a specific base URL
Set `PLAYWRIGHT_TEST_BASE_URL` before running:
- Windows PowerShell:
  - `$env:PLAYWRIGHT_TEST_BASE_URL="http://localhost:3000"`
  - `npm run test:e2e --workspace=@ahkms/web`

## Alternatives Considered

### Alternative A: Keep E2E in `npm test` for `packages/web`
- **Pros**: “Always run everything” by default.
- **Cons**: makes monorepo `npm test` slow/flaky; requires server/env to be correct even for non-web changes.

### Alternative B: Make root `npm test` start required services first
- **Pros**: consistent end-to-end coverage in one command.
- **Cons**: increases complexity significantly; still conflates different test types and runtime dependencies.

### Alternative C: Run E2E only in CI
- **Pros**: developer flow stays fast.
- **Cons**: developers lose an obvious “run E2E locally” pathway; slower feedback loop for UI work.

## Related

- `.github/workflows/playwright.yml` (Playwright CI job)
- `packages/web/playwright.config.ts`
- `packages/web/package.json` scripts (`test:unit`, `test:e2e`)
- `turbo.json` task graph (root `test` depends on `build`)

