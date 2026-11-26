# ADR015: CI/CD pipeline, enforcement plan-gating, and E2E tiering

**Status:** Accepted
**Date:** 2026-06-13
**Accepted-on-dev:** 2026-06-13
**Deciders:** Angus Hally
**Amended by:** [ADR-096](./ADR096_Retire_The_Web_Surface.md) — the Vercel web deploy and the `nightly-e2e` tier are retired; `nightly-e2e.yml` no longer exists on `dev` (restorable from the `web-archive-2026-09` tag).

## Context and problem

The repo uses a two-tier branch model (`dev` → `main`). The pipeline introduced
alongside it (`ci-dev`, `ci-main`, `guard-main`, `nightly-e2e`,
`backmerge-main-to-dev`) needs its rationale recorded: where E2E runs, how the
`main`-source policy is enforced, and what happens to enforcement given the repo
is **private on a plan without required-status-check support**. This ADR records
those decisions and the net-new guard workflows added on top
(`pr-title`, `secret-scan`, `docs-index-guard`, `stale`, `auto-request-review`,
`issue-lifecycle`).

## Decision drivers

- Fast, cheap feedback on everyday `dev` PRs; don't pay for E2E on every push.
- Keep the expensive/flaky E2E suite **off the critical path** but run often
  enough that the `dev → main` batch is rarely a surprise.
- A machine decides pass/fail (deterministic gate); AI review stays advisory.
- Enforcement must be a **settings change**, not a rewrite, when the repo moves to
  a plan that supports required checks.
- Deploy is already handled by platform git-integration (Vercel/Railway) — don't
  duplicate it in a workflow.

## Considered options

**E2E placement.** (A) E2E on every PR — too slow/expensive, flaky blocks
everyday work. (B) **Unit + typecheck + lint on every `dev` PR; build + E2E only
at the `dev → main` batch (`ci-main`) and nightly against `dev` (`nightly-e2e`)**
— chosen. (C) E2E only nightly — breakage discovered too late, after a batch is
already cut.

**`main`-source enforcement.** (A) Convention only — drifts. (B) **A
`guard-main` job that fails any PR into `main` not from `dev` or a labelled
`hotfix/*`** — chosen; becomes a required check once on a paid plan. 

**Deploy.** (A) A `deploy.yml` env-routing workflow — would fight Vercel/Railway's
native git deploys. (B) **Rely on platform integrations** (`main` → prod) and
document the routing here — chosen.

## Decision

- **Tiering:** cheap gate (`lint` + `typecheck` + `test:unit` via `turbo`) on
  every `dev` PR ([`ci-dev.yml`](../../.github/workflows/ci-dev.yml)); build + E2E
  at the release batch ([`ci-main.yml`](../../.github/workflows/ci-main.yml)) and
  nightly ([`nightly-e2e.yml`](../../.github/workflows/nightly-e2e.yml)). Unit vs
  E2E split per [ADR009](./ADR009_Test_Command_Separation_Unit_vs_E2E.md).
- **Policy:** [`guard-main.yml`](../../.github/workflows/guard-main.yml) enforces
  the `main`-source rule; [`backmerge-main-to-dev.yml`](../../.github/workflows/backmerge-main-to-dev.yml)
  keeps `dev` in sync after a hotfix.
- **Net-new guards:** PR-title Conventional-Commits lint, secret scan
  (TruffleHog), docs-index guard, stale nudger (never auto-closes), reviewer
  auto-request, and issue lifecycle labelling.
- **Enforcement plan-gating:** the repo is **private**, so the
  branch-protection / required-checks APIs need a paid GitHub plan. Until then CI
  is **advisory** — green is visible on every PR and the reviewer confirms it
  before merge (**review coverage is the gate**). Record the trigger-to-upgrade
  here; flipping enforcement on afterward is one command (below).
- **Deploy** stays on Vercel (web, `main` → production) + Railway (worker) via
  their git integrations; no `deploy.yml`.

```bash
# After upgrading to a plan that supports required status checks + reviews:
for branch in dev main; do
  gh api --method PUT "repos/anguspersonal/knowledgeMgmtSystemOct2025/branches/$branch/protection" \
    -H "Accept: application/vnd.github+json" --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [
    { "context": "Lint · Typecheck · Unit" }
  ]},
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1 },
  "restrictions": null
}
JSON
done
# On main, also require the guard job:
gh api --method PATCH "repos/anguspersonal/knowledgeMgmtSystemOct2025/branches/main/protection/required_status_checks" \
  -f 'checks[][context]=Enforce source + label policy'
```

## Consequences

- **Good:** everyday PRs get sub-minute-ish feedback; E2E cost is bounded;
  `main` can't take an unauthorized source; secrets are scanned before merge.
- **Cost / bad:** breakage only E2E can catch may land on `dev` between nightly
  runs (mitigated by the batch gate before it reaches `main`). Enforcement is
  advisory until the plan upgrade — depends on reviewer discipline.
- **Follow-up:** when scale justifies it, adopt path-filtering on the cheap gate
  (see PR #26) and promote the guard/cheap-gate jobs to required checks via the
  command above.

## Amendment — 2026-07-12 (#47): E2E is on-demand, not scheduled or gated

The original tiering (option B) placed build + E2E at the `ci-main` release batch
**and** nightly against `dev`. In practice the Playwright suite needs a seeded
Supabase **test** backend to pass at all (no seeded data → even auth specs fail),
which is disproportionate infra for a single-user system. So:

- E2E was lifted off the `ci-main` release gate (build stays; #47 stop-gap).
- The `nightly-e2e.yml` **schedule is removed** — it kept spending Actions minutes
  nightly on a suite that couldn't meaningfully pass. It now runs
  **`workflow_dispatch` only** (on demand).
- **E2E is now run at the owner's discretion** — on demand via that workflow, or
  locally (`npm run test:e2e`). The `ci-main` gate keeps build + unit + typecheck +
  lint; Vercel's own build and daily dogfooding cover runtime regressions.

This **narrows** the original E2E-placement decision (it does not reverse the rest
of the ADR); the "reinstate E2E on the gate" goal (#47) is closed as won't-do. If a
seeded test backend is ever stood up, E2E can be reinstated per option B — the
original decision text above is unchanged and remains the reference for that path.

## Links

- Pairs with: [ADR014](./ADR014_Repo_Operating_System.md)
- Test split: [ADR009](./ADR009_Test_Command_Separation_Unit_vs_E2E.md)
- Judgement layer: [`.github/qa-rubric.md`](../../.github/qa-rubric.md)
