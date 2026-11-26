# ADR014: Repo operating system — documentation lanes + contribution model

**Status:** Accepted
**Date:** 2026-06-13
**Accepted-on-dev:** 2026-06-13
**Deciders:** Angus Hally

## Context and problem

The repo grew organically. `docs/README.md` was a *naming-convention* guide
rather than a navigable index; there was no `CONTRIBUTING.md`, no ADR index or
template, and `AGENTS.md` had drifted to describe a layout (`.mad-workflows`,
`.cursor`, `server/`, `nextjs/`) that no longer exists — it even carried a
corrupted patch artifact. New contributors (and agents) had no single front door,
and "where does this doc go?" had no answer. A portable repo-operating-system
blueprint (documentation system + contribution model + CI/CD suite) was available
from another team; this ADR records adopting it, adapted to this repo.

## Decision drivers

- One front door for humans and agents; deterministic "where does X go?".
- Separate **current state** (`docs/`), **why** (`docs/ADRs/`), and **planning**
  (GitHub Issues) so none silently absorbs the others.
- Low overhead for a small/solo private repo — enforce by discipline + cheap CI,
  not heavyweight tooling.
- Don't churn history: keep the existing `ADR[NNN]_Title` naming and the 13
  existing ADRs as-is.

## Considered options

### Option A — Adopt the blueprint, adapted to existing conventions (chosen)

- **Pros:** Proven structure; lanes table + decision tree + CI-enforced index;
  `CONTRIBUTING.md` + PR template codify the branch/commit/review bar; ADR index +
  template make the existing ADRs navigable. Adapts to `ADR[NNN]_` naming so
  nothing is renumbered.
- **Cons:** Up-front authoring; a `docs-index-guard` to keep honest.

### Option B — Keep the ad-hoc status quo

- **Pros:** Zero work.
- **Cons:** Front door stays broken; planning keeps leaking into `docs/`; ADRs
  stay un-indexed.

### Option C — External wiki / heavyweight docs tool

- **Pros:** Rich features.
- **Cons:** Splits docs from the code they describe; overkill for this repo;
  another system to maintain.

## Decision

We chose **Option A**. Concretely: `docs/README.md` becomes the lanes + "where
does X go?" index (CI-enforced); `docs/ADRs/` gets a `README.md` index and
`TEMPLATE.md`; `CONTRIBUTING.md` + `.github/PULL_REQUEST_TEMPLATE.md` codify the
contribution model; `AGENTS.md` is rewritten as the agent front door pointing at
`docs/README.md`. Planning artifacts (specs, requirements, backlog) live in GitHub
Issues, never in `docs/`. The CI/CD half of the blueprint is covered separately in
[ADR015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md).

## Consequences

- **Good:** Single navigable entry point; agents get an accurate front door;
  ADR reasoning is discoverable; the index can't silently drift
  (`docs-index-guard.yml`).
- **Cost / bad:** A PR that adds/removes/renames a doc must also touch the
  relevant index (enforced) — small, deliberate friction.
- **Follow-up:** Migrate any remaining plan/spec docs under `docs/` into Issues
  opportunistically; keep `AGENTS.md` honest as the layout evolves.

## Links

- Pairs with: [ADR015](./ADR015_CICD_Pipeline_Enforcement_and_E2E_Tiering.md)
- Enforced by: the docs-index step in [`pr-guards.yml`](../../.github/workflows/pr-guards.yml)
  (was `docs-index-guard.yml`; the five PR guards were consolidated into one job
  on 2026-07-21 to cut Actions minutes — see #435)
- Codified in: [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [`docs/README.md`](../README.md)
