# ADR-096: Retire the web surface

- **Status:** Accepted
- **Created:** 2026-09-25
- **Accepted-on-dev:** 2026-09-26
- **Deciders:** Angus (solo maintainer)
- **Tags:** deployment, ci-cd, security
- **Amends:** [ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md) (its "Deploy stays on Vercel (web)" consequence and the `nightly-e2e` tier)
- **Amended-by:** [ADR-100](./ADR100_Unified_Action_Wrapper_And_Co_Editing_Surface.md) (unarchives packages/web as authenticated single-user Agent-Native Co-Editing and Knowledge Graph workspace)
- **Related:** [ADR-082](./ADR082_Web_Capture_Meeting_Notes_Derived_Artifact_Path_Retired.md) (an earlier, narrower retirement inside the web capture route)
- **Issue:** #1089

## Context and problem

`packages/web` was a Next.js 14 app deployed on Vercel (project
`knowledge-mgmt-system-oct2025`, domain `kms.example.com`), with production
following `main` per ADR-015. From 3 Sep 2026 its function usage jumped from ~0
to 9–11 GB a day, well past the Hobby thresholds. Nothing in `packages/web` had
changed since 30 Aug, so the cause was inbound traffic, not a code change. The
per-path usage breakdown is pay-gated, so the source was never identified;
`waitlist_entries` was empty, so the unauthenticated waitlist POST was not the
obvious target. On 16 Sep the project was paused, then deleted, and the CNAME
for `kms.example.com` was removed.

The owner does not use the browser UI. The MCP server (Railway) is how every
surface reaches ahOS, and `packages/mobile` is the only client package. Nothing
in `packages/worker`, `packages/mcp-server`, `packages/mobile`, the migrations
or the skills called the Vercel deployment, and nothing in the monorepo imports
`@ahkms/web`. What was left was an undeployed package that still cost CI time
on every PR, plus docs and config describing a deployment that no longer
existed.

## Decision drivers

- One serving surface to secure and pay for, not two.
- No CI minutes spent typechecking, linting and building a package nobody runs.
- The code must stay recoverable: it is a working app, and a future browser
  surface may want pieces of it.
- An unattended public deployment must not be able to run up a bill again.

## Considered options

### Option A — Keep `packages/web` in-tree, undeployed

- **Pros:** zero restore cost; shared-type drift would still be caught by its
  typecheck.
- **Cons:** every PR keeps typechecking, linting, unit-testing and (on `main`)
  building ~225 files for nothing; the Playwright E2E suite, whose only target
  was this app, rots; the two unauthenticated POST routes stay one Vercel click
  from being public again with no rate limiting.

### Option B — Keep only the `/graph` screen

- **Pros:** keeps the one screen with any residual value.
- **Cons:** still drags the whole Next.js toolchain, auth/session plumbing and
  build for one screen; same CI cost, smaller benefit.

### Option C — Archive the package out of the tree (chosen)

- **Pros:** CI, lockfile and docs describe only what runs; restore is one
  command from a fixed ref.
- **Cons:** shared-type changes are no longer checked against the web code, so a
  restore may need type fixes; restoring costs an `npm install`.

## Decision

We chose **Option C**. The web surface is retired and the MCP server is the only
serving surface.

1. **Archive location.** The last `dev` commit that carried the package
   (`b0ffedde1a2ac5a4899175f85998d1c008fb93e9`) is tagged
   `web-archive-2026-09`, with an `archive/web` branch at the same commit.
2. **Restore recipe.** `git checkout web-archive-2026-09 -- packages/web`, then
   `npm install` to relink the workspace and regenerate the lockfile. Restoring
   the Playwright workflow is `git checkout web-archive-2026-09 --
   .github/workflows/nightly-e2e.yml`.
3. **Removed from `dev`:** `packages/web` (with its `vercel.json` and
   `turbo-ignore` hook), `.github/workflows/nightly-e2e.yml`, the `dev:app`,
   `dev:web`, `dev:full`, `dev:docker` and `build:web` root scripts, the
   web-only turbo build env and outputs, and `https://kms.example.com` from
   the worker's default CORS allowlist.
4. **Rule for any future public deployment.** Every unauthenticated POST route
   (for the archived app: `api/waitlist` and `api/auth/sync-session`) is rate
   limited **before** the deployment goes live, not after. When an unattended
   public deployment shows a usage spike, **pause first and investigate
   second**: a paused project stops the meter instantly and is reversible.

## Consequences

- **Good:** CI (`ci-dev`, `ci-main`) now checks only `shared`, `worker`,
  `mcp-server` and `mobile`; `ci-main`'s Build job is `tsc` only and no longer
  needs placeholder `NEXT_PUBLIC_*` env. There is no E2E tier.
- **Good:** no Vercel project exists, so no Vercel preview check runs on PRs.
- **Cost / bad:** shared-type changes are unchecked against the archived web
  code; a restore should expect type drift.
- **Cost / bad:** ADR-015's "Deploy stays on Vercel (web)" and its E2E tier no
  longer describe the system; this ADR amends that part. ADR-009's web-runner
  guidance (Vitest in `packages/web`) likewise applies only to a restored copy.
- **Follow-up:** the owner removes any leftover Vercel env vars, the Vercel
  GitHub integration's access to this repo, and the Vercel/branch-protection
  status check if one is still required.

## Links

- Issue: #1089 (grill resolution in its comments)
- Amends: [ADR-015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md)
- Related: [ADR-009](./ADR009_Test_Command_Separation_Unit_vs_E2E.md),
  [ADR-082](./ADR082_Web_Capture_Meeting_Notes_Derived_Artifact_Path_Retired.md)
- Current state: [`docs/guides/DEPLOYMENT.md`](../guides/DEPLOYMENT.md)
